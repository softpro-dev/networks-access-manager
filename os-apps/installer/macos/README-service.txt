SoftProIt Network Service (macOS)
=================================

Install:  double-click "Install SoftProIt Network Service.pkg" and follow the steps.
          You will be asked for:
            - the admin server URL (e.g. https://admin.example.com)
            - the organization access token (admin console: Organizations > Generate token)

If macOS says the package "cannot be opened because it is from an unidentified developer":
          right-click (Control-click) the .pkg > Open > Open.

Installs: /usr/local/softproit/SoftProIt.network.conducted/   (the service)
          /Library/LaunchDaemons/com.softproit.network.conducted.plist
          /Library/Application Support/OrganizationNetworkAgent/   (config, data, logs; root only)

Upgrade:  install the newer package; the existing configuration is kept.

Status:   sudo /usr/local/softproit/SoftProIt.network.conducted/SoftProIt.network.conducted status
Logs:     /Library/Application Support/OrganizationNetworkAgent/logs/
          /var/log/softproit-network-install.log   (installer)

Uninstall:
  sudo /usr/local/softproit/SoftProIt.network.conducted/SoftProIt.network.conducted uninstall
  sudo rm -rf /usr/local/softproit/SoftProIt.network.conducted
  sudo pkgutil --forget com.softproit.network.conducted
  (optional, removes config and cached policy)
  sudo rm -rf "/Library/Application Support/OrganizationNetworkAgent"
