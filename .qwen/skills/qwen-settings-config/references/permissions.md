# Qwen Code Permissions Configuration Reference

## Overview

The permission system uses the top-level `permissions` key to control tool access. Rules are evaluated at three levels with fixed priority: **deny > ask > allow**.

```jsonc
// ~/.qwen/settings.json
{
  "permissions": {
    "allow": [], // auto-approved, no confirmation needed
    "ask": [], // always requires user confirmation
    "deny": [], // always blocked, cannot execute
  },
}
```

**Merge strategy**: `union` (deduplicated merge across config layers)

---

## Rule Format

Each rule is a string in the format:

```
"ToolName"               — matches all calls to that tool
"ToolName(specifier)"    — matches a specific call pattern for that tool
```

### Example

```jsonc
{
  "permissions": {
    "allow": [
      "Bash(git *)", // allow all git commands
      "Bash(npm test)", // allow npm test
      "Bash(docker build *)", // allow docker build
      "ReadFile", // allow all file reads
      "Grep", // allow all grep searches
      "Glob", // allow all glob searches
      "ListDir", // allow directory listing
      "mcp__playwright__*", // allow all tools from playwright MCP
    ],
    "ask": [
      "Bash(npm publish)", // publish operations always require confirmation
      "WriteFile", // writing files always requires confirmation
    ],
    "deny": [
      "Bash(rm -rf *)", // block recursive deletion
      "Bash(sudo *)", // block sudo
      "Bash(curl * | sh)", // block pipe-to-shell execution
      "mcp__untrusted__*", // block all tools from untrusted MCP
    ],
  },
}
```

---

## Tool Name Reference

### Canonical Tool Names → Rule Aliases

Any of the following aliases can be used in rules (case-insensitive):

| Canonical Name      | Accepted Aliases                            | Description             |
| ------------------- | ------------------------------------------- | ----------------------- |
| `run_shell_command` | **Bash**, Shell, ShellTool, RunShellCommand | Shell command execution |
| `read_file`         | **ReadFile**, ReadFileTool, Read            | Read files              |
| `edit`              | **Edit**, EditFile, EditFileTool            | Edit files              |
| `write_file`        | **WriteFile**, WriteFileTool, Write         | Write new files         |
| `glob`              | **Glob**, GlobTool, ListFiles               | File pattern search     |
| `grep_search`       | **Grep**, GrepSearch, SearchFiles           | Content search          |
| `list_directory`    | **ListDir**, LS, ListDirectory              | List directory          |
| `web_fetch`         | **WebFetch**, Fetch, FetchUrl               | Fetch web pages         |
| `web_search`        | **WebSearch**, Search                       | Web search              |
| `save_memory`       | **SaveMemory**, Memory                      | Save to memory          |
| `task`              | **Task**, SubAgent                          | Sub-agent task          |
| `skill`             | **Skill**, UseSkill                         | Invoke a skill          |
| `ask_user_question` | **AskUser**, AskUserQuestion                | Ask the user            |
| `todo_write`        | **TodoWrite**, Todo                         | Write todos             |
| `exit_plan_mode`    | **ExitPlanMode**                            | Exit plan mode          |

### Meta-Categories (match a group of tools)

| Meta-category | Covered tools                          |
| ------------- | -------------------------------------- |
| **FileTools** | edit, write_file, glob, list_directory |
| **ReadTools** | read_file, grep_search                 |

Example: `"deny": ["FileTools"]` blocks all file editing, writing, searching, and directory listing.

### MCP Tool Naming

```
"mcp__serverName"           — matches all tools from that MCP server
"mcp__serverName__*"        — same, wildcard form
"mcp__serverName__toolName" — matches a specific MCP tool
```

---

## Specifier Matching Rules

Different tool types use different specifier matching algorithms:

### Shell Commands (Bash/Shell) — Shell Glob Matching

```
"Bash(git *)"     — matches "git status", "git commit -m 'msg'"
                    ⚠️ space+* creates a word boundary: does NOT match "gitx"
"Bash(ls*)"       — matches "ls -la" AND "lsof" (no space = no boundary)
"Bash(npm)"       — prefix match: matches "npm test", "npm install"
"Bash(*)"         — matches any command
```

**Compound command handling**: `git status && rm -rf /` is split into sub-commands, each evaluated separately; the strictest result applies.

**Shell virtual ops**: Shell commands also extract virtual file/network operations (e.g., `cat file.txt` → ReadFile rules also apply, `curl url` → WebFetch rules also apply). Virtual ops can only escalate restriction level, never downgrade.

### File Paths (ReadFile/Edit/WriteFile/Glob/ListDir) — Gitignore-style Matching

```
"ReadFile(src/**)"         — matches all files under src/
"Edit(*.config.js)"        — matches all .config.js files
"WriteFile(/etc/**)"       — matches all files under /etc/
```

### Domain (WebFetch) — Domain Matching

```
"WebFetch(example.com)"     — matches example.com and its subdomains
"WebFetch(*.github.com)"    — matches all subdomains of github.com
```

### Other Tools — Literal Matching

```
"Skill(review)"             — matches a specific skill name
"Task(code)"                — matches a specific sub-agent type
```

---

## Relationship with `tools.approvalMode`

`permissions` rules take priority over `tools.approvalMode`:

1. Evaluate `permissions.deny` first → if matched, block execution
2. Evaluate `permissions.ask` → if matched, require confirmation
3. Evaluate `permissions.allow` → if matched, auto-approve
4. No match → fall back to the global `tools.approvalMode` policy

---

## Common Configuration Scenarios

### Read-only mode — allow reads, block all writes

```jsonc
{
  "permissions": {
    "allow": [
      "ReadFile",
      "Grep",
      "Glob",
      "ListDir",
      "Bash(ls *)",
      "Bash(cat *)",
    ],
    "deny": ["FileTools", "Bash(rm *)", "Bash(mv *)", "Bash(cp *)"],
  },
}
```

### Allow git and tests, confirm other shell commands

```jsonc
{
  "permissions": {
    "allow": ["Bash(git *)", "Bash(npm test)", "Bash(npm run lint)"],
    "ask": ["Bash"],
  },
}
```

### Allow specific MCP servers

```jsonc
{
  "permissions": {
    "allow": ["mcp__playwright__*", "mcp__github__*"],
    "deny": ["mcp__untrusted__*"],
  },
}
```

---

## ⚠️ Deprecated Fields

The following fields are deprecated. Use `permissions` instead:

| Old field       | Replacement         |
| --------------- | ------------------- |
| `tools.core`    | `permissions.allow` |
| `tools.allowed` | `permissions.allow` |
| `tools.exclude` | `permissions.deny`  |

These fields still work but are not recommended and may be removed in a future version.
