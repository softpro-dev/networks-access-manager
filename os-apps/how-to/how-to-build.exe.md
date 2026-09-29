# Build the executables

1. Windows x64 (for `.exe`) or macOS. Install Python 3.12. PyInstaller does not cross-compile.
2. Windows: `cd os-apps && ./scripts/build.ps1`  ·  macOS: `cd os-apps && ./scripts/build.sh`
3. Output in `dist/`: `SoftProIt.network.conducted` (service) and `SoftProIt.network.admin` (desktop app).
4. Set `.env`: `ADMIN_SERVER`, `ACCESS_TOKE` (org → Generate access token), `CACHE_EXPIRATION_TIME_IN_MINUTE`.
5. Windows installer: compile `installer/OrganizationNetworkAgent.iss` with Inno Setup.
