# Desktop Auto-Update Design

## Goal

Enable stable-channel desktop auto-updates for packaged OpenWork and Qwen Code desktop builds using public GitHub Releases and `electron-updater`.

## Scope

The first version supports stable releases only. Draft releases, prereleases, nightly builds, staged rollouts, and forced updates are intentionally out of scope.

## Pre-Implementation State

Before this change, the desktop app already had most of the runtime surface:

- `apps/electron/src/main/auto-update.ts` wraps `electron-updater`, broadcasts update state, and checks on launch when a packaged build has a brand update source.
- `apps/electron/src/main/handlers/system.ts` exposes update RPC handlers.
- `apps/electron/src/transport/channel-map.ts` exposes renderer API methods for update RPC and events.
- `apps/electron/src/renderer/hooks/useUpdateChecker.ts` returned a disabled stub.
- `apps/electron/electron-builder.yml` had no `publish` configuration, so release builds did not produce update feed metadata.

## Brand-Owned Update Source

Update source configuration belongs in `packages/shared/src/branding.ts` with the rest of desktop brand metadata. Each brand owns its release location:

- `openwork` uses `modelstudioai/openwork`.
- `qwen-code` uses `QwenLM/qwen-code`.

The brand config exposes a GitHub update source with `provider`, `owner`, `repo`, and `releasePageUrl`. `scripts/electron-builder-config.ts` reads it and emits the `publish` block in `apps/electron/electron-builder.generated.yml`. Runtime code reads the same brand update source for logs and fallback release-page actions.

## Release Flow

The existing desktop release workflow remains responsible for uploading assets to GitHub Releases. `electron-builder` should generate updater metadata, but the workflow continues to publish assets itself.

Expected assets include platform installers and feed files:

- macOS: zip, dmg, blockmaps, `latest-mac.yml`
- Windows: NSIS exe, blockmap, `latest.yml`
- Linux: AppImage, blockmap, Linux feed metadata if generated

Only non-draft, non-prerelease GitHub Releases are expected to reach stable-channel users.

## Runtime Flow

Packaged desktop builds enable auto-update. Development builds stay disabled to avoid replacing local development apps.

On launch, the app checks for updates and auto-downloads available stable updates. It does not force an immediate restart. Once a download is ready, the renderer can prompt the user to restart; if the user quits normally after a download is ready, `electron-updater` may apply the update on quit using its default behavior. Manual checks in Settings use the same update API and can show dismissed versions.

## UI

The first UI lives in `Settings > App` as an Updates section:

- Show current version.
- Let users manually check for updates.
- Show download progress.
- Show a restart button once the update is ready.
- Show concise errors in Settings while logging details in the main process.

Global interruption is deliberately minimal. Startup checks stay silent unless an update is ready.

## Testing

Use focused local checks first:

- Generate builder config for `openwork` and `qwen-code`, verifying each brand emits the right `publish` config.
- Typecheck the Electron app.
- Run i18n parity checks after adding Settings copy.

CI dry runs validate asset and metadata generation. A true update test requires installing an older packaged release, publishing a newer non-draft stable release, and confirming the old app downloads and installs the new version.
