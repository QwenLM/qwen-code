# Operator verification (Windows)

The `launcher-app` Electron shell wires the main process (`wsl.exe` +
`qwen-rc`) to a renderer UI. Its Electron-runtime behavior — `BrowserWindow`
creation, `contextBridge`, IPC round-trips, `wsl.exe` subprocess spawning —
requires a real Windows host with a GUI and a WSL distro installed, so it
cannot be exercised in Linux CI. The pure logic (`statusPoll.ts`'s reducer,
plus the Task 1/2 parsers) is unit-tested; everything below is checked by a
human operator after building on Windows.

Run `npm run build && npm start` (or `npm run start`) from
`packages/launcher-app` on a Windows machine with WSL + a qwen-rc-provisioned
distro, then confirm:

## Task 3 slice (this task)

- [ ] **App launches** — `npm start` opens the Electron app with no console
      errors in the main-process terminal.
- [ ] **Window opens** — a `BrowserWindow` appears at a reasonable default
      size (960x720) on first run, sized/positioned per the emitted
      `<userData>/launcher-app.json` `windowBounds` on subsequent runs.
- [ ] **Window bounds persist across restarts** — resize/move the window,
      quit, relaunch: it reopens at the same position/size.
- [ ] **Distro picker populates from `listDistros`** — the renderer's distro
      list (once Task 4 wires the picker) matches `wsl.exe -l -q` output for
      the machine.
- [ ] **Choosing a distro persists it** — after `setDistro`, restarting the
      app targets the same distro (`<userData>/launcher-app.json` has a
      `distro` field) without losing previously-persisted `windowBounds`.
- [ ] **Status dot updates** — with the target distro's `qwen-rc` stopped,
      the status poll reports not-running; after `qwen-rc up` (via the UI or
      manually inside WSL), the dot flips to running within one poll interval
      (~3s) and shows the reported URL.
- [ ] **No devtools/nodeIntegration leakage** — `webPreferences` show
      `contextIsolation: true`, `nodeIntegration: false`; `window.require` is
      undefined in the renderer devtools console; only `window.launcher` is
      exposed.
- [ ] **Security: no secret persistence** — after entering an API key and
      pairing code (once Task 4's UI exists) and using the app for a
      session, `<userData>/launcher-app.json` contains **no** API key and
      **no** pairing code — only `distro` and `windowBounds`. The pairing
      code and `OPENAI_API_KEY` should appear on disk only in the WSL-side
      `~/.qwen/.env` (managed by `envConfig.ts`), never in Electron's
      `userData`, never in any log file, and never printed to the main- or
      renderer-process console.

## Notes for the operator

- The main-process log (Electron's stdout) should never print the pairing
  code or `OPENAI_API_KEY` value; if you see either, that is a regression —
  file it against `ipc.ts`/`main.ts`.
- Logs streamed via `startLogs()`/`onLog` come from `journalctl --user -u
qwen-rc-gateway -f`; verify lines arrive in near-real-time and stop when
  `stopLogs()` is called (e.g., on window close) — no orphaned `wsl.exe`
  child processes should remain after the app quits (check Task Manager).
