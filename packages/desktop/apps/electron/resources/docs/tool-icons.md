# Tool Icons Configuration

Customize the icons shown next to CLI commands in chat activity rows.

## Overview

When the agent runs a CLI command (e.g., `git status`, `npm install`), the app resolves the command name to a branded icon. The mapping is defined in:

```
~/.craft-agent/tool-icons/tool-icons.json
```

Icon files (`.png`, `.ico`, `.svg`, `.jpg`) live in the same directory alongside the JSON config.

## Schema

```json
{
  "version": 1,
  "tools": [
    {
      "id": "git",
      "displayName": "Git",
      "icon": "git.ico",
      "commands": ["git"]
    }
  ]
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Schema version (currently `1`) |
| `tools` | array | Array of tool entries |
| `tools[].id` | string | Unique identifier (slug format, e.g. `"git"`) |
| `tools[].displayName` | string | Human-readable name shown in the UI |
| `tools[].icon` | string | Icon filename relative to the tool-icons directory |
| `tools[].commands` | string[] | CLI command names that map to this tool |

## Adding a Custom Tool

1. Place your icon file in `~/.craft-agent/tool-icons/` (any of: `.png`, `.ico`, `.svg`, `.jpg`)
2. Add an entry to `tool-icons.json`:

```json
{
  "id": "my-tool",
  "displayName": "My Tool",
  "icon": "my-tool.png",
  "commands": ["my-tool", "mt"]
}
```

3. Restart the app or start a new chat for changes to take effect.

## Command Matching

The command parser handles complex bash strings:

- **Simple commands**: `git status` matches `git`
- **Chained commands**: `git add . && npm publish` matches the first recognized tool
- **Environment prefixes**: `NODE_ENV=prod npm test` matches `npm`
- **Sudo/time prefixes**: `sudo docker ps` matches `docker`
- **Path prefixes**: `/usr/local/bin/node` matches `node`
- **Pipes**: `git log | head -10` matches `git`

The first recognized command in the string determines the icon.

## Multiple Commands per Tool

A tool can match multiple command names:

```json
{
  "id": "npm",
  "displayName": "npm",
  "icon": "npm.png",
  "commands": ["npm", "npx"]
}
```

## Bundled Defaults

The app ships with ~57 built-in tool icons covering common CLI tools (git, npm, docker, python, rust, aws, etc.). These are seeded on first run and are never overwritten, so your customizations are preserved across updates.

## Icon File Guidelines

- **Recommended size**: 64x64 or 128x128 pixels
- **Formats**: PNG (preferred), ICO, SVG, JPG
- **Background**: Transparent PNG works best
- Icons are displayed at 20x20px in the UI, so keep them simple and recognizable
