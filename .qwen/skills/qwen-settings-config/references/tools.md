# Qwen Code Tools Settings Reference

## Overview

The top-level `tools` key controls tool execution behavior, including approval mode, sandbox, and shell configuration.

```jsonc
// ~/.qwen/settings.json
{
  "tools": {
    // settings here
  },
}
```

---

## `tools.approvalMode` — Approval Mode

Controls the approval policy before tool execution.

| Value         | Description                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `"plan"`      | Plan mode: agent only generates a plan, no tools execute until the user explicitly approves                               |
| `"default"`   | **Default mode**: safe operations (reads) execute automatically; dangerous operations (writes/shell) require confirmation |
| `"auto_edit"` | Auto-edit mode: file edits execute automatically; shell commands still require confirmation                               |
| `"yolo"`      | Full-auto mode: all tools execute automatically ⚠️ security risk                                                          |

```jsonc
{
  "tools": {
    "approvalMode": "default",
  },
}
```

⚠️ **Note**: `permissions` rules take priority over `approvalMode`. Even in `yolo` mode, `permissions.deny` rules will still block tool execution.

---

## `tools.autoAccept` — Auto-Accept Safe Operations

```jsonc
{
  "tools": {
    "autoAccept": false, // default: false
  },
}
```

When set to `true`, operations considered safe (e.g., read-only) execute automatically without confirmation.

---

## `tools.sandbox` — Sandbox Execution

```jsonc
{
  "tools": {
    "sandbox": false, // boolean or path string
  },
}
```

- `false`: sandbox disabled
- `true`: enable default sandbox
- `"/path/to/sandbox"`: use the specified sandbox environment

---

## `tools.shell` — Shell Configuration

```jsonc
{
  "tools": {
    "shell": {
      "enableInteractiveShell": true, // use PTY interactive shell (default: true)
      "pager": "cat", // pager command (default: "cat")
      "showColor": false, // show color in shell output (default: false)
    },
  },
}
```

---

## `tools.useRipgrep` / `tools.useBuiltinRipgrep` — Search Engine

```jsonc
{
  "tools": {
    "useRipgrep": true, // use ripgrep for search (default: true)
    "useBuiltinRipgrep": true, // use bundled ripgrep binary (default: true)
  },
}
```

- `useRipgrep: false` → use fallback implementation
- `useBuiltinRipgrep: false` → use system-installed `rg` command

---

## `tools.truncateToolOutputThreshold` / `tools.truncateToolOutputLines` — Output Truncation

```jsonc
{
  "tools": {
    "truncateToolOutputThreshold": 30000, // character threshold (default: 30000, -1 to disable)
    "truncateToolOutputLines": 500, // lines to keep after truncation (default: 500)
  },
}
```

---

## `tools.discoveryCommand` / `tools.callCommand` — Custom Tools

```jsonc
{
  "tools": {
    "discoveryCommand": "my-tool-discovery", // tool discovery command
    "callCommand": "my-tool-call", // tool invocation command
  },
}
```

Used to integrate external custom tool systems.

---

## Common Scenarios

### Enable Plan Mode (Read-Only Analysis)

```jsonc
{
  "tools": {
    "approvalMode": "plan",
  },
}
```

### Enable Auto-Edit Mode

```jsonc
{
  "tools": {
    "approvalMode": "auto_edit",
  },
}
```

### Enable Full Auto Mode (Use with Caution)

```jsonc
{
  "tools": {
    "approvalMode": "yolo",
  },
}
```

### Configure Sandbox

```jsonc
{
  "tools": {
    "sandbox": true, // or "/path/to/sandbox"
  },
}
```

### Configure Shell Pager

```jsonc
{
  "tools": {
    "shell": {
      "pager": "less",
      "showColor": true,
    },
  },
}
```

### Use System Ripgrep

```jsonc
{
  "tools": {
    "useRipgrep": true,
    "useBuiltinRipgrep": false, // use system-installed `rg`
  },
}
```

---

## ⚠️ Deprecated Fields

| Field           | Replacement         | Description         |
| --------------- | ------------------- | ------------------- |
| `tools.core`    | `permissions.allow` | Core tool allowlist |
| `tools.allowed` | `permissions.allow` | Auto-approved tools |
| `tools.exclude` | `permissions.deny`  | Blocked tools       |

These fields still work but are not recommended. Please migrate to `permissions`.
