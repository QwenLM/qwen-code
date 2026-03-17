# Qwen Code MCP Server Configuration Reference

## Overview

MCP (Model Context Protocol) servers are configured via the top-level `mcpServers` key. The key feature of Qwen Code: **transport type is automatically inferred from the config fields — no explicit `"type"` field is needed**.

```jsonc
// ~/.qwen/settings.json
{
  "mcpServers": {
    "server-name": {
      // transport type is inferred from the fields you provide
    },
  },
}
```

**Merge strategy**: `shallow_merge` (shallow merge across config layers)

---

## Transport Type Inference

| Transport           | Inferred from               | Description                                    |
| ------------------- | --------------------------- | ---------------------------------------------- |
| **stdio**           | presence of `command` field | Local subprocess communicates via stdin/stdout |
| **SSE**             | presence of `url` field     | Server-Sent Events streaming transport         |
| **Streamable HTTP** | presence of `httpUrl` field | HTTP request/response transport                |
| **WebSocket**       | presence of `tcp` field     | WebSocket persistent connection                |

---

## Full Configuration by Transport Type

### stdio Transport (Local Process)

```jsonc
{
  "mcpServers": {
    "my-local-server": {
      "command": "node", // required: launch command
      "args": ["path/to/server.js", "--port=3000"], // optional: command arguments
      "env": {
        // optional: environment variables
        "API_KEY": "$MY_API_KEY", // supports $VAR interpolation
        "DEBUG": "true",
      },
      "cwd": "/path/to/working/dir", // optional: working directory
      "timeout": 10000, // optional: timeout in ms
      "trust": true, // optional: mark as trusted
      "description": "My local MCP server", // optional: description
      "includeTools": ["tool1", "tool2"], // optional: whitelist tools
      "excludeTools": ["dangerous_tool"], // optional: blacklist tools
    },
  },
}
```

#### Common stdio Examples

```jsonc
{
  "mcpServers": {
    // Playwright MCP
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
    },
    // Python MCP server
    "python-server": {
      "command": "python",
      "args": ["-m", "my_mcp_server"],
      "env": { "PYTHONPATH": "/path/to/lib" },
    },
    // MCP server launched via uvx
    "filesystem": {
      "command": "uvx",
      "args": ["mcp-server-filesystem", "--root", "/home/user/projects"],
    },
    // GitHub MCP server
    "github": {
      "command": "npx",
      "args": ["@github/mcp-server@latest"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN",
      },
    },
    // Database MCP server
    "postgres": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-postgres"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost:5432/mydb",
      },
    },
  },
}
```

### SSE Transport (Server-Sent Events)

```jsonc
{
  "mcpServers": {
    "sse-server": {
      "url": "https://mcp-server.example.com/sse", // required: SSE endpoint
      "headers": {
        // optional: request headers
        "Authorization": "Bearer $TOKEN",
      },
      "timeout": 30000,
    },
  },
}
```

### Streamable HTTP Transport

```jsonc
{
  "mcpServers": {
    "http-server": {
      "httpUrl": "https://api.example.com/mcp", // required: HTTP endpoint
      "headers": {
        // optional: request headers
        "Authorization": "Bearer $TOKEN",
        "X-Custom-Header": "value",
      },
      "timeout": 15000,
    },
  },
}
```

### WebSocket Transport

```jsonc
{
  "mcpServers": {
    "ws-server": {
      "tcp": "ws://localhost:8080/mcp", // required: WebSocket URL
      "timeout": 10000,
    },
  },
}
```

---

## Advanced Options

### Tool Filtering

Control which tools are exposed per server using `includeTools` / `excludeTools`:

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["@github/mcp-server"],
      "includeTools": ["create_issue", "list_repos"], // whitelist mode
      "excludeTools": ["delete_repo"], // blacklist mode
    },
  },
}
```

Note: `includeTools` and `excludeTools` are mutually exclusive. When `includeTools` is set, only the listed tools are exposed.

### OAuth Authentication

```jsonc
{
  "mcpServers": {
    "oauth-server": {
      "httpUrl": "https://api.example.com/mcp",
      "oauth": {
        "enabled": true,
        "clientId": "my-client-id",
        "clientSecret": "$OAUTH_SECRET",
        "authorizationUrl": "https://auth.example.com/authorize",
        "tokenUrl": "https://auth.example.com/token",
        "scopes": ["read", "write"],
        "redirectUri": "http://localhost:8080/callback",
      },
    },
  },
}
```

### Environment Variable Interpolation

All string values support environment variable interpolation:

```jsonc
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"],
      "env": {
        "API_KEY": "$MY_API_KEY", // $VAR format
        "SECRET": "${MY_SECRET}", // ${VAR} format
        "HOME_DIR": "$HOME", // system env var
      },
    },
  },
}
```

---

## MCP Global Control (`mcp` top-level key)

In addition to configuring servers under `mcpServers`, the `mcp` key provides global control:

```jsonc
{
  "mcp": {
    "serverCommand": "custom-mcp-launcher", // optional: global MCP launch command
    "allowed": ["trusted-server-1", "trusted-server-2"], // allowlist
    "excluded": ["untrusted-server"], // blocklist
  },
}
```

- `mcp.allowed`: only MCP servers in this list will be loaded (whitelist mode)
- `mcp.excluded`: MCP servers in this list will not be loaded (blacklist mode)
- Both use `concat` merge strategy

---

## MCP Tool Permission Control

Control MCP tool permissions via the `permissions` config (see `permissions.md`):

```jsonc
{
  "permissions": {
    "allow": ["mcp__playwright__*"], // allow all playwright tools
    "deny": ["mcp__untrusted__*"], // block all untrusted tools
    "ask": ["mcp__github__delete_repo"], // github delete requires confirmation
  },
}
```

---

## Common Scenarios

### Add a New MCP Server

```jsonc
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
    },
  },
}
```

### Configure MCP Server with API Key

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["@github/mcp-server@latest"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN",
      },
    },
  },
}
```

### Limit MCP Server Tools

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["@github/mcp-server@latest"],
      "includeTools": ["create_issue", "list_repos"],
      "excludeTools": ["delete_repo"],
    },
  },
}
```

### Connect to Remote MCP Server

```jsonc
{
  "mcpServers": {
    "remote-server": {
      "httpUrl": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer $TOKEN",
      },
    },
  },
}
```

### Allow Only Specific MCP Servers

```jsonc
{
  "mcp": {
    "allowed": ["playwright", "github"],
  },
}
```

---

## ⚠️ Key Differences from Claude Code MCP Config

| Feature                    | Qwen Code                                  | Claude Code                                    |
| -------------------------- | ------------------------------------------ | ---------------------------------------------- |
| Transport type declaration | **Auto-inferred** (no `type` field needed) | Requires `"type": "stdio"` or `"type": "http"` |
| Config location            | `mcpServers` in `~/.qwen/settings.json`    | `~/.claude/.mcp.json` or `.claude.json`        |
| Tool filtering             | `includeTools` / `excludeTools` fields     | Via `mcp__` prefix in `permissions.allow`      |
| Global control             | Separate `mcp` top-level key               | No separate global control                     |
| Env variables              | `$VAR` / `${VAR}` interpolation            | Values written directly in `env` object        |
