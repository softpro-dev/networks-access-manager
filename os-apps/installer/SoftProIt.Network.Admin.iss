; Inno Setup 6 script: SoftProIt Network ADMIN (Windows x64) — install on administrators' PCs.
;
; Installs SoftProIt.network.admin.exe, the desktop admin-console window (it also scans the
; local network for "Add My PC" / "Add from network"). No questions: ADMIN_SERVER is baked in at
; build time from os-apps\.env (build.ps1 generates build\installer-config-admin.iss, which holds
; the server URL only — never the access token) and written to admin.env next to the exe.
; The service has its own installer: SoftProIt.Network.Service.iss.
;
; Build: scripts\build.ps1 -Target Admin -Installer   (or build-now\build-admin-setup.bat)
;
; Silent install: setup.exe /VERYSILENT   (optional override: /SERVER=https://...)

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#include "..\build\installer-config-admin.iss"
#ifndef CfgServer
  #error build\installer-config-admin.iss must define CfgServer (run scripts\build.ps1)
#endif
#define AppName "SoftProIt Network Admin"
#define AdminExeName "SoftProIt.network.admin.exe"

[Setup]
AppId={{B2F4C8E1-5D3A-4F6B-9C7E-1A2D3E4F5A6B}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Organization IT
DefaultDirName={autopf}\SoftProIt Network Admin
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=Output
OutputBaseFilename=SoftProIt-Network-Admin-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Nothing to ask: the only page shows the baked-in server (read-only) before Install.
DisableWelcomePage=yes
DisableReadyPage=no
UninstallDisplayIcon={app}\{#AdminExeName}
UninstallDisplayName={#AppName}
SetupLogging=yes

[Files]
Source: "..\dist\SoftProIt.network.admin\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AdminExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AdminExeName}"

[Run]
Filename: "{app}\{#AdminExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{app}\admin.env"

[Code]
function ServerValue(): String;
begin
  Result := Trim(ExpandConstant('{param:SERVER|}'));
  if Result = '' then Result := '{#CfgServer}';
end;

{ Shown values are limited on purpose: the server only by its first 10 characters. }
function ShortServer(): String;
begin
  Result := ServerValue();
  if Length(Result) > 10 then Result := Copy(Result, 1, 10) + '...';
end;

function CodeValue(): String;
begin
  Result := '{#CfgCode}';
  if Result = '' then Result := '(not set)';
end;

{ Ready page: identify this build (read-only; nothing to enter). }
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := 'The admin app will be set up with:' + NewLine + NewLine +
    Space + 'ADMIN_SERVER:                     ' + ShortServer() + NewLine +
    Space + 'CACHE_EXPIRATION_TIME_IN_MINUTE:  ' + '{#CfgCache}' + NewLine +
    Space + 'CODE_NUMBER:                      ' + CodeValue() + NewLine +
    Space + 'BUILD_VERSION:                    ' + '{#AppVersion}' + NewLine + NewLine +
    MemoDirInfo;
end;

function InitializeSetup(): Boolean;
begin
  Log('Settings: ADMIN_SERVER=' + ShortServer() + ', CODE_NUMBER=' + CodeValue() + ', BUILD_VERSION={#AppVersion}');
  Result := True;
end;

{ The app runs as a normal user, so it reads the URL from admin.env next to its exe. Program
  Files is Users read/execute, so the file is readable but not writable by non-admins. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  AdminEnv, Url: String;
begin
  if CurStep <> ssPostInstall then Exit;
  Url := ServerValue();
  AdminEnv := ExpandConstant('{app}\admin.env');
  SaveStringToFile(AdminEnv,
    '# Managed by SoftProIt Network Admin setup. Server URL only; no secrets.' + #13#10 +
    'ADMIN_SERVER="' + Url + '"' + #13#10, False);
  Log('wrote ' + AdminEnv);
end;
