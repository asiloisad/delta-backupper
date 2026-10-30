Unicode true
!include "MUI2.nsh"

!define DELTA_BRANDING_DIR "@@DELTA_BRANDING_DIR@@"
!define DELTA_VERSION "@@DELTA_VERSION@@"
!define DELTA_FILE_VERSION "@@DELTA_FILE_VERSION@@"

Name "Delta Backupper"
OutFile "@@DELTA_OUTPUT@@"
InstallDir "$LOCALAPPDATA\Programs\Delta Backupper"
InstallDirRegKey HKCU "Software\Delta Backupper" "InstallDirectory"
RequestExecutionLevel user
SetCompressor zlib
BrandingText "Delta Backupper"
ShowInstDetails hide
ShowUninstDetails hide
VIProductVersion "${DELTA_FILE_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "Delta Backupper"
VIAddVersionKey /LANG=1033 "CompanyName" "Delta Backupper contributors"
VIAddVersionKey /LANG=1033 "FileDescription" "Delta Backupper Setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${DELTA_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${DELTA_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) 2026 Delta Backupper contributors"

!define MUI_ICON "${DELTA_BRANDING_DIR}\app.ico"
!define MUI_UNICON "${DELTA_BRANDING_DIR}\app.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${DELTA_BRANDING_DIR}\installer-header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "${DELTA_BRANDING_DIR}\installer-header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${DELTA_BRANDING_DIR}\installer-sidebar.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${DELTA_BRANDING_DIR}\installer-sidebar.bmp"
!define MUI_ABORTWARNING
!define MUI_UNABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Welcome to Delta Backupper"
!define MUI_WELCOMEPAGE_TEXT "Create and restore file backups with transparent ZIP archives.$\r$\n$\r$\nSetup installs Delta Backupper for your Windows account and adds the delta command to your user PATH.$\r$\n$\r$\nChoose Next to continue."
!insertmacro MUI_PAGE_WELCOME
!define MUI_LICENSEPAGE_TEXT_TOP "Delta Backupper is distributed under the MIT License."
!insertmacro MUI_PAGE_LICENSE "@@DELTA_LICENSE@@"
!define MUI_DIRECTORYPAGE_TEXT_TOP "Choose a location for application files. Set your backup destinations separately in Delta Backupper."
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Install for the current Windows account:"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "Delta Backupper is installed"
!define MUI_FINISHPAGE_TEXT "Open Delta Backupper from the Start menu.$\r$\n$\r$\nTo use the delta command, open a new terminal.$\r$\n$\r$\nUse Settings to choose background behavior and notifications."
!insertmacro MUI_PAGE_FINISH

!define MUI_WELCOMEPAGE_TITLE "Remove Delta Backupper"
!define MUI_WELCOMEPAGE_TEXT "This wizard removes Delta Backupper from your Windows account.$\r$\n$\r$\nYour backup archives and personal settings are preserved.$\r$\n$\r$\nClose Delta Backupper before continuing."
!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "Delta Backupper was removed"
!define MUI_FINISHPAGE_TEXT "Delta Backupper has been removed.$\r$\n$\r$\nYour backup archives and personal settings remain available."
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Function .onVerifyInstDir
  SetRegView 64
  ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "InstallLocation"
  StrCmp $2 "" +2
  StrCmp $2 "$INSTDIR" 0 invalid_install_path
  ReadRegStr $2 HKCU "Software\Delta Backupper" "InstallDirectory"
  StrCmp $2 "" +2
  StrCmp $2 "$INSTDIR" 0 invalid_install_path
  SetRegView 32
  ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "InstallLocation"
  StrCmp $2 "" +2
  StrCmp $2 "$INSTDIR" 0 invalid_install_path
  ReadRegStr $2 HKCU "Software\Delta Backupper" "InstallDirectory"
  StrCmp $2 "" +2
  StrCmp $2 "$INSTDIR" 0 invalid_install_path
  StrLen $2 $INSTDIR
  IntCmp $2 3 invalid_install_path invalid_install_path
  StrCpy $3 $INSTDIR 1 1
  StrCmp $3 ":" 0 invalid_install_path
  StrCpy $3 $INSTDIR 1 2
  StrCmp $3 "\" 0 invalid_install_path
  StrCpy $2 0
  validate_path_character:
    StrCpy $3 $INSTDIR 1 $2
    StrCmp $3 "" validated_path_characters
    StrCmp $3 ";" invalid_install_path
    StrCmp $3 "%" invalid_install_path
    IntOp $2 $2 + 1
    Goto validate_path_character
  invalid_install_path:
    SetRegView 32
    SetErrorLevel 1
    Abort
  validated_path_characters:
  IfFileExists "$INSTDIR\.delta-install-marker" owned_install
  FindFirst $0 $1 "$INSTDIR\*.*"
  next_entry:
    StrCmp $1 "" empty_install
    StrCmp $1 "." skip_entry
    StrCmp $1 ".." skip_entry
    FindClose $0
    SetErrorLevel 1
    Abort
  skip_entry:
    FindNext $0 $1
    Goto next_entry
  empty_install:
    FindClose $0
    Return
  owned_install:
    FileOpen $0 "$INSTDIR\.delta-install-marker" r
    FileRead $0 $1
    FileClose $0
    StrCmp $1 "DELTA_BACKUPPER_INSTALL_V1$\r$\n" valid_install
    SetErrorLevel 1
    Abort
  valid_install:
FunctionEnd
Function un.onInit
  FileOpen $0 "$INSTDIR\.delta-install-marker" r
  IfErrors invalid_uninstall
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "DELTA_BACKUPPER_INSTALL_V1$\r$\n" 0 invalid_uninstall
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "InstallLocation"
  StrCmp $1 "$INSTDIR" valid_uninstall
  invalid_uninstall:
    MessageBox MB_ICONSTOP "Cannot verify this installation directory. No files were removed." /SD IDOK
    SetErrorLevel 1
    Abort
  valid_uninstall:
FunctionEnd
Section "Delta Backupper"
Call .onVerifyInstDir
@@DELTA_INSTALL_FILES@@
SetOutPath "$INSTDIR"
FileOpen $0 "$INSTDIR\.delta-install-marker" w
FileWrite $0 "DELTA_BACKUPPER_INSTALL_V1$\r$\n"
FileClose $0
WriteUninstaller "$INSTDIR\Uninstall.exe"
CreateDirectory "$SMPROGRAMS\Delta Backupper"
CreateShortcut "$SMPROGRAMS\Delta Backupper\Delta Backupper.lnk" "$INSTDIR\Delta Backupper.exe" "" "$INSTDIR\Delta Backupper.exe" 0
CreateShortcut "$SMPROGRAMS\Delta Backupper\Uninstall.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "DisplayName" "Delta Backupper"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "DisplayVersion" "${DELTA_VERSION}"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "Publisher" "Delta Backupper contributors"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "DisplayIcon" "$INSTDIR\Delta Backupper.exe,0"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "InstallLocation" "$INSTDIR"
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "NoModify" 1
WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper" "NoRepair" 1
nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install-path.ps1" -InstallDirectory "$INSTDIR" -Mode Install'
Pop $0
Pop $1
StrCmp $0 "0" install_path_ready
MessageBox MB_ICONEXCLAMATION "The delta command was not added to PATH. Run $INSTDIR\bin\delta.exe." /SD IDOK
SetErrorLevel 1
Quit
install_path_ready:
SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
SetErrorLevel 0
SectionEnd
Section "Uninstall"
; This installer is 32-bit; the desktop COM activator lives in the 64-bit CLSID view.
StrCpy $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
StrCpy $2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
nsExec::ExecToStack '"$2" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\notification-registration.ps1" -Mode Remove -InstallDirectory "$INSTDIR"'
Pop $0
Pop $1
StrCmp $0 "0" uninstall_notifications_ready
MessageBox MB_ICONSTOP "Cannot safely remove the notification registration. Uninstallation was cancelled." /SD IDOK
SetErrorLevel 1
Abort
uninstall_notifications_ready:
nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install-path.ps1" -InstallDirectory "$INSTDIR" -Mode Uninstall'
Pop $0
Pop $1
StrCmp $0 "0" uninstall_path_ready
MessageBox MB_ICONSTOP "Cannot safely remove the PATH entry. Uninstallation was cancelled." /SD IDOK
SetErrorLevel 1
Abort
uninstall_path_ready:
SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
Delete "$SMPROGRAMS\Delta Backupper\Delta Backupper.lnk"
Delete "$SMPROGRAMS\Delta Backupper\Uninstall.lnk"
RMDir "$SMPROGRAMS\Delta Backupper"
DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Delta Backupper"
@@DELTA_UNINSTALL_FILES@@
@@DELTA_REMOVE_DIRECTORIES@@
Delete "$INSTDIR\Uninstall.exe"
Delete "$INSTDIR\.delta-install-marker"
RMDir "$INSTDIR"
SetErrorLevel 0
SectionEnd
