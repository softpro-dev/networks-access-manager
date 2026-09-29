"""SoftProIt.network.admin — a minimal native desktop wrapper around the admin console.

This is an ordinary desktop app (like an Electron wrapper): it opens the admin
console web UI served at ADMIN_SERVER in a normal application window. It hides
nothing from the OS, the network or devtools; the server address stays in `.env`
and in normal network traffic. It does NOT import the service package's
Windows-only modules and packages independently from the service.
"""

__version__ = "1.0.0"
ADMIN_VERSION = __version__

APP_NAME = "SoftProIt Network Admin"
WINDOW_TITLE = "SoftProIt Network Admin"
