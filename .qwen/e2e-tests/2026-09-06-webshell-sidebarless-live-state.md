# Web Shell sidebarless live prompt state

## Baseline

The global CLI cannot reproduce a host-only `sidebar={false}` configuration.
A focused Web Shell reproduction at `f6f237233b8c` mounted the prompt bridge
without the sidebar or Sessions panel: the catalog fallback ran once, the
live-state endpoint was never called, and the bridge remained non-authoritative.

## Manual check

1. Open the VS Code companion on a trusted workspace and start a prompt whose
   tool call stays silent for longer than three seconds.
2. Keep the Sessions panel closed.
3. Verify `GET /workspaces/:cwd/sessions/live-state` continues polling and the
   conversation indicator remains active until the daemon reports the prompt
   finished.
4. Repeat with an untrusted workspace and verify no qualified live-state request
   is sent.

## Automated coverage

`App.test.tsx` verifies that a sidebarless host enables live-state polling for
the connected trusted workspace. Existing provider tests verify that daemon
authority keeps a silent turn active and settles it when the authority clears.
