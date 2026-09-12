# VS Code session source switch E2E plan

## Scenario

1. In one workspace, create one session in the VS Code Companion sidebar and one from the terminal or browser Web Shell.
2. Open the sidebar's session-history dialog and confirm it initially shows the VS Code session.
3. Switch to **Terminal / Web** and confirm the other session appears without rename or delete controls.
4. Open that session, reload the extension host, and confirm it remains accessible without moving into the VS Code source list.
5. Create a new session from the VS Code header and confirm it appears in the VS Code source list.

## Expected result

- Each source view contains only its scoped catalog plus allowlisted pre-cutover sessions in the VS Code view.
- Switching sources replaces the page; a late response from the previous source cannot overwrite it.
- Opening a Terminal / Web session never rewrites its creator attribution, including after the sidebar re-bootstraps.
- New VS Code sessions retain VS Code attribution.

## Automated coverage

The focused webview tests cover scoped requests, the legacy allowlist, stale responses, read-only foreign rows, re-bootstrap attribution, and new-session attribution. A real VS Code host remains a manual validation boundary.

The global `qwen` CLI has no companion history dialog, so a standalone CLI dry run is not a faithful baseline for this UI scenario.
