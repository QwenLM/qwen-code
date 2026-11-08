!define ELECTRON_INSTALL_KEY "Software\821b18a9-7c63-5bb4-9e20-51ba63d5ecc3"
!define ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\821b18a9-7c63-5bb4-9e20-51ba63d5ecc3"

; Stops the bundled Node runtime that outlived a desktop build released before
; the app-side runtime stop: that build registers no updater `on_before_exit`
; hook, and the updater's `process::exit(0)` skips `RunEvent::Exit`, so its
; daemon still maps $INSTDIR\runtime\qwen-code\node\node.exe when the copy
; stage replaces that file (#15933). The installer that performs that
; transition update is this one, so clearing the lock is its job.
;
; Processes are matched by image path, not by name: `node.exe` processes the
; user runs from anywhere else are left alone. An interactive `qwen` session
; started from this installation runs that same image and holds the same lock,
; so it is stopped too -- the copy cannot succeed while it runs. NSIS cannot
; enumerate by image path itself (`nsis_tauri_utils` matches names only, and
; `wmic` no longer ships with current Windows), so the enumeration goes through
; PowerShell's CIM client. Any result other than exit code 0 -- including a
; lock surviving the wait or nsExec failing to start PowerShell -- stops the
; install before the copy stage.
!macro StopBundledRuntime
  StrCpy $R0 "$INSTDIR\runtime\qwen-code\node\node.exe"
  ${If} ${FileExists} "$R0"
    System::Call 'kernel32::SetEnvironmentVariableW(t "QWEN_CODE_DESKTOP_NODE_EXE", t "$R0")'
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$exe=$$env:QWEN_CODE_DESKTOP_NODE_EXE;if(-not $$exe){exit 0};$$root=[IO.Path]::GetDirectoryName($$exe)+[IO.Path]::DirectorySeparatorChar;$$locked=$$true;foreach($$round in 1..2){Get-CimInstance Win32_Process|Where-Object{$$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root,[StringComparison]::OrdinalIgnoreCase)}|ForEach-Object{Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue};$$deadline=(Get-Date).AddSeconds(5);while((Get-Date) -lt $$deadline){try{$$stream=[IO.File]::Open($$exe,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::Read);$$stream.Close();$$locked=$$false;break}catch{Start-Sleep -Milliseconds 250}};if(-not $$locked){break}};if($$locked){exit 1}else{exit 0}"'
    Pop $R1
    ; Clearing the lock is the point of this step, and failing here beats
    ; letting the copy stage offer Ignore, which leaves a half-replaced
    ; runtime nobody verifies. A silent install must not block on a dialog.
    ${If} $R1 != "0"
      ${If} ${Silent}
        Abort
      ${Else}
        Abort "Qwen Code could not stop the bundled runtime that locks $R0. Close every Qwen Code window, then run the installer again."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Runs before the Tauri installer template's copy stage.
  !insertmacro StopBundledRuntime

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
