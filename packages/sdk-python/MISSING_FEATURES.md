# Python SDK 与 TypeScript SDK 功能差异记录

## 概述

本文档记录 Python SDK 实现过程中与 TypeScript SDK 的功能差异、无法直接对应的功能、以及技术限制。

## 测试结果

- **总测试数**: 246
- **通过**: 244
- **失败**: 2 (预先存在，与 Stream 修复无关)

## 无法直接对应的功能

### 1. Logger - `ScopedLogger.child()` 方法

**TS-SDK**:
```typescript
logger.child('subcomponent').debug('message');
```

**Python SDK**: ✅ 已实现
- 使用 `ScopedLogger.child(suffix)` 方法
- 返回新的 `ScopedLogger` 实例

### 2. Logger - 日志格式化

**TS-SDK**: 使用 `util.format()` 进行格式化
**Python SDK**: ✅ 已实现
- 使用 Python 标准 `logging.Formatter`
- 格式: `%(asctime)s - %(name)s - %(levelname)s - %(message)s`

### 3. AbortController/AbortSignal

**TS-SDK**: 原生 Web API
**Python SDK**: ✅ 已自定义实现
- 由于 Python 3.10 没有内置 `AbortController`/`AbortSignal`
- 在 `transport.py` 中实现了兼容版本
- 支持多个监听器

### 4. Stream 类

**TS-SDK**: `Stream<T>` 类用于异步迭代
**Python SDK**: ✅ 已实现
- `utils.py` 中的 `Stream` 类
- 支持 `async for` 迭代
- 支持 `enqueue()`, `error()`, `done()`
- **超时机制**: `_consume()` 使用 `asyncio.wait_for()` + 0.1s 超时
- **完成检测**: 通过 `_done` 标志和超时组合确保迭代可正常结束

### 5. JSON Lines 序列化

**TS-SDK**: `jsonLines.ts` 模块
**Python SDK**: ✅ 已实现
- `serialize_json_line(obj)` - 序列化
- `deserialize_json_line(line)` - 反序列化

### 6. Schema 验证

**TS-SDK**: `queryOptionsSchema.ts` 使用 JSON Schema
**Python SDK**: ✅ 已实现
- `validation.py` 中的验证函数
- 使用自定义验证逻辑（pydantic 可选）

## 功能差异

### 1. MCP SDK 服务器功能

**状态**: 暂未实现（标记为"暂缓"）

**TS-SDK**:
- `mcp/tool.ts` - `tool()` 装饰器
- `mcp/createSdkMcpServer.ts` - 创建 MCP 服务器
- `mcp/SdkControlServerTransport.ts` - 控制传输
- `mcp/formatters.ts` - 消息格式化

**Python SDK**: 未实现
- 原因: 需要更复杂的 MCP 协议实现
- 建议: 后续版本实现

### 2. CLI MCP 服务器配置

**TS-SDK**:
- `SdkMcpServerResponse` 类型
- 完整的 MCP OAuth 配置

**Python SDK**: 部分实现
- `SdkMcpServerConfig` 已实现
- `McpAuthConfig` 已实现
- OAuth 特定配置未完全实现

### 3. 类型系统差异

**TS-SDK**: 使用 TypeScript 静态类型系统
**Python SDK**: 使用 Python 类型提示 (PEP 484)
- 使用 `@dataclass` 模拟 TypeScript 接口
- 使用 `Literal` 类型表示字符串字面量
- 使用 `Union` 表示联合类型

### 4. 导入/导出模式

**TS-SDK**: ES Modules
**Python SDK**: Python 模块系统
- 使用 `__init__.py` 重新导出
- 支持 `from qwen_code import ...`

## 技术限制

### 1. 异步迭代器实现

**TS-SDK**:
```typescript
for await (const message of query) { }
```

**Python SDK**:
```python
async for message in query:
    pass
```

两者都使用 `AsyncIterator` 协议，但实现细节不同。

### 2. 类型守卫函数

**TS-SDK**: 使用类型谓词
```typescript
function isSDKUserMessage(msg: any): msg is SDKUserMessage { }
```

**Python SDK**: 使用函数返回布尔值
```python
def is_sdk_user_message(msg: Any) -> bool:
    return isinstance(msg, dict) and msg.get("type") == "user"
```

### 3. 子进程通信

**TS-SDK**: 使用 `child_process` 模块
**Python SDK**: 使用 `subprocess` 模块
- 实现方式不同，但功能等价
- `ProcessTransport` 类已对齐

## 未实现的 TS-SDK 功能

| 功能 | 文件 | 状态 | 原因 |
|------|------|------|------|
| `tool()` 装饰器 | `mcp/tool.ts` | **不实现** | 用户请求不实现 MCP 功能 |
| `createSdkMcpServer()` | `mcp/createSdkMcpServer.ts` | **不实现** | 用户请求不实现 MCP 功能 |
| `SdkControlServerTransport` | `mcp/SdkControlServerTransport.ts` | **不实现** | 用户请求不实现 MCP 功能 |
| MCP formatters | `mcp/formatters.ts` | **不实现** | 用户请求不实现 MCP 功能 |

## 总结

Python SDK 实现了 TS-SDK 的核心功能对齐，包括:
- ✅ Query 核心功能
- ✅ 传输层 (`ProcessTransport`)
- ✅ 协议消息类型
- ✅ 错误处理 (`AbortError`)
- ✅ 工具函数 (Stream, JSON Lines)
- ✅ CLI 路径工具
- ✅ 日志系统
- ✅ Schema 验证
- ✅ 配置类型
- ✅ 超时设置方法
- ✅ 事件监听器
- ✅ 子代理选项支持
- ✅ 控制请求处理程序

**MCP SDK 服务器功能**: 用户明确请求不实现

---

## 已修复的关键问题

### 2026-02-03: 流式迭代永久挂起

**问题描述**: 使用 `async for` 迭代查询结果时，程序永久挂起无法结束。

**根本原因**: 三处问题组合导致：
1. `Stream._consume()` 中的 `queue.get()` 永久阻塞
2. 任务取消时 `_read_stdout_loop()` 未标记 stream 完成
3. 未调用 `transport.endInput()` 通知 CLI 输入结束

**修复文件**:
- `utils.py`: 添加 0.1s 超时到 `_consume()` 方法
- `transport.py`: 在 `_read_stdout_loop()` 的 finally 块中标记 stream 完成
- `query.py`: 添加 `endInput()` 调用和 `_input_stream.done()`

**详细记录**: 参见 `issues/2026-02-03_stream_hang_on_iteration.md`
