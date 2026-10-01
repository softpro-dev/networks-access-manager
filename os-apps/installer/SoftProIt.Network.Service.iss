; Inno Setup 6 script: SoftProIt Network SERVICE (Windows x64) — install on every computer to control.
;
; Installs SoftProIt.network.conducted.exe (background service; internal service name
; OrganizationNetworkAgent, auto start, recovery, restrictive service DACL), collects the three
; org-token settings and writes them to the config the service reads (agent.env).
; The desktop admin app has its own installer: SoftProIt.Network.Admin.iss.
;
; Build: scripts\build.ps1 -Target Service -Installer   (or build-now\build-service-setup.bat)
;   ISCC.exe /DAppVersion=1.2.3 installer\SoftProIt.Network.Service.iss
;
; Silent install:
;   setup.exe /VERYSILENT /SERVER=https://admin.example.com /TOKENFILE=C:\secure\token.txt /CACHE=5
; (Prefer /TOKENFILE over /TOKEN=...: command lines are visible to other processes.)

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppName "SoftProIt Network Service"
#define ServiceName "OrganizationNetworkAgent"
#define SvcExeName "SoftProIt.network.conducted.exe"
#define DataRoot "{commonappdata}\OrganizationNetworkAgent"

[Setup]
; Same AppId and folder as the former combined "SoftProIt Network Agent" installer, so this
; upgrades an existing install in place (the old bundled admin copy is removed below).
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
OutputBaseFilename=SoftProIt-Network-Service-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\conducted\{#SvcExeName}
UninstallDisplayName={#AppName}
CloseApplications=no
SetupLogging=yes

[Dirs]
Name: "{#DataRoot}"
Name: "{#DataRoot}\config"
Name: "{#DataRoot}\data"
Name: "{#DataRoot}\logs"

[InstallDelete]
; Left over from the former combined installer; the admin app now installs separately.
Type: filesandordirs; Name: "{app}\admin"

[Files]
Source: "..\dist\SoftProIt.network.conducted\*"; DestDir: "{app}\conducted"; Flags: recursesubdirs createallsubdirs ignoreversion

[UninstallRun]
Filename: "{app}\conducted\{#SvcExeName}"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\conducted\{#SvcExeName}"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"

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
    'Connect this computer to your organization''s admin server.',
    'Enter the admin server URL and the organization access token from the admin ' +
    'console (Organizations -> Generate token). ' +
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

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  RunTool(ExpandConstant('{sys}\sc.exe'), 'stop {#ServiceName}');
  Sleep(3000);
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

procedure WriteConfig();
var
  EnvFile, Url, Cache, Content: String;
begin
  if AllEmpty() and ExistingConfig() then Exit;
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
