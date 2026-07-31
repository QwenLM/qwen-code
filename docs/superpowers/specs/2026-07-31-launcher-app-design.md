# Design — launcher control panel (`packages/launcher-app`)

**Goal:** A one-window Windows app to Start/Stop the remote-control stack,
watch its status, connect a phone (URL + QR + pairing code), tail logs, and
set the Lovelace model endpoint — by driving the Spec-1 `qwen-rc up`/`down`/
`status` launcher over `wsl.exe`. Spec 2 of the mobile-launcher work; Spec 1
(the `qwen-rc` orchestrator, PR #14) is its engine.

**Scope:** a new fork-local package `packages/launcher-app` (Electron).
**Not** an OpenSpec change — unlike Spec 1 (gateway CLI tooling), this is a
standalone desktop app, so it ships as a fork package with a superpowers
design + plan + SDD, no OpenSpec/PR.

## The honest build/test boundary

This app _runs on Windows_ and its core action is `wsl.exe -- qwen-rc …`, but
the dev/build environment is WSL/Linux. So:

- **Node-testable here (Vitest):** every main-process module, behind an
  injected `RunWsl` exec seam (exactly like Spec 1's `RunCommand`) — the WSL
  client, log tailer, env-config reader/writer, and the status-poll logic.
- **Windows-only, operator-verified (no automated test here):** the Electron
  shell (BrowserWindow, IPC, preload), the renderer UI, real `wsl.exe`, and
  packaging. The design pushes all logic into the testable core and keeps the
  shell thin and hand-verifiable.

Spec 1's D-Bus/`XDG_RUNTIME_DIR` hint was built for exactly this
`wsl.exe -- qwen-rc up` non-login-shell path, so that integration risk is
already surfaced by the engine.

## Architecture — thin Electron shell over a Node-testable core

### Main process (`src/main/`) — all logic, behind the `RunWsl` seam

- **`wsl.ts`** — the seam: `type RunWsl = (argv: string[]) => Promise<{ code,
stdout, stderr }>`; real impl spawns `wsl.exe -d <distro> -- bash -lc
"<cmd>"` (a **login shell** so `qwen-rc` is on PATH — an integration point
  to verify on Windows). `listDistros(run)` parses `wsl.exe -l -q`.
- **`launcherClient.ts`** — `up(run,distro)`, `down(run,distro)`,
  `status(run,distro)`: invoke `qwen-rc <cmd> --json`, parse the metadata
  object (`{ status, url, host, port, unit, certExpiry }` — no pairing code,
  by Spec 1's design). `readPairingCode(run,distro)`: `cat
~/.qwen/rc/owner-bootstrap.code` (the 0600 owner secret the `--json`
  surface deliberately omits).
- **`logs.ts`** — a streamer over `journalctl --user -u qwen-rc-gateway -f`
  (+ the up/down output), forwarding lines to the renderer via IPC; started/
  stopped by the renderer, torn down on window close.
- **`envConfig.ts`** — read/write the Lovelace provider vars in `~/.qwen/.env`
  via WSL (`cat` to read; write via `bash -lc "cat > …"`/`tee`), parsing and
  serializing dotenv: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`.
  Only these keys are touched; other `.env` lines are preserved.
- **`appConfig.ts`** — the app's own settings (chosen distro, window state) in
  Electron `userData` (a small JSON; no secrets).
- **`ipc.ts` + `main.ts`** — create the window, load the preload
  `contextBridge` API, wire IPC handlers to the modules, run a status-poll
  loop (interval, cancels on close). `preload.ts` exposes a typed, minimal
  surface (`window.launcher.{up,down,status,pairingCode,logs.on,config.get,
config.save,distros}`) — no direct Node access in the renderer.

### Renderer (`src/renderer/`) — plain HTML/CSS/JS, esbuild-bundled

(Mirrors `vscode-ide-companion`'s esbuild approach; `qrcode` renders the QR
**image** from the connect URL.) One window, three tabs:

- **Control:** a Start/Stop toggle (calls `up`/`down`), a status dot fed by
  the poll, the connect URL, a rendered QR, and the pairing code (fetched via
  `pairingCode()`; shown, never persisted by the app).
- **Logs:** a scrolling pane fed by the log stream.
- **Config:** a form (Lovelace endpoint + API key + model). **Save** writes
  `~/.qwen/.env`; because qwen reads env at boot, Save offers to restart the
  stack (`down`→`up`) so the change takes effect.

## Distro handling

Default distro (invoke `wsl.exe` without `-d`) unless overridden. First run:
enumerate `wsl.exe -l -q`, let the operator pick, persist the choice in
`appConfig`. All `RunWsl` calls carry the chosen distro.

## Error / edge handling

- `up` returning `ok:false` → surface its `hint` verbatim (the Spec-1 engine
  already classifies: needs-auth URL, not-installed, needs-operator,
  https-not-enabled, D-Bus/`XDG_RUNTIME_DIR`) in a status banner.
- `wsl.exe` absent / distro not found → a clear "WSL not available" state.
- Pairing code not yet present (gateway still booting) → Spec 1's poll makes
  `up` wait; if still absent, the app shows "gateway starting — check status".
- Any `RunWsl` nonzero → shown, never silently swallowed.

## Security

- The app displays the owner **pairing code** and holds the **`OPENAI_API_KEY`**
  (written to `~/.qwen/.env`, mode 0600 via WSL). It MUST NOT log either or
  persist them in `appConfig`/logs. The pairing code is fetched on demand and
  only rendered; the API key lives only in the `.env` file it manages.
- The app runs on the operator's own machine and targets their own WSL — it
  is the owner's control surface, not a network service.

## Build & packaging

- **esbuild** bundles `main`/`preload`/`renderer` (like `vscode-ide-companion`).
- **Dev:** `electron .` against the built bundle.
- **Use:** an `electron-builder` **portable / unpacked Windows** target.
- **Deferred:** installer, code-signing, auto-update.

## Testing

- **Unit (here):** `wsl.ts` (argv composition / `-l -q` parse),
  `launcherClient.ts` (up/down/status/pairing-code parsing + error mapping),
  `envConfig.ts` (dotenv read/merge/write preserving other keys),
  `logs.ts` (line framing), the status-poll reducer — all with a stubbed
  `RunWsl`.
- **Operator-verified (Windows):** launch, Start→scan→connect a phone,
  Config→Save→restart, logs stream. These are the first-run checklist, not
  automated (real `wsl.exe`/Electron).

## Implementation phasing (fork, `packages/launcher-app`)

- **B — package scaffold + `RunWsl` seam + `wsl.ts`/`launcherClient.ts`**
  (+ unit tests). No Electron yet — pure Node core.
- **C — `envConfig.ts` + `logs.ts`** (+ unit tests): dotenv read/merge/write;
  log line framing.
- **D — Electron shell:** `main.ts`/`preload.ts`/`ipc.ts` + `appConfig.ts` +
  the status-poll loop. Thin; the poll reducer is unit-tested, the wiring is
  operator-verified.
- **E — renderer:** the 3-tab UI + QR; esbuild build config; `electron .` dev
  - a portable Windows build target. Operator-verified.
