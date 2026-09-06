# Electron-to-Tauri desktop update bridge

## Context

The legacy Electron desktop reads `latest-mac.yml`, `latest.yml`, or `latest-linux.yml` from the fixed `desktop-latest` release. The Tauri desktop reads `desktop-latest.json` from the same release. A stable release can therefore expose both update formats over the same Tauri installers without building Electron again.

## Compatibility contract

The Tauri bundle keeps the legacy product name and application identifier. With `electron_bridge` enabled, the release workflow publishes:

- `latest-mac.yml` plus ZIP and DMG payloads for Apple Silicon and Intel;
- `latest.yml` plus the x64 NSIS installer for Windows;
- `latest-linux.yml` plus the x64 AppImage for Linux;
- `desktop-latest.json` for Tauri clients on all platforms.

The macOS ZIPs are created from the signed and notarized Tauri app. Windows removes the matching per-user Electron installation through its registered uninstaller before Tauri writes files, preserving user data and avoiding duplicate uninstall entries. Linux AppImage updates replace the current AppImage directly.

## Release usage

Run `Desktop Release` for the next stable version with `electron_bridge=true`, `dry_run=false`, `draft=false`, and `prerelease=false`. The bridge is one-time: the fixed `desktop-latest` release retains the three Electron manifests and payloads when later Tauri-only releases update `desktop-latest.json`.

Before publishing, verify each signed legacy client can install the bridge and that the resulting Tauri app can then update to a newer Tauri release. Do not remove the bridge assets from `desktop-latest` while legacy Electron installations remain supported.
