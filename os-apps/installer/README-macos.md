# macOS packaging (.pkg + launchd)

PyInstaller does not cross-compile: **build, sign, notarize and package on macOS.**
The steps below are provided for reference; the signed/notarized `.pkg` is produced on
a macOS build host with your Apple Developer credentials. Enforcement itself is still
the `NotImplementedBackend` (no traffic filtering), and the launchd path has not been
verified end-to-end on macOS in this build — treat it as buildable-and-documented.

## 1. Build the apps

```bash
scripts/build.sh
# -> dist/SoftProIt.network.conducted/          (service, onedir)
# -> dist/SoftProIt.network.admin.app           (desktop admin wrapper)
```

## 2. Sign and notarize (Developer ID)

```bash
codesign --deep --force --options runtime --timestamp \
  --sign "Developer ID Application: <Your Org> (TEAMID)" \
  dist/SoftProIt.network.conducted/SoftProIt.network.conducted
codesign --deep --force --options runtime --timestamp \
  --sign "Developer ID Application: <Your Org> (TEAMID)" \
  dist/SoftProIt.network.admin.app
# Notarize the built .pkg (below) with notarytool, then `xcrun stapler staple`.
```

## 3. Lay out payload

Suggested install locations:

| Component | Path |
|-----------|------|
| Service binary (onedir) | `/usr/local/softproit/SoftProIt.network.conducted/` |
| Admin app | `/Applications/SoftProIt Network Admin.app` |
| Data root | `/Library/Application Support/OrganizationNetworkAgent/{config,data,logs}` |
| LaunchDaemon | `/Library/LaunchDaemons/com.softproit.network.conducted.plist` |

Restrict the data root to root only:

```bash
sudo mkdir -p "/Library/Application Support/OrganizationNetworkAgent/"{config,data,logs}
sudo chown -R root:wheel "/Library/Application Support/OrganizationNetworkAgent"
sudo chmod -R 700 "/Library/Application Support/OrganizationNetworkAgent"
```

## 4. Configuration (org-token mode)

Write the three documented keys to the config the service reads
(`/Library/Application Support/OrganizationNetworkAgent/config/agent.env`):

```
ADMIN_SERVER="https://admin.example.com"
ACCESS_TOKE="nat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
CACHE_EXPIRATION_TIME_IN_MINUTE="5"
NAM_SECRET_PROTECTOR="file-key"
```

On macOS the service protects the enrollment credential/secrets at rest with the
`file-key` protector (a 256-bit key in a `0600` key file inside the data dir). In
org-token mode the access token lives in `agent.env`, protected by the data-dir
permissions (the same model as the Windows DPAPI + ProgramData ACL).

## 5. LaunchDaemon

Install `com.softproit.network.conducted.plist` (edit the `ProgramArguments` path to
match step 3), owned `root:wheel`, mode `0644`, then:

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/com.softproit.network.conducted.plist
```

Or use the CLI on the installed binary (run as root), which writes the plist and
bootstraps it for you:

```bash
sudo /usr/local/softproit/SoftProIt.network.conducted/SoftProIt.network.conducted install
sudo .../SoftProIt.network.conducted start
sudo .../SoftProIt.network.conducted status
```

## 6. Build the installer package

```bash
pkgbuild --root <staged payload root> \
  --scripts <postinstall scripts> \
  --identifier com.softproit.network.conducted \
  --version 1.0.0 \
  --install-location / \
  SoftProIt.network.conducted-component.pkg

productbuild --distribution distribution.xml \
  --package-path . \
  --sign "Developer ID Installer: <Your Org> (TEAMID)" \
  SoftProIt.network-1.0.0.pkg
```

Then notarize the `.pkg` with `xcrun notarytool submit` and `xcrun stapler staple`.
