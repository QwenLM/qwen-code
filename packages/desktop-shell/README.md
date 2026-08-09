# Qwen Code desktop shell

This package is an isolated Tauri 2 shell around the existing Web Shell. It does not contain a second UI.

## Runtime layout

`npm run build:runtime` prepares `runtime/qwen-code/` with:

- the current platform's Node.js runtime,
- the bundled `qwen` CLI,
- the built Web Shell under `lib/web-shell/`.

The Tauri app starts `qwen serve` on an ephemeral loopback port with a per-launch bearer token, waits for `/health`, and then opens that same daemon-served Web Shell in the native window.

Use **Control → Local Control…** to temporarily share that live daemon with a phone on the same Wi-Fi. The app displays a QR code, keeps the computer awake while sharing is enabled, and closes the LAN gateway when the control window closes or the user turns it off.

## Local development

From this directory:

```bash
npm install --workspaces=false
npm run build:runtime --workspaces=false
npm test --workspaces=false
npm run dev --workspaces=false
```

Use `QWEN_DESKTOP_WORKSPACE=/absolute/path` to override the initial workspace. The app otherwise restores its saved primary workspace or creates `~/Documents/Qwen` on first launch. Add and switch project workspaces from the Web Shell after startup.

## Releases

The `Desktop Release` workflow builds signed updater artifacts when `dry_run` is disabled. Published releases require the Tauri updater private key. macOS releases also require Apple signing and notarization credentials.

The first stable Tauri release may set `electron_bridge=true` to publish the macOS ZIPs and `latest-mac.yml` consumed by Electron `0.0.5`. Leave the input disabled for later releases; the fixed `desktop-latest` release retains the bridge assets while `desktop-latest.json` advances independently.

The macOS workflow accepts either the Tauri-era `APPLE_*` certificate and notarization secrets or the existing `MAC_CSC_*` and `APPLE_NOTARY_*` secrets. `TAURI_SIGNING_PRIVATE_KEY` must match the public key in `src-tauri/tauri.conf.json`.
