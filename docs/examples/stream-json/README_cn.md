# Stream JSON 交互示例

本示例展示如何直接以 JSON Lines 协议驱动 Qwen Code CLI，并提供一个伪 SDK 客户端脚本，方便对接测试。

## 先决条件

- 本地已安装并可执行 `qwen code`（或在仓库内通过 `npx tsx packages/cli/index.ts` 运行）。
- 建议使用 `--include-partial-messages` 以体验增量事件。

## CLI 快速体验

1. 准备一份输入流（写入 `examples/stream-json/request.jsonl`）：

   ```bash
   cat <<'EOF' > examples/stream-json/request.jsonl
   {"type":"control_request","request_id":"req-init-1","request":{"subtype":"initialize","hooks":null}}
   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"请阅读 README.md 并总结三个关键特性。"}]}}
   {"type":"control_request","request_id":"req-interrupt-1","request":{"subtype":"interrupt"}}
   EOF
   ```

2. 运行 CLI，并将 JSONL 管道到标准输入。仓库内推荐通过 `npm run qwen` 启动（注意 `--` 之后才是 CLI 自身参数）：

   ```bash
   npm run qwen -- \
     --input-format stream-json \
     --output-format stream-json \
     --include-partial-messages \
     --model qwen-coder \
     < examples/stream-json/request.jsonl
   ```

3. 观察标准输出：当 CLI 初始化成功时会输出 `system/init`、`control_response` 以及含 `thinking_delta`、`text_delta` 的 `stream_event`，最后以 `result` 事件结束。

> 注意：若 CLI 发出 `control_request.can_use_tool` 等事件，需要调用方实时回写 `control_response`，否则进程会等待回执。

## 伪 SDK 脚本

- 位置：`docs/examples/stream-json/simple_stream_json_client.py`
- 功能：启动 CLI 子进程，自动完成 `initialize` 握手、发送用户消息，并对 `can_use_tool`、`hook_callback` 等控制请求给出示例响应。脚本会在收到 `result` 后通过 `interrupt` 结束会话。

运行示例：

```bash
python docs/examples/stream-json/simple_stream_json_client.py
```

默认脚本使用 `npm run qwen -- …` 启动 CLI，如需替换命令可设置环境变量 `QWEN_STREAM_JSON_COMMAND`，例如：

```bash
# export QWEN_STREAM_JSON_COMMAND="npm run qwen -- --input-format stream-json --output-format stream-json --include-partial-messages --model qwen-coder"
export QWEN_STREAM_JSON_COMMAND="npm run qwen -- --input-format stream-json --output-format stream-json --include-partial-messages"
python docs/examples/stream-json/simple_stream_json_client.py
```

脚本内部提供了 `StreamJsonClient` 类，可通过 `StreamJsonClientOptions` 自定义命令、初始化请求、用户消息、控制处理函数等，例如：

```python
import asyncio
import sys

sys.path.append("docs/examples/stream-json")
from simple_stream_json_client import StreamJsonClient, StreamJsonClientOptions

options = StreamJsonClientOptions(
    command=["npm", "run", "qwen", "--", "--input-format", "stream-json", "--output-format", "stream-json"],
    user_messages=[
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "举例说明 stream-json 协议用途"}],
            },
        }
    ],
    extra_handlers={
        # 拒绝敏感工具
        "can_use_tool": lambda client, request_id, payload: client.send_control_response(
            request_id,
            success=True,
            response={"behavior": "deny", "message": "demo client blocks all tools"},
        ),
    },
)

client = StreamJsonClient(options)
asyncio.run(client.run())
```

## 自动化测试

新增单元测试验证了 stream-json 相关功能，可通过以下命令运行：

```bash
npx vitest run \
  packages/cli/src/streamJson/writer.test.ts \
  packages/cli/src/streamJson/session.test.ts \
  packages/cli/src/nonInteractiveCli.test.ts
```

测试涵盖：
- `system/init` 事件与会话元数据
- 部分消息增量（`thinking_delta`、`input_json_delta` 等）
- `result` 事件中的 `usage`、`duration_api_ms` 字段
- `can_use_tool` 控制请求桥接逻辑

通过上述步骤即可快速验证 Stream JSON 协议在 CLI 中的输出与控制通道行为。

### 运行日志示例（节选）

下表摘录脚本运行过程中的关键日志，并标注演示的能力：

| 日志片段 | 功能说明 |
| --- | --- |
| `{"type":"control_response","request_id":"demo-init","success":true,...}`<br/>`{"type":"system","subtype":"init",...}` | 脚本回写 `initialize`，CLI 输出 `system/init` 会话元数据（控制通道 + 系统事件）。 |
| `{"type":"user","message":{"role":"user","content":"请阅读 README.md..."}}` | 客户端发送 `user` 消息，触发单轮会话。 |
| `{"type":"stream_event","event":{"type":"message_start",...}}`<br/>`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}`<br/>`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta",...}}}` | 增量事件补全：文本 `text_delta` 与工具输入 `input_json_delta`。 |
| `{"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}`<br/>`{"type":"user","message":{"content":[{"type":"tool_result",...}]},...}` | CLI 发起工具调用，脚本回写 `tool_result`，展示 `can_use_tool` 桥接及工具结果回传。 |
| 连续 `content_block_delta` 输出 README 摘要<br/>`{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}` | 思考/文本增量与最终完整 `assistant` 消息一致。 |
| `{"type":"result","subtype":"session_summary","duration_api_ms":..., ...}` | `result` 事件包含 `duration_api_ms`、`num_turns` 等统计字段。 |
| `{"type":"control_response","request_id":"demo-interrupt","success":true,...}` | 脚本发送 `interrupt` 收尾，CLI 返回成功响应。 |

## 手工验证指南

如下命令便于人工对照本次实现的关键能力是否落实：

1. **初始化与增量事件**（验证 `system/init`、`stream_event` 生命周期对齐 Claude 协议）
   ```bash
   npm run qwen -- \
     --input-format stream-json \
     --output-format stream-json \
     --include-partial-messages \
     --model qwen-coder \
     < examples/stream-json/request.jsonl
   ```
   期望输出：初始化时包含完整 `system/init` 字段；助手回复过程中出现 `message_start`、`content_block_start/delta/stop` 及 `message_stop`。

2. **实时控制通道**（验证 `can_use_tool`、`hook_callback` 等高级子类型）
   ```bash
   npm run qwen -- --input-format stream-json --output-format stream-json --model qwen-coder
   # 依次输入：
   {"type":"control_request","request_id":"req-init","request":{"subtype":"initialize"}}
   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"请执行 ls"}]}}
   ```
   期望输出：CLI 对初始化请求返回 `control_response.success`，在触发工具调用时向上游发送 `control_request.can_use_tool`，同时可看到钩子回执产生的 `system hook_callback` 消息。

3. **MCP 消息桥接**（验证 `mcp_message` 透传）
   ```bash
   npm run qwen -- --input-format stream-json --output-format stream-json --model qwen-coder
   {"type":"control_request","request_id":"req-mcp","request":{"subtype":"mcp_message","server_name":"default","message":{"jsonrpc":"2.0","id":"1","method":"tools/list"}}}
   ```
   期望输出：`control_response.success` 中的 `mcp_response.result.tools` 列出已注册的 MCP 工具。若未配置 MCP，可用于验证错误回执 `control_response.error` 的结构化字段。

4. **工具结果回链**（验证 `user` 信封携带 `tool_result` 与 `parent_tool_use_id`）
   ```bash
   npm run qwen -- --input-format stream-json --output-format stream-json --model qwen-coder
   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"demo-tool","content":[{"type":"text","text":"手动工具结果"}]}]},"parent_tool_use_id":"demo-tool"}
   ```
   期望输出：CLI 会在后续调用 `runNonInteractive` 时读取该 `tool_result`，并在需要时继续衍生对话，不再记录用户回响。

上述手工步骤覆盖了 OpenSpec 剩余任务中新增的高级控制请求、系统初始化字段、增量事件补全、用户信封扩展与错误语义规范化等核心能力。

## 自动化验证脚本

若需一次性跑通上述控制通道场景，可执行：

```bash
python docs/examples/stream-json/validate_stream_json_cli.py
```

脚本将自动启动 `qwen code`，依次触发 `initialize`/`hook_callback`/`can_use_tool`/`mcp_message` 等事件，并把所有请求/响应 JSON 行实时打印出来，最终以表格形式汇总每个断言的通过状态。可通过以下环境变量调整行为：

- `QWEN_STREAM_JSON_COMMAND`：自定义 CLI 启动命令。
- `STREAM_JSON_VALIDATE_VERBOSE=0`：如需关闭逐行日志，可将该变量设为 `0`。
- `STREAM_JSON_VALIDATE_PROMPT=1`：启用“用户 prompt 触发工具调用”的附加场景（需要可用模型或代理凭据）。
- `STREAM_JSON_VALIDATE_TOOL_RESULT=1`：启用“tool_result + parent_tool_use_id 链路”的附加场景。
