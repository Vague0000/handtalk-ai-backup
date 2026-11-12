// ─────────────────────────────────────────────────────────────────
// app.js  —  ASL Dashboard logic
// Phase 1: UI only (no WebSocket yet)
// Phase 2: Uncomment the socket section at the bottom to connect
// ─────────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────
const state = {
  running:            false,
  sentence:           '',
  history:            [],
  sessionStart:       null,
  currentGesture:     '—',
  confidence:         0,
  fps:                0,
  mode:               'STATIC',
};

// ── DOM helpers ───────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

// Declared here (rather than next to connectSocket() below) because
// applySettingsToDashboard() reads it, and in guest mode loadSettings()
// calls applySettingsToDashboard() synchronously during the initial
// script run - before execution would otherwise reach a `let socket`
// declared further down the file. Referencing a not-yet-declared `let`
// binding throws a TDZ ReferenceError even though the function that
// reads it was defined earlier; declaring it this early avoids that
// regardless of call order.
let socket = null;
let browserCameraStream = null;
let browserCameraVideo = null;
let browserCameraCanvas = null;
let browserFrameTimer = null;
let browserFrameBusy = false;

// ── Auth gate ─────────────────────────────────────────────────────
// Runs as soon as this script loads. If there's no active session,
// bounce to the login page before the user sees any dashboard data.
let currentUser = null;

async function checkAuth() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) {
      window.location.href = 'login.html';
      return;
    }
    const data = await res.json();
    currentUser = data.user;
    const navUser = el('nav-user');
    if (navUser) {
      navUser.innerHTML = `Hi, <strong>${escapeHtml(currentUser.fullname || currentUser.username)}</strong>`;
    }
    updateWelcomeName();
    renderProfile();
    if (!currentUser.id) hideAuthUI();
    // loadSettings() already ran once at script startup, before this
    // async call resolved and currentUser was known - re-run it now
    // that guest vs. logged-in is certain, so it picks the right
    // source (Local Storage vs. /api/settings).
    loadSettings();
  } catch (err) {
    window.location.href = 'login.html';
  }
}

// Hides Login, Register, and Logout UI elements when ENABLE_LOGIN is False.
// Called automatically when /api/me returns a guest user (id === null).
function hideAuthUI() {
  [
    '.profile-dropdown-logout',
    '.profile-dropdown-divider',
    '.sidebar-logout',
  ].forEach(sel => {
    document.querySelectorAll(sel).forEach(node => { node.style.display = 'none'; });
  });

  // Profile page: hide Edit Profile / Change Password / Logout actions —
  // none of these work without a real user account.
  const profileActions = document.querySelector('.profile-actions');
  if (profileActions) profileActions.style.display = 'none';
}

// Populates the Dashboard's "Welcome back, {name}" header. Additive only —
// no existing state or DOM hooks are touched if #welcome-name isn't present.
function updateWelcomeName() {
  const welcomeName = el('welcome-name');
  if (welcomeName && currentUser) {
    const first = (currentUser.fullname || currentUser.username || '').split(' ')[0];
    welcomeName.textContent = first || 'there';
  }
  const avatar = el('sidebar-avatar');
  if (avatar && currentUser) {
    const label = currentUser.fullname || currentUser.username || '';
    avatar.textContent = label.trim().charAt(0).toUpperCase() || '?';
  }
  syncHeaderAvatar();
}

// Header (topbar) avatar + name + dropdown trigger. Reads the same
// currentUser/avatar_path data already loaded by checkAuth()/renderProfile() —
// no new network calls, no new backend fields.
function syncHeaderAvatar() {
  if (!currentUser) return;

  const nameEl = el('topbar-username');
  if (nameEl) nameEl.textContent = currentUser.fullname || currentUser.username || 'Account';

  const avatarWrap = el('topbar-avatar');
  if (!avatarWrap) return;

  const initials = (currentUser.fullname || currentUser.username || '')
    .trim().split(/\s+/).map(w => w.charAt(0).toUpperCase()).slice(0, 2).join('') || '?';

  if (currentUser.avatar_path) {
    avatarWrap.innerHTML = `<img src="${escapeAttr(currentUser.avatar_path)}" alt="" class="topbar-avatar-img">`;
  } else {
    avatarWrap.textContent = initials;
  }
}

// Profile dropdown (header). Purely a UI toggle — My Profile / Settings
// route through the existing switchPage() + topbar nav functions;
// Logout calls the existing logout().
function toggleProfileMenu(evt) {
  if (evt) evt.stopPropagation();
  const menu = el('profile-dropdown');
  if (!menu) return;
  menu.classList.toggle('show');
}

function closeProfileMenu() {
  const menu = el('profile-dropdown');
  if (menu) menu.classList.remove('show');
}

document.addEventListener('click', (evt) => {
  const menu = el('profile-dropdown');
  const trigger = el('topbar-user-trigger');
  if (!menu || !menu.classList.contains('show')) return;
  if (trigger && trigger.contains(evt.target)) return;
  if (menu.contains(evt.target)) return;
  closeProfileMenu();
});

document.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape') closeProfileMenu();
});

async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (err) {
    // Network hiccup or not - still send them to the login page.
  }
  window.location.href = 'login.html?logged_out=1';
}

checkAuth();

// ── Toast ─────────────────────────────────────────────────────────
function showToast(msg, duration = 2500) {
  const toast = el('toast');
  el('toast-text').textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ── Top nav ───────────────────────────────────────────────────────
const PAGE_TITLES = {
  overview:   'Overview',
  dashboard:  'Translator',
  dictionary: 'Dictionary',
  history:    'History',
  favorites:  'Favorites',
  analytics:  'Analytics',
  profile:    'Profile',
  settings:   'Settings',
  support:    'Customer Support',
};

// Navigate to a page by name, activating the correct nav button.
// Used by Overview CTA buttons and any in-page links.
function gotoPage(page) {
  const btn = document.querySelector(`.topbar-link[data-page="${page}"]`);
  if (btn) switchPage(btn, page);
}

// Mobile nav dropdown. At 1100px and above the topbar-nav's own
// @media rule forces it to display:flex regardless of this class, so
// an open dropdown left over from a narrower viewport self-resolves
// on resize with no JS needed here.
function toggleMobileNav() {
  const nav = el('topbar-center');
  const btn = el('nav-hamburger');
  if (!nav) return;
  const open = nav.classList.toggle('show');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeMobileNav() {
  const nav = el('topbar-center');
  const btn = el('nav-hamburger');
  if (nav) nav.classList.remove('show');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function switchPage(btn, page) {
  document.querySelectorAll('.topbar-link[data-page]')
    .forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  document.querySelectorAll('.page-panel')
    .forEach(p => p.classList.remove('active'));
  const panel = el('page-' + page);
  if (panel) panel.classList.add('active');

  const titleEl = el('page-title');
  if (titleEl) titleEl.textContent = PAGE_TITLES[page] || 'Dashboard';

  closeMobileNav();
  closeProfileMenu();

  // Leaving Settings for any other tab drops the unsaved theme
  // preview - loadSettings() re-stages it (to the real saved theme)
  // if/when the user comes back.
  if (page !== 'settings') clearThemePreview();

  if (page === 'profile')    { renderProfile(); loadProfileStats(); }
  if (page === 'history')    loadSentenceHistory();
  if (page === 'favorites')  loadFavorites();
  if (page === 'settings')   loadSettings();
  if (page === 'dictionary') resetDictView();
}

function renderProfile() {
  if (!currentUser) return;

  const navUser = el('nav-user');
  if (navUser) {
    navUser.innerHTML = `Hi, <strong>${escapeHtml(currentUser.fullname || currentUser.username)}</strong>`;
  }
  updateWelcomeName();
  syncHeaderAvatar();

  el('profile-fullname-display').textContent  = currentUser.fullname || '—';
  el('profile-username-display').textContent  = '@' + (currentUser.username || '—');
  el('profile-email').textContent             = currentUser.email || '—';
  el('profile-created').textContent           = currentUser.created_at
    ? new Date(currentUser.created_at).toLocaleDateString()
    : '—';
  el('profile-last-active').textContent       = currentUser.last_active
    ? new Date(currentUser.last_active).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

  const avatarImg   = el('profile-avatar');
  const placeholder = el('profile-avatar-placeholder');
  const removeBtn   = el('profile-avatar-remove');
  if (currentUser.avatar_path) {
    avatarImg.src = currentUser.avatar_path;
    avatarImg.classList.remove('hidden');
    placeholder.classList.add('hidden');
    removeBtn.classList.add('show');
  } else {
    avatarImg.classList.add('hidden');
    placeholder.classList.remove('hidden');
    removeBtn.classList.remove('show');
  }
}

// ── Profile statistics (real, MySQL-backed) ─────────────────────────
async function loadProfileStats() {
  try {
    const res = await fetch('/api/profile/stats');
    if (!res.ok) {
      showToast('Could not load profile stats.');
      return;
    }
    const data = await res.json();
    renderProfileStats(data.stats || {});
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

function renderProfileStats(stats) {
  el('pstat-sessions').textContent     = stats.total_sessions  ?? 0;
  el('pstat-sentences').textContent    = stats.total_sentences ?? 0;
  el('pstat-favorites').textContent    = stats.total_favorites ?? 0;
  el('pstat-avg-duration').textContent = stats.avg_duration_seconds != null
    ? formatTime(stats.avg_duration_seconds * 1000)
    : '—';
  el('pstat-letter').textContent       = stats.most_used_letter || '—';
}

// ── Avatar upload ─────────────────────────────────────────────────────
async function uploadAvatar(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('avatar', file);

  try {
    const res  = await fetch('/api/me/avatar', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Could not upload picture.');
      return;
    }
    currentUser.avatar_path = data.avatar_path;
    renderProfile();
    showToast('Profile picture updated!');
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

// ── Avatar removal ──────────────────────────────────────────────────
async function removeAvatar() {
  if (!currentUser || !currentUser.avatar_path) return;

  try {
    const res  = await fetch('/api/me/avatar', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Could not remove picture.');
      return;
    }
    currentUser.avatar_path = null;
    renderProfile();
    showToast('Profile picture removed.');
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

// ── Edit Profile modal ───────────────────────────────────────────────
function openEditProfile() {
  el('edit-fullname').value = currentUser.fullname || '';
  el('edit-username').value = currentUser.username || '';
  el('edit-profile-error').classList.remove('show');
  el('edit-profile-overlay').classList.add('show');
}

function closeEditProfile() {
  el('edit-profile-overlay').classList.remove('show');
}

async function submitEditProfile() {
  const fullname = el('edit-fullname').value.trim();
  const username = el('edit-username').value.trim();
  const errBox   = el('edit-profile-error');

  try {
    const res = await fetch('/api/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullname, username }),
    });
    const data = await res.json();
    if (!res.ok) {
      errBox.textContent = data.error || 'Could not update profile.';
      errBox.classList.add('show');
      return;
    }
    currentUser = data.user;
    renderProfile();
    closeEditProfile();
    showToast('Profile updated!');
  } catch (err) {
    errBox.textContent = 'Could not reach the server.';
    errBox.classList.add('show');
  }
}

// ── Change Password modal ────────────────────────────────────────────
function openChangePassword() {
  el('current-password').value = '';
  el('new-password').value     = '';
  el('change-password-error').classList.remove('show');
  el('change-password-overlay').classList.add('show');
}

function closeChangePassword() {
  el('change-password-overlay').classList.remove('show');
}

async function submitChangePassword() {
  const current_password = el('current-password').value;
  const new_password     = el('new-password').value;
  const errBox = el('change-password-error');

  try {
    const res = await fetch('/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password, new_password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errBox.textContent = data.error || 'Could not change password.';
      errBox.classList.add('show');
      return;
    }
    closeChangePassword();
    showToast('Password changed!');
  } catch (err) {
    errBox.textContent = 'Could not reach the server.';
    errBox.classList.add('show');
  }
}

// ── Local Settings Storage (temporary persistence layer) ────────────
// settings_routes.py always returns the hardcoded DEFAULTS on GET and
// silently no-ops PUT/reset whenever there's no logged-in session (see
// its `if not ENABLE_LOGIN or session["user_id"] is None` branch) —
// i.e. in this app's current loginless configuration, the backend
// never actually persists a Settings change. This module fills that
// gap in the browser instead.
//
// Same shape LocalHistoryStore uses for History: getAll/save/reset are
// the only things callers below talk to, so swapping this for a real
// /api/settings-backed store later only means rewriting the inside of
// these three functions — not the Settings page UI.
const LocalSettingsStore = (() => {
  const STORAGE_KEY = 'handtalk_settings';

  const DEFAULTS = {
    speech_speed:       1.0,
    speech_volume:      100,
    speech_voice:       '',   // '' = system default
    camera_size:        'medium',
    show_landmarks:     true,
    show_analytics:     true,
    show_history_panel: true,
    theme:              'light',
  };

  function readAll() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return (saved && typeof saved === 'object')
        ? Object.assign({}, DEFAULTS, saved)
        : Object.assign({}, DEFAULTS);
    } catch {
      return Object.assign({}, DEFAULTS);
    }
  }

  function writeAll(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage unavailable/full (e.g. private browsing) - settings
      // simply won't survive a reload in that case.
    }
  }

  return {
    DEFAULTS,
    getAll: readAll,
    save(patch) {
      const merged = Object.assign(readAll(), patch);
      writeAll(merged);
      return merged;
    },
    // keys omitted -> reset everything
    reset(keys) {
      const current   = readAll();
      const resetKeys = (keys && keys.length) ? keys : Object.keys(DEFAULTS);
      resetKeys.forEach(k => { current[k] = DEFAULTS[k]; });
      writeAll(current);
      return current;
    },
  };
})();

// Mirrors settings_service.py's server-side validation (update_settings())
// so guest saves, which never reach the backend, are held to the same
// constraints instead of silently writing out-of-range values.
function validateSettingsPatch(patch) {
  if ('speech_speed' in patch) {
    const v = Number(patch.speech_speed);
    if (Number.isNaN(v) || v < 0.5 || v > 2.0) return 'Speech speed must be between 0.5x and 2.0x.';
  }
  if ('speech_volume' in patch) {
    const v = Number(patch.speech_volume);
    if (Number.isNaN(v) || v < 0 || v > 100) return 'Speech volume must be between 0 and 100.';
  }
  if ('camera_size' in patch && !['small', 'medium', 'large'].includes(patch.camera_size)) {
    return 'Camera size must be small, medium, or large.';
  }
  return null;
}

// ── Settings (real, MySQL-backed for logged-in users; Local Storage
//    for guests — see LocalSettingsStore above) ─────────────────────
// Applied to the live Dashboard immediately on load/save (camera size,
// show/hide cards), independent of whether the user is currently on
// the Settings page or the Dashboard page.
//
// NOTE on Speech Speed / Speech Volume: these are saved and loaded
// correctly below, but only ever applied to the browser's own
// speechSynthesis playback (History page's per-row Speak button).
// The primary voice - Python's TTS, triggered by the SPEAK-gesture
// hold or the manual Speak button (speakSentence() below, which
// emits 'speak' over the socket) - doesn't read these yet; that
// would need Speed/Volume wired into whatever TTS engine
// src/speech.py wraps. Left as a deliberate TODO rather than faking
// a hook that wouldn't do anything.
// ── Theme (Light/Dark) ───────────────────────────────────────────────
// Purely a client-side display preference — kept in the same
// LocalSettingsStore all guests already use for settings, but applied
// regardless of login state since it's device-local and never touches
// the server (no Flask/API route reads or writes it). The inline
// <script> in <head> of every page already applies the saved value
// before first paint to avoid a flash of the wrong theme; this just
// keeps it in sync afterward and lets the Settings toggle change it.
function syncThemeRadios(theme) {
  const lightRadio = el('setting-theme-light');
  const darkRadio  = el('setting-theme-dark');
  if (lightRadio) lightRadio.checked = theme !== 'dark';
  if (darkRadio)  darkRadio.checked  = theme === 'dark';
}

// The committed (saved) theme - single source of truth for "what to
// go back to" once a preview ends. Kept separate from the <body>
// attribute below because that attribute gets temporarily overridden
// during preview, in both directions (dark savedtheme previewing
// light, or vice versa).
let committedTheme = LocalSettingsStore.getAll().theme;

// Applies the theme to the whole app - this is the "committed" apply,
// used after Save Changes / Reset to Default, and on initial page
// load for whatever was last saved. Ownership of the data-theme
// attribute moves from <html> (set by the inline pre-paint <script> in
// <head>, before <body> exists, purely to avoid a flash of the wrong
// theme) to <body> here, so there is exactly one element carrying the
// attribute once app.js has run - otherwise a still-dark <html> would
// keep matching dark-mode selectors (e.g. `[data-theme="dark"] .card`)
// even while <body> was overridden to "light" for a preview, since
// CSS descendant selectors match through ANY matching ancestor.
function applyTheme(theme) {
  committedTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.removeAttribute('data-theme');
  document.body.setAttribute('data-theme', committedTheme);
  syncThemeRadios(committedTheme);
}

function setTheme(theme) {
  LocalSettingsStore.save({ theme: theme === 'dark' ? 'dark' : 'light' });
  applyTheme(theme);
}

// Radio buttons preview immediately, but scoped to while the Settings
// page is open - data-theme is set on <body>, which style.css also
// uses to redefine the dark-mode CSS variables, so the topbar/header
// (a sibling of the page panels, not inside any one of them) previews
// too. Because <html> no longer carries the attribute (see applyTheme
// above), this correctly overrides the committed theme in EITHER
// direction - e.g. selecting Light Mode while Dark Mode is the saved
// theme actually goes light on this page, not just when going the
// other way. switchPage() reverts this the moment the user navigates
// to any other tab, so Dashboard, Translator, Dictionary, History,
// Support, and the Landing Page (which reads the saved theme from
// localStorage on its own load) all stay on whatever theme was last
// saved until this one is actually committed via Save Changes
// (setTheme()).
let pendingTheme = committedTheme;

function stageThemeSelection(theme) {
  pendingTheme = theme === 'dark' ? 'dark' : 'light';
  document.body.setAttribute('data-theme', pendingTheme);
  syncThemeRadios(pendingTheme);
}

function clearThemePreview() {
  document.body.setAttribute('data-theme', committedTheme);
}

applyTheme(LocalSettingsStore.getAll().theme);

let currentSettings = null;

async function loadSettings() {
  if (!currentUser || !currentUser.id) {
    currentSettings = LocalSettingsStore.getAll();
    renderSettingsForm(currentSettings);
    applySettingsToDashboard(currentSettings);
    return;
  }
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) {
      showToast('Could not load settings.');
      return;
    }
    const data = await res.json();
    currentSettings = data.settings || {};
    renderSettingsForm(currentSettings);
    applySettingsToDashboard(currentSettings);
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

function renderSettingsForm(settings) {
  // Reset the Settings-only preview back to whatever's actually saved.
  // Called every time the Settings page is (re-)entered (loadSettings),
  // so any unsaved preview from a previous visit doesn't linger.
  pendingTheme = settings.theme || LocalSettingsStore.getAll().theme;
  document.body.setAttribute('data-theme', pendingTheme);
  syncThemeRadios(pendingTheme);
  el('setting-show-analytics').checked     = settings.show_analytics     !== false;
  el('setting-show-history-panel').checked = settings.show_history_panel !== false;
  el('setting-show-landmarks').checked     = settings.show_landmarks     !== false;

  el('setting-camera-size').value = settings.camera_size || 'medium';

  const speed = settings.speech_speed != null ? settings.speech_speed : 1.0;
  el('setting-speech-speed').value = speed;
  el('setting-speech-speed-val').textContent = Number(speed).toFixed(1) + 'x';

  const volume = settings.speech_volume != null ? settings.speech_volume : 100;
  el('setting-speech-volume').value = volume;
  el('setting-speech-volume-val').textContent = volume;

  ensureVoiceOptions().then(() => applyVoiceSelection(settings.speech_voice));
}

// Speech Voice dropdown — populated once from the server's installed
// voice list (GET /api/voices, backed by pyttsx3). Cached: the set of
// installed voices doesn't change while the page stays open.
let _voiceOptionsPromise = null;
function ensureVoiceOptions() {
  if (!_voiceOptionsPromise) {
    _voiceOptionsPromise = fetch('/api/voices')
      .then(res => res.ok ? res.json() : { voices: [] })
      .then(data => {
        const sel = el('setting-speech-voice');
        if (!sel) return;
        (data.voices || []).forEach(v => {
          const opt = document.createElement('option');
          opt.value = v.name;
          opt.textContent = v.name;
          sel.appendChild(opt);
        });
      })
      .catch(() => { /* leave just "System Default" if this fails */ });
  }
  return _voiceOptionsPromise;
}

// Applies a saved voice name to the dropdown, falling back to "System
// Default" if that voice isn't in the currently installed list (e.g. it
// was saved on a different machine than the one running the server now).
function applyVoiceSelection(voiceName) {
  const sel = el('setting-speech-voice');
  if (!sel) return;
  sel.value = voiceName || '';
  if (sel.selectedIndex === -1) sel.selectedIndex = 0;
}

// Live-update the numeric readouts next to the sliders as they're dragged.
el('setting-speech-speed').addEventListener('input', e => {
  el('setting-speech-speed-val').textContent = Number(e.target.value).toFixed(1) + 'x';
});
el('setting-speech-volume').addEventListener('input', e => {
  el('setting-speech-volume-val').textContent = e.target.value;
});

// ── Settings accordion ────────────────────────────────────────────
const _SETTINGS_ACC_IDS = ['speech', 'camera', 'prefs'];

function toggleSettingsAcc(id) {
  _SETTINGS_ACC_IDS.forEach(i => {
    const body   = el('stt-body-' + i);
    const header = document.querySelector(`.stt-acc-header[data-stt-acc="${i}"]`);
    const nowOpen = i === id && !body.classList.contains('open');
    body.classList.toggle('open', nowOpen);
    if (header) header.classList.toggle('open', nowOpen);
  });
}

// Navigate to support page, keeping Settings highlighted in the nav.
function openSupportPage() {
  document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('active'));
  const panel = el('page-support');
  if (panel) panel.classList.add('active');
  const title = el('page-title');
  if (title) title.textContent = PAGE_TITLES['support'] || 'Customer Support';
}

// Navigate back to Settings from the Support page.
function backFromSupport() {
  document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('active'));
  const panel = el('page-settings');
  if (panel) panel.classList.add('active');
  const title = el('page-title');
  if (title) title.textContent = PAGE_TITLES['settings'] || 'Settings';
  document.querySelectorAll('.topbar-link[data-page]').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('.topbar-link[data-page="settings"]');
  if (btn) btn.classList.add('active');
}

function readSettingsForm() {
  return {
    speech_speed:        parseFloat(el('setting-speech-speed').value),
    speech_volume:       parseInt(el('setting-speech-volume').value, 10),
    speech_voice:        el('setting-speech-voice').value,
    camera_size:         el('setting-camera-size').value,
    show_analytics:      el('setting-show-analytics').checked,
    show_history_panel:  el('setting-show-history-panel').checked,
    show_landmarks:      el('setting-show-landmarks').checked,
  };
}

async function saveSettings() {
  const payload = readSettingsForm();
  const error   = validateSettingsPatch(payload);
  if (error) { showToast(error); return; }

  // Theme is device-local only (see setTheme() above) and never sent
  // to the backend - commit it here, at Save time, regardless of
  // whether the rest of the payload is server- or locally-backed.
  setTheme(pendingTheme);

  if (!currentUser || !currentUser.id) {
    currentSettings = LocalSettingsStore.save(payload);
    applySettingsToDashboard(currentSettings);
    showToast('Settings saved!');
    return;
  }

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Could not save settings.');
      return;
    }
    currentSettings = data.settings;
    applySettingsToDashboard(currentSettings);
    showToast('Settings saved!');
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

async function resetSettingsToDefault() {
  if (!confirm('Reset all settings to their default values?')) return;

  // Reset applies immediately (it's already a confirmed, saved action),
  // so the default theme takes effect right away - same rule as
  // Save Changes, just via a different entry point.
  setTheme(LocalSettingsStore.DEFAULTS.theme);

  if (!currentUser || !currentUser.id) {
    currentSettings = LocalSettingsStore.reset();
    renderSettingsForm(currentSettings);
    applySettingsToDashboard(currentSettings);
    showToast('Settings reset to default.');
    return;
  }

  try {
    const res = await fetch('/api/settings/reset', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Could not reset settings.');
      return;
    }
    currentSettings = data.settings;
    renderSettingsForm(currentSettings);
    applySettingsToDashboard(currentSettings);
    showToast('Settings reset to default.');
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

// Applies the settings that affect the Dashboard's own layout/behavior.
// Safe to call any time (page load, after save, after reset) - it only
// toggles CSS classes and visibility, never touches the camera/socket
// pipeline itself.
function applySettingsToDashboard(settings) {
  if (!settings) return;

  // Camera size -> adjusts the top-row grid split (see style.css).
  const topRow = document.querySelector('.top-row');
  if (topRow) {
    topRow.classList.remove('camera-small', 'camera-medium', 'camera-large');
    topRow.classList.add('camera-' + (settings.camera_size || 'medium'));
  }

  // Show/hide Dashboard cards without breaking their functionality -
  // the camera/socket loop keeps running and writing into these
  // elements either way, they're just hidden via CSS.
  const analyticsCard = document.querySelector('.analytics-card');
  if (analyticsCard) analyticsCard.style.display = settings.show_analytics === false ? 'none' : '';

  const historyCard = document.querySelector('.history-card');
  if (historyCard) historyCard.style.display = settings.show_history_panel === false ? 'none' : '';

  // Landmark overlay — emit to server so the camera loop skips draw_landmarks().
  // Speech speed/volume — emit so the actual TTS voice (SPEAK-gesture hold OR
  // manual Speak button) uses them, not just the History page's browser replay.
  // Only emits when the socket is already connected; connectSocket() re-emits
  // on every new connection so both settings survive camera stop/start cycles.
  if (socket && socket.connected) {
    socket.emit('set_landmarks', { visible: settings.show_landmarks !== false });
    socket.emit('set_speech', {
      speed:  parseFloat(settings.speech_speed) || 1.0,
      volume: parseInt(settings.speech_volume, 10) ?? 100,
      voice:  settings.speech_voice || '',
    });
  }
}

// Load settings once at startup too, so Camera Size / show-hide
// preferences are already applied the moment the Dashboard renders -
// not just after a visit to the Settings page.
loadSettings();

// ── Local History Storage (temporary persistence layer) ─────────────
// Guest sessions have no logged-in user_id, so the backend never
// writes their spoken sentences to the database (see server.py
// speak_text(), which only calls save_sentence() when active_user_id
// is set). This module fills that gap with a browser-side store so
// guest history survives refreshes/reopens.
//
// It exposes the same four operations a database-backed store would
// (save/getAll/remove/clear) and is the only place that touches
// localStorage. Swapping this for a real API/database later only
// means rewriting the inside of these functions - every caller below
// (loadSentenceHistory, addToHistory, deleteGuestItem, clearHistory)
// already talks to it through this interface.
const LocalHistoryStore = (() => {
  const STORAGE_KEY = 'handtalk_guest_history';

  function readAll() {
    try {
      const list = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function writeAll(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      // Storage unavailable/full (e.g. private browsing) - history
      // simply won't survive a reload in that case.
    }
  }

  function makeId() {
    return (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  return {
    save(sentence) {
      const entry = {
        id: makeId(),
        sentence,
        created_at: new Date().toISOString(),
        session_id: null,
        is_favorited: false,
      };
      const list = readAll();
      list.unshift(entry);
      writeAll(list);
      return entry;
    },
    getAll(search) {
      const q = (search || '').trim().toLowerCase();
      const list = readAll();
      return q ? list.filter(item => item.sentence.toLowerCase().includes(q)) : list;
    },
    remove(id) {
      writeAll(readAll().filter(item => item.id !== id));
    },
    clear() {
      writeAll([]);
    },
  };
})();

// ── Sentence History (real, MySQL-backed) ──────────────────────────
let historySentences = [];
let _localHistoryId = 0;

async function loadSentenceHistory(search) {
  // Guest mode: no user_id means nothing is saved to the database.
  // Load from the local (browser storage) history instead.
  if (!currentUser || !currentUser.id) {
    historySentences = LocalHistoryStore.getAll(search).map(item => ({
      id: null,
      localId: item.id,
      sentence: item.sentence,
      created_at: item.created_at,
      session_id: item.session_id,
      is_favorited: item.is_favorited,
    }));
    renderSentenceHistory();
    return;
  }

  try {
    const qs  = search ? `?search=${encodeURIComponent(search)}` : '';
    const res = await fetch('/api/sentences' + qs);
    if (!res.ok) {
      showToast('Could not load history.');
      return;
    }
    const data = await res.json();
    historySentences = data.sentences || [];
    renderSentenceHistory();
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

function searchSentenceHistory() {
  loadSentenceHistory(el('history-search-input').value.trim());
}

// Live search — instant for guest (local storage), debounced for logged-in (API).
let _histSearchTimer = null;
function searchSentenceHistoryLive(query) {
  clearTimeout(_histSearchTimer);
  if (!currentUser || !currentUser.id) {
    loadSentenceHistory(query);
  } else {
    _histSearchTimer = setTimeout(() => loadSentenceHistory(query), 300);
  }
}

function renderSentenceHistory() {
  const tbody = el('history-table-body');
  const empty = el('history-page-empty');
  tbody.innerHTML = '';

  if (!historySentences.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  historySentences.forEach(row => {
    const tr = document.createElement('tr');
    const dt = new Date(row.created_at);
    const dateStr = isNaN(dt) ? '—' : dt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

    const deleteCall = row.id != null
      ? `deleteSentenceRow(${row.id})`
      : `deleteGuestItem('${row.localId}')`;
    tr.innerHTML = `
      <td class="hx-sentence">${escapeHtml(row.sentence)}</td>
      <td class="hx-date">${dateStr}</td>
      <td class="hx-actions">
        <button class="hx-icon-btn hx-icon-btn-speak" title="Speak" onclick="speakSentenceRow('${escapeAttr(row.sentence)}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
        </button>
        <button class="hx-icon-btn hx-icon-btn-del" title="Delete" onclick="${deleteCall}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </td>`;
    tbody.appendChild(tr);
  });
}

function deleteGuestItem(localId) {
  LocalHistoryStore.remove(localId);
  loadSentenceHistory();
  showToast('Deleted.');
}

function copySentenceRow(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Copied!'))
      .catch(() => _clipboardFallback(text));
  } else {
    _clipboardFallback(text);
  }
}

function _clipboardFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    showToast('Copied!');
  } catch {
    showToast('Copy failed — please copy manually.');
  }
  document.body.removeChild(ta);
}

// The Settings page's Speech Voice list comes from the server's pyttsx3
// enumeration (e.g. "Microsoft David Desktop - English (United States)"),
// but the browser's own speechSynthesis voices are a completely separate
// namespace with their own naming (e.g. "Microsoft David - English
// (United States)", no "Desktop"). Exact names rarely line up, so match
// on the proper-name token (e.g. "David"/"Zira") instead - good enough
// since these are the same underlying Microsoft SAPI voices on Windows.
// Returns null (browser's own default voice) if nothing matches.
function findMatchingBrowserVoice(voiceName) {
  if (!voiceName || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const exact = voices.find(v => v.name === voiceName);
  if (exact) return exact;

  const core = voiceName.replace(/^Microsoft\s+/i, '').split(/\s+/)[0];
  if (!core) return null;
  return voices.find(v => v.name.toLowerCase().includes(core.toLowerCase())) || null;
}

// Chrome (and others) populate speechSynthesis.getVoices() asynchronously:
// right after page load it returns [] until the 'voiceschanged' event fires,
// which is why the very first speak-back used the browser's default (Male)
// voice instead of the saved one, and only the second call (once voices were
// cached) matched correctly. This promise resolves once voices are actually
// available, and is created eagerly at script load so it's ready well before
// the user clicks a Speak button.
function loadVoicesReady() {
  if (!('speechSynthesis' in window)) return Promise.resolve([]);
  const existing = window.speechSynthesis.getVoices();
  if (existing.length) return Promise.resolve(existing);
  return new Promise(resolve => {
    const onVoicesChanged = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        resolve(voices);
      }
    };
    window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
    // Some browsers never fire voiceschanged if voices were already
    // available by the time the listener attached; re-check shortly after.
    setTimeout(() => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length) {
        window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
        resolve(voices);
      }
    }, 250);
  });
}

const voicesReadyPromise = loadVoicesReady();

async function speakSentenceRow(text) {
  // Plays back through the browser's own text-to-speech, independent of
  // the live AI/socket pipeline - works even if the camera isn't running,
  // and intentionally does NOT create a new history row (it's a replay,
  // not a newly spoken sentence). Speech speed, volume, and voice come
  // from settings (voice is best-effort matched - see
  // findMatchingBrowserVoice() above).
  if (!('speechSynthesis' in window)) {
    showToast('Speech playback not supported in this browser.');
    return;
  }
  await voicesReadyPromise;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  if (currentSettings) {
    utter.rate   = parseFloat(currentSettings.speech_speed)  || 1.0;
    utter.volume = (parseInt(currentSettings.speech_volume, 10) ?? 100) / 100;
    const voice = findMatchingBrowserVoice(currentSettings.speech_voice);
    if (voice) utter.voice = voice;
  }
  window.speechSynthesis.speak(utter);
}

async function deleteSentenceRow(id) {
  if (!confirm('Delete this sentence from your history?')) return;
  try {
    const res = await fetch('/api/sentences/' + id, { method: 'DELETE' });
    if (!res.ok) {
      showToast('Could not delete that sentence.');
      return;
    }
    historySentences = historySentences.filter(r => r.id !== id);
    renderSentenceHistory();
    showToast('Deleted.');
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

async function toggleFavorite(sentenceId) {
  const row = historySentences.find(r => r.id === sentenceId);
  if (!row) return;
  const wasFavorited = !!row.is_favorited;
  try {
    const res = await fetch('/api/favorites/' + sentenceId, {
      method: wasFavorited ? 'DELETE' : 'POST',
    });
    if (!res.ok) {
      showToast('Could not update favorites.');
      return;
    }
    row.is_favorited = wasFavorited ? 0 : 1;
    renderSentenceHistory();
    showToast(wasFavorited ? 'Removed from favorites' : 'Added to favorites');
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

// ── Favorites (real, MySQL-backed) ─────────────────────────────────
let favoriteSentences = [];

async function loadFavorites() {
  try {
    const res = await fetch('/api/favorites');
    if (!res.ok) {
      showToast('Could not load favorites.');
      return;
    }
    const data = await res.json();
    favoriteSentences = data.favorites || [];
    renderFavorites();
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

function renderFavorites() {
  const tbody = el('favorites-table-body');
  const empty = el('favorites-page-empty');
  tbody.innerHTML = '';

  if (!favoriteSentences.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  favoriteSentences.forEach(row => {
    const tr = document.createElement('tr');
    const dt = new Date(row.created_at);
    const dateStr = isNaN(dt) ? '—' : dt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

    tr.innerHTML = `
      <td class="hx-sentence">${escapeHtml(row.sentence)}</td>
      <td class="hx-date">${dateStr}</td>
      <td class="hx-session">${row.session_id ?? '—'}</td>
      <td class="hx-actions">
        <button class="hx-icon-btn" title="Speak" onclick="speakSentenceRow('${escapeAttr(row.sentence)}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
        </button>
        <button class="hx-icon-btn hx-icon-btn-fav active" title="Remove from favorites" onclick="removeFavoriteRow(${row.sentence_id})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>
      </td>`;
    tbody.appendChild(tr);
  });
}

async function removeFavoriteRow(sentenceId) {
  try {
    const res = await fetch('/api/favorites/' + sentenceId, { method: 'DELETE' });
    if (!res.ok) {
      showToast('Could not remove favorite.');
      return;
    }
    favoriteSentences = favoriteSentences.filter(r => r.sentence_id !== sentenceId);
    renderFavorites();
    showToast('Removed from favorites');
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

// ── Session timer ─────────────────────────────────────────────────
function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

let _sessionTimerInterval = null;

function startSessionTimer() {
  clearInterval(_sessionTimerInterval);
  state.sessionStart = Date.now();
  el('session-time').textContent = 'Session: 00:00:00';
  _sessionTimerInterval = setInterval(() => {
    el('session-time').textContent =
      `Session: ${formatTime(Date.now() - state.sessionStart)}`;
  }, 1000);
}

function stopSessionTimer() {
  clearInterval(_sessionTimerInterval);
  _sessionTimerInterval = null;
  state.sessionStart    = null;
  el('session-time').textContent = 'Session: 00:00:00';
}

// ── Camera controls ───────────────────────────────────────────────
const CAM_LOADING_MESSAGES = [
  'Starting camera…',
  'Initializing MediaPipe…',
  'Preparing gesture recognition…',
  'Almost ready…',
];
let _camLoadingInterval = null;

function showCamLoading() {
  hideCamError();
  const overlay = el('cam-loading-overlay');
  const text    = el('cam-loading-text');
  overlay.classList.remove('fade-out');
  overlay.classList.add('show');

  let i = 0;
  text.textContent = CAM_LOADING_MESSAGES[0];
  clearInterval(_camLoadingInterval);
  _camLoadingInterval = setInterval(() => {
    i = Math.min(i + 1, CAM_LOADING_MESSAGES.length - 1);
    text.textContent = CAM_LOADING_MESSAGES[i];
  }, 1500);
}

function hideCamLoading() {
  clearInterval(_camLoadingInterval);
  _camLoadingInterval = null;
  const overlay = el('cam-loading-overlay');
  overlay.classList.add('fade-out');
  setTimeout(() => overlay.classList.remove('show', 'fade-out'), 300);
}

function showCamError() {
  clearInterval(_camLoadingInterval);
  _camLoadingInterval = null;
  el('cam-loading-overlay').classList.remove('show', 'fade-out');
  el('cam-error-overlay').classList.add('show');
}

function hideCamError() {
  el('cam-error-overlay').classList.remove('show');
  const errorText = document.querySelector('#cam-error-overlay .cam-error-text');
  if (errorText) errorText.textContent = 'Unable to access the camera. Please check your permissions and try again.';
}

function retryCamera() {
  if (state.running || browserCameraStream) stopCamera();
  hideCamError();
  startCamera();
}

async function startCamera() {
  if (state.running) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError('This browser cannot access the camera. Use HTTPS.');
    return;
  }

  showCamLoading();
  try {
    browserCameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    });

    browserCameraVideo = document.createElement('video');
    browserCameraVideo.autoplay = true;
    browserCameraVideo.muted = true;
    browserCameraVideo.playsInline = true;
    browserCameraVideo.srcObject = browserCameraStream;
    await browserCameraVideo.play();

    browserCameraCanvas = document.createElement('canvas');
    browserCameraCanvas.width = 480; 
    browserCameraCanvas.height = 360;

    window.landmarkCanvas = document.createElement('canvas');
    window.landmarkCanvas.style.position = 'absolute';
    window.landmarkCanvas.style.top = '0';
    window.landmarkCanvas.style.left = '0';
    window.landmarkCanvas.style.width = '100%';
    window.landmarkCanvas.style.height = '100%';
    window.landmarkCanvas.style.pointerEvents = 'none';
    window.landmarkCanvas.style.transform = 'scaleX(-1)';

    state.running = true;
    startSessionTimer();
    showToast('Camera ready. Connecting to AI backend…');
    connectSocket();
  } catch (error) {
    stopBrowserCamera();
    showCameraError('Unable to start the camera.');
  }
}

function showCameraError(message) {
  const errorText = document.querySelector('#cam-error-overlay .cam-error-text');
  if (errorText && message) errorText.textContent = message;
  showCamError();
}

function startBrowserFramePump() {
  stopBrowserFramePump();
  if (!browserCameraVideo || !browserCameraCanvas || !socket?.connected) return;
  const context = browserCameraCanvas.getContext('2d', { alpha: false });
  
  browserFrameTimer = setInterval(() => {
    if (!state.running || !socket?.connected || browserFrameBusy) return;
    if (browserCameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    browserFrameBusy = true;
    try {
      context.drawImage(browserCameraVideo, 0, 0, browserCameraCanvas.width, browserCameraCanvas.height);
      const jpeg = browserCameraCanvas.toDataURL('image/jpeg', 0.6).split(',')[1];
      socket.emit('process_frame', { image: jpeg }, () => {
        browserFrameBusy = false;
      });
    } catch (error) {
      browserFrameBusy = false;
      console.error('[camera] Frame capture failed:', error);
    }
  }, 150); 
}

function stopBrowserFramePump() {
  if (browserFrameTimer) clearInterval(browserFrameTimer);
  browserFrameTimer = null;
  browserFrameBusy = false;
}

function stopBrowserCamera() {
  stopBrowserFramePump();
  if (browserCameraStream) {
    browserCameraStream.getTracks().forEach(track => track.stop());
  }
  browserCameraStream = null;
  if (browserCameraVideo) {
    browserCameraVideo.pause();
    browserCameraVideo.srcObject = null;
    if (browserCameraVideo.parentNode) browserCameraVideo.parentNode.removeChild(browserCameraVideo);
  }
  browserCameraVideo = null;
  browserCameraCanvas = null;
  
  if (window.landmarkCanvas && window.landmarkCanvas.parentNode) {
    window.landmarkCanvas.parentNode.removeChild(window.landmarkCanvas);
    window.landmarkCanvas = null;
  }
}

// Release the visitor's webcam if they navigate away or close the tab.
window.addEventListener('pagehide', stopBrowserCamera);

function stopCamera() {
  state.running = false;
  stopSessionTimer();
  stopBrowserCamera();
  el('camera-feed').classList.remove('active');
  el('camera-img').src = '';
  setStatus(false);
  updateGesture('—', 0, []);
  const fpsBadge = el('fps-badge-inline');
  if (fpsBadge) fpsBadge.textContent = '0 fps';
  hideCamLoading();
  hideCamError();
  disconnectSocket();
}

// Fully tears down the current socket: disconnects it, strips its event
// listeners, and clears the module-level reference. Used both when
// stopping a session and defensively before opening a new one, so a
// stale connection can never keep pushing frame/analytics updates after
// the session has stopped.
function disconnectSocket() {
  if (!socket) return;
  socket.off();
  socket.disconnect();
  socket = null;
}

function setStatus(online) {
  const pill = el('status-pill');
  const txt  = el('status-text');
  if (!pill || !txt) return;
  if (online) {
    pill.classList.remove('offline');
    txt.textContent = 'Live';
  } else {
    pill.classList.add('offline');
    txt.textContent = 'Offline';
  }
}

// ── Gesture updates ───────────────────────────────────────────────
// Called by WebSocket handler in Phase 2, or manually for testing
function updateGesture(letter, confidence, topK, mode) {
  state.currentGesture = letter;
  state.confidence     = confidence;

  // Big letter display
  el('gesture-letter').textContent = letter || '—';
  el('gesture-name').textContent   =
    !letter || letter === '—' ? 'No gesture detected'
    : letter === 'SPACE'      ? 'Space (word break)'
    : letter === 'SPEAK'      ? 'Speak gesture — hold!'
    : `Letter ${letter}`;

  // Confidence bar
  const pct  = Math.round(confidence * 100);
  const fill = el('conf-fill');
  fill.style.width = pct + '%';
  fill.className   = 'conf-bar-fill' +
    (pct >= 80 ? '' : pct >= 60 ? ' mid' : ' low');
  el('conf-val').textContent = pct + '%';

  // Top-K predictions
  const rows  = el('pred-list').querySelectorAll('.pred-row');
  const preds = topK || [];
  rows.forEach((row, i) => {
    const p   = preds[i] || { label: '—', confidence: 0 };
    const pct = Math.round(p.confidence * 100);
    row.querySelector('.pred-letter').textContent          = p.label;
    row.querySelector('.pred-bar-fill').style.width        = pct + '%';
    row.querySelector('.pred-pct').textContent             = pct + '%';
  });

  // Mode badge
  if (mode) {
    const modeBadge = el('mode-badge');
    if (modeBadge) modeBadge.textContent = mode;
    state.mode = mode;
  }
}

// ── Sentence builder ──────────────────────────────────────────────
// The sentence itself is built server-side (main.py's WordBuilder,
// mirrored in server.py) - each 'frame' event just carries the current
// full sentence string, not individual letter events.
function updateSentence(text, speakProgress) {
  text = text || '';

  state.sentence = text;
  el('sentence-text').textContent     = text;
  el('controls-sentence').textContent = text || '—';
  el('char-count').textContent        = text.length + ' / 500';

  // Speak progress bar
  const pct = Math.round((speakProgress || 0) * 100);
  el('speak-fill').style.width = pct + '%';
  el('speak-label').textContent = pct > 0
    ? `Releasing in ${(((1 - speakProgress) * 1.5)).toFixed(1)}s…`
    : 'Hold thumbs up to speak';
}

function speakSentence() {
  const text = state.sentence.trim();
  if (!text) { showToast('Nothing to speak yet'); return; }

  if (socket && socket.connected) {
    // Let Python actually speak it; UI updates when 'spoken' comes back.
    socket.emit('speak', { text });
    clearSentence();
  } else {
    // Offline / not connected yet — local-only fallback for UI testing.
    addToHistory(text);
    showToast(`Speaking: "${text}"`);
    flashSpeaking();
    clearSentence();
  }
}

function clearSentence() {
  state.sentence = '';
  updateSentence('', 0);
  // Also clear the server-side WordBuilder - otherwise the next 'frame'
  // event (still arriving while the camera is running) would overwrite
  // this with the old, un-cleared sentence.
  if (socket && socket.connected) socket.emit('clear_sentence');
}

function flashSpeaking() {
  const card = el('sentence-card');
  if (!card) return;
  card.classList.add('speaking');
  setTimeout(() => card.classList.remove('speaking'), 800);
}

// ── History ───────────────────────────────────────────────────────
function addToHistory(text) {
  const time = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit'
  });
  const ts = new Date().toISOString();
  state.history.unshift({ text, time, ts, localId: ++_localHistoryId });
  renderHistory();

  // Guest mode: the backend has no user_id to save this sentence
  // against, so persist the confirmed translation locally instead.
  if (!currentUser || !currentUser.id) {
    LocalHistoryStore.save(text);
    const hp = el('page-history');
    if (hp && hp.classList.contains('active')) {
      loadSentenceHistory();
    }
  }
}

function renderHistory() {
  const body  = el('history-body');
  const empty = el('history-empty');

  if (!state.history.length) {
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  body.innerHTML      = '';
  body.appendChild(empty);

  state.history.slice(0, 10).forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'history-item' + (i === 0 ? ' new' : '');
    div.innerHTML = `
      <span class="history-text">${escapeHtml(item.text)}</span>
      <span class="history-meta">${item.time}</span>`;
    body.appendChild(div);
  });
}

function clearHistory() {
  state.history = [];
  renderHistory();

  if (!currentUser || !currentUser.id) {
    LocalHistoryStore.clear();
    const hp = el('page-history');
    if (hp && hp.classList.contains('active')) {
      loadSentenceHistory();
    }
  }
  showToast('History cleared');
}

function copyText(text) {
  copySentenceRow(text);
}

// ── Export ────────────────────────────────────────────────────────
function exportHistory() {
  if (!state.history.length) {
    showToast('No history to export');
    return;
  }
  const lines = state.history
    .map(h => `[${h.time}] ${h.text}`)
    .join('\n');
  const blob = new Blob([lines], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `asl-history-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported!');
}

// ── Helpers ───────────────────────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'");
}

// ── Keyboard shortcuts ────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Enter')                 speakSentence();
  if (e.key === 'Backspace' && e.ctrlKey) clearSentence();
  if (e.key === 'Escape') {
    if (el('dictv-preview-overlay')?.classList.contains('show')) {
      closeDictPreview();
    } else {
      stopCamera();
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// PHASE 2 — WebSocket connection (Flask-SocketIO)
// Connects to server.py, which bridges the Python AI pipeline.
// ─────────────────────────────────────────────────────────────────
// (`socket` itself is declared near the top of the file - see the
// comment there for why.)

function connectSocket() {
  // Tear down any previous connection first - guards against ever having
  // two live sockets (and therefore two servers pushing frame/analytics
  // updates) at once.
  disconnectSocket();

  // Requires socket.io client script in index.html, e.g.:
  // <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
  // Connect back to whichever host this page was loaded from (localhost,
  // 127.0.0.1, or a LAN IP) - not a hardcoded address. Hardcoding a
  // different host than the page itself breaks session cookies, since
  // browsers treat different hostnames as different origins even on the
  // same machine.
  socket = io(window.location.origin);

  socket.on('connect', () => {
    setStatus(true);
    showToast('Connected to AI backend');
    startBrowserFramePump();
    // Re-apply landmark preference; server resets to show_landmarks=True on
    // each GestureStreamer.start(), so we must re-send the saved preference.
    if (currentSettings && currentSettings.show_landmarks === false) {
      socket.emit('set_landmarks', { visible: false });
    }
    // Re-apply speech speed/volume/voice too — SpeechOutput defaults to
    // 1.0x/100/system-default until told otherwise, and a fresh server
    // process (or a streamer that hadn't been created yet) won't already
    // know a saved preference.
    if (currentSettings && (currentSettings.speech_speed !== 1.0 || currentSettings.speech_volume !== 100 || currentSettings.speech_voice)) {
      socket.emit('set_speech', {
        speed:  parseFloat(currentSettings.speech_speed) || 1.0,
        volume: parseInt(currentSettings.speech_volume, 10) ?? 100,
        voice:  currentSettings.speech_voice || '',
      });
    }
  });

  socket.on('disconnect', () => {
    setStatus(false);
    stopBrowserFramePump();
    if (state.running) showCameraError('Connection to the AI backend was lost. Check your connection and retry.');
    showToast('Disconnected');
  });

  socket.on('connect_error', () => {
    stopBrowserFramePump();
    if (state.running) {
      state.running = false;
      stopSessionTimer();
      stopBrowserCamera();
      disconnectSocket();
      showCameraError('Could not connect to the AI backend. Check your internet connection and retry.');
    }
  });

  socket.on('server_error', (data) => {
    showToast(`AI processing error: ${data.message || 'unknown error'}`, 4000);
  });

    // ── LIVE FRAME DATA ──
      socket.on('frame', (data) => {
    if (!state.running) return;

    if (!el('camera-feed').classList.contains('active')) {
      hideCamLoading();
      el('camera-feed').classList.add('active');
      el('camera-img').style.display = 'none';
    }
    
    if (browserCameraVideo && !browserCameraVideo.parentNode) {
      browserCameraVideo.style.width = '100%';
      browserCameraVideo.style.height = '100%';
      browserCameraVideo.style.objectFit = 'cover';
      browserCameraVideo.style.transform = 'scaleX(-1)'; 
      el('camera-feed').appendChild(browserCameraVideo);
      
      if (window.landmarkCanvas) {
          window.landmarkCanvas.width = el('camera-feed').clientWidth;
          window.landmarkCanvas.height = el('camera-feed').clientHeight;
          el('camera-feed').appendChild(window.landmarkCanvas);
      }
    }

    // Ensure canvas dimensions match the container perfectly on every frame
    if (window.landmarkCanvas) {
        window.landmarkCanvas.width = el('camera-feed').clientWidth;
        window.landmarkCanvas.height = el('camera-feed').clientHeight;
    }

    // --- DRAW THE LANDMARKS ---
    if (window.landmarkCanvas && data.landmarks && data.landmarks.length > 0) {
      const ctx = window.landmarkCanvas.getContext('2d');
      const w = window.landmarkCanvas.width;
      const h = window.landmarkCanvas.height;
      ctx.clearRect(0, 0, w, h);

      const connections = [
        [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
        [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]
      ];

      ctx.strokeStyle = '#d3d3d3'; 
      ctx.lineWidth = 3;
      connections.forEach(([i, j]) => {
        if (data.landmarks[i] && data.landmarks[j]) {
          ctx.beginPath();
          ctx.moveTo(data.landmarks[i].x * w, data.landmarks[i].y * h);
          ctx.lineTo(data.landmarks[j].x * w, data.landmarks[j].y * h);
          ctx.stroke();
        }
      });

      ctx.fillStyle = '#ffffff';
      data.landmarks.forEach(pt => {
        ctx.beginPath();
        ctx.arc(pt.x * w, pt.y * h, 4, 0, 2 * Math.PI);
        ctx.fill();
      });
    } else if (window.landmarkCanvas) {
      window.landmarkCanvas.getContext('2d').clearRect(0, 0, window.landmarkCanvas.width, window.landmarkCanvas.height);
    }

    const fpsBadge = el('fps-badge-inline');
    if (fpsBadge) fpsBadge.textContent = (data.fps || 0).toFixed(0) + ' fps';

    updateGesture(data.gesture, data.confidence, data.top_k, data.mode);
    updateSentence(data.sentence, data.speak_progress);
  });

    socket.on('spoken', (data) => {
    addToHistory(data.text);
    showToast(`Spoke: "${data.text}"`);
    flashSpeaking();

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(data.text);
      if (currentSettings) {
        utter.rate = parseFloat(currentSettings.speech_speed) || 1.0;
        utter.volume = (parseInt(currentSettings.speech_volume, 10) ?? 100) / 100;
        const voice = findMatchingBrowserVoice(currentSettings.speech_voice);
        if (voice) utter.voice = voice;
      }
      window.speechSynthesis.speak(utter);
    }
  });

// ─────────────────────────────────────────────────────────────────
// DICTIONARY PAGE
// ─────────────────────────────────────────────────────────────────
const DICT_CATEGORIES = {
  alpha:   { name: 'ALPHABETS',    catLabel: 'Alphabets',    items: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
  numbers: { name: 'NUMBERS',      catLabel: 'Numbers',      items: ['0','1','2','3','4','5','6','7','8','9'] },
  words:   { name: 'COMMON WORDS', catLabel: 'Common Words', items: ['Yes','No','What','Why','How','Where','Thank You'] },
  space:   { name: 'SPACE',        catLabel: 'Space',        items: ['Space'] },
  speak:   { name: 'SPEAK',        catLabel: 'Speak',        items: ['Speak (Thumbs Up)'] },
  delete:  { name: 'DELETE',       catLabel: 'Delete',       items: ['Delete'] },
};

// Flat list used for global search across all categories
const _DICT_ALL_ITEMS = Object.entries(DICT_CATEGORIES).flatMap(([id, cat]) =>
  cat.items.map(item => ({ id, name: item, catLabel: cat.catLabel }))
);

let _dictCatSearchVisible = false;

function openDictCat(id) {
  const cat = DICT_CATEGORIES[id];
  if (!cat) return;

  // Update title bar
  el('dictv-cat-title-bar').textContent = cat.name;

  // Render list items
  const wrap = el('dictv-list-wrap');
  wrap.innerHTML = '';
  cat.items.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'dictv-list-item';
    div.dataset.name = item.toLowerCase();
    div.innerHTML = `
      <span class="dictv-list-name">${escapeHtml(item)}</span>
      <button class="dictv-play-btn" title="View gesture" onclick="event.stopPropagation(); openDictPreview('${id}', ${idx})">
        <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor"><polygon points="0,0 10,6 0,12"/></svg>
      </button>`;
    wrap.appendChild(div);
  });

  // Reset inline search
  _dictCatSearchVisible = false;
  el('dictv-cat-search-bar').classList.remove('visible');
  el('dictv-cat-search-btn').classList.remove('open');
  el('dictv-cat-search').value = '';

  // Transition: hide main, animate category view in
  el('dictv-main').style.display = 'none';
  el('dictv-cat').classList.remove('dict-in');
  void el('dictv-cat').offsetWidth; // force reflow so animation re-fires
  el('dictv-cat').classList.add('dict-in');
}

function closeDictCat() {
  el('dictv-cat').classList.remove('dict-in');
  el('dictv-main').style.display = '';
}

function dictToggleCatSearch() {
  _dictCatSearchVisible = !_dictCatSearchVisible;
  const bar = el('dictv-cat-search-bar');
  const btn = el('dictv-cat-search-btn');
  bar.classList.toggle('visible', _dictCatSearchVisible);
  btn.classList.toggle('open', _dictCatSearchVisible);
  btn.setAttribute('aria-label', _dictCatSearchVisible ? 'Close search' : 'Search');
  if (_dictCatSearchVisible) {
    el('dictv-cat-search').focus();
  } else {
    el('dictv-cat-search').value = '';
    dictCatSearch('');
  }
}

// Called by switchPage when navigating to dictionary — resets to main view
function resetDictView() {
  el('dictv-cat').classList.remove('dict-in');
  el('dictv-main').style.display = '';
  const inp = el('dictv-search');
  if (inp && inp.value) { inp.value = ''; dictMainSearch(''); }
}

function dictCatSearch(query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll('#dictv-list-wrap .dictv-list-item').forEach(item => {
    item.classList.toggle('hidden', !!q && !item.dataset.name.includes(q));
  });
}

function dictMainSearch(query) {
  const q = query.trim().toLowerCase();
  const gridSection    = el('dictv-grid-section');
  const resultsSection = el('dictv-results-section');
  const resultsList    = el('dictv-results-list');
  if (!q) {
    gridSection.style.display = '';
    resultsSection.style.display = 'none';
    return;
  }
  gridSection.style.display = 'none';
  resultsSection.style.display = '';
  const matches = _DICT_ALL_ITEMS.filter(i => i.name.toLowerCase().includes(q));
  if (!matches.length) {
    resultsList.innerHTML = `<div class="dictv-no-result">No gestures found for "<strong>${escapeHtml(q)}</strong>"</div>`;
    return;
  }
  resultsList.innerHTML = matches.map(i => `
    <div class="dictv-result-item" onclick="openDictCat('${i.id}')">
      <div>
        <div class="dictv-result-name">${escapeHtml(i.name)}</div>
        <div class="dictv-result-cat">${escapeHtml(i.catLabel)}</div>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B09480" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </div>`).join('');
}

// ─────────────────────────────────────────────────────────────────
// DICTIONARY — Sign Preview Modal
// Keyed by "<categoryId>:<itemName>" → { type: 'image'|'video', src }.
// Currently points at generated placeholder cards in
// dashboard/uploads/signs/ (not real ASL reference images). Swap any
// entry's src for a real photo, or change type to 'video', and
// renderDictPreview() picks it up automatically — no UI changes needed.
// ─────────────────────────────────────────────────────────────────
const DICT_MEDIA = {
  'alpha:A': { type: 'image', src: '/uploads/signs/sign_a.svg' },
  'alpha:B': { type: 'image', src: '/uploads/signs/sign_b.svg' },
  'alpha:C': { type: 'image', src: '/uploads/signs/sign_c.svg' },
  'alpha:D': { type: 'image', src: '/uploads/signs/sign_d.svg' },
  'alpha:E': { type: 'image', src: '/uploads/signs/sign_e.svg' },
  'alpha:F': { type: 'image', src: '/uploads/signs/sign_f.svg' },
  'alpha:G': { type: 'image', src: '/uploads/signs/sign_g.svg' },
  'alpha:H': { type: 'image', src: '/uploads/signs/sign_h.svg' },
  'alpha:I': { type: 'image', src: '/uploads/signs/sign_i.svg' },
  'alpha:J': { type: 'image', src: '/uploads/signs/sign_j.svg' },
  'alpha:K': { type: 'image', src: '/uploads/signs/sign_k.svg' },
  'alpha:L': { type: 'image', src: '/uploads/signs/sign_l.svg' },
  'alpha:M': { type: 'image', src: '/uploads/signs/sign_m.svg' },
  'alpha:N': { type: 'image', src: '/uploads/signs/sign_n.svg' },
  'alpha:O': { type: 'image', src: '/uploads/signs/sign_o.svg' },
  'alpha:P': { type: 'image', src: '/uploads/signs/sign_p.svg' },
  'alpha:Q': { type: 'image', src: '/uploads/signs/sign_q.svg' },
  'alpha:R': { type: 'image', src: '/uploads/signs/sign_r.svg' },
  'alpha:S': { type: 'image', src: '/uploads/signs/sign_s.svg' },
  'alpha:T': { type: 'image', src: '/uploads/signs/sign_t.svg' },
  'alpha:U': { type: 'image', src: '/uploads/signs/sign_u.svg' },
  'alpha:V': { type: 'image', src: '/uploads/signs/sign_v.svg' },
  'alpha:W': { type: 'image', src: '/uploads/signs/sign_w.svg' },
  'alpha:X': { type: 'image', src: '/uploads/signs/sign_x.svg' },
  'alpha:Y': { type: 'image', src: '/uploads/signs/sign_y.svg' },
  'alpha:Z': { type: 'image', src: '/uploads/signs/sign_z.svg' },
  'numbers:0': { type: 'image', src: '/uploads/signs/numbers_0.svg' },
  'numbers:1': { type: 'image', src: '/uploads/signs/numbers_1.svg' },
  'numbers:2': { type: 'image', src: '/uploads/signs/numbers_2.svg' },
  'numbers:3': { type: 'image', src: '/uploads/signs/numbers_3.svg' },
  'numbers:4': { type: 'image', src: '/uploads/signs/numbers_4.svg' },
  'numbers:5': { type: 'image', src: '/uploads/signs/numbers_5.svg' },
  'numbers:6': { type: 'image', src: '/uploads/signs/numbers_6.svg' },
  'numbers:7': { type: 'image', src: '/uploads/signs/numbers_7.svg' },
  'numbers:8': { type: 'image', src: '/uploads/signs/numbers_8.svg' },
  'numbers:9': { type: 'image', src: '/uploads/signs/numbers_9.svg' },
  'words:Yes': { type: 'image', src: '/uploads/signs/words_yes.svg' },
  'words:No': { type: 'image', src: '/uploads/signs/words_no.svg' },
  'words:What': { type: 'image', src: '/uploads/signs/words_what.svg' },
  'words:Why': { type: 'image', src: '/uploads/signs/words_why.svg' },
  'words:How': { type: 'image', src: '/uploads/signs/words_how.svg' },
  'words:Where': { type: 'image', src: '/uploads/signs/words_where.svg' },
  'words:Thank You': { type: 'image', src: '/uploads/signs/words_thank_you.svg' },
  'space:Space': { type: 'image', src: '/uploads/signs/space_space.svg' },
  'speak:Speak (Thumbs Up)': { type: 'image', src: '/uploads/signs/speak_speak_thumbs_up.svg' },
  'delete:Delete': { type: 'image', src: '/uploads/signs/delete_delete.svg' },
};

let _dictPreviewCat = null;
let _dictPreviewIndex = 0;

function openDictPreview(catId, index) {
  _dictPreviewCat = catId;
  _dictPreviewIndex = index;
  renderDictPreview();
  el('dictv-preview-overlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeDictPreview() {
  el('dictv-preview-overlay').classList.remove('show');
  document.body.style.overflow = '';
  const vid = el('dictv-preview-media').querySelector('video');
  if (vid) vid.pause();
}

function dictPreviewNav(dir) {
  const items = DICT_CATEGORIES[_dictPreviewCat].items;
  const next = _dictPreviewIndex + dir;
  if (next < 0 || next >= items.length) return;
  _dictPreviewIndex = next;
  renderDictPreview();
}

function renderDictPreview() {
  const cat  = DICT_CATEGORIES[_dictPreviewCat];
  const item = cat.items[_dictPreviewIndex];
  const media = DICT_MEDIA[`${_dictPreviewCat}:${item}`];
  const mediaWrap = el('dictv-preview-media');

  el('dictv-preview-title').textContent   = item;
  el('dictv-preview-current').textContent = item;

  if (media && media.type === 'video') {
    mediaWrap.innerHTML = `<video class="dictv-preview-video" src="${media.src}" autoplay loop muted playsinline></video>`;
  } else if (media && media.type === 'image') {
    mediaWrap.innerHTML = `<img class="dictv-preview-image" src="${media.src}" alt="${escapeHtml(item)} sign">`;
  } else {
    const textMode = item.length > 2 ? ' dictv-preview-placeholder--text' : '';
    mediaWrap.innerHTML = `<div class="dictv-preview-placeholder${textMode}"><span>${escapeHtml(item)}</span></div>`;
  }

  el('dictv-preview-prev').disabled = _dictPreviewIndex === 0;
  el('dictv-preview-next').disabled = _dictPreviewIndex === cat.items.length - 1;
}

// ─────────────────────────────────────────────────────────────────
// CUSTOMER SUPPORT — Accordion
// ─────────────────────────────────────────────────────────────────
function toggleAccordion(btn) {
  const item = btn.closest('.accordion-item');
  const body = item.querySelector('.accordion-body');
  const isOpen = item.classList.contains('open');

  // Close all open items first
  document.querySelectorAll('.accordion-item.open').forEach(i => {
    i.classList.remove('open');
    i.querySelector('.accordion-body').style.maxHeight = '';
  });

  if (!isOpen) {
    item.classList.add('open');
    body.style.maxHeight = body.scrollHeight + 'px';
  }
}

// ─────────────────────────────────────────────────────────────────
// CUSTOMER SUPPORT — Star Rating
// ─────────────────────────────────────────────────────────────────
async function rateAccuracy(stars) {
  document.querySelectorAll('.rating-star').forEach((s, i) => {
    s.classList.toggle('active', i < stars);
  });
  const thanks = el('rating-thanks');
  if (thanks) {
    thanks.style.display = 'block';
    setTimeout(() => { thanks.style.display = 'none'; }, 3000);
  }

  try {
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: stars }),
    });
  } catch (err) {
    // rating already reflected in the UI; ignore network errors here
  }
}

// ─────────────────────────────────────────────────────────────────
// CUSTOMER SUPPORT — Report an Issue modal
// ─────────────────────────────────────────────────────────────────
function openReportIssue() {
  el('report-issue-title').value = '';
  el('report-issue-description').value = '';
  el('report-issue-error').classList.remove('show');
  el('report-issue-overlay').classList.add('show');
}

function closeReportIssue() {
  el('report-issue-overlay').classList.remove('show');
}

async function submitReportIssue() {
  const title       = el('report-issue-title').value.trim();
  const description = el('report-issue-description').value.trim();
  const errBox      = el('report-issue-error');

  if (!title || !description) {
    errBox.textContent = 'Please fill in both the title and description.';
    errBox.classList.add('show');
    return;
  }

  try {
    const res = await fetch('/api/support/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description }),
    });
    const data = await res.json();
    if (!res.ok) {
      errBox.textContent = data.error || 'Could not submit report.';
      errBox.classList.add('show');
      return;
    }
    closeReportIssue();
    showToast(data.message || 'Issue reported. Thank you!');
  } catch (err) {
    errBox.textContent = 'Could not reach the server.';
    errBox.classList.add('show');
  }
}

// ─────────────────────────────────────────────────────────────────
// CUSTOMER SUPPORT — Send Feedback modal
// ─────────────────────────────────────────────────────────────────
function openSendFeedback() {
  el('send-feedback-message').value = '';
  el('send-feedback-error').classList.remove('show');
  el('send-feedback-overlay').classList.add('show');
}

function closeSendFeedback() {
  el('send-feedback-overlay').classList.remove('show');
}

async function submitSendFeedback() {
  const message = el('send-feedback-message').value.trim();
  const errBox  = el('send-feedback-error');

  if (!message) {
    errBox.textContent = 'Please enter your feedback before submitting.';
    errBox.classList.add('show');
    return;
  }

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    if (!res.ok) {
      errBox.textContent = data.error || 'Could not submit feedback.';
      errBox.classList.add('show');
      return;
    }
    closeSendFeedback();
    showToast(data.message || 'Thank you for your feedback!');
  } catch (err) {
    errBox.textContent = 'Could not reach the server.';
    errBox.classList.add('show');
  }
}

// ─────────────────────────────────────────────────────────────────
// FEATURE FLAGS — restore hidden pages from /api/config
// Runs once on load. If show_profile/favorites/analytics is true in
// config.py, the corresponding nav button becomes visible again.
// ─────────────────────────────────────────────────────────────────
(async function applyPageFeatureFlags() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const cfg = await res.json();
    ['profile', 'favorites', 'analytics'].forEach(page => {
      if (cfg['show_' + page]) {
        const btn = document.querySelector(`[data-feature="${page}"]`);
        if (btn) btn.classList.remove('nav-feature-hidden');
      }
    });
  } catch (e) { /* non-fatal */ }
})();

/* ══════════════════════════════════════════════════════════════
   SETTINGS v2 — Per-category save / reset
   ══════════════════════════════════════════════════════════════ */

const _STT_CAT_KEYS = {
  speech: ['speech_speed', 'speech_volume', 'speech_voice'],
  camera: ['camera_size', 'show_landmarks'],
  prefs:  ['show_analytics', 'show_history_panel'],
};

// Same defaults LocalSettingsStore uses — reused rather than redeclared
// so the two can't drift out of sync.
const _STT_DEFAULTS = LocalSettingsStore.DEFAULTS;

const _STT_CAT_LABELS = {
  speech: 'AI & Speech',
  camera: 'Camera',
  prefs:  'Dashboard Preferences',
};

function switchSettingsTab(cat) {
  document.querySelectorAll('.stt-t2-tab[data-stt-cat]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sttCat === cat);
  });
  document.querySelectorAll('.stt-t2-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === 'stt-panel-' + cat);
  });
}

function switchSettingsCat(cat) { switchSettingsTab(cat); }

async function saveSettingsCategory(cat) {
  const full  = readSettingsForm();
  const keys  = _STT_CAT_KEYS[cat] || [];
  const patch = {};
  keys.forEach(k => { patch[k] = full[k]; });

  const error = validateSettingsPatch(patch);
  if (error) { showToast(error); return; }

  // Theme lives in the 'prefs' tab's radio group but is device-local
  // only (see setTheme() above) and never sent to the backend - commit
  // the staged choice here, at Save time, same as the rest of the tab.
  if (cat === 'prefs') setTheme(pendingTheme);

  if (!currentUser || !currentUser.id) {
    currentSettings = LocalSettingsStore.save(patch);
    applySettingsToDashboard(currentSettings);
    showToast('Settings saved!');
    return;
  }

  const payload = Object.assign({}, currentSettings || {}, patch);
  try {
    const res = await fetch('/api/settings', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not save settings.'); return; }
    currentSettings = data.settings;
    applySettingsToDashboard(currentSettings);
    showToast('Settings saved!');
  } catch (err) {
    showToast('Could not reach the server.');
  }
}

async function resetSettingsCategory(cat) {
  const label = _STT_CAT_LABELS[cat] || cat;
  if (!confirm('Reset ' + label + ' settings to their default values?')) return;
  const keys = _STT_CAT_KEYS[cat] || [];

  // Reset is already a confirmed, saved action, so the default theme
  // applies immediately - same rule as the Save Changes button above.
  if (cat === 'prefs') setTheme(LocalSettingsStore.DEFAULTS.theme);

  if (!currentUser || !currentUser.id) {
    currentSettings = LocalSettingsStore.reset(keys);
    renderSettingsForm(currentSettings);
    applySettingsToDashboard(currentSettings);
    showToast('Settings reset to default.');
    return;
  }

  const patch = {};
  keys.forEach(k => { patch[k] = _STT_DEFAULTS[k]; });
  const payload = Object.assign({}, currentSettings || {}, patch);
  try {
    const res = await fetch('/api/settings', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not reset settings.'); return; }
    currentSettings = data.settings;
    renderSettingsForm(currentSettings);
    applySettingsToDashboard(currentSettings);
    showToast('Settings reset to default.');
  } catch (err) {
    showToast('Could not reach the server.');
  }
}
}