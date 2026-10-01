; Inno Setup 6 script for the SoftProIt network apps (Windows x64).
;
; Installs BOTH executables produced by scripts\build.ps1:
;   - SoftProIt.network.conducted.exe  (background service; internal service name
;     OrganizationNetworkAgent, auto start, recovery, restrictive service DACL)
;   - SoftProIt.network.admin.exe      (desktop admin-console wrapper, Start-menu shortcut)
;
; Collects the three documented org-token settings and writes them to the config the
; service reads (agent.env). Build first, then:
;   ISCC.exe installer\OrganizationNetworkAgent.iss   (or: scripts\build.ps1 -Installer)
;
; Silent install:
;   setup.exe /VERYSILENT /SERVER=https://admin.example.com /TOKENFILE=C:\secure\token.txt /CACHE=5
; (Prefer /TOKENFILE over /TOKEN=...: command lines are visible to other processes.)

#define AppName "SoftProIt Network Agent"
#define AppVersion "1.0.0"
#define ServiceName "OrganizationNetworkAgent"
#define SvcExeName "SoftProIt.network.conducted.exe"
#define AdminExeName "SoftProIt.network.admin.exe"
#define AdminDisplayName "SoftProIt Network Admin"
#define DataRoot "{commonappdata}\OrganizationNetworkAgent"

[Setup]
AppId={{6C1E3E0A-3B7B-4E53-9E0C-0A6F3D5B2C11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Organization IT
DefaultDirName={autopf}\SoftProIt Network
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=Output
OutputBaseFilename=SoftProIt-Network-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\admin\{#AdminExeName}
UninstallDisplayName={#AppName}
CloseApplications=no
SetupLogging=yes

[Dirs]
Name: "{#DataRoot}"
Name: "{#DataRoot}\config"
Name: "{#DataRoot}\data"
Name: "{#DataRoot}\logs"

[Files]
; The service (onedir) and the admin app (onedir) go into separate subfolders.
Source: "..\dist\SoftProIt.network.conducted\*"; DestDir: "{app}\conducted"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\dist\SoftProIt.network.admin\*"; DestDir: "{app}\admin"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#AdminDisplayName}"; Filename: "{app}\admin\{#AdminExeName}"

[UninstallRun]
Filename: "{app}\conducted\{#SvcExeName}"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\conducted\{#SvcExeName}"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"

[UninstallDelete]
Type: files; Name: "{app}\admin\admin.env"

; ProgramData (policy cache, logs, config) is intentionally kept on uninstall so a
; reinstall keeps state. Delete C:\ProgramData\OrganizationNetworkAgent to wipe.

[Code]
var
  ConfigPage: TInputQueryWizardPage;

function ExistingConfig(): Boolean;
begin
  Result := FileExists(ExpandConstant('{#DataRoot}\config\agent.env'));
end;

procedure InitializeWizard();
begin
  ConfigPage := CreateInputQueryPage(wpSelectTasks,
    'Organization configuration (unattended / org-token mode)',
    'Connect these computers to your organization''s admin server.',
    'Enter the admin server URL and the organization access token from the admin ' +
    'console (organization -> Generate access token). ' +
    'Leave all fields empty on an upgrade to keep the existing configuration.');
  ConfigPage.Add('Admin server (e.g. https://admin.example.com):', False);
  ConfigPage.Add('Access token (nat_...):', True);
  ConfigPage.Add('Policy refresh interval, minutes (default 5):', False);
  ConfigPage.Values[0] := ExpandConstant('{param:SERVER|}');
  ConfigPage.Values[1] := ExpandConstant('{param:TOKEN|}');
  ConfigPage.Values[2] := ExpandConstant('{param:CACHE|5}');
end;

function TokenValue(): String;
var
  S: AnsiString;
  F: String;
begin
  Result := Trim(ConfigPage.Values[1]);
  F := ExpandConstant('{param:TOKENFILE|}');
  if (Result = '') and (F <> '') and LoadStringFromFile(F, S) then
    Result := Trim(String(S));
end;

function AllEmpty(): Boolean;
begin
  Result := (Trim(ConfigPage.Values[0]) = '') and (TokenValue() = '');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Url: String;
begin
  Result := True;
  if CurPageID <> ConfigPage.ID then Exit;
  if AllEmpty() and ExistingConfig() then Exit;
  Url := Lowercase(Trim(ConfigPage.Values[0]));
  if (Pos('https://', Url) <> 1) and (Pos('http://', Url) <> 1) then
  begin
    MsgBox('Admin server must be an http(s):// URL (https recommended for production).', mbError, MB_OK);
    Result := False;
  end
  else if TokenValue() = '' then
  begin
    MsgBox('Access token is required.', mbError, MB_OK);
    Result := False;
  end;
end;

function RunTool(const Exe, Params: String): Integer;
var
  Code: Integer;
begin
  if not Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Code := -1;
  Log(Format('%s %s -> %d', [Exe, Params, Code]));
  Result := Code;
end;

function SvcExe(): String;
begin
  Result := ExpandConstant('{app}\conducted\{#SvcExeName}');
end;

procedure PrepareToInstallStopService();
begin
  RunTool(ExpandConstant('{sys}\sc.exe'), 'stop {#ServiceName}');
  Sleep(3000);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  PrepareToInstallStopService();
  Result := '';
end;

procedure SecureDirectories();
var
  Data, App: String;
begin
  Data := ExpandConstant('{#DataRoot}');
  App := ExpandConstant('{app}');
  { ProgramData: SYSTEM + Administrators full control, no access for Users. The access
    token in agent.env is protected by this ACL (same model as Windows DPAPI at rest). }
  RunTool(ExpandConstant('{sys}\icacls.exe'),
    AddQuotes(Data) + ' /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F');
  RunTool(ExpandConstant('{sys}\icacls.exe'), AddQuotes(Data + '\*') + ' /reset /T /C /Q');
  { Program Files: Users may read/execute only; binaries cannot be replaced by non-admins. }
  RunTool(ExpandConstant('{sys}\icacls.exe'),
    AddQuotes(App) + ' /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX');
  RunTool(ExpandConstant('{sys}\icacls.exe'), AddQuotes(App + '\*') + ' /reset /T /C /Q');
end;

{ ADMIN_SERVER from an existing agent.env (upgrade with empty fields). }
function ExistingAdminServer(): String;
var
  Lines: TArrayOfString;
  I: Integer;
  Line: String;
begin
  Result := '';
  if not LoadStringsFromFile(ExpandConstant('{#DataRoot}\config\agent.env'), Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Trim(Lines[I]);
    if Pos('ADMIN_SERVER=', Line) = 1 then
    begin
      Result := Trim(Copy(Line, Length('ADMIN_SERVER=') + 1, MaxInt));
      StringChangeEx(Result, '"', '', True);
    end;
  end;
end;

{ The admin app runs as a normal user and cannot read agent.env (admin-only, holds the
  access token), so give it the server URL alone in admin.env next to its executable.
  The install dir is Users read/execute, so the file inherits that and stays non-writable. }
procedure WriteAdminEnv(const Url: String);
var
  AdminEnv: String;
begin
  if Url = '' then Exit;
  AdminEnv := ExpandConstant('{app}\admin\admin.env');
  SaveStringToFile(AdminEnv,
    '# Managed by SoftProIt Network setup. Server URL only; no secrets.' + #13#10 +
    'ADMIN_SERVER="' + Url + '"' + #13#10, False);
  Log('wrote ' + AdminEnv);
end;

procedure WriteConfig();
var
  EnvFile, Url, Cache, Content: String;
begin
  if AllEmpty() and ExistingConfig() then
  begin
    WriteAdminEnv(ExistingAdminServer());
    Exit;
  end;
  EnvFile := ExpandConstant('{#DataRoot}\config\agent.env');
  Url := Trim(ConfigPage.Values[0]);
  Cache := Trim(ConfigPage.Values[2]);
  if Cache = '' then Cache := '5';
  Content := '# Managed by SoftProIt Network setup (org-token mode).' + #13#10;
  Content := Content + 'ADMIN_SERVER="' + Url + '"' + #13#10;
  Content := Content + 'ACCESS_TOKE="' + TokenValue() + '"' + #13#10;
  Content := Content + 'CACHE_EXPIRATION_TIME_IN_MINUTE="' + Cache + '"' + #13#10;
  { Permit http:// for non-TLS admin servers (e.g. on-prem); https needs no flag. }
  if Pos('https://', Lowercase(Url)) <> 1 then
    Content := Content + 'NAM_ALLOW_INSECURE_HTTP="true"' + #13#10;
  SaveStringToFile(EnvFile, Content, False);
  Log('wrote ' + EnvFile);
  WriteAdminEnv(Url);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  SecureDirectories();
  WriteConfig();

  { Register the service (idempotent on upgrade: remove first). `install` sets auto start. }
  RunTool(SvcExe(), 'uninstall');
  Code := RunTool(SvcExe(), 'install');
  if Code <> 0 then
  begin
    MsgBox('Service registration failed (exit code ' + IntToStr(Code) + '). See the setup log.', mbError, MB_OK);
    Exit;
  end;
  { Recovery: restart after 5 s / 30 s / 60 s, reset counter daily; also on non-crash failures. }
  RunTool(ExpandConstant('{sys}\sc.exe'), 'failure {#ServiceName} reset= 86400 actions= restart/5000/restart/30000/restart/60000');
  RunTool(ExpandConstant('{sys}\sc.exe'), 'failureflag {#ServiceName} 1');
  { DACL: SYSTEM/Administrators full; interactive, service and authenticated users may only query. }
  RunTool(ExpandConstant('{sys}\sc.exe'),
    'sdset {#ServiceName} D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLORC;;;IU)(A;;CCLCSWLORC;;;SU)(A;;CCLCSWLORC;;;AU)');

  { `start` exits non-zero unless the service reaches RUNNING. }
  Code := RunTool(SvcExe(), 'start');
  if Code <> 0 then
    MsgBox('The service did not reach the RUNNING state (exit code ' + IntToStr(Code) + '). ' +
      'Check C:\ProgramData\OrganizationNetworkAgent\logs\agent.log and the Application event log.', mbError, MB_OK);
end;
