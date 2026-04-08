# MCP Server E2E Testing

How to set up and run end-to-end tests involving MCP tool servers.

## Where MCP Config Goes

MCP servers are configured in `.qwen/settings.json` under `mcpServers`. This is
the **only** location that works for E2E testing.

Common mistakes that waste time:

- `.mcp.json` — Claude Code convention, not Qwen Code
- `settings.local.json` — the JSON schema validation rejects `mcpServers` here
- `--mcp-config` CLI flag — does not exist

## Setup

The CLI needs a git repo to load project settings. Create a temp directory:

```bash
mkdir -p /tmp/test-dir && cd /tmp/test-dir && git init -q
mkdir -p .qwen
cat > .qwen/settings.json << 'EOF'
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/tmp/my-mcp-server.js"],
      "trust": true
    }
  }
}
EOF
```

Run from that directory:

```bash
cd /tmp/test-dir && <qwen> "prompt" \
  --approval-mode yolo --output-format json
```

## Writing Test Servers

Use `scripts/mcp-test-server.js` as a template. It's a zero-dependency
JSON-RPC server over stdin/stdout — no npm install needed.

To create a server with custom tools, copy the template and edit the
`TOOL_DEFINITIONS` array and the `handleToolCall` function. Each tool definition
follows the MCP `inputSchema` format (standard JSON Schema).

### Sanity-checking the server

Test the server without the CLI by piping JSON-RPC directly:

```bash
node /tmp/my-mcp-server.js << 'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF
```

## Verifying the Server Loaded

Check the `type: "system"` init message in JSON output:

```json
"mcp_servers": [{"name": "my-server", "status": "connected"}]
```

If `mcp_servers` is empty:

- You're not running from the directory containing `.qwen/settings.json`
- The directory is not a git repo (`git init` missing)
- The server command/path is wrong (check stderr with `2>&1`)
