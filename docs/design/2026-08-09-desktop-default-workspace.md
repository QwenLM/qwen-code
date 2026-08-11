# Desktop default workspace

## Motivation

The Tauri app currently blocks first launch on a folder picker because its bundled `qwen serve` process needs a primary workspace. The previous Electron app instead created a protected `Qwen` conversation workspace and let users add projects after entering the app.

## Design

Desktop resolves its primary workspace in this order:

1. `QWEN_DESKTOP_WORKSPACE`
2. The workspace saved in `desktop-state.json`
3. `~/Documents/Qwen`, matching the Electron app and created on first launch

Only the default directory is created automatically. A missing environment-provided or saved workspace continues through the existing recovery page rather than recreating a user project path.

The default remains the stable daemon primary. Project directories continue to use the Web Shell's existing dynamic workspace registration and switching, so adding a project does not restart Node. The bootstrap folder picker remains available only for recovery.

## Compatibility

Existing Tauri users retain their saved primary workspace. Existing `Documents/Qwen` content is reused without migration or deletion. The runtime command, daemon, Web Shell, and Local Control lifecycle remain unchanged.
