# MCP Example Configurations

Ready-to-use MCP server configurations for common scenarios.

## 📁 Local Development

### Basic Setup

```json
{
  "mcpServers": {
    "workspace": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "trust": true,
      "description": "Full workspace access"
    }
  }
}
```

### Multi-Directory Project

```json
{
  "mcpServers": {
    "frontend": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "./src",
        "./public",
        "./tests"
      ],
      "trust": true,
      "description": "Frontend development files"
    },
    "config": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "./config",
        "./.env.example"
      ],
      "trust": true,
      "includeTools": ["read_file", "list_directory"],
      "description": "Configuration files (read-only)"
    }
  }
}
```

## 🧠 Memory & Context

### Persistent Memory

```json
{
  "mcpServers": {
    "project-memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "trust": true,
      "description": "Remember project context across sessions"
    }
  }
}
```

### Combined with Filesystem

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

## 🌐 Remote Servers (HTTP/SSE)

### HTTP MCP Server

```json
{
  "mcpServers": {
    "remote-api": {
      "httpUrl": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}",
        "Content-Type": "application/json"
      },
      "timeout": 30000,
      "description": "Remote MCP API"
    }
  }
}
```

### SSE Server with OAuth

```json
{
  "mcpServers": {
    "sse-service": {
      "url": "https://mcp.example.com/sse",
      "oauth": {
        "enabled": true,
        "scopes": ["read", "write"]
      },
      "timeout": 60000,
      "description": "SSE server with OAuth"
    }
  }
}
```

## 🐍 Python MCP Servers

### Simple Python Server

```json
{
  "mcpServers": {
    "python-tools": {
      "command": "python",
      "args": ["-m", "my_mcp_server"],
      "env": {
        "PYTHONPATH": "${PWD}",
        "DEBUG": "false"
      },
      "description": "Custom Python MCP tools"
    }
  }
}
```

### Python with Virtual Environment

```json
{
  "mcpServers": {
    "python-venv": {
      "command": "./venv/bin/python",
      "args": ["-m", "mcp_server"],
      "cwd": "./",
      "env": {
        "VIRTUAL_ENV": "${PWD}/venv"
      },
      "description": "Python server in virtual environment"
    }
  }
}
```

## 🐳 Docker Containers

### Basic Docker Server

```json
{
  "mcpServers": {
    "docker-mcp": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "my-mcp-server:latest"
      ],
      "timeout": 45000,
      "description": "MCP server in Docker"
    }
  }
}
```

### Docker with Volume Mounts

```json
{
  "mcpServers": {
    "docker-workspace": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "${PWD}:/workspace",
        "-w",
        "/workspace",
        "-e",
        "API_KEY",
        "mcp-tools:latest"
      ],
      "env": {
        "API_KEY": "${MY_API_KEY}"
      },
      "description": "Docker MCP with workspace access"
    }
  }
}
```

## 🛡️ Security-Focused Configs

### Read-Only Filesystem

```json
{
  "mcpServers": {
    "readonly-docs": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "./docs",
        "./README.md"
      ],
      "includeTools": ["read_file", "list_directory", "search_files"],
      "excludeTools": [
        "write_file",
        "create_directory",
        "move_file",
        "delete_file"
      ],
      "trust": true,
      "description": "Read-only documentation access"
    }
  }
}
```

### Untrusted External Server

```json
{
  "mcpServers": {
    "external-api": {
      "httpUrl": "https://external-mcp.example.com/api",
      "trust": false,
      "timeout": 15000,
      "includeTools": ["search", "analyze"],
      "description": "External API (requires confirmation)"
    }
  }
}
```

## 📊 Database Access

### PostgreSQL MCP Server

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-postgres",
        "${DATABASE_URL}"
      ],
      "env": {
        "DATABASE_URL": "$POSTGRES_CONNECTION_STRING"
      },
      "timeout": 30000,
      "trust": false,
      "description": "PostgreSQL database access"
    }
  }
}
```

## 🧪 Testing & Development

### Test Environment

```json
{
  "mcpServers": {
    "test-files": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "./tests",
        "./fixtures"
      ],
      "trust": true,
      "description": "Test files and fixtures"
    },
    "test-memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "trust": true,
      "description": "Test session memory"
    }
  }
}
```

### Debug Configuration

```json
{
  "mcpServers": {
    "debug-server": {
      "command": "node",
      "args": ["--inspect", "mcp-server.js"],
      "env": {
        "DEBUG": "*",
        "LOG_LEVEL": "verbose"
      },
      "timeout": 60000,
      "description": "MCP server with debugging enabled"
    }
  }
}
```

## 🔄 CI/CD Integration

### GitHub Actions Environment

```json
{
  "mcpServers": {
    "ci-workspace": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "${GITHUB_WORKSPACE}"
      ],
      "env": {
        "GITHUB_TOKEN": "$GITHUB_TOKEN",
        "CI": "true"
      },
      "trust": true,
      "description": "CI/CD workspace access"
    }
  }
}
```

## 🌟 Advanced Patterns

### Multiple Servers Same Type

```json
{
  "mcpServers": {
    "project-a": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "../project-a"],
      "description": "Project A files"
    },
    "project-b": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "../project-b"],
      "description": "Project B files"
    },
    "shared-memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "Shared knowledge across projects"
    }
  }
}
```

### Conditional Server Selection

User-level config (`~/.qwen/settings.json`):
```json
{
  "mcpServers": {
    "global-memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "trust": true,
      "description": "Global memory across all projects"
    }
  }
}
```

Project-level config (`.qwen/settings.json`):
```json
{
  "mcpServers": {
    "project-files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "trust": true,
      "description": "Project-specific files"
    }
  }
}
```

## 📝 Configuration Validation

### Check Your Config

```bash
# List configured servers
qwen mcp list

# Show server details and schemas
qwen mcp list --schema

# Test connection
qwen mcp list --descriptions
```

### Common Mistakes

❌ **Wrong:**
```json
{
  "mcpServers": {
    "server": {
      "command": "mcp-server",  // Not in PATH
      "args": ["./"]
    }
  }
}
```

✅ **Correct:**
```json
{
  "mcpServers": {
    "server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"],
      "description": "Uses npx to ensure server is available"
    }
  }
}
```

## 🎯 Best Practices

1. **Use descriptive names** - Make server purposes clear
2. **Set appropriate timeouts** - Match your server's response time
3. **Trust local servers** - Skip confirmation for your own tools
4. **Filter tools** - Use `includeTools`/`excludeTools` for security
5. **Document configs** - Add descriptions for team members
6. **Environment variables** - Keep secrets out of configs
7. **Test independently** - Verify servers work before configuring

## 🔗 Quick Copy-Paste Configs

### Starter Pack

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

### Documentation Project

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./docs"],
      "includeTools": ["read_file", "list_directory"],
      "trust": true
    }
  }
}
```

### Full-Stack Development

```json
{
  "mcpServers": {
    "frontend": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./frontend"],
      "trust": true
    },
    "backend": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./backend"],
      "trust": true
    },
    "shared": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./shared"],
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

---

**Need help?** Check `qwen mcp --help` or refer to the [complete MCP documentation](./tools/mcp-server.md).
