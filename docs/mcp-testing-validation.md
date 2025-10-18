# MCP Testing & Validation Guide

This guide helps you test and validate your MCP server configurations.

## ✅ Quick Validation Checklist

### 1. Check MCP Servers Are Configured

```bash
qwen mcp list
```

**Expected output:**
```
Configured MCP servers:

✓ filesystem: npx -y @modelcontextprotocol/server-filesystem ./ (stdio) - Connected
✓ memory: npx -y @modelcontextprotocol/server-memory (stdio) - Connected
```

**Status indicators:**
- ✓ (green) - Connected successfully
- ✗ (red) - Connection failed or not connected

### 2. Verify Server Is Installed

Test the server command directly:

```bash
# Filesystem server
npx -y @modelcontextprotocol/server-filesystem --help

# Memory server
npx -y @modelcontextprotocol/server-memory --help

# Custom server
python mcp_server.py --help
```

### 3. Check Configuration File Syntax

Validate your JSON configuration:

```bash
# Linux/macOS
cat .qwen/settings.json | jq .

# Windows PowerShell
Get-Content .qwen/settings.json | ConvertFrom-Json | ConvertTo-Json
```

### 4. Test Within Qwen Code Session

Start an interactive session and check MCP status:

```bash
qwen

# Inside the session:
/mcp              # Show all MCP servers and tools
/mcp desc         # Show tool descriptions
/mcp schema       # Show tool parameter schemas
```

## 🧪 Test Cases

### Test Case 1: Filesystem Server

**Configuration:**
```json
{
  "mcpServers": {
    "test-fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "trust": true
    }
  }
}
```

**Validation:**
1. List files: Start `qwen` and ask "List all files in this directory"
2. Read file: "Read the README.md file"
3. Verify output contains actual file contents

**Expected Tools:**
- `read_file` - Read file contents
- `write_file` - Write to files
- `list_directory` - List directory contents
- `create_directory` - Create directories
- `move_file` - Move/rename files
- `search_files` - Search for files
- `get_file_info` - Get file metadata

### Test Case 2: Memory Server

**Configuration:**
```json
{
  "mcpServers": {
    "test-memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "trust": true
    }
  }
}
```

**Validation:**
1. Store information: "Remember that this project uses React 18"
2. Query: "What JavaScript framework does this project use?"
3. Verify it recalls the information from step 1

**Expected Tools:**
- `create_entities` - Create knowledge entities
- `create_relations` - Create relationships between entities
- `add_observations` - Add observations to entities
- `delete_entities` - Remove entities
- `delete_observations` - Remove observations
- `delete_relations` - Remove relationships
- `read_graph` - Read entire knowledge graph
- `search_nodes` - Search for specific nodes
- `open_nodes` - Open specific nodes by name

### Test Case 3: Multiple Servers

**Configuration:**
```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "trust": true
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "trust": true
    }
  }
}
```

**Validation:**
1. Check both servers are connected: `qwen mcp list`
2. Use filesystem tool: "List all JavaScript files"
3. Use memory tool: "Remember that we prefer TypeScript"
4. Verify both tools work simultaneously

### Test Case 4: Tool Filtering

**Configuration:**
```json
{
  "mcpServers": {
    "readonly-fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "includeTools": ["read_file", "list_directory"],
      "trust": true
    }
  }
}
```

**Validation:**
1. Start qwen session
2. Run `/mcp desc` to list available tools
3. Verify only `read_file` and `list_directory` are present
4. Verify `write_file`, `create_directory`, etc. are NOT available

### Test Case 5: Untrusted Server Confirmation

**Configuration:**
```json
{
  "mcpServers": {
    "untrusted": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "trust": false
    }
  }
}
```

**Validation:**
1. Ask qwen to read a file
2. Confirmation dialog should appear before execution
3. Options should include:
   - Proceed once
   - Always allow this tool
   - Always allow this server
   - Cancel

## 🔍 Debugging Failed Connections

### Issue: Server Shows "Disconnected"

**Diagnostic steps:**

1. **Test command manually:**
   ```bash
   npx -y @modelcontextprotocol/server-filesystem ./
   ```

2. **Check for errors:**
   ```bash
   qwen --debug
   ```

3. **Verify paths are correct:**
   ```bash
   # Check if directory exists
   ls ./
   
   # Check if command is in PATH
   which npx  # Linux/macOS
   where npx  # Windows
   ```

4. **Check permissions:**
   ```bash
   # Verify read/execute permissions
   ls -la ./
   ```

5. **Review environment variables:**
   ```bash
   echo $PATH
   echo $PYTHONPATH  # For Python servers
   ```

### Issue: No Tools Discovered

**Diagnostic steps:**

1. **Verify server implements MCP protocol:**
   ```bash
   # For stdio servers, test input/output manually
   echo '{"jsonrpc": "2.0", "method": "initialize", "id": 1}' | npx -y @modelcontextprotocol/server-filesystem ./
   ```

2. **Check server logs:**
   ```bash
   # Some servers log to stderr
   qwen --debug 2>&1 | grep MCP
   ```

3. **Verify server version:**
   ```bash
   npm list -g @modelcontextprotocol/server-filesystem
   ```

### Issue: Tools Fail to Execute

**Diagnostic steps:**

1. **Check parameter format:**
   - Ensure parameters match the expected schema
   - Verify JSON encoding is correct

2. **Increase timeout:**
   ```json
   {
     "mcpServers": {
       "slow-server": {
         "command": "...",
         "timeout": 60000
       }
     }
   }
   ```

3. **Check server implementation:**
   - Verify the server actually implements the tool
   - Test the tool independently if possible

## 📊 Validation Results

### Expected Server Connection Times

| Server Type | Typical Connection Time | Timeout Recommendation |
|-------------|------------------------|------------------------|
| Filesystem  | < 1 second            | 10-30 seconds         |
| Memory      | < 1 second            | 10-30 seconds         |
| HTTP/SSE    | 1-3 seconds           | 30-60 seconds         |
| Custom Python | 2-5 seconds         | 30-60 seconds         |
| Docker      | 5-10 seconds          | 60-120 seconds        |

### Tool Execution Times

| Tool Type         | Typical Duration | Timeout Recommendation |
|-------------------|-----------------|------------------------|
| Read file         | < 100ms         | 5-10 seconds          |
| List directory    | < 500ms         | 10-15 seconds         |
| Search files      | 1-5 seconds     | 30-60 seconds         |
| Memory operations | < 1 second      | 10-30 seconds         |
| API calls         | 1-10 seconds    | 30-120 seconds        |

## 🎯 Success Criteria

Your MCP configuration is working correctly if:

✅ `qwen mcp list` shows all servers as "Connected"
✅ `/mcp` command in qwen session displays tools
✅ Tool executions complete without errors
✅ Confirmation dialogs appear for untrusted servers (if `trust: false`)
✅ Tool filtering works as expected (include/exclude)
✅ Environment variables are properly substituted
✅ Timeouts are appropriate for your server's response time

## 🚀 Performance Tips

1. **Use `trust: true` for local servers** to skip confirmation dialogs
2. **Set appropriate timeouts** - too low causes failures, too high slows down errors
3. **Filter tools** - Only enable tools you actually need
4. **Test servers independently** before configuring in qwen
5. **Use `--debug` flag** during initial setup
6. **Monitor resource usage** for long-running or resource-intensive servers

## 📝 Validation Script Example

Create a test script to automate validation:

```bash
#!/bin/bash
# validate-mcp.sh

echo "Testing MCP configuration..."

# Test 1: Check config file exists
if [ ! -f .qwen/settings.json ]; then
    echo "❌ Missing .qwen/settings.json"
    exit 1
fi
echo "✅ Config file exists"

# Test 2: Validate JSON syntax
if ! cat .qwen/settings.json | jq . > /dev/null 2>&1; then
    echo "❌ Invalid JSON in settings.json"
    exit 1
fi
echo "✅ Valid JSON syntax"

# Test 3: Check servers are configured
SERVER_COUNT=$(cat .qwen/settings.json | jq '.mcpServers | length')
if [ "$SERVER_COUNT" -eq 0 ]; then
    echo "❌ No MCP servers configured"
    exit 1
fi
echo "✅ $SERVER_COUNT MCP server(s) configured"

# Test 4: Check connection status
qwen mcp list | grep -q "Connected"
if [ $? -eq 0 ]; then
    echo "✅ At least one server is connected"
else
    echo "❌ No servers connected"
    exit 1
fi

echo ""
echo "✅ All validation checks passed!"
```

## 📚 Next Steps

After validation:

1. **Start using MCP tools** in your workflow
2. **Document your custom configurations** for team members
3. **Share your successful configs** with the community
4. **Monitor performance** and adjust timeouts as needed
5. **Explore more MCP servers** from the community

---

**Having issues?** Check the [MCP troubleshooting guide](./tools/mcp-server.md#troubleshooting) or open an issue on GitHub.
