---
name: qwen-migrate
description: Migrate configuration from Claude Code or Gemini CLI to Qwen Code. Invoke this skill when users:
  - Mention they previously used Claude Code or Gemini CLI
  - Paste a config snippet from another tool and want it converted
  - Ask "how do I do X from Claude in Qwen?"
  - Use non-existent Qwen Code fields (e.g., defaultApprovalMode, TOML rules)
---

# Qwen Code Configuration Migration Guide

You are helping the user migrate their Claude Code or Gemini CLI configuration to Qwen Code.
For full Qwen Code config details, read the reference docs in the sibling `qwen-config/references/` directory.

---

## Part 1: Migrating from Claude Code

### 1.1 Config File Location Mapping

| Claude Code                    | Qwen Code                                    |
| ------------------------------ | -------------------------------------------- |
| `~/.claude/settings.json`      | `~/.qwen/settings.json`                      |
| `.claude.json` (project-level) | `.qwen/settings.json`                        |
| `~/.claude/.mcp.json`          | `~/.qwen/settings.json` (`mcpServers` field) |
| `CLAUDE.md`                    | `QWEN.md`                                    |

### 1.2 Permissions Migration

**Claude Code format** (❌ does not work in Qwen Code):

```json
{
  "permissions": {
    "allow": ["Bash", "Edit", "Write", "Read", "mcp__playwright__*"],
    "deny": []
  }
}
```

**Qwen Code equivalent** (✅):

```jsonc
{
  "permissions": {
    "allow": ["Bash", "Edit", "WriteFile", "ReadFile", "mcp__playwright__*"],
    "deny": [],
  },
}
```

**Tool name mapping**:

| Claude Code             | Qwen Code                    | Status                       |
| ----------------------- | ---------------------------- | ---------------------------- |
| `Bash`                  | `Bash` / `Shell`             | ✅ Compatible                |
| `Edit`                  | `Edit`                       | ✅ Compatible                |
| `Write`                 | `WriteFile` / `Write`        | ✅ Compatible                |
| `Read`                  | `ReadFile` / `Read`          | ✅ Compatible                |
| `Glob`                  | `Glob`                       | ✅ Compatible                |
| `Grep`                  | `Grep`                       | ✅ Compatible                |
| `mcp__server__*`        | `mcp__server__*`             | ✅ Compatible                |
| `mcp__server__tool`     | `mcp__server__tool`          | ✅ Compatible                |
| `WebFetch`              | `WebFetch`                   | ✅ Compatible                |
| `TodoRead`/`TodoWrite`  | `TodoWrite`                  | ⚠️ Qwen only has `TodoWrite` |
| `additionalDirectories` | `context.includeDirectories` | ⚠️ Different location        |

**Key differences**:

- Claude has a flat two-level allow/deny system; Qwen has **three levels: allow/ask/deny** — the `ask` level has no Claude equivalent
- Claude has no specifier syntax; Qwen supports fine-grained `"Bash(git *)"` patterns
- Claude's `additionalDirectories` maps to Qwen's `context.includeDirectories`

### 1.3 MCP Server Migration

**Claude Code format** (❌):

```json
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
      "env": {}
    },
    "remote-server": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

**Qwen Code equivalent** (✅):

```jsonc
{
  "mcpServers": {
    "playwright": {
      // No "type" field needed — having "command" auto-infers stdio transport
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
    },
    "remote-server": {
      // "type": "http" → use "httpUrl" field (auto-inferred as Streamable HTTP)
      // or use "url" field (auto-inferred as SSE)
      "httpUrl": "https://mcp.example.com/mcp",
    },
  },
}
```

**Conversion rules**:

| Claude Code                   | Qwen Code                            | Notes                       |
| ----------------------------- | ------------------------------------ | --------------------------- |
| `"type": "stdio"` + `command` | keep `command`, **remove `type`**    | auto-inferred               |
| `"type": "http"` + `url`      | `"httpUrl": "..."` or `"url": "..."` | httpUrl → HTTP, url → SSE   |
| `"type": "sse"` + `url`       | `"url": "..."`                       | auto-inferred as SSE        |
| `env: {}`                     | can be omitted                       | empty object is unnecessary |

---

## Part 2: Migrating from Gemini CLI

### 2.1 Config File Location Mapping

| Gemini CLI                     | Qwen Code                                     |
| ------------------------------ | --------------------------------------------- |
| `~/.gemini/settings.json`      | `~/.qwen/settings.json`                       |
| `.gemini-config/settings.json` | `.qwen/settings.json`                         |
| `~/.gemini/policies/*.toml`    | `~/.qwen/settings.json` (`permissions` field) |
| `GEMINI.md`                    | `QWEN.md`                                     |

### 2.2 Approval Mode Migration

**Gemini CLI format** (❌):

```json
{
  "general": {
    "defaultApprovalMode": "default"
  }
}
```

**Qwen Code equivalent** (✅):

```jsonc
{
  "tools": {
    "approvalMode": "default", // plan | default | auto_edit | yolo
  },
}
```

### 2.3 TOML Policy Rules Migration

**Gemini CLI format** (❌ TOML):

```toml
[[rule]]
toolName = "run_shell_command"
commandPrefix = "rm"
decision = "ask_user"
priority = 200

[[rule]]
toolName = "run_shell_command"
decision = "allow"
priority = 100
```

**Qwen Code equivalent** (✅ JSON):

```jsonc
{
  "permissions": {
    "allow": ["Bash"], // priority 100 allow rule
    "ask": ["Bash(rm *)"], // priority 200 ask_user rule
  },
}
```

**TOML → JSON decision mapping**:

| Gemini `decision` | Qwen `permissions` array |
| ----------------- | ------------------------ |
| `"allow"`         | `permissions.allow`      |
| `"ask_user"`      | `permissions.ask`        |
| `"deny"`          | `permissions.deny`       |

**Tool name mapping**:

| Gemini `toolName`   | Qwen tool name   |
| ------------------- | ---------------- |
| `run_shell_command` | `Bash` / `Shell` |
| `replace`           | `Edit`           |
| `write_file`        | `WriteFile`      |
| `activate_skill`    | `Skill`          |

**Priority handling**: Gemini uses numeric priorities; Qwen has a fixed priority order of deny > ask > allow — no manual ordering needed.

### 2.4 Gemini `commandPrefix` → Qwen specifier

```
Gemini: commandPrefix = "git"      →  Qwen: "Bash(git *)"
Gemini: commandPrefix = "rm"       →  Qwen: "Bash(rm *)"
Gemini: commandPrefix = "npm test" →  Qwen: "Bash(npm test)"
```

---

## Part 3: Migration Checklist

When the user provides a source config:

1. **Identify the source**: determine if it's Claude Code or Gemini CLI
2. **Translate each item**: apply the mapping tables above
3. **Check for platform-specific features**:
   - Qwen-only: `permissions.ask` (three-level permissions), specifier syntax, MCP `includeTools`/`excludeTools`, `mcp` global control
   - Claude-only: `additionalDirectories` → use `context.includeDirectories` in Qwen
   - Gemini-only: numeric priority in TOML rules → use fixed deny > ask > allow order in Qwen
4. **Validate the output**: ensure the resulting JSON is syntactically correct with no extra fields
5. **Suggest enhancements**: encourage the user to leverage Qwen's `ask` level for finer-grained permission control

---

## Part 4: Common Migration Scenarios

### "I allowed all Bash commands in Claude"

Claude: `"permissions": {"allow": ["Bash"]}`

Qwen:

```jsonc
{
  "permissions": {
    "allow": ["Bash"]   // ✅ directly compatible
  }
}
// Or the safer approach:
{
  "permissions": {
    "allow": ["Bash(git *)", "Bash(npm *)", "Bash(ls *)"],
    "ask": ["Bash"],               // other Bash commands require confirmation
    "deny": ["Bash(rm -rf *)"]     // dangerous commands blocked
  }
}
```

### "I set up MCP servers in Claude"

Simply remove the `"type"` field — everything else stays the same.

### "I have TOML policy rules in Gemini"

Classify all `[[rule]]` blocks into `permissions.allow`, `permissions.ask`, and `permissions.deny` arrays.

---
