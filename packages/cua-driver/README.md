# Qwen Cua Driver

Cross-platform background computer-use driver for AI agents. Speaks MCP over stdio; drives native apps without stealing focus.

Based on [trycua/cua](https://github.com/trycua/cua) with Qwen-specific extensions: relative-coordinate normalization (0–1000 space for Qwen-VL models), vendored patches, and qwen-code integration.

## Installation

### macOS / Linux

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cua-driver/scripts/install.sh)"
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cua-driver/scripts/install.ps1 | iex
```

### Pin a specific version

```bash
# macOS / Linux
CUA_DRIVER_RS_VERSION=0.7.0 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cua-driver/scripts/install.sh)"
```

```powershell
# Windows
$env:CUA_DRIVER_RS_VERSION = "0.7.0"
irm https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cua-driver/scripts/install.ps1 | iex
```

> **Note:** After installation, restart your terminal or IDE for PATH changes to take effect.

## Verify installation

```bash
qwen-cua-driver --version
# Expected: cua-driver 0.7.0
```

### macOS permissions

macOS requires Accessibility and Screen Recording permissions:

```bash
# Grant permissions (launches the driver so the dialog attributes correctly)
qwen-cua-driver permissions grant

# Check status
qwen-cua-driver permissions status
```

### Quick functional test

```bash
# List running apps
qwen-cua-driver call list_apps '{}'

# List available tools
qwen-cua-driver list-tools
```

## MCP Configuration

### Qwen Code

```bash
qwen mcp add --transport stdio cua-driver -- qwen-cua-driver mcp
```

With relative-coordinate normalization (recommended for Qwen-VL models):

```bash
qwen mcp add-json --scope user cua-computer-use '{"command":"qwen-cua-driver","args":["mcp"],"env":{"CUA_DRIVER_RS_COORDINATE_SPACE":"1"}}'
```

Or add to `.qwen/settings.json`:

```json
{
  "mcpServers": {
    "cua-computer-use": {
      "command": "qwen-cua-driver",
      "args": ["mcp"],
      "env": {
        "CUA_DRIVER_RS_COORDINATE_SPACE": "1"
      }
    }
  }
}
```

> **Note:** If you enable the MCP server manually, disable the built-in computer-use to avoid conflicts:
> ```json
> {
>   "tools": {
>     "computerUse": {
>       "enabled": false
>     }
>   }
> }
> ```

### Claude Code

Standard registration:

```bash
claude mcp add --transport stdio cua-driver -- qwen-cua-driver mcp
```

Computer-use compatibility mode (grounds Claude Code's vision flow on cua-driver screenshots):

```bash
claude mcp add --transport stdio cua-computer-use -- qwen-cua-driver mcp --claude-code-computer-use-compat
```

Or via JSON (recommended for Windows where arg parsing can lose flags):

```bash
claude mcp add-json --scope user cua-computer-use '{"command":"qwen-cua-driver","args":["mcp","--claude-code-computer-use-compat"]}'
```

### Codex (OpenAI)

```bash
codex mcp add cua-driver -- qwen-cua-driver mcp
```

### Other clients (Cursor, OpenCode, Hermes, etc.)

Generate a client-specific config snippet:

```bash
qwen-cua-driver mcp-config --client cursor
qwen-cua-driver mcp-config --client opencode
qwen-cua-driver mcp-config --client hermes
```

Or get the generic `mcpServers` JSON shape:

```bash
qwen-cua-driver mcp-config
```

## Relative-coordinate mode

For models that output normalized 0–1000 coordinates (e.g. Qwen-VL `computer_use`), enable coordinate normalization:

```bash
# Via environment variable (set before starting the MCP server)
export CUA_DRIVER_RS_COORDINATE_SPACE=1

# Optional: change full-scale (default 1000, some models use 999)
export CUA_DRIVER_RS_COORDINATE_SCALE=999
```

When enabled:
- `get_window_state` / `get_desktop_state` report `screenshot_width/height` as 1000
- `click` / `drag` / `scroll` x/y accept 0–1000 values (auto-converted to pixels)
- `move_cursor` uses 0–1000 in screen space
- Tool descriptions are rewritten to mention the normalized coordinate system

## Uninstall

### macOS / Linux

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cua-driver/scripts/uninstall.sh)"
```

### Windows

```powershell
irm https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/cua-driver/scripts/uninstall.ps1 | iex
```

## Platform support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS (Apple Silicon) | Stable | Full AX tree + screenshot + input |
| macOS (Intel) | Stable | Same as above |
| Windows x86_64 | Stable | UIA + screenshot + input |
| Windows ARM64 | Stable | Same as x86_64 |
| Linux x86_64 | Pre-release | X11 + AT-SPI; Wayland partial |
| Linux ARM64 | Pre-release | Same limitations as x86_64 |

## Documentation

- [Vendored patches](./.vendored-patches.md)
- [Relative-coordinate design](./rust/docs/relative-coordinates-design.md)
- [Upstream docs](https://github.com/trycua/cua/tree/main/libs/cua-driver/rust)
