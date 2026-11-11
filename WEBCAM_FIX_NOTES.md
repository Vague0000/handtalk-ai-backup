# HandTalk AI browser webcam fix

## What changed

- `dashboard/app.js` now requests camera permission in the visitor's browser with `navigator.mediaDevices.getUserMedia()`.
- The browser captures small JPEG frames and sends them to Flask over the existing Socket.IO connection using the `process_frame` event.
- `server.py` no longer calls `cv2.VideoCapture()` for the dashboard. It decodes browser frames and passes them through the existing MediaPipe landmark extractor, TensorFlow recognizer, motion predictor, sentence builder, and speech flow.
- Existing dashboard markup, styling, history, dictionary, settings, authentication, and AI model files are retained.

## Deployment and testing

1. Replace the matching files in your project with the updated `server.py` and `dashboard/app.js`.
2. Keep the existing model files and Python dependencies. No new Python package is required for this change.
3. Commit and deploy the updated project to Render.
4. Open the deployed site over HTTPS, sign in, select Translator, and click **Start Feed**.
5. Allow camera access in the browser permission prompt.
6. Confirm the camera feed appears and that gesture/confidence/top-prediction values update.
7. Click **Stop** and confirm the browser camera indicator turns off.

Camera access requires a secure context (HTTPS in production; localhost is also allowed by modern browsers). The Render backend processes frames but cannot access the webcam physically connected to the visitor's computer.

## Notes

- The browser sends approximately 8 frames per second at a reduced JPEG size to limit bandwidth and server load. This can be tuned after testing on the deployed Render instance.
- The source archive's `.git` directory, `cookies.txt`, Python bytecode caches, and runtime logs are intentionally excluded from the cleaned delivery ZIP. Do not publish session cookies or credentials.
- Static syntax checks passed for the modified Python and JavaScript files. A live server/model integration test could not be run in this environment because Flask and the project's runtime dependencies are not installed here.
