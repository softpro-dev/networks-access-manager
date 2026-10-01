; Inno Setup 6 script: SoftProIt Network ADMIN (Windows x64) — install on administrators' PCs.
;
; Installs SoftProIt.network.admin.exe, the desktop admin-console window (it also scans the
; local network for "Add My PC" / "Add from network"). Asks only for the admin server URL and
; writes it to admin.env next to the exe (no secrets). The service has its own installer:
; SoftProIt.Network.Service.iss.
;
; Build: scripts\build.ps1 -Target Admin -Installer   (or how-to\build-admin-setup.bat)
;   ISCC.exe /DAppVersion=1.2.3 installer\SoftProIt.Network.Admin.iss
;
; Silent install:
;   setup.exe /VERYSILENT /SERVER=https://admin.example.com

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppName "SoftProIt Network Admin"
#define AdminExeName "SoftProIt.network.admin.exe"
#define InstallDir "{autopf}\SoftProIt Network Admin"
#define ServiceEnv "{commonappdata}\OrganizationNetworkAgent\config\agent.env"

[Setup]
AppId={{B2F4C8E1-5D3A-4F6B-9C7E-1A2D3E4F5A6B}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Organization IT
DefaultDirName={#InstallDir}
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
UninstallDisplayIcon={app}\{#AdminExeName}
UninstallDisplayName={#AppName}
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; GroupDescription: "Additional icons:"

[Files]
Source: "..\dist\SoftProIt.network.admin\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AdminExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AdminExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AdminExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{app}\admin.env"

[Code]
var
  ConfigPage: TInputQueryWizardPage;

{ Value of KEY= in a dotenv file (quotes stripped), or '' when absent/unreadable. }
function ReadEnvValue(const FileName, Key: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
  Line: String;
begin
  Result := '';
  if not LoadStringsFromFile(FileName, Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Trim(Lines[I]);
    if Pos(Key + '=', Line) = 1 then
    begin
      Result := Trim(Copy(Line, Length(Key) + 2, MaxInt));
      StringChangeEx(Result, '"', '', True);
    end;
  end;
end;

procedure InitializeWizard();
var
  Url: String;
begin
  ConfigPage := CreateInputQueryPage(wpSelectTasks,
    'Admin server',
    'Which admin console should this app open?',
    'Enter the admin server URL (the same one the network service uses).');
  ConfigPage.Add('Admin server (e.g. https://admin.example.com):', False);
  { Prefill: /SERVER=, else the previous admin install, else this PC's service config. }
  Url := ExpandConstant('{param:SERVER|}');
  if Url = '' then Url := ReadEnvValue(ExpandConstant('{#InstallDir}\admin.env'), 'ADMIN_SERVER');
  if Url = '' then Url := ReadEnvValue(ExpandConstant('{#ServiceEnv}'), 'ADMIN_SERVER');
  ConfigPage.Values[0] := Url;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Url: String;
begin
  Result := True;
  if CurPageID <> ConfigPage.ID then Exit;
  Url := Lowercase(Trim(ConfigPage.Values[0]));
  if (Pos('https://', Url) <> 1) and (Pos('http://', Url) <> 1) then
  begin
    MsgBox('Admin server must be an http(s):// URL (https recommended for production).', mbError, MB_OK);
    Result := False;
  end;
end;

{ The app runs as a normal user, so it reads the URL from admin.env next to its exe. Program
  Files is Users read/execute, so the file is readable but not writable by non-admins. }
procedure CurStepChanged(CurStep: TSetupStep);
var
  AdminEnv: String;
begin
  if CurStep <> ssPostInstall then Exit;
  AdminEnv := ExpandConstant('{app}\admin.env');
  SaveStringToFile(AdminEnv,
    '# Managed by SoftProIt Network Admin setup. Server URL only; no secrets.' + #13#10 +
    'ADMIN_SERVER="' + Trim(ConfigPage.Values[0]) + '"' + #13#10, False);
  Log('wrote ' + AdminEnv);
end;
