# qwen-serve-bridge MCP Server

将 `qwen serve` 的 HTTP API 封装为 MCP (Model Context Protocol) Server，方便任何支持 MCP 的客户端直接调用。

## 快速开始

### 1. 启动 qwen serve daemon

```bash
# 基本启动
qwen serve
# 默认监听 http://127.0.0.1:4170

# 带 token 和 workspace 启动
QWEN_SERVER_TOKEN=<your-token> qwen serve \
  --port 4170 \
  --workspace /path/to/your/project
```

### 2. 运行 MCP Server（stdio 模式）

```bash
QWEN_DAEMON_URL=http://127.0.0.1:4170 \
QWEN_DAEMON_TOKEN=<your-token> \
qwen-serve-mcp
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `QWEN_DAEMON_URL` | daemon 基础 URL | `http://127.0.0.1:4170` |
| `QWEN_DAEMON_TOKEN` | Bearer token（loopback 可省略 health 路由） | 无 |
| `QWEN_WORKSPACE_CWD` | 默认工作区路径 | 无 |

## 在 MCP 客户端中配置

### 方式一：通过 npx（推荐，无需本地安装）

适用于任何外部项目，无需本地源码：

```json
{
  "mcpServers": {
    "qwen-serve-bridge": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "@qwen-code/sdk", "qwen-serve-mcp"],
      "env": {
        "QWEN_DAEMON_URL": "http://127.0.0.1:4170",
        "QWEN_DAEMON_TOKEN": "<your-token>"
      }
    }
  }
}
```

### 方式二：全局安装后使用

```bash
npm install -g @qwen-code/sdk
```

```json
{
  "mcpServers": {
    "qwen-serve-bridge": {
      "type": "stdio",
      "command": "qwen-serve-mcp",
      "env": {
        "QWEN_DAEMON_URL": "http://127.0.0.1:4170",
        "QWEN_DAEMON_TOKEN": "<your-token>"
      }
    }
  }
}
```

### 方式三：指定本地路径（开发调试用）

适用于本地开发 qwen-code 源码时：

```json
{
  "mcpServers": {
    "qwen-serve-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/qwen-code/packages/sdk-typescript/dist/daemon-mcp/serve-bridge/bin.js"],
      "env": {
        "QWEN_DAEMON_URL": "http://127.0.0.1:4170",
        "QWEN_DAEMON_TOKEN": "<your-token>",
        "QWEN_WORKSPACE_CWD": "/path/to/your/project"
      }
    }
  }
}
```

> **注意**：方式三需要指定 Node >=22 的完整路径（如 `~/.nvm/versions/node/v22.x.x/bin/node`），
> 除非系统默认 Node 版本已经 >=22。

### 编程式使用

```typescript
import { createServeBridgeMcpServer } from '@qwen-code/sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createServeBridgeMcpServer({
  daemonUrl: 'http://127.0.0.1:4170',
  token: process.env.QWEN_DAEMON_TOKEN,
  workspaceCwd: '/path/to/workspace',
});

const transport = new StdioServerTransport();
await server.instance.connect(transport);
```

## 提供的工具（共 31 个）

### Infrastructure（2）

| 工具名 | 说明 |
|--------|------|
| `health` | 检查 daemon 是否存活 |
| `capabilities` | 获取功能/版本信息 |

### Session Lifecycle（6）

| 工具名 | 说明 |
|--------|------|
| `session_create` | 创建/附加会话（自动设为默认会话） |
| `session_load` | 恢复会话（含历史回放） |
| `session_resume` | 恢复会话（无历史） |
| `session_close` | 关闭会话 |
| `session_update_metadata` | 更新会话元数据 |
| `session_list` | 列出工作区会话 |

### Agent Interaction（4）

| 工具名 | 说明 |
|--------|------|
| `prompt` | 发送 prompt 到 Agent（核心工具，可能耗时较长） |
| `prompt_cancel` | 取消正在执行的 prompt |
| `session_set_model` | 切换模型 |
| `session_context` | 获取会话状态 |

### Workspace Read（10）

| 工具名 | 说明 |
|--------|------|
| `file_read` | 读取文本文件 |
| `file_read_bytes` | 读取二进制文件（base64） |
| `file_stat` | 文件元信息 |
| `dir_list` | 目录列表 |
| `glob` | Glob 模式匹配 |
| `workspace_mcp_status` | MCP 服务器状态 |
| `workspace_skills` | 技能列表 |
| `workspace_providers` | 模型提供商状态 |
| `workspace_env` | 运行时环境快照 |
| `workspace_preflight` | 就绪检查 |

### Workspace Write（9）

| 工具名 | 说明 |
|--------|------|
| `file_write` | 写文件（支持 hash 校验的原子写入） |
| `file_edit` | 编辑文件（精确匹配替换） |
| `session_set_approval_mode` | 变更审批模式 |
| `workspace_tool_toggle` | 启用/禁用工具 |
| `workspace_init` | 初始化 QWEN.md |
| `workspace_mcp_restart` | 重启 MCP 服务器 |
| `workspace_memory_read` | 读工作区记忆 |
| `workspace_memory_write` | 写工作区记忆 |
| `workspace_agents_manage` | Agent CRUD 管理 |

## 会话管理

MCP 协议是无状态的，但大部分工具需要 `session_id`。本 MCP Server 采用**默认会话**机制：

1. 调用 `session_create` 后自动记住创建的会话 ID
2. 后续工具调用若省略 `session_id`，自动使用默认会话
3. 也可显式传入 `session_id` 操作多个会话
4. `session_close` 关闭默认会话时自动清除缓存

## 验证

```bash
# 发送 MCP initialize + tools/list 请求
printf '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","method":"tools/list","id":2}\n' \
  | node dist/daemon-mcp/serve-bridge/bin.js

# 调用 health 工具
printf '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","method":"tools/call","params":{"name":"health","arguments":{}},"id":3}\n' \
  | node dist/daemon-mcp/serve-bridge/bin.js
```

预期输出：
- `tools/list` 返回 31 个工具定义
- `health` 返回 `{"content":[{"type":"text","text":"{\"status\":\"ok\"}"}]}`
