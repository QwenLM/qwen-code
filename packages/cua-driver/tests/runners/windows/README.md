# Windows Rust runner

This directory contains the Windows Rust harness runner for an interactive user
desktop, including the Azure RDP/scheduled-task validation environment.

Run from `packages/cua-driver` in an RDP or console session:

```powershell
.\tests\runners\windows\run-all.ps1
.\tests\runners\windows\run-all.ps1 -RequireGui
```

The runner builds repo-local Windows fixtures and runs the Rust unit and typed
harness matrix.
It intentionally skips optional external-app suites such as LibreOffice because
those require extra software on the environment image.
