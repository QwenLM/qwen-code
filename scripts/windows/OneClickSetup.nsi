Unicode true
Name "Qwen Local Desktop Setup"
OutFile "Qwen-Local-Setup.exe"
RequestExecutionLevel user
InstallDir "$TEMP\\QwenLocalSetup"
ShowInstDetails show
Section "Install Qwen Desktop and local AI"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=QwenDesktopInstaller.exe" "desktop-package\\QwenDesktopInstaller.exe"
  File "desktop-package\\Setup-Local-Qwen.ps1"
  DetailPrint "Installing Ollama, local model and official Qwen Desktop..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\\Setup-Local-Qwen.ps1"'
  Pop $0
  StrCmp $0 "0" success
  MessageBox MB_ICONSTOP "Setup did not finish successfully. Exit code: $0"
  Abort
success:
  DetailPrint "Setup finished."
SectionEnd
