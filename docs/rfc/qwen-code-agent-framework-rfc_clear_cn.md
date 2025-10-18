# Qwen-Code Agent 框架架构设计（整理版）

## 概览

| 字段 | 详情 |
| --- | --- |
| 设计版本 | v1.1 |
| 最后更新 | 2025-10-10 |
| 架构范围 | Qwen-Code Agent SDK 与 qwen-code CLI 的子进程编排、控制协议、可观测与配置体系 |
| 关键目标 | 为第三方应用提供统一 IPC 通信、Worker 池治理、权限控制与工具桥接能力 |

- **核心组件**: 文档聚焦 Qwen-Code Agent SDK, 在宿主进程内封装会话路由、控制协议与 Worker 池治理, 面向多语言场景提供统一接入。
- **核心职能**: 会话调度与路由；CLI 子进程生命周期与资源治理；控制协议 Hook 与权限判定；轻量日志输出与可观测接入；观察性数据采集（日志、指标、追踪）。
- **核心功能**: 支持同步/异步任务执行、流式输出、会话管理、错误处理与重试、In-Process MCP 工具桥接以及独立配置注入。
- 面向多语言 SDK，统一封装 CLI 子进程生命周期与 JSONL 协议。
- 提供会话调度、权限治理、Hook/MCP 回调、日志与指标采集的一致接口。
- 以与 Claude Agent SDK 对齐的协议规范，降低多端协作与生态集成成本。

## 架构总览

| 层级 | 主要组件 | 职责要点 |
| --- | --- | --- |
| 上游客户端 | TypeScript / Python / Go / Java SDK | 暴露标准 API，适配各语言生态，负责会话接入与自定义工具注册 |
| Agent SDK 内核 | Router、ControlPlane、WorkerPool、ProcessMgr、IPC | 管理会话路由、权限回调、进程池生命周期与 STDIO JSONL 传输 |
| CLI Worker | qwen-code CLI 子进程 | 执行模型推理与工具调用，按照协议输出 `chat.completion*` / `result/*` / `control_request` |
| 周边服务 | LLM/MCP、监控、日志、追踪 | 提供模型服务、可观测数据与外部系统集成能力 |

```mermaid
flowchart LR
    subgraph Clients["第三方应用 / 服务"]
        direction LR
        TypeScriptSDK["qwen-agent-sdk<br/>TypeScript"]
        PythonSDK["qwen-agent-sdk<br/>Python"]
        GoSDK["qwen-agent-sdk<br/>Go (TODO)"]
        JavaSDK["qwen-agent-sdk<br/>Java (TODO)"]
    end

    subgraph AgentSDK["Qwen-Code Agent SDK"]
        direction TB
        Router["会话调度<br/>路由 / 负载均衡"]
        ControlPlane["控制协议<br/>Hook / 权限判定"]
        WorkerPool["Worker 池管理<br/>分配 / 回收 / 健康检查"]
        ProcessMgr["子进程管理<br/>启动 / 监控 / 重启"]
        IPC["IPC 适配层<br/>STDIN/STDOUT JSONL"]
    end

    subgraph Workers["qwen-code CLI Workers"]
        direction LR
        Worker1["Worker #1<br/>qwen-code CLI"]
        Worker2["Worker #2<br/>qwen-code CLI"]
        WorkerN["Worker #N"]
    end

    subgraph Services["外围服务"]
        LLM_MCP["大模型服务/MCP 服务"]
        Monitor["监控告警"]
        Logger["日志中心"]
        Trace["链路追踪"]
    end

    Clients --> Router
    Router --> ControlPlane
    Router --> WorkerPool
    WorkerPool --> ProcessMgr
    ProcessMgr --> IPC
    ControlPlane -->|control_response| IPC
    IPC -->|control_request| ControlPlane
    IPC --> Worker1
    IPC --> Worker2
    IPC --> WorkerN

    Worker1 --> LLM_MCP
    Worker2 --> LLM_MCP
    WorkerN --> LLM_MCP

    Router --> Monitor
    Router --> Logger
    Router --> Trace
    IPC -->|result/*| ControlPlane
    ControlPlane -->|request| IPC

    classDef clientStyle fill:#e67e22,stroke:#ba6c1e,color:#fff
    classDef sdkStyle fill:#f39c12,stroke:#ca7e08,color:#fff
    classDef workerStyle fill:#16a085,stroke:#138d75,color:#fff
    classDef serviceStyle fill:#95a5a6,stroke:#707b7c,color:#fff
    class Clients,TypeScriptSDK,PythonSDK,GoSDK,JavaSDK clientStyle
    class AgentSDK,Router,ControlPlane,ProcessMgr,IPC,WorkerPool sdkStyle
    class Workers,Worker1,Worker2,WorkerN workerStyle
    class Services,MCP,Monitor,Logger,Trace serviceStyle
```

- Agent SDK 与 CLI 共享 STDIN/STDOUT 双向 JSONL 通道，统一传输 `chat.completion*`、`result/*`、`control_request` 等事件。
- 双向通信链路：CLI 逐行输出 `chat.completion`/`result/*`/`control_request` 至 stdout，SDK 解析后按需通过 stdin 回写 `request`/`control_response`，当出现 `control_request{subtype:"mcp_message"}` 时，ControlPlane 会将 JSON-RPC 转发至本地 MCP Server 并回传 `mcp_response`。
- qwen-code CLI 已接入 OpenTelemetry，上报模型调用、工具执行、CLI 内部事件；Agent SDK 需独立接入，并通过 Trace/Span ID 串联端到端链路，构建统一排障视角。
- 控制协议的事件语义与 CLI 输出格式规范保持一致，详见配套的 `stream-json` RFC。
- 事件分类提示：关于 `result/*`、`request`、`control_request` 等事件的详细语义，请参阅《qwen-code-cli-output-format-stream-json-rfc_cn.md》的“事件机制分类”章节。

## 核心能力映射

| 能力域 | 关键内容 | 当前能力 | 后续演进 |
| --- | --- | --- | --- |
| 会话调度 | 会话路由、Worker 绑定、复用策略 | SDK 侧提供 Router、Worker 池调度 | 增强会话分支/子 Agent 调度 |
| 进程治理 | 子进程启动、监控、重启 | ProcessMgr 负责生命周期与资源限制 | 引入资源配额、故障自动隔离 |
| 控制协议 | 权限回调、Hook、MCP | ControlPlane 统一处理 `control_request` | 扩展更多 Hook 点与审批策略 |
| IPC 协议 | JSON Lines、输入输出格式 | IPC 层实现 `stream-json`/`stream-chunk-json` | 丰富事件类型、协议版本协商 |
| 可观测性 | 日志、指标、Trace | SDK 与 CLI 各自接入 OTel，并输出结构化日志 | 统一指标命名与跨组件追踪分析 |

- 会话调度与控制层需要保证 Worker 独占机制、会话隔离与资源回收。
- 控制协议以 request/response 模型运行，SDK 必须在超时前回写 `control_response`，确保 CLI 不被阻塞。

## Agentic 会话能力

| 能力块 | 设计重点 | 接口/结构 |
| --- | --- | --- |
| 会话循环 | 状态化 `QwenAgentClient`，区分连接与消息流阶段 | `connect()`、`disconnect()`、`Query.initialize()` |
| 会话上下文 | 支持异步上下文管理与资源释放 | `__aenter__` / `__aexit__`、`async with QwenAgentClient` |
| 消息流处理 | 同一会话内追加输入并消费流式输出 | `query()`、`stream_input()`、`receive_messages()`、`receive_response()` |
| 动态控制 | 运行时切换模型/权限、触发中断并回读初始化能力 | `interrupt()`、`set_permission_mode()`、`set_model()`、`get_server_info()` |
| 传输抽象 | 可插拔 Transport 支持本地/远程 CLI 与缓冲守护 | `Transport`、`SubprocessCLITransport`、`max_buffer_size` 校验 |

### 会话循环与上下文

- `QwenAgentClient.connect()` 支持字符串与异步流模式，可在首次 `initialize` 时注入 Hook 与 SDK MCP Server，保障 IDE/服务多轮会话。
- `disconnect()` 清理 `_query` 及 Transport，结合 `async with` 自动化连接/释放流程，避免遗留子进程。
- 参数校验需提前阻止互斥选项（如 `can_use_tool` 与 `permission_prompt_tool_name` 同时启用），提升配置体验。

### 消息流处理

- `query()` 自动补全 `session_id` 并写入 JSONL，支持脚本/界面按需追加消息。
- `stream_input()` 负责增量写入并在异常时清空缓冲、记录调试日志，维持长流程稳定性。
- `receive_messages()` 遍历所有事件，`receive_response()` 检测到 `ResultMessage` 后提前收束，方便界面感知一次回答完成。
- `include_partial_messages` 选项允许透传增量 chunk，配合 `stderr`/`debug_stderr` 捕获底层诊断输出，便于复杂界面实时渲染。

### 动态控制接口

- `_send_control_request` 支持 `interrupt`、`set_permission_mode`、`set_model` 等子类型，实现手动打断、权限模式切换与热切模型。
- `get_server_info()` 回读 CLI 初始化能力（协议版本、指令集等），用于动态配置前端或策略。
- `async query(...)->AsyncIterator` 暴露在脚本化场景，实现一次性消费完整响应，同时保留自定义 Transport 的可能。

### 单次查询与多 Agent 编排

- `query()` 快速入口封装了会话生命周期，适合集成脚本或批量任务；当传入自定义 `Transport` 时可复用远程 CLI 或 Agent 服务。
- `agents` 配置将多 Agent 拓扑映射到 CLI `--agents` 参数，结合 `fork_session` 支持会话分叉与子 Agent 路由。
- CLI 命令生成时需根据 `setting_sources`、`allowed_tools`、`mcp_servers` 等选项拼装 JSON，保证 SDK 与 CLI 能力一致。

### Hook 与 MCP 桥接

- Hook 初始化阶段将 `HookMatcher` 列表转换为 `hookCallbackIds`，`hook_callback` 事件据此回调宿主逻辑，支持 `PreToolUse`、`PostToolUse`、`UserPromptSubmit` 等关键节点。
- SDK 侧 `create_sdk_mcp_server`/`defineTools` 在宿主进程构建 MCP Server，`mcp_message` 请求触发 `tools/list`、`tools/call`、`initialize` 等 JSON-RPC，避免额外子进程。
- 权限审批通过 `PermissionResultAllow`/`PermissionResultDeny` 及 `PermissionUpdate` 结构返回细粒度策略，可在 Hook 或工具回调中按需调整。
- **示例：PreToolUse 与 UserPromptSubmit 组合**（参考 `third-party/anthropics/claude-agent-sdk-python/examples/hooks.py`）：
  ```python
  import asyncio
  from qwen_agent_sdk import HookContext, HookMatcher, QwenAgentOptions, QwenSDKClient


  async def block_risky_bash(
      input_data: dict[str, object],
      tool_use_id: str | None,
      context: HookContext,
  ) -> dict[str, object]:
      command = input_data.get("command", "") if isinstance(input_data, dict) else ""
      if isinstance(command, str) and "rm -rf" in command:
          return {
              "hookSpecificOutput": {
                  "hookEventName": "PreToolUse",
                  "permissionDecision": "deny",
                  "permissionDecisionReason": "阻止危险删除命令",
              }
          }
      return {}


  async def inject_user_memory(
      input_data: dict[str, object],
      tool_use_id: str | None,
      context: HookContext,
  ) -> dict[str, object]:
      return {
          "hookSpecificOutput": {
              "hookEventName": "UserPromptSubmit",
              "additionalContext": "请牢记用户最喜欢的颜色是蓝色。",
          }
      }


  options = QwenAgentOptions(
      allowed_tools=["Bash"],
      hooks={
          "PreToolUse": [HookMatcher(matcher="Bash", hooks=[block_risky_bash])],
          "UserPromptSubmit": [HookMatcher(matcher=None, hooks=[inject_user_memory])],
      },
  )


  async def main() -> None:
      async with QwenSDKClient(options=options) as client:
          await client.query("尝试运行命令: rm -rf /tmp")
          async for message in client.receive_response():
              ...


  asyncio.run(main())
  ```

### 传输层扩展

- `Transport` 抽象允许替换默认的 `SubprocessCLITransport`，以适配远程 CLI、Agent 服务或容器托管场景。
- 传输层在握手前执行版本检测与 `max_buffer_size` 限制，输出超限时抛出结构化错误并清理缓冲，防止内存膨胀。
- 可通过选项控制工作目录、环境变量及 stderr 捕获，为 IDE 与服务端部署提供灵活拓扑。
- `SubprocessCLITransport` 构建 CLI 命令时需注入 `--mcp-config`、`--agents`、`--setting-sources` 等参数，并在环境变量中写入 `CLAUDE_CODE_ENTRYPOINT`、自定义 `env`、`user` 配置以确保子进程能力对齐。
- **示例：自定义远程 Transport**（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/__init__.py`）：
  ```python
  import json
  from collections.abc import AsyncIterator
  import httpx
  from qwen_agent_sdk import QwenAgentOptions, QwenSDKClient
  from qwen_agent_sdk.transport import Transport


  class RemoteHTTPTransport(Transport):
      def __init__(self, endpoint: str) -> None:
          self._client = httpx.AsyncClient(base_url=endpoint, timeout=30.0)
          self._ready = False

      async def connect(self) -> None:
          self._ready = True

      async def write(self, data: str) -> None:
          await self._client.post("/ingress", content=data.encode("utf-8"))

      def read_messages(self) -> AsyncIterator[dict[str, object]]:
          async def iterator() -> AsyncIterator[dict[str, object]]:
              async with self._client.stream("GET", "/egress") as response:
                  async for line in response.aiter_lines():
                      if line:
                          yield json.loads(line)
          return iterator()

      async def close(self) -> None:
          await self._client.aclose()
          self._ready = False

      def is_ready(self) -> bool:
          return self._ready

      async def end_input(self) -> None:
          await self._client.post("/ingress/close")


  transport = RemoteHTTPTransport("https://cli-gateway.internal")
  options = QwenAgentOptions(system_prompt="所有命令都通过远程 CLI 网关执行。")


  async with QwenSDKClient(options=options, transport=transport) as client:
      await client.query("读取 README.md 并总结三条要点。")
      async for message in client.receive_response():
          ...
  ```

### 调试与环境注入

- CLI 编排需根据 `QwenAgentOptions` 生成完整命令列，区分流式与一次性执行（`--input-format stream-json` 与 `--print`）。
- `options.stderr` 与 `debug_stderr` 支持在 SDK 侧接管 CLI 调试输出，结合 anyio TaskGroup 实时读取 stderr 流。
- `cwd`、`env`、`user` 等参数决定子进程工作目录与权限边界，SDK 应在启动时显式传入并在断连时回收资源。
- **示例：错误回调与重试**（参考 `third-party/claude-agent-sdk-python-demo/add_my_permission.py`）：
  ```python
  import anyio
  from qwen_agent_sdk import (
      PermissionDecision,
      PermissionRequest,
      PermissionUpdate,
      QwenAgentOptions,
      QwenSDKClient,
  )


  async def decide_permission(request: PermissionRequest) -> PermissionDecision:
      if request.tool_name == "Write" and request.input and "rm -rf" in str(request.input):
          return PermissionDecision(allow=False, reason="拒绝可能破坏工作的命令")
      return PermissionDecision(allow=True, updates=[PermissionUpdate(mode="allow")])


  async def main() -> None:
      options = QwenAgentOptions(
          allowed_tools=["Read", "Write"],
          permission_callback=decide_permission,
          permission_mode="ask",
      )

      async with QwenSDKClient(options=options) as client:
          try:
              await client.query("删除所有临时文件并写入新的日志")
              async for message in client.receive_response():
                  ...
          except Exception:
              await client.query("改为仅清理 ./tmp 目录")
              async for message in client.receive_response():
                  ...


  anyio.run(main)
  ```

## SDK 实现概览

| 语言 | 运行时要求 | 分发形态 | 关键依赖 | 主要能力 | 状态 |
| --- | --- | --- | --- | --- | --- |
| Python | Python 3.10+ | `pyproject + hatchling`，命名空间 `qwen_agent_sdk`，发布 `py.typed` | `anyio>=4`、`typing_extensions`、`mcp>=0.1`、`pydantic>=2` | `query()` 快速入口、`QwenSDKClient`、工具注册、权限/Hook 回调、日志与 OTel | 首发实现 |
| TypeScript | Node.js 18+ | 包 `@qwen-agent/sdk`，ESM 默认导出，`tsup` 产物 | `@qwen-code/cli`、`zx/execa`、`eventemitter3` | `createAgentManager`、流式迭代、权限回调、MCP 工具、settingSources 控制 | 首发实现 |
| Go | 待定 | 待定 | 待定 | 复用控制协议，暴露通用 API | TODO |
| Java | 待定 | 待定 | 待定 | 面向企业场景的 SDK | TODO |

### Python SDK 细节

- **运行时与分发**: 需 Python 3.10+；采用 `pyproject.toml + hatchling` 发布；提供 `qwen_agent_sdk` 命名空间与 `py.typed`。
- **环境依赖**: 需预装 Node.js 及 `qwen-code` CLI，SDK 启动前通过 `which qwen` 或 `QWEN_BIN` 环境变量定位二进制。
- **核心依赖**: `anyio>=4`、`typing_extensions`、`mcp>=0.1`、`pydantic>=2`。
- **适用场景**：第三方后端服务、希望自定义交互体验或进行服务端调用的场景。
- **API 设计**：
  - `async def query(...) -> AsyncIterator[Message]`：对齐 Anthropic `query()` 的流式接口。
  - `class QwenSDKClient`：支持 `async with`、会话续写与中断管理。
  - `QwenAgentOptions`：包含 `system_prompt`、`setting_sources`、`permission_mode`、`cwd`、`fork_session` 等参数。
  - `@tool` 装饰器 + `create_sdk_mcp_server`：将 Python 函数注册为 MCP 工具。
- **实现要点**：
  - `StdIOSubprocessTransport` 启动 `qwen` CLI，写入 JSONL，读取流式 chunk。
  - `_handle_control_request()` 对 `can_use_tool`、`hook_callback`、`mcp_message` 等 `subtype` 执行回调，并写入 `control_response`。
  - **Hook 体系**：支持 `PreToolUse`、`PostToolUse`、`UserPromptSubmit` 等事件，可返回 JSON 指令以调整会话流程，与 Anthropic Hook JSON 保持一致。
  - `Query.initialize()` 首次发送 `control_request{subtype:"initialize"}`，同步 Hook 配置与能力声明。
  - 支持 `PermissionResult`、Hook JSON 与 MCP JSON-RPC 的统一封装。
- **日志与可观测**：
  - 默认输出结构化 JSON 日志，支持 `structlog` 注入。
  - **轻量日志约定**：遵循 `logging` 风格输出结构化 JSON，可通过 `options.stderr`/`debug_stderr` 捕获 CLI 原始错误流，加速排障。
  - 规划内置 OpenTelemetry Tracer/Meter，记录会话耗时、传输错误、Worker 利用率。
- **健壮性**：
  - CLI 崩溃时自动重试与会话 fork，保存最近成功结果实现断点续传。
  - 回调异常时返回 `control_response{subtype:"error"}`，触发 CLI 安全回退。
- **测试体系**：
  - `pytest + pytest-asyncio` 覆盖核心流程。
  - `ruff + mypy` 保证代码质量。
- **示例：快速流式对话**（参考 `third-party/anthropics/claude-agent-sdk-python/examples/quick_start.py`）：
  ```python
  import anyio
  from qwen_agent_sdk import (
      AssistantMessage,
      QwenAgentOptions,
      ResultMessage,
      TextBlock,
      query,
  )


  async def main() -> None:
      options = QwenAgentOptions(
          system_prompt="你是一名示例助手，回答保持简洁。",
          allowed_tools=["Read"],
          max_turns=1,
      )

      async for message in query(prompt="2 + 2 等于多少？", options=options):
          if isinstance(message, AssistantMessage):
              for block in message.content:
                  if isinstance(block, TextBlock):
                      print(block.text)
          elif isinstance(message, ResultMessage) and message.total_cost_usd:
              print(f"本轮花费: ${message.total_cost_usd:.4f}")


  anyio.run(main)
  ```
- **示例：多 Agent 与设置源**（参考 `third-party/anthropics/claude-agent-sdk-python/examples/agents.py`、`third-party/anthropics/claude-agent-sdk-python/examples/setting_sources.py`）：
  ```python
  from qwen_agent_sdk import AgentDefinition, QwenAgentOptions, query


  options = QwenAgentOptions(
      agents={
          "doc-writer": AgentDefinition(
              description="输出结构化说明",
              prompt="你是资深文档工程师，请附带步骤解释。",
              tools=["Read", "Write"],
          ),
          "tester": AgentDefinition(
              description="生成并运行测试",
              prompt="你负责编写测试并验证结果。",
              tools=["Read", "Write", "Bash"],
          ),
      },
      setting_sources=["user", "project"],
  )


  async for message in query(
      prompt="请调用 doc-writer 说明 AgentDefinition 的用途。",
      options=options,
  ):
      ...
  ```
- **示例：内嵌 MCP 工具**（参考 `third-party/anthropics/claude-agent-sdk-python/examples/mcp_calculator.py`）：
  ```python
  from qwen_agent_sdk import (
      AssistantMessage,
      QwenAgentOptions,
      QwenSDKClient,
      TextBlock,
      create_sdk_mcp_server,
      tool,
  )


  @tool("add", "计算两个数之和", {"a": float, "b": float})
  async def add_numbers(args: dict[str, float]) -> dict[str, object]:
      total = args["a"] + args["b"]
      return {"content": [{"type": "text", "text": f"{args['a']} + {args['b']} = {total}"}]}


  calculator = create_sdk_mcp_server(
      name="calculator",
      version="1.0.0",
      tools=[add_numbers],
  )


  options = QwenAgentOptions(
      mcp_servers={"calc": calculator},
      allowed_tools=["mcp__calc__add"],
  )


  async with QwenSDKClient(options=options) as client:
      await client.query("请调用 mcp__calc__add 计算 6 + 7。")
      async for message in client.receive_response():
          if isinstance(message, AssistantMessage):
              for block in message.content:
                  if isinstance(block, TextBlock):
                      print(block.text)
          else:
              ...
  ```

### TypeScript SDK 细节

- **运行时与分发**: 需 Node.js 18+；包名 `@qwen-agent/sdk`，默认 ESM 导出并通过 `exports` 暴露 CJS；使用 `tsup` 生成 `dist/esm`、`dist/cjs`、`dist/types`。
- **核心依赖**: `@qwen-code/cli`（peerDependency）、`zx/execa`、`eventemitter3`。
- **API 能力**：
  - `createAgentManager(options)`：提供 `createSession`、`run`、`forkSession`。
  - `session.stream(task)`：返回 `AsyncIterable<AgentMessage>`，可 `for await` 消费。
  - `onPermissionRequest`：以 `allow/deny/ask` + 规则返回权限决策。
  - `settingSources`：默认关闭，需要显式声明 `["user","project","local"]` 等条目才会加载对应设置文件。
  - `defineTools`：注册 MCP 工具，与 CLI 会话共享上下文。
  - `agents` 选项：支持内联多 Agent 拓扑，结合 `forkSession` 构建子 Agent。
- **实现要点**：
  - 使用 `execa` 启动 CLI，统一解析 stdout 为 `AgentStreamChunk`。
  - `ProcessTransport` 逐行解码 stdout (`JSON.parse`)，通过 `EventEmitter` 推送 `control_request`、`result/*`、`chat.completion*` 事件，所有反向 `control_response` 共用子进程 stdin。
  - 维持 `result/heartbeat` 定时器，超时自动重启 Worker。
  - `pendingControl` 映射配合 `request_id` 路由 `control_request`。
  - 回调 Promise 生成标准化 `control_response` payload；未注册时走默认策略。
  - `onPermissionRequest`、`onHookEvent` 等回调 Promise 化处理，统一生成 `control_response`，未注册时沿用默认策略避免 CLI 阻塞。
  - `defineTools()` 将 TS 函数组装为 in-process MCP server，透传 JSON-RPC。
  - 初始化阶段等待 CLI 首条 `chat.completion` 握手信息，并通过 `control_request{subtype:"initialize"}` 发送 Hook/工具能力。
  - 异常场景记录 verbose 日志并返回 `control_response{subtype:"error"}`。
- **工程体系**：
  - `tsup` 产出 `dist/esm`、`dist/cjs` 与 `dist/types`。
  - 测试矩阵使用 `vitest` + `tsx`，结合 CLI mock 校验流式输出、权限回调。
  - 提供 `enableVerboseLogging()` 开关、`logger`/`stderr` 回调以及 OpenTelemetry Trace 规划。

### 其它语言路线（TODO）

- **Go/Java**：计划复用统一控制协议与 Worker 调度策略，面向企业场景与后端服务。
- 将在 Python/TypeScript 稳定后补充 SDK 设计与实现细节。

## 控制协议与 MCP 集成

| 通道 | 发起方 | 典型事件 | 回执要求 | 目的 |
| --- | --- | --- | --- | --- |
| `chat.completion*` | CLI → SDK | 模型回复、工具调用、收尾摘要 | 无需回执 | 承载主流程消息 |
| `result/*` | CLI → SDK | `result/command`、`result/heartbeat`、`result/cancel`、`x-qwen-session-event` | 无需回执 | 发布状态与辅助信息 |
| `*request` | SDK → CLI | `command_hint_request`、`heartbeat_request`、`control/cancel` | CLI 以 `result/*` 响应 | 触发即时操作 |
| `control_request` | CLI → SDK | `can_use_tool`、`hook_callback`、`mcp_message` | 需回写 `control_response` | 执行权限判定、Hook、MCP 调用 |

- 所有控制事件通过统一 STDIN/STDOUT 管道传输，SDK 必须确保在约定超时内响应。
- MCP 集成在 SDK 进程内创建 server，无需额外子进程或网络服务。
- 授权回调与 MCP 调用解耦：CLI 仍负责触发 `can_use_tool`，SDK 收到后执行权限逻辑，随后才能处理 `mcp_message`。

```mermaid
sequenceDiagram
    participant CLI as qwen-code CLI (stdout/stdin)
    participant Control as Agent SDK ControlPlane
    participant MCP as In-Process MCP Server
    participant Tool as 用户自定义工具

    CLI->>Control: control_request (subtype="mcp_message"，stdout)
    Control->>MCP: JSON-RPC (tools/list | tools/call)
    MCP->>Tool: 调用异步处理函数
    Tool-->>MCP: 处理结果
    MCP-->>Control: jsonrpc result (mcp_response)
    Control-->>CLI: control_response (stdin)
```

- 初始化阶段通过 `control_request{subtype:"initialize"}` 同步 Hook 配置与能力声明。
- 回调异常时，SDK 需记录日志并返回 `control_response{subtype:"error"}`，CLI 遵循安全回退策略。

| `control_request.subtype` | 输入要点 | SDK 响应约束 | 说明 |
| --- | --- | --- | --- |
| `initialize` | 携带 `hooks` 配置、可选 MCP 能力声明 | 返回 `control_response` 确认或报错；存档 `_initialization_result` | 需将 `HookMatcher` 中的回调映射为 `hookCallbackIds`，便于后续触发 |
| `can_use_tool` | 提供 `tool_name`、`input`、`permission_suggestions` | 返回 `behavior=allow/deny`，可附带 `updatedInput`、`updatedPermissions` | `updatedPermissions` 由 `PermissionUpdate` 数组组成，支持规则/目录/模式调整 |
| `hook_callback` | 提供 `callback_id`、Hook 输入上下文 | 查找对应回调并返回 JSON 结果 | 需在连接阶段缓存回调映射，未命中应返回结构化错误 |
| `mcp_message` | 提供 `server_name`、`message` JSON-RPC | 调用 SDK 内置 MCP server，封装 `mcp_response` | 支持 `initialize`、`tools/list`、`tools/call` 等标准方法，出错时返回 JSON-RPC 错误对象 |

- `PermissionUpdate` 结构支持 `addRules`、`replaceRules`、`removeRules`、`setMode`、`addDirectories`、`removeDirectories` 等类型，需精确传递规则内容与目录集合以满足企业级权限治理。
- Hook 配置允许多事件、多匹配器组合：`HookMatcher.matcher` 指定匹配条件，`hooks` 填写回调函数列表，SDK 在初始化时生成回调 ID，并在 `hook_callback` 阶段路由执行。

## 通信模式与 MCP 能力

| 模块 | 形态 | 关键说明 |
| --- | --- | --- |
| IPC 模式 | STDIN/STDOUT JSON Lines | SDK 启动本地 `qwen` 子进程，以 JSON Lines 进行通信；协议细节对齐《qwen-code-cli-output-format-stream-json-rfc_cn.md》，保持 `/`、`@`、`?` 指令的即时回执。 |
| In-Process MCP Server | SDK 内嵌 MCP Server | 依赖 `mcp>=0.1` 在宿主进程创建 MCP Server，透传 `@tool`/`defineTools` 定义的函数，无需额外子进程或网络服务。 |

- **IPC 实现要点**：
  - `SubprocessCLITransport`（或等价实现）通过同一 STDIN/STDOUT 管道处理正向/反向消息，无需额外套接字。
  - CLI 输出 `chat.completion`/`chat.completion.chunk` 时需在首条消息的 `metadata` 携带 `protocol_version`、`input_format`、`output_format`、`capabilities`。
  - 事件语义覆盖 `result/heartbeat`、`result/cancel`、`x-qwen-session-event`、`control_request/control_response`，并提供 OpenAI 风格错误对象。
- **MCP 事件链路**：
  - CLI 通过 `control_request{subtype:"mcp_message"}` 将 JSON-RPC 请求写入 stdout，SDK 转发给本地 MCP Server 执行 `tools/list`、`tools/call`。
  - 执行结果封装为 `control_response` 写回 stdin，形成闭环。
- **授权分工与优势**：
  - CLI 触发 `control_request{subtype:"can_use_tool"}` 由 SDK 决策授权，MCP 调用链路与权限判定解耦。
  - 工具执行下沉到 SDK 进程内，降低延迟；Hook 能力可沿同一通路后续接入，与 Claude Agent SDK 实践保持一致。

## Worker 池与复用

| 维度 | 设计要点 | 实施状态 |
| --- | --- | --- |
| 状态机 | 空闲 → 占用 → 空闲，单 Worker 独占会话 | 已设计 |
| 复用策略 | 会话结束不销毁进程，清理上下文后复用 | 规划落地 |
| 安全保障 | 会话隔离、资源清理、健康检查 | 随 Worker 池实现同步 |
| 配置项 | `min_workers`、`max_workers`、`idle_timeout`、`max_sessions_per_worker`、`health_check_interval` | 需在 SDK/CLI 配置中暴露 |
| 可观测 | 结构化日志、指标导出、Trace 链接 | SDK/CLI 各自接入 |

- **环境说明**: Worker 本质是 qwen-code CLI 子进程，其容器/沙箱与工具桥接由 CLI 管理，SDK 仅通过 STDIN/STDOUT 进行调度与控制。
- Worker 仅在单会话期间占用，保证隔离；会话结束后回到空闲池。
- 复用依赖清理会话变量、关闭文件句柄、重置环境变量。
- 健康检查覆盖内存泄漏、僵尸进程、卡死检测，异常时自动重启。
- 典型配置示例：

```yaml
worker_pool:
  min_workers: 5
  max_workers: 50
  idle_timeout: 1800  # 30 分钟
  max_sessions_per_worker: 100
  health_check_interval: 60
```

- 会话日志需记录 `session_id`、`prompt_id`、耗时、命令摘要，支持回传至集中式日志系统。
- 指标采集聚焦活跃/空闲数量、排队时长、重启次数、失败率等，Trace 在 SDK → CLI → 工具调用间传播。

## 配置注入与设置管理

| 项目 | 能力描述 | 说明 |
| --- | --- | --- |
| `settings_profile` | 为单个 `QwenClient` 指定独立配置 | 影响该客户端维护的 Worker 池及子进程 |
| `system/system_defaults` | 传入绝对路径或 JSON overrides | 映射到 CLI `QWEN_CODE_SYSTEM_SETTINGS_PATH` 等环境变量 |
| `user/workspace` | JSON 对象或文件/目录路径 | SDK 在临时目录生成 `settings.json` 并挂载至 CLI |
| `overrides` | 键值覆盖，如 `model.name`、`tools.allowed` | 直接写入临时配置文件 |

- **生态复用**：沿用 CLI 多层设置体系 (`SettingScope.System/SystemDefaults/User/Workspace`)，不同 `QwenClient` 相互隔离，未提供 profile 时走 CLI 默认加载顺序。
- **实现步骤**：
  1. 在 `QwenClientOptions`/`QwenAgentOptions` 新增 `settings_profile` 字段，Python/TypeScript SDK 均需支持。
  2. Worker 池启动 CLI 前，将 profile 写入隔离目录，并设置 `--setting-sources`/`--settings` 或相关参数。
  3. 写入 `QWEN_CODE_USER_SETTINGS_PATH`、`QWEN_CODE_WORKSPACE_SETTINGS_PATH` 等环境变量，以指向生成的临时配置文件。
  4. Worker 池销毁时清理临时目录，避免配置泄漏。
- **日志与排障**：日志中打印 profile 摘要（脱敏），便于排查配置错配。
- **安全考量**：配置仅由宿主应用注入，不做共享路径回退，防止跨租户污染，需提醒妥善管理敏感 Token/路径。
- **兼容性**：CLI 需补齐对新环境变量的解析，未识别的变量应回退默认行为（忽略）。
- **现状提醒**：当前 CLI 尚未支持单子进程独立配置，需要后续 RFC/PR 推进 `--settings-profile` 及相关环境变量能力。

## Agent SDK 调度层能力

| 模块 | 核心职责 | 现状 | 后续工作 |
| --- | --- | --- | --- |
| IPC 封装 | JSON Lines 解析与写入，事件路由 | CLI 仍为文本 STDIN，需扩展 | 引入 `StdinReaderService`、`StdoutWriterService`、增强 `main()` |
| 进程管理 | 启动、监控、资源限制、日志 | 初步设计 | 建立资源配额与异常重启策略 |
| 控制协议 | 权限回调、Hook 注入 | CLI 仅有 ApprovalMode | 新增权限接口、Hook 体系与插桩 |
| 输入输出格式 | `--input-format/--output-format` | 需 CLI 支持 `stream-json` | 完成参数解析与 TUI 自动禁用 |
| 事件语义 | `result/heartbeat`、`control_request` 等 | 定义中 | 与 CLI 输出格式 RFC 对齐实现 |

- `docs/ipc/qwen-chat-request-schema.json` 扩展自 OpenAI `/chat/completions`，增加 `session_id`、`prompt_id`、`origin`、`tool_call_id` 字段。
- 错误语义需要对齐 CLI 输出格式：致命错误输出 OpenAI 风格错误对象；可恢复错误通过 `chat.completion` 表示。
- 需要确保 `/`、`@`、`?` 指令请求的即时响应与事件派发。

## 可观测性与调试

| 领域 | 要点 |
| --- | --- |
| 日志 | SDK 默认结构化 JSON，CLI 可透传 stderr，支持 `logger` 注入 |
| 指标 | SDK/CLI 各自导出活跃 Worker、排队时长、错误数等，规划统一指标命名 |
| Trace | 生成会话级 Span，传播至 CLI 与工具调用链路，实现端到端排障 |
| 调试工具 | TypeScript 提供 `enableVerboseLogging()`，Python 支持捕获 `debug_stderr`，两侧均计划引入 OTel |

- 第三方服务需记录消息序列，支持审计与问题重放。
- CLI 命令示例可用于本地调试（详见输出格式 RFC）。

## 集成模式

| 模式 | 适用场景 | 关键特性 |
| --- | --- | --- |
| 宿主进程引入 SDK | IDE 插件、企业内部工具、CLI 扩展 | 直接在宿主进程启动 Worker 池，通过 IPC JSONL 与 CLI 通信，支持同步与流式输出 |

**快速上手示例**：

```python
from qwen_agent_sdk import QwenClient

with QwenClient(binary_path="qwen", model="qwen3-coder-plus") as client:
    result = client.chat(
        task="扫描并修复 main.py 中的潜在 bug",
        workspace="/repos/demo"
    )
    print(result.summary)
```

- 第三方程序可依赖 `qwen-agent-sdk` 统一管理会话、工具与权限策略。
- SDK 需支持会话重放与取消、心跳维持与超时控制。
- **示例：一体化会话脚手架**（参考 `third-party/claude-agent-sdk-python-demo/quick_start_example.py`）：
  ```python
  import anyio
  from qwen_agent_sdk import (
      AssistantMessage,
      QwenAgentOptions,
      QwenSDKClient,
      TextBlock,
      create_sdk_mcp_server,
      query,
      tool,
  )


  @tool("get_system_info", "获取系统信息", {})
  async def get_system_info(_: dict[str, object]) -> dict[str, object]:
      import os
      import platform

      summary = "\n".join(
          [
              f"- 操作系统: {platform.system()} {platform.release()}",
              f"- Python 版本: {platform.python_version()}",
              f"- 当前目录: {os.getcwd()}",
          ]
      )
      return {"content": [{"type": "text", "text": summary}]}


  async def run_all_examples() -> None:
      # 1) 基础问答
      async for msg in query(prompt="你好，做个自我介绍。"):
          if isinstance(msg, AssistantMessage):
              for block in msg.content:
                  if isinstance(block, TextBlock):
                      print(block.text)

      # 2) 定制参数 + 流式消费
      options = QwenAgentOptions(system_prompt="你是一名资深助手，善于步骤化回答。")
      async for msg in query("解释一下多进程和多线程的差异", options=options):
          ...

      # 3) 注册自定义工具
      server = create_sdk_mcp_server(name="my-tools", version="1.0.0", tools=[get_system_info])
      async with QwenSDKClient(
          options=QwenAgentOptions(
              mcp_servers={"tools": server},
              allowed_tools=["mcp__tools__get_system_info"],
          )
      ) as client:
          await client.query("请获取当前运行环境")
          async for msg in client.receive_response():
              ...


  anyio.run(run_all_examples)
  ```

## 开放事项与后续计划

| 方向 | 待完成事项 |
| --- | --- |
| CLI 协议支持 | 补齐 `stream-json` 输入输出、事件语义与握手元数据 |
| 控制协议 | 实现权限回调 API、Hook 插桩、MCP `mcp_message` 通路 |
| Worker 池 | 完善健康检查、资源配额、异常自动隔离策略 |
| 配置体系 | CLI 合入 `--settings-profile` 与相关环境变量支持 |
| 多语言 SDK | 丰富 Go/Java 版本，实现统一测试矩阵与文档 |
| 可观测 | 联合定义指标命名 & Trace 采样策略，完善日志规范 |
