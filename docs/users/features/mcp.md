# Connect Qwen Code to tools via MCP

Qwen Code can connect to external tools and data sources through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction). MCP servers give Qwen Code access to your tools, databases, and APIs.

## What you can do with MCP

With MCP servers connected, you can ask Qwen Code to:

- Work with files and repos (read/search/write, depending on the tools you enable)
- Query databases (schema inspection, queries, reporting)
- Integrate internal services (wrap your APIs as MCP tools)
- Automate workflows (repeatable tasks exposed as tools/prompts)

> [!tip]
>
> If you’re looking for the “one command to get started”, jump to [Quick start](#quick-start).

## Quick start

Qwen Code loads MCP servers from `mcpServers` in your `settings.json`. You can configure servers either:

- By editing `settings.json` directly
- By using `qwen mcp` commands (see [CLI reference](#qwen-mcp-cli))

### Add your first server

1. Add a server (example: remote HTTP MCP server):

```bash
qwen mcp add --transport http my-server http://localhost:3000/mcp
```

2. Verify it shows up:

```bash
qwen mcp list
```

3. Restart Qwen Code in the same project (or start it if it wasn’t running yet), then ask the model to use tools from that server.

## Where configuration is stored (scopes)

Most users only need these two scopes:

- **Project scope (default)**: `.qwen/settings.json` in your project root
- **User scope**: `~/.qwen/settings.json` across all projects on your machine

Write to user scope:

```bash
qwen mcp add --scope user --transport http my-server http://localhost:3000/mcp
```

> [!tip]
>
> For advanced configuration layers (system defaults/system settings and precedence rules), see [Settings](../configuration/settings).

## Configure servers

### Choose a transport

| Transport | When to use                                                       | JSON field(s)                               |
| --------- | ----------------------------------------------------------------- | ------------------------------------------- |
| `http`    | Recommended for remote services; works well for cloud MCP servers | `httpUrl` (+ optional `headers`)            |
| `sse`     | Legacy/deprecated servers that only support Server-Sent Events    | `url` (+ optional `headers`)                |
| `stdio`   | Local process (scripts, CLIs, Docker) on your machine             | `command`, `args` (+ optional `cwd`, `env`) |

> [!note]
>
> If a server supports both, prefer **HTTP** over **SSE**.

### Configure via `settings.json` vs `qwen mcp add`

Both approaches produce the same `mcpServers` entries in your `settings.json`—use whichever you prefer.

#### Stdio server (local process)

JSON (`.qwen/settings.json`):

```json
{
  "mcpServers": {
    "pythonTools": {
      "command": "python",
      "args": ["-m", "my_mcp_server", "--port", "8080"],
      "cwd": "./mcp-servers/python",
      "env": {
        "DATABASE_URL": "$DB_CONNECTION_STRING",
        "API_KEY": "${EXTERNAL_API_KEY}"
      },
      "timeout": 15000
    }
  }
}
```

CLI (writes to project scope by default):

```bash
qwen mcp add pythonTools -e DATABASE_URL=$DB_CONNECTION_STRING -e API_KEY=$EXTERNAL_API_KEY \
  --timeout 15000 python -m my_mcp_server --port 8080
```

#### HTTP server (remote streamable HTTP)

JSON:

```json
{
  "mcpServers": {
    "httpServerWithAuth": {
      "httpUrl": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-api-token"
      },
      "timeout": 5000
    }
  }
}
```

CLI:

```bash
qwen mcp add --transport http httpServerWithAuth http://localhost:3000/mcp \
  --header "Authorization: Bearer your-api-token" --timeout 5000
```

#### SSE server (remote Server-Sent Events)

JSON:

```json
{
  "mcpServers": {
    "sseServer": {
      "url": "http://localhost:8080/sse",
      "timeout": 30000
    }
  }
}
```

CLI:

```bash
qwen mcp add --transport sse sseServer http://localhost:8080/sse --timeout 30000
```

## Safety and control

### Trust (skip confirmations)

- **Server trust** (`trust: true`): bypasses confirmation prompts for that server (use sparingly).

### Tool filtering (allow/deny tools per server)

Use `includeTools` / `excludeTools` to restrict tools exposed by a server (from Qwen Code’s perspective).

Example: include only a few tools:

```json
{
  "mcpServers": {
    "filteredServer": {
      "command": "python",
      "args": ["-m", "my_mcp_server"],
      "includeTools": ["safe_tool", "file_reader", "data_processor"],
      "timeout": 30000
    }
  }
}
```

### Global allow/deny lists

The `mcp` object in your `settings.json` defines global rules for all MCP servers:

- `mcp.allowed`: allow-list of MCP server names (keys in `mcpServers`)
- `mcp.excluded`: deny-list of MCP server names

Example:

```json
{
  "mcp": {
    "allowed": ["my-trusted-server"],
    "excluded": ["experimental-server"]
  }
}
```

## Troubleshooting

- **Server shows “Disconnected” in `qwen mcp list`**: verify the URL/command is correct, then increase `timeout`.
- **Stdio server fails to start**: use an absolute `command` path, and double-check `cwd`/`env`.
- **Environment variables in JSON don’t resolve**: ensure they exist in the environment where Qwen Code runs (shell vs GUI app environments can differ).

## Reference

### `settings.json` structure

#### Server-specific configuration (`mcpServers`)

Add an `mcpServers` object to your `settings.json` file:

```json
// ... file contains other config objects
{
  "mcpServers": {
    "serverName": {
      "command": "path/to/server",
      "args": ["--arg1", "value1"],
      "env": {
        "API_KEY": "$MY_API_TOKEN"
      },
      "cwd": "./server-directory",
      "timeout": 30000,
      "trust": false
    }
  }
}
```

Configuration properties:

Required (one of the following):

| Property  | Description                                            |
| --------- | ------------------------------------------------------ |
| `command` | Path to the executable for Stdio transport             |
| `url`     | SSE endpoint URL (e.g., `"http://localhost:8080/sse"`) |
| `httpUrl` | HTTP streaming endpoint URL                            |

Optional:

| Property               | Type/Default                 | Description                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `args`                 | array                        | Command-line arguments for Stdio transport                                                                                                                                                                                                                        |
| `headers`              | object                       | Custom HTTP headers when using `url` or `httpUrl`                                                                                                                                                                                                                 |
| `env`                  | object                       | Environment variables for the server process. Values can reference environment variables using `$VAR_NAME` or `${VAR_NAME}` syntax                                                                                                                                |
| `cwd`                  | string                       | Working directory for Stdio transport                                                                                                                                                                                                                             |
| `timeout`              | number<br>(default: 600,000) | Request timeout in milliseconds (default: 600,000ms = 10 minutes)                                                                                                                                                                                                 |
| `trust`                | boolean<br>(default: false)  | When `true`, bypasses all tool call confirmations for this server (default: `false`)                                                                                                                                                                              |
| `includeTools`         | array                        | List of tool names to include from this MCP server. When specified, only the tools listed here will be available from this server (allowlist behavior). If not specified, all tools from the server are enabled by default.                                       |
| `excludeTools`         | array                        | List of tool names to exclude from this MCP server. Tools listed here will not be available to the model, even if they are exposed by the server.<br>Note: `excludeTools` takes precedence over `includeTools` - if a tool is in both lists, it will be excluded. |
| `targetAudience`       | string                       | The OAuth Client ID allowlisted on the IAP-protected application you are trying to access. Used with `authProviderType: 'service_account_impersonation'`.                                                                                                         |
| `targetServiceAccount` | string                       | The email address of the Google Cloud Service Account to impersonate. Used with `authProviderType: 'service_account_impersonation'`.                                                                                                                              |

<a id="qwen-mcp-cli"></a>

### Manage MCP servers with `qwen mcp`

You can always configure MCP servers by manually editing `settings.json`, but the CLI is usually faster.

#### Adding a server (`qwen mcp add`)

```bash
qwen mcp add [options] <name> <commandOrUrl> [args...]
```

| Argument/Option     | Description                                                         | Default            | Example                                   |
| ------------------- | ------------------------------------------------------------------- | ------------------ | ----------------------------------------- |
| `<name>`            | A unique name for the server.                                       | —                  | `example-server`                          |
| `<commandOrUrl>`    | The command to execute (for `stdio`) or the URL (for `http`/`sse`). | —                  | `/usr/bin/python` or `http://localhost:8` |
| `[args...]`         | Optional arguments for a `stdio` command.                           | —                  | `--port 5000`                             |
| `-s`, `--scope`     | Configuration scope (user or project).                              | `project`          | `-s user`                                 |
| `-t`, `--transport` | Transport type (`stdio`, `sse`, `http`).                            | `stdio`            | `-t sse`                                  |
| `-e`, `--env`       | Set environment variables.                                          | —                  | `-e KEY=value`                            |
| `-H`, `--header`    | Set HTTP headers for SSE and HTTP transports.                       | —                  | `-H "X-Api-Key: abc123"`                  |
| `--timeout`         | Set connection timeout in milliseconds.                             | —                  | `--timeout 30000`                         |
| `--trust`           | Trust the server (bypass all tool call confirmation prompts).       | — (`false`)        | `--trust`                                 |
| `--description`     | Set the description for the server.                                 | —                  | `--description "Local tools"`             |
| `--include-tools`   | A comma-separated list of tools to include.                         | all tools included | `--include-tools mytool,othertool`        |
| `--exclude-tools`   | A comma-separated list of tools to exclude.                         | none               | `--exclude-tools mytool`                  |

#### Listing servers (`qwen mcp list`)

```bash
qwen mcp list
```

#### Removing a server (`qwen mcp remove`)

```bash
qwen mcp remove <name>
```
