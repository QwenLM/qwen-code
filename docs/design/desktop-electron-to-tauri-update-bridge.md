# Electron-to-Tauri desktop update bridge

## Context

The last published desktop release, `desktop-v0.0.5`, is an Electron app named `Qwen Code Desktop` with bundle identifier `com.alibaba.qwen-code`. Its macOS updater reads `latest-mac.yml` from the fixed `desktop-latest` release and installs a ZIP archive.

The new desktop shell is a Tauri app. It currently uses a different product name and bundle identifier and publishes `desktop-latest.json`, so the existing Electron app cannot discover or replace it.

## Goals

- Let signed macOS Electron `0.0.5` installations update directly to the first stable Tauri release.
- Preserve the existing macOS application identity so the updater replaces the installed app bundle.
- Keep Tauri's signed updater feed for all releases after the migration.
- Make the bridge opt-in and one-time; later releases must not need Electron build tooling.

## Non-goals

- Migrating Electron settings, sessions, or workspace state. The Tauri app may ask for a workspace on first launch.
- Bridging Windows or Linux Electron installations.
- Generating Electron differential blockmaps. Electron updater falls back to the checksum-verified full ZIP.

## Compatibility contract

The Tauri bundle uses the legacy macOS identity:

- product name: `Qwen Code Desktop`
- bundle identifier: `com.alibaba.qwen-code`
- artifact prefix: `Qwen-Code-Desktop`
- signing identity: the existing Developer ID Application certificate

The bridge release must be newer than `0.0.5`. It publishes two updater views over the same signed app bundles:

1. `latest-mac.yml` points legacy Electron clients at `Qwen-Code-Desktop-arm64.zip` or `Qwen-Code-Desktop-x64.zip`.
2. `desktop-latest.json` points Tauri clients at the signed Tauri updater archives.

The ZIP is created from the already signed and notarized `.app`; it is not rebuilt by Electron tooling.

## Release flow

`Desktop Release` gains an `electron_bridge` input, disabled by default.

- All macOS builds continue to produce the Tauri app, DMG, updater archive, and updater signature.
- When `electron_bridge` is enabled, each macOS build also creates a legacy-compatible ZIP.
- The publish job generates `latest-mac.yml` from the two ZIPs and two DMGs.
- A stable bridge release uploads the legacy metadata and payloads to `desktop-latest` together with `desktop-latest.json`.
- Later stable releases leave `electron_bridge` disabled. Updating `desktop-latest.json` does not remove the bridge files, so Electron installations that return later can still cross to Tauri.

Draft and prerelease runs may build and publish bridge artifacts for inspection, but they never update the stable feed.

## Signing credentials

The repository already stores the Electron-era Apple certificate and App Store Connect API key under `MAC_CSC_*` and `APPLE_NOTARY_*` secret names. The workflow accepts those names as fallbacks for the newer Tauri names, so the Developer ID identity remains unchanged.

Tauri updater artifacts additionally require `TAURI_SIGNING_PRIVATE_KEY`; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is only needed for an encrypted private key. The private key must match the public key in the Tauri configuration before the first published Tauri release.

## Validation

Automated release-helper tests verify:

- the legacy application identity,
- exact bridge artifact selection,
- SHA-512 and size values in `latest-mac.yml`,
- failure when a required bridge artifact is missing,
- existing Tauri updater manifest and version synchronization behavior.

Before the stable release, install the signed `desktop-v0.0.5` arm64 and x64 builds, point them at an isolated bridge feed, and verify both `0.0.5 -> Tauri bridge` and `Tauri bridge -> newer Tauri` updates.
