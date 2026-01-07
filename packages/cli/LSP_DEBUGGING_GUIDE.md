# LSP 调试指南

本指南介绍如何调试 packages/cli 中的 LSP (Language Server Protocol) 功能。

## 1. 启用调试模式

CLI 支持调试模式，可以提供额外的日志信息：

```bash
# 使用 debug 标志运行
qwen --debug [你的命令]

# 或设置环境变量
DEBUG=true qwen [你的命令]
DEBUG_MODE=true qwen [你的命令]
```

## 2. LSP 配置选项

LSP 功能通过设置系统配置，包含以下选项：

- `lsp.enabled`: 启用/禁用原生 LSP 客户端（默认为 `false`）
- `lsp.allowed`: 允许的 LSP 服务器名称白名单
- `lsp.excluded`: 排除的 LSP 服务器名称黑名单

在 settings.json 中的示例配置：
```json
{
  "lsp": {
    "enabled": true,
    "allowed": ["typescript-language-server", "pylsp"],
    "excluded": ["gopls"]
  }
}
```

## 3. NativeLspService 调试功能

`NativeLspService` 类包含几个调试功能：

### 3.1 控制台日志
服务向控制台输出状态消息：
- `LSP 服务器 ${name} 启动成功` - 服务器成功启动
- `LSP 服务器 ${name} 启动失败` - 服务器启动失败
- `工作区不受信任，跳过 LSP 服务器发现` - 工作区不受信任，跳过发现

### 3.2 错误处理
服务具有全面的错误处理和详细的错误消息

### 3.3 状态跟踪
您可以通过 `getStatus()` 方法检查所有 LSP 服务器的状态

## 4. 调试命令

```bash
# 启用调试运行
qwen --debug --prompt "调试 LSP 功能"

# 检查在您的项目中检测到哪些 LSP 服务器
# 系统会自动检测语言和相应的 LSP 服务器
```

## 5. 手动 LSP 服务器配置

您还可以在项目根目录使用 `.lsp.json` 文件手动配置 LSP 服务器：

```json
{
  "python": {
    "command": "pylsp",
    "args": [],
    "transport": "stdio",
    "trustRequired": true
  }
}
```

## 6. LSP 问题排查

### 6.1 检查 LSP 服务器是否已安装
- 对于 TypeScript/JavaScript: `typescript-language-server`
- 对于 Python: `pylsp` 
- 对于 Go: `gopls`

### 6.2 验证工作区信任
- LSP 服务器可能需要受信任的工作区才能启动
- 检查 `security.folderTrust.enabled` 设置

### 6.3 查看日志
- 查找以 `LSP 服务器` 开头的控制台消息
- 检查命令存在性和路径安全性问题

## 7. LSP 服务启动流程

LSP 服务的启动遵循以下流程：

1. **发现和准备**: `discoverAndPrepare()` 方法检测工作区中的编程语言
2. **创建服务器句柄**: 根据检测到的语言创建对应的服务器句柄
3. **启动服务器**: `start()` 方法启动所有服务器句柄
4. **状态管理**: 服务器状态在 `NOT_STARTED`, `IN_PROGRESS`, `READY`, `FAILED` 之间转换

## 8. 调试技巧

- 使用 `--debug` 标志查看详细的启动过程
- 检查工作区是否受信任（影响 LSP 服务器启动）
- 确认 LSP 服务器命令在系统 PATH 中可用
- 使用 `getStatus()` 方法监控服务器运行状态