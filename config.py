import os

# ─── Feature Flags ────────────────────────────────────────────────────────────
#
# ENABLE_LOGIN controls whether the authentication system is active.
#
#   False  →  Login is bypassed entirely. The dashboard is publicly accessible,
#             all auth checks are skipped, and Login/Register/Logout UI elements
#             are hidden. No authentication code is deleted — flip back to True
#             to restore the full login system exactly as it works today.
#
#   True   →  Normal operation. Users must register and log in. All session
#             checks, protected routes, and auth UI elements are active.
#
# Set ENABLE_LOGIN=true in the deployment environment only after configuring
# a reachable MySQL database through DB_HOST, DB_PORT, DB_USER, DB_PASSWORD,
# and DB_NAME. The false default preserves the current guest-mode behavior.
ENABLE_LOGIN = os.environ.get("ENABLE_LOGIN", "false").strip().lower() in {
    "1", "true", "yes", "on",
}

# ─── Page Visibility Flags ─────────────────────────────────────────────────────
# Set any of these to True to restore the page in the sidebar and navigation.
# All underlying code (routes, HTML panels, JS functions) stays intact.
SHOW_PROFILE   = False
SHOW_FAVORITES = False
SHOW_ANALYTICS = False
