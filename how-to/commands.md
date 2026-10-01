```bash

cd D:\Projects\networks-access-manager\os-apps
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" installer\OrganizationNetworkAgent.iss


```

# Copy exe to download folder

```bash of PowerShell
Copy-Item D:\Projects\networks-access-manager\os-apps\installer\Output\SoftProIt-Network-1.0.0-setup.exe "C:\Users\SURFACE 4\Downloads\SoftProIt-Network-1.0.0-setup.exe"
```
