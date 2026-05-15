---
name: desktop-reproduce
description: Use when reproducing, investigating, or improving local desktop app behavior, especially the Codex desktop client or other Electron/Chromium apps distributed as binaries. Prioritizes Codex-client-aware evidence: CDP renderer state, Computer Use observations, accessibility tree, screenshots, logs, crash reports, workspace/thread/plugin context, and clear desktop feature optimization opportunities.
---

# Desktop Reproduce

Use this skill when the target is a local desktop app, not a CLI or normal web
app. It is optimized for the Codex desktop client and for apps where source may
be unavailable, such as a downloaded `.app`, `.exe`, or packaged Electron
build.

Use it for two related jobs:

- Reproduce or investigate desktop bugs with enough evidence for a developer to
  act.
- Study Codex client behavior and identify concrete opportunities to improve
  desktop-specific agent capabilities, such as app control, browser integration,
  local workspace handling, plugin/skill flows, permissions, diagnostics, or
  visual verification.

## Core principle

Prefer structured Codex client context over visual guessing:

1. If the app is Electron/Chromium and CDP is available, use CDP first.
2. Use Computer Use for native shell context: windows, menus, permission
   prompts, file pickers, focus, drag/drop, and OS dialogs.
3. For Codex, correlate renderer state with the visible client surface:
   thread, workspace, terminal, in-app browser, plugin/tool panels, approvals,
   notifications, and generated artifacts.
4. Fall back to black-box observation when CDP is unavailable.

CDP is not a replacement for Computer Use. CDP sees the renderer; Computer Use
sees the desktop.

## Safety defaults

- Start with read-only observation.
- Do not restart, quit, reset profile data, delete caches, or perform externally
  visible actions unless the user asked for it or approved it.
- Treat CDP output as potentially sensitive. Do not collect input values,
  tokens, cookies, or storage values unless the user explicitly requests it.
- Prefer a temporary app profile for reproduction, but verify whether the app
  actually honors the requested profile directory.
- Record exact commands, app version, OS version, and ports used.

## Workflow

### 1. Identify the app

Collect:

- App path and name.
- Version/build from app metadata when available.
- OS version, architecture, locale, and display setup when relevant.
- Whether the app appears to be Electron/Chromium.
- For Codex: active workspace, thread state, visible panels, relevant plugin or
  skill, local server URLs, terminal session state, and whether the issue is in
  the desktop shell, renderer UI, browser view, terminal, or agent/tool bridge.

On macOS, useful probes include:

```bash
plutil -p /Applications/App.app/Contents/Info.plist
ps aux | rg -i 'app-name|electron|chromium'
lsof -nP -iTCP -sTCP:LISTEN | rg -i 'app-name|electron'
```

### 2. Try CDP

First check whether an existing instance already exposes CDP:

```bash
curl -sS --max-time 2 http://127.0.0.1:9222/json/version
curl -sS --max-time 2 http://127.0.0.1:9222/json/list
```

If not, and it is safe to launch a separate instance, try a dedicated port:

```bash
open -n -a /Applications/App.app --args --remote-debugging-port=9333
```

For Electron apps, a temporary profile may help but must be verified:

```bash
open -n -a /Applications/App.app --args \
  --remote-debugging-port=9333 \
  --user-data-dir=/tmp/app-repro-profile
```

After launch, verify:

```bash
curl -sS http://127.0.0.1:9333/json/version
curl -sS http://127.0.0.1:9333/json/list
ps aux | rg 'remote-debugging-port|user-data-dir'
```

If helper processes still use the normal app data directory, note that the
profile was not fully isolated.

### 3. Capture CDP context

Use the bundled script for a read-only snapshot:

```bash
node .agents/skills/desktop-reproduce/scripts/cdp-snapshot.mjs \
  --endpoint http://127.0.0.1:9333 \
  --capture-ms 3000
```

Optional target selection:

```bash
node .agents/skills/desktop-reproduce/scripts/cdp-snapshot.mjs \
  --endpoint http://127.0.0.1:9333 \
  --target 'Codex|app://-' \
  --screenshot /tmp/desktop-repro.png
```

The snapshot includes runtime version, targets, current URL, document title,
DOM/control summary, accessibility summary, resource list, source map hints,
console events seen during capture, and network failures/status errors seen
during capture.

### 4. Capture desktop context

Use Computer Use or the local accessibility tooling to observe:

- Active app and window titles.
- Native menus, popovers, file pickers, permission prompts, and modals.
- Screenshot before and after each important step.
- Accessibility tree for stable element names and roles.
- For Codex: thread composer state, terminal output, in-app browser URL and
  viewport, plugin/tool panes, approval prompts, workspace file references,
  generated artifact previews, and any mismatch between what the agent believes
  happened and what the client displays.

Prefer element-based actions over coordinate-only actions when possible.

### 5. Evaluate Codex desktop opportunities

When the target is the Codex client, do not stop at "bug reproduced." Also
classify what the observation implies for desktop product quality:

- **Agent capability gap**: The agent cannot reliably inspect, click, type,
  scroll, upload, download, view media, or verify the result inside the client.
- **Bridge/tool gap**: Browser, Computer Use, terminal, file preview, plugin, or
  MCP state differs from what the agent can observe or control.
- **UX/debuggability gap**: The client hides key state, gives ambiguous errors,
  loses focus, obscures approvals, or makes it hard to connect a user-visible
  problem to logs or runtime state.
- **Reliability gap**: Reproduction depends on timing, stale windows, workspace
  changes, permissions, background processes, or inconsistent profile/session
  state.

For each gap, capture the smallest concrete example and the expected desktop
capability improvement. Prefer actionable wording such as "Expose current
in-app browser URL to the agent" or "Surface approval prompt state in the
accessibility tree."

### 6. Collect diagnostics

Look for:

- App logs under OS-standard locations.
- Crash reports.
- stderr/stdout if the app was launched from a terminal.
- System logs filtered by bundle id or process name.

On macOS, common locations:

```bash
ls ~/Library/Logs
ls ~/Library/Application\ Support
ls ~/Library/Logs/DiagnosticReports | rg -i 'app-name'
log show --last 10m --predicate 'process CONTAINS[c] "AppName"' --style compact
```

### 7. Produce the reproduction report

Use this shape:

```markdown
## App Runtime
- App:
- Version/build:
- OS:
- Launch command:
- Profile isolation:
- CDP endpoint:
- Renderer targets:

## Initial State
- Account/session:
- Project/file/data needed:
- Reset steps:

## Observations
- Desktop state:
- CDP state:
- Codex client state:
- Console/network issues:
- Logs/crashes:

## Repro Steps
1. ...
2. ...
3. ...

## Expected
...

## Actual
...

## Artifacts
- CDP snapshot:
- Screenshots/video:
- Logs:

## Desktop Optimization Opportunities
- Capability gap:
- Evidence:
- Proposed client improvement:
- Confidence:
```

## Mode selection

- **CDP mode**: Use when CDP attaches cleanly and the bug lives mostly inside
  the renderer.
- **Hybrid mode**: Default for Electron apps. Combine CDP snapshots with
  Computer Use observations/actions.
- **Black-box mode**: Use when CDP is unavailable. Rely on Computer Use,
  accessibility, screenshots, logs, and crash reports.
