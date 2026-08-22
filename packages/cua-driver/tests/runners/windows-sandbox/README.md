# Legacy Windows Sandbox runner

This runner exists only for local smoke checks and must not be treated as the
canonical Windows desktop test entrypoint.

Run it from `packages/cua-driver` on a Windows host with Windows Sandbox enabled:

```powershell
.\tests\runners\windows-sandbox\run-tests-in-sandbox.ps1
.\tests\runners\windows-sandbox\run-tests-in-sandbox.ps1 harness_wpf
```

The host script builds selected Rust test binaries and Windows fixtures, maps
`packages/cua-driver` into the sandbox as `C:\cua-driver`, and streams logs from the
inside-sandbox runner.

For current GUI validation, use the interactive Azure RDP/scheduled-task runner
described by the Windows Rust test runner. Keep this sandbox path as a local
smoke check only.
