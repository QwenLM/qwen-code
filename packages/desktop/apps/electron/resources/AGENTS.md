# Bundled Resources

This folder contains assets that are bundled with the Electron app and synced to the user's `~/.craft-agent/` directory on every launch.

## How It Works

1. **Build time**: `scripts/copy-assets.ts` copies this folder to `dist/resources/`
2. **Package time**: electron-builder includes `dist/resources/` in the app bundle
3. **Runtime**: `getBundledAssetsDir()` resolves paths to these bundled assets
4. **Launch**: Each asset type syncs to the user's home directory

## Asset Types

| Folder/File | Synced To | Sync Behavior |
|-------------|-----------|---------------|
| `docs/` | `~/.craft-agent/docs/` | Always overwrite on launch |
| `themes/` | `~/.craft-agent/themes/` | Always overwrite on launch |
| `permissions/` | `~/.craft-agent/permissions/` | Always overwrite on launch |
| `tool-icons/` | `~/.craft-agent/tool-icons/` | Always overwrite on launch |
| `config-defaults.json` | `~/.craft-agent/config-defaults.json` | Always overwrite on launch |

## Why Sync on Every Launch?

- Ensures users always have the latest defaults/docs when the app updates
- Consistent behavior between debug and release builds
- No stale configuration causing confusion

## Other Files (Not Synced)

These files are used by electron-builder or the app directly, not synced to user home:

| File | Purpose |
|------|---------|
| `icon.*` | App icons (icns, ico, png, svg) |
| `Assets.car` | Optional macOS compiled asset catalog |
| `dmg-background.*` | DMG installer background |
| `craft-logos/` | Branding assets |
| `source.png` | Default source icon |
| `generate-icons.sh` | Icon generation script |
| `bridge-mcp-server/` | Bundled MCP server for API source bridge |
| `session-mcp-server/` | Bundled MCP server for session tools |

## Single Source of Truth

The files in this folder are the **source of truth** for bundled defaults:
- Edit `config-defaults.json` here to change default settings
- Edit files in `docs/` to update documentation
- Edit files in `themes/` to update bundled themes

There is no TypeScript fallback - if the bundled JSON file is missing, the app will fail with a clear error.
