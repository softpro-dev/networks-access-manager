; Inno Setup 6 script for the Organization Network Management Agent.
; Build on Windows x64 after scripts\build.ps1 has produced dist\OrganizationNetworkAgent\:
;   ISCC.exe installer\OrganizationNetworkAgent.iss      (or: scripts\build.ps1 -Installer)
;
; Silent install:  setup.exe /VERYSILENT /ORG=INST-001 /SERVER=https://management.example.com/api /TOKENFILE=C:\secure\token.txt
; (Prefer /TOKENFILE over /TOKEN=...: command lines are visible to other processes.)

#define AppName "Organization Network Management Agent"
#define AppVersion "1.0.0"
#define ServiceName "OrganizationNetworkAgent"
#define ExeName "OrganizationNetworkAgent.exe"
#define DataRoot "{commonappdata}\OrganizationNetworkAgent"

[Setup]
AppId={{6C1E3E0A-3B7B-4E53-9E0C-0A6F3D5B2C11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Organization IT
DefaultDirName={autopf}\OrganizationNetworkAgent
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=Output
OutputBaseFilename=OrganizationNetworkAgent-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#ExeName}
UninstallDisplayName={#AppName}
CloseApplications=no
SetupLogging=yes

[Dirs]
Name: "{#DataRoot}"
Name: "{#DataRoot}\config"
Name: "{#DataRoot}\data"
Name: "{#DataRoot}\logs"

[Files]
Source: "..\dist\OrganizationNetworkAgent\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[UninstallRun]
Filename: "{app}\{#ExeName}"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\{#ExeName}"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"

; ProgramData (device identity, policy cache, logs) is intentionally kept on uninstall so a
; reinstall keeps the same device_uuid. Delete C:\ProgramData\OrganizationNetworkAgent to wipe.

[Code]
var
  ConfigPage: TInputQueryWizardPage;
  ConfigureFailed: Boolean;

function ExistingConfig(): Boolean;
begin
  Result := FileExists(ExpandConstant('{#DataRoot}\config\agent.env'));
end;

procedure InitializeWizard();
begin
  ConfigPage := CreateInputQueryPage(wpSelectTasks,
    'Organization configuration',
    'Connect this computer to your organization''s management server.',
    'The server connection is verified over TLS before setup completes. ' +
    'Leave all fields empty on an upgrade to keep the existing configuration.');
  ConfigPage.Add('Organization ID (e.g. INST-001):', False);
  ConfigPage.Add('Server (e.g. https://management.example.com/api):', False);
  ConfigPage.Add('Registration token:', True);
  ConfigPage.Values[0] := ExpandConstant('{param:ORG|}');
  ConfigPage.Values[1] := ExpandConstant('{param:SERVER|}');
  ConfigPage.Values[2] := ExpandConstant('{param:TOKEN|}');
end;

function TokenValue(): String;
var
  S: AnsiString;
  F: String;
begin
  Result := Trim(ConfigPage.Values[2]);
  F := ExpandConstant('{param:TOKENFILE|}');
  if (Result = '') and (F <> '') and LoadStringFromFile(F, S) then
    Result := Trim(String(S));
end;

function AllEmpty(): Boolean;
begin
  Result := (Trim(ConfigPage.Values[0]) = '') and (Trim(ConfigPage.Values[1]) = '') and (TokenValue() = '');
end;

function ValidOrgId(S: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := (Length(S) >= 2) and (Length(S) <= 32) and (S[1] <> '-');
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if not (((C >= 'A') and (C <= 'Z')) or ((C >= '0') and (C <= '9')) or (C = '-')) then
      Result := False;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID <> ConfigPage.ID then Exit;
  if AllEmpty() and ExistingConfig() then Exit;
  if not ValidOrgId(Trim(ConfigPage.Values[0])) then
  begin
    MsgBox('Organization ID must be 2-32 characters: A-Z, 0-9 and "-" (not leading).', mbError, MB_OK);
    Result := False;
  end
  else if Pos('https://', Lowercase(Trim(ConfigPage.Values[1]))) <> 1 then
  begin
    MsgBox('Server must be an https:// URL.', mbError, MB_OK);
    Result := False;
  end
  else if TokenValue() = '' then
  begin
    MsgBox('Registration token is required.', mbError, MB_OK);
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

function RunAgent(const Params: String): Integer;
begin
  Result := RunTool(ExpandConstant('{app}\{#ExeName}'), Params);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  { Upgrade: stop the running service so its files can be replaced. }
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
  { ProgramData: SYSTEM + Administrators full control, no access for Users. SIDs keep this locale-independent. }
  RunTool(ExpandConstant('{sys}\icacls.exe'),
    AddQuotes(Data) + ' /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F');
  RunTool(ExpandConstant('{sys}\icacls.exe'), AddQuotes(Data + '\*') + ' /reset /T /C /Q');
  { Program Files: Users may read/execute only; binaries cannot be replaced by non-admins. }
  RunTool(ExpandConstant('{sys}\icacls.exe'),
    AddQuotes(App) + ' /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX');
  RunTool(ExpandConstant('{sys}\icacls.exe'), AddQuotes(App + '\*') + ' /reset /T /C /Q');
end;

function Configure(): Boolean;
var
  TokenFile: String;
  Code: Integer;
begin
  Result := True;
  if AllEmpty() and ExistingConfig() then Exit;
  TokenFile := ExpandConstant('{tmp}\regtoken.txt');  { per-setup temp dir of the elevated admin }
  SaveStringToFile(TokenFile, TokenValue(), False);
  try
    Code := RunAgent('configure --organization-id ' + AddQuotes(Trim(ConfigPage.Values[0])) +
      ' --server-url ' + AddQuotes(Trim(ConfigPage.Values[1])) + ' --token-file ' + AddQuotes(TokenFile));
  finally
    DeleteFile(TokenFile);
  end;
  Result := Code = 0;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  SecureDirectories();

  ConfigureFailed := not Configure();

  { Register service (idempotent on upgrade: remove first). `install` sets auto start. }
  RunAgent('uninstall');
  Code := RunAgent('install');
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

  if ConfigureFailed then
  begin
    MsgBox('The agent was installed but configuration failed (invalid input or the server could not be reached over TLS).' + #13#10 +
      'Run as Administrator:' + #13#10 + '  "' + ExpandConstant('{app}\{#ExeName}') + '" configure' + #13#10 +
      'then start the service with "' + ExpandConstant('{#ExeName}') + ' start".', mbError, MB_OK);
    Exit;
  end;

  { `start` exits non-zero unless the service reaches RUNNING. }
  Code := RunAgent('start');
  if Code <> 0 then
    MsgBox('The service did not reach the RUNNING state (exit code ' + IntToStr(Code) + '). ' +
      'Check C:\ProgramData\OrganizationNetworkAgent\logs\agent.log and the Application event log.', mbError, MB_OK);
end;
