# Qwen Code desktop shell PoC

This package is an isolated Tauri 2 shell around the existing Web Shell. It does not contain a second UI.

## Runtime layout

`npm run build:runtime` prepares `runtime/qwen-code/` with:

- the current platform's Node.js runtime,
- the bundled `qwen` CLI,
- the built Web Shell under `lib/web-shell/`.

The Tauri app starts `qwen serve` on an ephemeral loopback port with a per-launch bearer token, waits for `/health`, and then opens that same daemon-served Web Shell in the native window.

## Local PoC

From this directory:

```bash
npm install --workspaces=false
npm run build:runtime --workspaces=false
npm test --workspaces=false
npm run dev --workspaces=false
```

Use `QWEN_DESKTOP_WORKSPACE=/absolute/path` to choose the initial workspace. Without it, the app shows a workspace picker on first launch.
