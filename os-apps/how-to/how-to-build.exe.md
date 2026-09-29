# Build the executables

# Windows x64 (for `.exe`) or macOS. Install Python 3.12. PyInstaller does not cross-compile.



## .exe build commands
```bash
cd os-apps 

# for Windows
./scripts/build.ps1
# for MAC
./scripts/build.sh
``` 
 

## Output (`dist/`)
- `SoftProIt.network.conducted` — service
- `SoftProIt.network.admin` — desktop app

## Set `.env`
```env
ADMIN_SERVER=http://localhost:3001
ACCESS_TOKE=copy_from_organization_list   # org → Generate access token
CACHE_EXPIRATION_TIME_IN_MINUTE=5
```

## Windows installer
Compile `installer/OrganizationNetworkAgent.iss` with Inno Setup.
