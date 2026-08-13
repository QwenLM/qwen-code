!define ELECTRON_INSTALL_KEY "Software\821b18a9-7c63-5bb4-9e20-51ba63d5ecc3"
!define ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\821b18a9-7c63-5bb4-9e20-51ba63d5ecc3"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "${ELECTRON_INSTALL_KEY}" "InstallLocation"
  ReadRegStr $R1 HKCU "${ELECTRON_UNINSTALL_KEY}" "DisplayName"
  StrCpy $R1 $R1 17
  ${If} $R0 != ""
  ${AndIf} $R1 == "Qwen Code Desktop"
  ${AndIf} ${FileExists} "$R0\Uninstall Qwen Code Desktop.exe"
    ExecWait '"$R0\Uninstall Qwen Code Desktop.exe" /currentuser /S --updated _?=$R0' $R2
    ${If} $R2 != 0
      Abort "Could not remove the previous Qwen Code Desktop installation."
    ${EndIf}
  ${EndIf}
!macroend
