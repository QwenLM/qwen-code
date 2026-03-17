---
name: qwen-config
description: Complete guide for Qwen Code's configuration system. Invoke this skill when users ask about:
  - The structure, field meanings, or valid values of settings.json
  - Config file locations, priority order, or loading behavior
  - Permission configuration (allow/ask/deny rules, tool names, wildcards)
  - MCP server configuration (adding, modifying, troubleshooting)
  - Tool approval modes (plan/default/auto_edit/yolo)
  - Sandbox, Shell, context, model, UI, or any other config settings
  - Remind the user that most config changes require restarting qwen-code to take effect
---

# Qwen Code Configuration System Guide

You are helping the user configure Qwen Code. Below is a complete outline of the configuration system. Detailed reference docs are in the `references/` subdirectory.
**Based on the user's specific question, use the `read_file` tool to load the relevant reference document on demand** (concatenate the base directory of this skill with the relative path).

---

## Config File Locations & Priority

| Level   | Path                                                         | Description                                   |
| ------- | ------------------------------------------------------------ | --------------------------------------------- |
| User    | `~/.qwen/settings.json`                                      | Personal global config                        |
| Project | `<project>/.qwen/settings.json`                              | Project-specific config, overrides user level |
| System  | macOS: `/Library/Application Support/QwenCode/settings.json` | Admin-level config                            |

**Priority** (highest to lowest): CLI args > env vars > system settings > project settings > user settings > system defaults > hardcoded defaults

**Format**: JSON with Comments (supports `//` and `/* */`), with environment variable interpolation (`$VAR` or `${VAR}`)

---

## settings.json Schema Overview

All top-level config keys at a glance. Load the referenced doc for details:

### 1. `permissions` — Permission Rules (⭐ Frequently Used)

> **Reference doc**: `references/permissions.md`

Controls tool access with three-level priority: deny > ask > allow.

```jsonc
{
  "permissions": {
    "allow": ["Bash(git *)", "ReadFile"], // auto-approved
    "ask": ["Bash(npm publish)"], // always requires confirmation
    "deny": ["Bash(rm -rf *)"], // always blocked
  },
}
```

### 2. `mcpServers` — MCP Server Configuration (⭐ Frequently Used)

> **Reference doc**: `references/mcp-servers.md`

Configure Model Context Protocol servers. Transport type is inferred from fields automatically.

```jsonc
{
  "mcpServers": {
    "my-server": {
      "command": "node", // → stdio transport
      "args": ["server.js"],
      "env": { "API_KEY": "$MY_API_KEY" },
    },
  },
}
```

### 3. `tools` — Tool Settings (⭐ Frequently Used)

> **Reference doc**: `references/tools.md`

Approval mode, sandbox, shell behavior, tool discovery, etc.

```jsonc
{
  "tools": {
    "approvalMode": "default", // plan | default | auto_edit | yolo
    "autoAccept": false,
    "sandbox": false,
  },
}
```

### 4. `mcp` — MCP Global Control

> **Reference doc**: `references/mcp-servers.md` (same as MCP servers doc)

Global allow/exclude lists for MCP servers.

```jsonc
{
  "mcp": {
    "allowed": ["trusted-server"],
    "excluded": ["untrusted-server"],
  },
}
```

### 5. `model` — Model Settings

> **Reference doc**: `references/model.md`

Model selection, session limits, generation config, etc.

```jsonc
{
  "model": {
    "name": "qwen-max",
    "sessionTokenLimit": 100000,
    "generationConfig": { "timeout": 30000 },
  },
}
```

### 6. `modelProviders` — Model Providers

> **Reference doc**: `references/model.md` (same doc)

Model provider configs grouped by authType.

### 7. `general` — General Settings

> **Reference doc**: `references/general-ui.md`

Preferred editor, language, auto-update, Vim mode, Git co-author, etc.

### 8. `ui` — UI Settings

> **Reference doc**: `references/general-ui.md` (same doc)

Theme, line numbers, accessibility, custom themes, etc.

### 9. `context` — Context Settings

> **Reference doc**: `references/context.md`

Context file name, include directories, file filtering, etc.

### 10. `security` — Security Settings

> **Reference doc**: `references/advanced.md`

Folder trust, authentication config.

### 11. `hooks` / `hooksConfig` — Hook System

> **Reference doc**: `references/advanced.md`

Run custom commands before/after agent processing.

### 12. `env` — Environment Variable Fallbacks

> **Reference doc**: `references/advanced.md`

Low-priority environment variable defaults.

### 13. `privacy` / `telemetry` — Privacy & Telemetry

> **Reference doc**: `references/advanced.md`

Usage statistics and telemetry config.

### 14. `webSearch` — Web Search

> **Reference doc**: `references/advanced.md`

Search provider configuration (Tavily, Google, DashScope).

### 15. `advanced` — Advanced Settings

> **Reference doc**: `references/advanced.md`

Memory management, DNS resolution, bug reporting, etc.

### 16. `ide` — IDE Integration

> **Reference doc**: `references/general-ui.md` (same doc)

IDE auto-connect.

### 17. `output` — Output Format

> **Reference doc**: `references/general-ui.md` (same doc)

CLI output format (text/json).

---

## Usage Guide

1. **Identify which config category the user's question relates to**
2. **Use `read_file` to load the relevant `references/*.md` doc** for precise field definitions, full options, and examples
3. **Provide concrete, usable JSON config snippets** with correct syntax
4. **If the user has Claude Code or Gemini CLI syntax**, identify it first, then translate to the equivalent Qwen Code config (can invoke the `qwen-migrate` skill)
