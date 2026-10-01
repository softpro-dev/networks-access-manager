; Inno Setup 6 script: SoftProIt Network SERVICE (Windows x64) — install on every computer to control.
;
; Installs SoftProIt.network.conducted.exe (background service; internal service name
; OrganizationNetworkAgent, auto start, recovery, restrictive service DACL) and writes the
; org-token config the service reads (agent.env). No questions: ADMIN_SERVER, ACCESS_TOKE and
; CACHE_EXPIRATION_TIME_IN_MINUTE are baked in at build time from os-apps\.env (build.ps1
; generates build\installer-config-service.iss). Every install/upgrade rewrites agent.env with them.
; The desktop admin app has its own installer: SoftProIt.Network.Admin.iss.
;
; Build: scripts\build.ps1 -Target Service -Installer   (or build-now\build-service-setup.bat)
;
; Silent install: setup.exe /VERYSILENT
; Optional overrides: /SERVER=https://... /TOKENFILE=C:\secure\token.txt /CACHE=5

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#include "..\build\installer-config-service.iss"
#ifndef CfgServer
  #error build\installer-config-service.iss must define CfgServer, CfgToken and CfgCache (run scripts\build.ps1)
#endif
#ifndef CfgTestPoll
  #define CfgTestPoll ""
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
; Nothing to ask: the only page shows the baked-in settings (read-only) before Install.
DisableWelcomePage=yes
DisableReadyPage=no
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
{ Settings baked in at build time (os-apps\.env); /SERVER= /TOKENFILE= /CACHE= may override. }
function ServerValue(): String;
begin
  Result := Trim(ExpandConstant('{param:SERVER|}'));
  if Result = '' then Result := '{#CfgServer}';
end;

function TokenValue(): String;
var
  S: AnsiString;
  F: String;
begin
  Result := '{#CfgToken}';
  F := ExpandConstant('{param:TOKENFILE|}');
  if (F <> '') and LoadStringFromFile(F, S) then
    Result := Trim(String(S));
end;

function CacheValue(): String;
begin
  Result := Trim(ExpandConstant('{param:CACHE|}'));
  if Result = '' then Result := '{#CfgCache}';
end;

{ Shown values are limited on purpose: the server only by its first 10 characters, never the token. }
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

{ Testing builds (NAM_TEST_POLL_SECONDS in os-apps\.env) say so loudly on the Ready page. }
function TestPollNotice(NewLine: String): String;
begin
  Result := '';
  if '{#CfgTestPoll}' <> '' then
    Result := 'TEST BUILD: checks for restrictions every {#CfgTestPoll} seconds (NAM_TEST_POLL_SECONDS).' +
      NewLine + 'Do not install on production computers.' + NewLine + NewLine;
end;

{ Ready page: identify this build (read-only; nothing to enter). }
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := 'This computer will be set up with:' + NewLine + NewLine +
    Space + 'ADMIN_SERVER:                     ' + ShortServer() + NewLine +
    Space + 'CACHE_EXPIRATION_TIME_IN_MINUTE:  ' + CacheValue() + NewLine +
    Space + 'CODE_NUMBER:                      ' + CodeValue() + NewLine +
    Space + 'BUILD_VERSION:                    ' + '{#AppVersion}' + NewLine + NewLine +
    TestPollNotice(NewLine) +
    MemoDirInfo;
end;

function InitializeSetup(): Boolean;
begin
  Log('Settings: ADMIN_SERVER=' + ShortServer() + ', CACHE_EXPIRATION_TIME_IN_MINUTE=' + CacheValue() +
    ', CODE_NUMBER=' + CodeValue() + ', BUILD_VERSION={#AppVersion}');
  Result := True;
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
  EnvFile := ExpandConstant('{#DataRoot}\config\agent.env');
  Url := ServerValue();
  Cache := CacheValue();
  Content := '# Managed by SoftProIt Network Service setup (org-token mode).' + #13#10;
  Content := Content + 'ADMIN_SERVER="' + Url + '"' + #13#10;
  Content := Content + 'ACCESS_TOKE="' + TokenValue() + '"' + #13#10;
  Content := Content + 'CACHE_EXPIRATION_TIME_IN_MINUTE="' + Cache + '"' + #13#10;
  { Testing only: seconds-level polling, baked in from os-apps\.env when set there. }
  if '{#CfgTestPoll}' <> '' then
    Content := Content + 'NAM_TEST_POLL_SECONDS="{#CfgTestPoll}"' + #13#10;
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
