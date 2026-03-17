---
name: qwen-config
description: Complete guide for Qwen Code's configuration system and migration from other tools (Claude Code, Gemini CLI, OpenCode, Codex). Invoke for settings.json structure, field meanings, config locations, permissions, MCP servers, approval modes, or migration help. Remind users that most config changes require restarting qwen-code.
---

# Qwen Code Configuration System Guide

You are helping the user configure Qwen Code. **Based on the user's specific question, use the `read_file` tool to load the relevant reference document on demand** (concatenate the base directory of this skill with the relative path).

---

## Quick Index

**High-Frequency Configs**: [Permissions](references/permissions.md) | [MCP Servers](references/mcp-servers.md) | [Approval Mode](references/tools.md) | [Model](references/model.md)

**All Config Categories**:

| Category    | Config Keys                                                                                  | Reference Doc                               |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Permissions | `permissions.allow/ask/deny`                                                                 | [permissions.md](references/permissions.md) |
| MCP         | `mcpServers.*`, `mcp.*`                                                                      | [mcp-servers.md](references/mcp-servers.md) |
| Tools       | `tools.approvalMode`, `tools.sandbox`, `tools.shell`                                         | [tools.md](references/tools.md)             |
| Model       | `model.name`, `model.generationConfig`, `modelProviders`                                     | [model.md](references/model.md)             |
| General/UI  | `general.*`, `ui.*`, `ide.*`, `output.*`                                                     | [general-ui.md](references/general-ui.md)   |
| Context     | `context.*`                                                                                  | [context.md](references/context.md)         |
| Advanced    | `hooks`, `hooksConfig`, `env`, `webSearch`, `security`, `privacy`, `telemetry`, `advanced.*` | [advanced.md](references/advanced.md)       |

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

## Core Config Quick Reference

### 1. Permissions (High-Frequency)

```jsonc
{
  "permissions": {
    "allow": ["Bash(git *)", "ReadFile"], // auto-approved
    "ask": ["Bash(npm publish)"], // always requires confirmation
    "deny": ["Bash(rm -rf *)"], // always blocked
  },
}
```

**Priority**: deny > ask > allow  
→ [Full doc](references/permissions.md)

### 2. MCP Servers (High-Frequency)

```jsonc
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
      // transport type auto-inferred: command=stdio, url=SSE, httpUrl=HTTP
    },
  },
}
```

→ [Full doc](references/mcp-servers.md)

### 3. Tool Approval Mode (High-Frequency)

```jsonc
{
  "tools": {
    "approvalMode": "default", // plan | default | auto_edit | yolo
  },
}
```

→ [Full doc](references/tools.md)

### 4. Model Selection

```jsonc
{
  "model": {
    "name": "qwen-max",
  },
}
```

→ [Full doc](references/model.md)

### 5. General & UI

```jsonc
{
  "general": {
    "vimMode": true,
    "language": "auto",
  },
  "ui": {
    "theme": "Qwen Dark",
  },
}
```

→ [Full doc](references/general-ui.md)

### 6. Context

```jsonc
{
  "context": {
    "fileName": ["QWEN.md", "CONTEXT.md"],
    "includeDirectories": ["../shared/libs"],
  },
}
```

→ [Full doc](references/context.md)

### 7. Advanced (Hooks, env, Web Search, Security)

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [{ "command": "npm run lint" }],
  },
  "env": {
    "API_KEY": "$MY_API_KEY",
  },
  "webSearch": {
    "provider": [{ "type": "tavily" }],
    "default": "tavily",
  },
}
```

→ [Full doc](references/advanced.md)

---

## Usage Guide

1. **Identify the config category** from the index table above
2. **Use `read_file` to load the relevant `references/*.md` doc** for precise field definitions, full options, and examples
3. **Provide concrete, usable JSON config snippets** with correct syntax
4. **Specify the target file path**: `~/.qwen/settings.json` (global) or `.qwen/settings.json` (project)
5. **If the user has Claude Code or Gemini CLI syntax**, identify it first, then translate to the equivalent Qwen Code config (see Migration Guide below)

**Note**: Most config changes require restarting qwen-code to take effect.

---

## Migration Guide

Help users migrate configurations from other AI coding tools to Qwen Code.

### Supported Tools

| Tool            | Config Docs                                                                                       | Key Differences                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Claude Code** | [code.claude.com/docs/en/settings](https://code.claude.com/docs/en/settings)                      | Uses `permissions` with same allow/ask/deny structure; MCP config similar but requires explicit `type` field |
| **Gemini CLI**  | [geminicli.com/docs/reference/configuration](https://geminicli.com/docs/reference/configuration/) | Uses `general.defaultApprovalMode` instead of `tools.approvalMode`; TOML policy rules format                 |
| **OpenCode**    | [opencode.ai/docs/config](https://opencode.ai/docs/config/)                                       | Uses `permission` object with simpler allow/ask/deny; JSONC format with variable substitution                |
| **Codex**       | [config.md](https://raw.githubusercontent.com/openai/codex/refs/heads/main/docs/config.md)        | TOML format; minimal config structure                                                                        |

### Migration Process

When a user wants to migrate from another tool:

1. **Identify the source tool** and ask for their current config (or offer to fetch from the docs above)
2. **Load the source tool's config docs** using `web_fetch` if needed for detailed field mapping
3. **Load the relevant Qwen Code reference doc** from `references/` directory
4. **Translate each config item** using the mapping logic below
5. **Provide the migrated Qwen Code config** with explanations for any breaking changes

### Translation Rules

#### From Claude Code

| Claude Code         | Qwen Code           | Notes                                 |
| ------------------- | ------------------- | ------------------------------------- |
| `permissions.allow` | `permissions.allow` | ✅ Direct compatible                  |
| `permissions.ask`   | `permissions.ask`   | ✅ Direct compatible                  |
| `permissions.deny`  | `permissions.deny`  | ✅ Direct compatible                  |
| `sandbox.enabled`   | `tools.sandbox`     | Boolean or path string                |
| `model`             | `model.name`        | Nested under `model`                  |
| `env`               | `env`               | ✅ Direct compatible                  |
| `mcpServers.*`      | `mcpServers.*`      | Remove `"type"` field (auto-inferred) |
| `hooks.*`           | `hooks.*`           | Similar structure, check event names  |

#### From Gemini CLI

| Gemini CLI                    | Qwen Code            | Notes                                    |
| ----------------------------- | -------------------- | ---------------------------------------- |
| `general.defaultApprovalMode` | `tools.approvalMode` | Same values: plan/default/auto_edit/yolo |
| `tools.sandbox`               | `tools.sandbox`      | ✅ Direct compatible                     |
| `model.name`                  | `model.name`         | ✅ Direct compatible                     |
| `context.*`                   | `context.*`          | ✅ Direct compatible                     |
| `mcpServers.*`                | `mcpServers.*`       | ✅ Direct compatible                     |
| `hooksConfig.*`               | `hooksConfig.*`      | ✅ Direct compatible                     |
| `ui.*`                        | `ui.*`               | ✅ Direct compatible                     |
| `general.*`                   | `general.*`          | ✅ Direct compatible                     |

#### From OpenCode

| OpenCode            | Qwen Code                    | Notes                                          |
| ------------------- | ---------------------------- | ---------------------------------------------- |
| `permission.*`      | `permissions.allow/ask/deny` | OpenCode uses object, Qwen uses arrays         |
| `model`             | `model.name`                 | Top-level vs nested                            |
| `provider.*`        | `modelProviders.*`           | Different structure                            |
| `tools.*` (boolean) | `permissions.deny`           | OpenCode disables tools, Qwen denies via rules |
| `mcp.*`             | `mcpServers.*`               | Different structure                            |
| `formatter.*`       | N/A                          | No direct equivalent                           |
| `compaction.*`      | `model.chatCompression`      | Similar concept                                |

### Example Migration Request

**User**: "I'm using Claude Code with this config, how do I migrate to Qwen Code?"

**You should**:

1. Acknowledge the source tool (Claude Code)
2. Load Claude Code docs if complex config: `web_fetch` with URL from table above
3. Load relevant Qwen Code reference: `read_file` for `references/permissions.md`, etc.
4. Provide side-by-side comparison with explanations
5. Output the migrated Qwen Code config

### Important Notes

- **Permission rules**: Qwen Code uses `deny > ask > allow` priority (same as Claude, different from others)
- **MCP servers**: Qwen Code auto-infers transport type (no `"type"` field needed)
- **Approval modes**: Qwen Code uses `tools.approvalMode` (Gemini uses `general.defaultApprovalMode`)
- **Config format**: Qwen Code uses JSON with Comments (like Claude), not TOML (like Codex/OpenCode)

---

## Where to Write Config

### For New Qwen Code Users

| Config Type        | File Path                       | Scope                |
| ------------------ | ------------------------------- | -------------------- |
| **Global config**  | `~/.qwen/settings.json`         | All projects         |
| **Project config** | `<project>/.qwen/settings.json` | Current project only |

**Recommendation**:

- Start with **project config** (`.qwen/settings.json` in your repo)
- Use **global config** for personal preferences (theme, vim mode, etc.)

### For Migration Users

When migrating from another tool, write to the equivalent location:

| Source Tool     | Source Path                        | Target Path                                 |
| --------------- | ---------------------------------- | ------------------------------------------- |
| **Claude Code** | `~/.claude/settings.json`          | `~/.qwen/settings.json`                     |
| **Claude Code** | `.claude/settings.json`            | `.qwen/settings.json`                       |
| **Gemini CLI**  | `~/.gemini/settings.json`          | `~/.qwen/settings.json`                     |
| **Gemini CLI**  | `.gemini/settings.json`            | `.qwen/settings.json`                       |
| **OpenCode**    | `~/.config/opencode/opencode.json` | `~/.qwen/settings.json`                     |
| **OpenCode**    | `opencode.json` (project root)     | `.qwen/settings.json`                       |
| **Codex**       | `~/.codex/config.toml`             | `~/.qwen/settings.json` (convert TOML→JSON) |

### Migration Output Format

When providing migrated config, always include:

1. **The target file path** (e.g., "Write this to `~/.qwen/settings.json`")
2. **A complete, valid JSON snippet** with comments explaining key changes
3. **A reminder** to restart qwen-code after changes

**Example output**:

````markdown
Write the following to `~/.qwen/settings.json` (or `.qwen/settings.json` for project-specific):

```jsonc
{
  "$schema": "https://json.schemastore.org/qwen-code-settings.json",
  "permissions": {
    "allow": ["Bash(git *)"], // Migrated from Claude Code
    "ask": [],
    "deny": [],
  },
  "tools": {
    "approvalMode": "default", // Migrated from general.defaultApprovalMode
  },
}
```
````

**Note**: Restart qwen-code for changes to take effect.

```

```
