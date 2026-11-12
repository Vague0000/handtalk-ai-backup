"""
server.py - Flask-SocketIO bridge between the ASL gesture AI pipeline and the
HandTalk AI web dashboard.
"""

import os
import sys
import time
import base64
import threading
import traceback

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, send_from_directory, session, redirect, jsonify

from config import ENABLE_LOGIN, SHOW_PROFILE, SHOW_FAVORITES, SHOW_ANALYTICS
from flask_socketio import SocketIO

from src.config import (
    STATIC_MODEL_PATH, LABEL_ENCODER_PATH,
    MOTION_MODEL_PATH, MOTION_ENCODER_PATH,
    NUMBER_MODEL_PATH, NUMBER_ENCODER_PATH,
    WINDOW_WIDTH, WINDOW_HEIGHT, FPS_TARGET,
    CONFIDENCE_THRESHOLD, MOTION_THRESHOLD,
    SPEAK_LABEL, SPEAK_HOLD_SECONDS, DELETE_LABEL,
)
from src.landmark_extractor import HandLandmarkExtractor
from src.predictor import StaticPredictor
from src.recognition_pipeline import MultiModelRecognizer

# ─── App / Socket setup ───────────────────────────────────────────────────
BASE_DIR      = os.path.dirname(os.path.abspath(__file__))
DASHBOARD_DIR = os.path.join(BASE_DIR, "dashboard")

app = Flask(__name__, static_folder=DASHBOARD_DIR, static_url_path="")
app.config["SECRET_KEY"] = "handtalk-ai"

from datetime import timedelta
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)

from auth.auth_routes import auth_bp
app.register_blueprint(auth_bp)

from history.history_routes import history_bp
app.register_blueprint(history_bp)
from history.history_service import save_sentence

from favorites.favorites_routes import favorites_bp
app.register_blueprint(favorites_bp)

from user_profile.profile_routes import profile_bp
app.register_blueprint(profile_bp)

from settings.settings_routes import settings_bp
app.register_blueprint(settings_bp)
from auth.auth_service import touch_last_active

from feedback.feedback_routes import feedback_bp
app.register_blueprint(feedback_bp)

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

JPEG_QUALITY = 70
MAX_FRAME_BYTES = 1_500_000


@app.route("/")
def landing():
    return send_from_directory(DASHBOARD_DIR, "landing.html")

@app.route("/dashboard")
def index():
    if not ENABLE_LOGIN or "user_id" in session:
        return send_from_directory(DASHBOARD_DIR, "index.html")
    return redirect("/login.html")

@app.route("/login.html")
def login_page():
    if not ENABLE_LOGIN:
        return redirect("/dashboard")
    return send_from_directory(DASHBOARD_DIR, "login.html")

@app.route("/register.html")
def register_page():
    if not ENABLE_LOGIN:
        return redirect("/dashboard")
    return send_from_directory(DASHBOARD_DIR, "register.html")

@app.route("/api/config")
def get_config():
    return jsonify({
        "enable_login":    ENABLE_LOGIN,
        "show_profile":    SHOW_PROFILE,
        "show_favorites":  SHOW_FAVORITES,
        "show_analytics":  SHOW_ANALYTICS,
    })

@app.route("/api/voices")
def get_voices():
    # pyttsx3 removed. Browser handles Text-to-Speech now.
    return jsonify({"voices": []})

# ─── Sentence builder ────────────
class WordBuilder:
    def __init__(self, hold=20):
        self.sentence = ""
        self._last = ""
        self._cnt = 0
        self._hold = hold

    def update(self, gesture, conf):
        if not gesture or gesture in ("Unknown", "No Hand", "—", SPEAK_LABEL):
            self._last = ""
            self._cnt = 0
            return False
        if gesture == self._last:
            self._cnt += 1
        else:
            self._last = gesture
            self._cnt = 1
            return False
        if self._cnt == self._hold:
            if gesture == DELETE_LABEL:
                if self.sentence:
                    self.sentence = self.sentence[:-1]
            elif gesture == "SPACE":
                if self.sentence and self.sentence[-1] != " ":
                    self.sentence += " "
            else:
                self.sentence += gesture
            return True
        return False

    @property
    def progress(self):
        return min(self._cnt / self._hold, 1.0)

    def backspace(self):
        if self.sentence:
            self.sentence = self.sentence[:-1]

    def clear(self):
        self.sentence = ""
        self._last = ""
        self._cnt = 0


# ─── Camera / inference worker ──────────────────────────────────────────────
class GestureStreamer:
    def __init__(self):
        self.static_ok = os.path.exists(STATIC_MODEL_PATH) and os.path.exists(LABEL_ENCODER_PATH)
        self.motion_ok = os.path.exists(MOTION_MODEL_PATH) and os.path.exists(MOTION_ENCODER_PATH)

        if not self.static_ok:
            raise RuntimeError("No static model found. Train it first: py train_pipeline.py")

        self.static_pred = StaticPredictor(
            STATIC_MODEL_PATH, LABEL_ENCODER_PATH, threshold=CONFIDENCE_THRESHOLD
        )

        self.number_ok = os.path.exists(NUMBER_MODEL_PATH) and os.path.exists(NUMBER_ENCODER_PATH)
        self.recognizer = MultiModelRecognizer()
        self.recognizer.register("alphabet", self.static_pred)
        if self.number_ok:
            self.number_pred = StaticPredictor(
                NUMBER_MODEL_PATH, NUMBER_ENCODER_PATH, threshold=CONFIDENCE_THRESHOLD
            )
            self.recognizer.register("number", self.number_pred)

        self.motion_pred = None
        if self.motion_ok:
            from src.motion_model import MotionPredictor
            self.motion_pred = MotionPredictor(
                MOTION_MODEL_PATH, MOTION_ENCODER_PATH, threshold=MOTION_THRESHOLD
            )

        self.extractor = HandLandmarkExtractor(max_hands=1)
        # REMOVED: self.speech = SpeechOutput()
        self.builder   = WordBuilder(hold=20)

        self._clahe     = cv2.createCLAHE(2.0, (8, 8))
        self._running   = False
        self._lock      = threading.Lock()
        self._frame_lock = threading.Lock()
        self._fps_count = 0
        self._fps_started = time.time()
        self._fps_value = 0.0

        self._motion_label = None
        self._motion_conf  = 0.0
        self._motion_display_frames = 0
        self._speak_start = None

        self.active_user_id    = None
        self.active_session_id = None
        self.show_landmarks    = True

    def start(self):
        with self._lock:
            if self._running:
                return
            self.builder.clear()
            if self.motion_pred:
                self.motion_pred.reset()
            self.static_pred.smoother.reset()
            self._motion_display_frames = 0
            self._speak_start = None
            self._fps_count = 0
            self._fps_started = time.time()
            self._fps_value = 0.0
            self._running = True
        print("[server] AI pipeline ready; waiting for browser camera frames.")

    def stop(self):
        with self._lock:
            self._running = False
        self.builder.clear()
        if self.motion_pred:
            self.motion_pred.reset()

    def speak_text(self, text):
        text = (text or "").strip()
        if not text:
            return
        
        # Just send the text to the frontend. Browser handles TTS.
        socketio.emit("spoken", {"text": text})

        if self.active_user_id:
            try:
                save_sentence(
                    user_id=self.active_user_id,
                    sentence=text,
                    session_id=self.active_session_id,
                )
            except Exception as e:
                print(f"[server] Failed to save sentence history: {e}")

    def clear_sentence(self):
        self.builder.clear()

    def process_browser_frame(self, encoded_image):
        if not self._running:
            return
        if not isinstance(encoded_image, str) or len(encoded_image) > (MAX_FRAME_BYTES * 2):
            raise ValueError("Invalid or oversized camera frame.")

        try:
            raw = base64.b64decode(encoded_image, validate=True)
        except Exception as exc:
            raise ValueError("The browser sent an invalid camera frame.") from exc
        if not raw or len(raw) > MAX_FRAME_BYTES:
            raise ValueError("Camera frame is empty or too large.")

        with self._frame_lock:
            frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise ValueError("Unable to decode the browser camera frame.")

            frame = cv2.flip(frame, 1)
            enhanced = self._enhance(frame)
            features, results = self.extractor.extract_features(enhanced)
            
            # Even if we don't send the image back, we still draw landmarks 
            # internally (this doesn't cost much CPU, but if you want max speed, 
            # you can skip this since the browser doesn't see it anyway)
            # self.extractor.draw_landmarks(frame, results) 

            if features is not None:
                if self.motion_pred:
                    self.motion_pred.push(features)
                    motion_label, motion_conf = self.motion_pred.predict()
                    if motion_label is not None:
                        self._motion_label = motion_label
                        self._motion_conf = motion_conf
                        self._motion_display_frames = 30

                static_label, static_conf, top_k, _source = self.recognizer.predict_with_top_k(features, k=3)
                if self._motion_display_frames > 0:
                    gesture, confidence = self._motion_label, self._motion_conf
                    self._motion_display_frames -= 1
                else:
                    gesture, confidence = static_label, static_conf
            else:
                gesture, confidence, top_k = "No Hand", 0.0, []
                if self.motion_pred:
                    self.motion_pred.reset()
                self.builder._last = ""
                self.builder._cnt = 0

            speak_now = gesture == SPEAK_LABEL and confidence >= CONFIDENCE_THRESHOLD
            speak_progress = 0.0
            if speak_now and self.builder.sentence.strip():
                if self._speak_start is None:
                    self._speak_start = time.time()
                elapsed = time.time() - self._speak_start
                speak_progress = min(elapsed / SPEAK_HOLD_SECONDS, 1.0)
                if elapsed >= SPEAK_HOLD_SECONDS:
                    sentence_to_speak = self.builder.sentence.strip()
                    self.speak_text(sentence_to_speak)
                    self.builder.clear()
                    self._speak_start = None
                    speak_progress = 0.0
            else:
                self._speak_start = None

            if speak_progress < 0.1:
                self.builder.update(gesture, confidence)

            self._fps_count += 1
            now = time.time()
            elapsed = now - self._fps_started
            if elapsed >= 1.0:
                self._fps_value = self._fps_count / elapsed
                self._fps_count = 0
                self._fps_started = now

            # REMOVED: cv2.imencode and sending image back. This saves massive CPU.
            socketio.emit("frame", {
                "fps": self._fps_value,
                "gesture": gesture,
                "confidence": float(confidence),
                "top_k": [{"label": label, "confidence": float(conf)} for label, conf in top_k],
                "mode": "HYBRID" if self.motion_ok else "STATIC",
                "sentence": self.builder.sentence,
                "speak_progress": speak_progress,
            })

    def _enhance(self, frame):
        lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        l = self._clahe.apply(l)
        return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)


# ─── Streamer singleton + connected-client tracking ────────────────────────
streamer = None
_connected_clients = 0
_clients_lock = threading.Lock()

def get_streamer():
    global streamer
    if streamer is None:
        streamer = GestureStreamer()
    return streamer


# ─── Socket events ──────────────────────────────────────────────────────────
@socketio.on("connect")
def on_connect():
    global _connected_clients
    if not ENABLE_LOGIN:
        with _clients_lock:
            _connected_clients += 1
        try:
            gs = get_streamer()
            gs.active_user_id    = None
            gs.active_session_id = None
            gs.start()
        except Exception as e:
            socketio.emit("server_error", {"message": str(e)})
        return

    if "user_id" not in session:
        return False
    with _clients_lock:
        _connected_clients += 1
    try:
        gs = get_streamer()
        gs.active_user_id    = session["user_id"]
        gs.active_session_id = session.get("session_id")
        gs.start()
        touch_last_active(session["user_id"])
    except Exception as e:
        socketio.emit("server_error", {"message": str(e)})


@socketio.on("disconnect")
def on_disconnect():
    global _connected_clients
    with _clients_lock:
        _connected_clients = max(0, _connected_clients - 1)
        count = _connected_clients
    if count == 0 and streamer is not None:
        streamer.stop()


@socketio.on("process_frame")
def on_process_frame(data):
    try:
        if not isinstance(data, dict):
            raise ValueError("Missing camera frame data.")
        get_streamer().process_browser_frame(data.get("image", ""))
        return {"ok": True}
    except Exception as e:
        socketio.emit("server_error", {"message": str(e)})
        return {"ok": False, "error": str(e)}


@socketio.on("speak")
def on_speak(data):
    text = (data or {}).get("text", "")
    try:
        get_streamer().speak_text(text)
    except Exception as e:
        socketio.emit("server_error", {"message": str(e)})


@socketio.on("clear_sentence")
def on_clear_sentence():
    try:
        get_streamer().clear_sentence()
    except Exception as e:
        socketio.emit("server_error", {"message": str(e)})


@socketio.on("set_landmarks")
def on_set_landmarks(data):
    try:
        get_streamer().show_landmarks = bool((data or {}).get("visible", True))
    except Exception:
        pass


@socketio.on("set_speech")
def on_set_speech(data):
    # Speech settings are now handled by the browser. 
    # We accept the event so the frontend doesn't throw an error, but we do nothing.
    pass


if __name__ == "__main__":
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", "5000"))
    socketio.run(app, host=host, port=port)