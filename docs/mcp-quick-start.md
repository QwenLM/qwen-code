# MCP Quick Start Guide - Practical Examples

This guide provides real-world examples to get you started with Model Context Protocol (MCP) servers in Qwen Code.

## 🚀 Getting Started in 5 Minutes

### Step 1: Install MCP Servers

Install official MCP servers from Anthropic:

```bash
# Filesystem access
npm install -g @modelcontextprotocol/server-filesystem

# Memory & Knowledge Graph
npm install -g @modelcontextprotocol/server-memory

# Sequential thinking
npm install -g @modelcontextprotocol/server-sequential-thinking
```

### Step 2: Configure Your First MCP Server

Create or edit `.qwen/settings.json` in your project:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "description": "Access project files"
    }
  }
}
```

### Step 3: Verify Connection

```bash
qwen mcp list
```

You should see:
```
✓ filesystem: npx -y @modelcontextprotocol/server-filesystem ./ (stdio) - Connected
```

## 📚 Practical Examples

### Example 1: Local Development Assistant

**Use Case:** Work on a Node.js project with file access and memory.

**Configuration (`.qwen/settings.json`):**

```json
{
  "mcpServers": {
    "project-files": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "./src",
        "./tests",
        "./docs"
      ],
      "description": "Access source code, tests, and documentation",
      "trust": true
    },
    "project-memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "Remember project decisions and context",
      "trust": true
    }
  }
}
```

**Usage:**
```bash
qwen

> Remember: This project uses React 18 with TypeScript and follows Airbnb style guide
> List all files in the src directory
> Read src/App.tsx and suggest improvements
```

### Example 2: Multi-Repository Development

**Use Case:** Working across multiple codebases simultaneously.

**Configuration:**

```json
{
  "mcpServers": {
    "frontend": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "../frontend-app"
      ],
      "description": "Frontend repository access"
    },
    "backend": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "../backend-api"
      ],
      "description": "Backend repository access"
    },
    "shared-memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "Shared knowledge across repositories"
    }
  }
}
```

### Example 3: Documentation-Only Access

**Use Case:** Safe access to documentation without risking code changes.

**Configuration:**

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "./docs",
        "./README.md"
      ],
      "description": "Read-only documentation access",
      "trust": true,
      "includeTools": ["read_file", "list_directory"]
    }
  }
}
```

### Example 4: Custom Python MCP Server

**Use Case:** Integrate custom Python tools via MCP.

**Server File (`mcp_server.py`):**

```python
#!/usr/bin/env python3
import sys
from mcp.server.stdio import stdio_server
from mcp.server import Server
from mcp.types import Tool, TextContent

server = Server("custom-tools")

@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="analyze_python_code",
            description="Static analysis of Python code",
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string"}
                },
                "required": ["file_path"]
            }
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    if name == "analyze_python_code":
        # Your custom logic here
        return [TextContent(type="text", text=f"Analysis of {arguments['file_path']}")]

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
```

**Configuration:**

```json
{
  "mcpServers": {
    "python-tools": {
      "command": "python",
      "args": ["mcp_server.py"],
      "env": {
        "PYTHONPATH": "${PWD}"
      },
      "description": "Custom Python analysis tools"
    }
  }
}
```

### Example 5: Docker-Based MCP Server

**Use Case:** Run MCP servers in isolated containers.

**Configuration:**

```json
{
  "mcpServers": {
    "containerized-tools": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "${PWD}:/workspace",
        "-w",
        "/workspace",
        "my-mcp-server:latest"
      ],
      "description": "MCP tools running in Docker"
    }
  }
}
```

## 🔧 Configuration Tips

### Environment Variables

Use environment variables for sensitive data:

```json
{
  "mcpServers": {
    "api-server": {
      "command": "node",
      "args": ["api-server.js"],
      "env": {
        "API_KEY": "${MY_API_KEY}",
        "DATABASE_URL": "$DB_CONNECTION"
      }
    }
  }
}
```

### Trust Settings

Trust servers you control to skip confirmation dialogs:

```json
{
  "mcpServers": {
    "trusted-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "trust": true
    }
  }
}
```

### Tool Filtering

Limit which tools are available:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "includeTools": ["read_file", "list_directory"],
      "excludeTools": ["write_file", "move_file"]
    }
  }
}
```

## 🎯 Common Use Cases

### Code Review Assistant

```json
{
  "mcpServers": {
    "codebase": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "description": "Full codebase access for reviews"
    },
    "review-memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "Remember review comments and patterns"
    }
  }
}
```

**Usage:**
```bash
qwen

> Review the changes in src/components/
> Remember: We follow the single responsibility principle
> Check if all new components have tests
```

### Documentation Generator

```json
{
  "mcpServers": {
    "source": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./src"],
      "includeTools": ["read_file", "list_directory"]
    },
    "docs-writer": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./docs"],
      "includeTools": ["write_file", "create_directory"]
    }
  }
}
```

### Learning Assistant

```json
{
  "mcpServers": {
    "tutorials": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "./tutorials",
        "./examples"
      ],
      "trust": true
    },
    "learning-progress": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "Track learning progress and concepts"
    }
  }
}
```

## 🛠️ Troubleshooting

### Server Won't Connect

1. **Check the command is accessible:**
   ```bash
   npx -y @modelcontextprotocol/server-filesystem ./
   ```

2. **Verify directory permissions:**
   ```bash
   ls -la ./
   ```

3. **Check logs:**
   ```bash
   qwen --debug
   ```

### No Tools Discovered

Ensure the server actually provides tools:
```bash
qwen mcp list --schema
```

### Tools Not Executing

- Check parameter schemas match
- Verify timeout settings (increase if needed)
- Test the server independently first

## 📖 Further Reading

- [MCP Server Documentation](./tools/mcp-server.md) - Complete reference
- [Official MCP Specification](https://modelcontextprotocol.io/) - Protocol details
- [MCP Server Examples](https://github.com/modelcontextprotocol/servers) - Community servers

## 🎓 Next Steps

1. ✅ Configure your first MCP server
2. ✅ Verify connection with `qwen mcp list`
3. ✅ Try basic file operations
4. ✅ Add memory for persistent context
5. ✅ Explore community MCP servers
6. ✅ Build your own custom server

---

**Pro Tip:** Start with trusted local servers (`trust: true`) for faster iteration, then add confirmation for production use.
