; Inno Setup 6 script: wraps the Windows bundle into a single SofiaSetup-<version>.exe
;
;   1. node scripts/build-windows-bundle.mjs
;   2. iscc /DVersion=1.0.0 /DBundleDir=..\..\release\SofiaSetup-1.0.0-windows deploy\windows\sofia-setup.iss
;   3. sign the resulting .exe with the restaurant's / vendor's code-signing certificate (signtool), otherwise
;      Windows SmartScreen warns about an unknown publisher.
;
; The .exe extracts the bundle to {tmp} and runs Install-Sofia.ps1, which does the real work (and is the single
; source of truth for the installation logic). Not yet compiled or tested by the development team.

#ifndef Version
  #define Version "1.0.0"
#endif
#ifndef BundleDir
  #define BundleDir "..\..\release\SofiaSetup-" + Version + "-windows"
#endif

[Setup]
AppId={{6B142034-5F1A-4C3E-9B1D-50F1A0000001}
AppName=Sofia's Resto-Lounge
AppVersion={#Version}
AppPublisher=Sofia's Resto-Lounge
DefaultDirName=C:\Sofia
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputBaseFilename=SofiaSetup-{#Version}
SetupIconFile={#BundleDir}\sofia.ico
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
Uninstallable=no
CreateAppDir=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "ar"; MessagesFile: "compiler:Languages\Arabic.isl"

[Files]
Source: "{#BundleDir}\*"; DestDir: "{tmp}\SofiaSetup"; Flags: recursesubdirs ignoreversion deleteafterinstall

[Code]
var
  ModePage: TInputOptionWizardPage;
  DomainPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  ModePage := CreateInputOptionPage(wpWelcome,
    'Connection security', 'How will tablets and phones connect to Sofia?',
    'Offline mode on tablets requires HTTPS.', True, False);
  ModePage.Add('Restaurant network (HTTPS with Sofia''s own certificate) - recommended');
  ModePage.Add('Public domain name with a Let''s Encrypt certificate');
  ModePage.Add('Plain HTTP (offline mode only on this PC)');
  ModePage.SelectedValueIndex := 0;

  DomainPage := CreateInputQueryPage(ModePage.ID,
    'Public domain', 'Domain name and e-mail for the certificate',
    'Ports 80 and 443 must be forwarded to this PC.');
  DomainPage.Add('Domain (e.g. book.example.com):', False);
  DomainPage.Add('E-mail for certificate notices:', False);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (PageID = DomainPage.ID) and (ModePage.SelectedValueIndex <> 1);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = DomainPage.ID) and ((Trim(DomainPage.Values[0]) = '') or (Trim(DomainPage.Values[1]) = '')) then
  begin
    MsgBox('Please enter the domain and the e-mail address.', mbError, MB_OK);
    Result := False;
  end;
end;

function InstallerArgs: String;
var
  Mode: String;
begin
  case ModePage.SelectedValueIndex of
    0: Mode := 'Lan';
    1: Mode := 'Domain';
  else
    Mode := 'None';
  end;
  Result := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\SofiaSetup\Install-Sofia.ps1') + '" -HttpsMode ' + Mode;
  if Mode = 'Domain' then
    Result := Result + ' -Domain "' + Trim(DomainPage.Values[0]) + '" -AcmeEmail "' + Trim(DomainPage.Values[1]) + '"';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Installing Sofia (database, services, HTTPS)... this can take several minutes.';
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), InstallerArgs, '',
      SW_SHOW, ewWaitUntilTerminated, Code) or (Code <> 0) then
      MsgBox('The Sofia installation did not finish (code ' + IntToStr(Code) + '). See the log file named in the installer window.', mbError, MB_OK);
  end;
end;
