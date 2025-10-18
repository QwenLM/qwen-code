# Qwen-Code Agent Framework Architecture Design (Clean Version)

## Overview

| Field | Details |
| --- | --- |
| Design Version | v1.1 |
| Last Updated | 2025-10-10 |
| Architecture Scope | Qwen-Code Agent SDK and qwen-code CLI subprocess orchestration, control protocol, observability, and configuration system |
| Key Objectives | Provide third-party applications with unified IPC communication, worker pool governance, permission control, and tool bridging capabilities |

- **Core Component**: This document focuses on the Qwen-Code Agent SDK, which encapsulates session routing, control protocol handling, and worker pool governance inside the host process to deliver unified access for multi-language scenarios.
- **Core Responsibilities**: Session scheduling and routing; CLI subprocess lifecycle and resource governance; control protocol hooks and permission adjudication; lightweight logging and observability integration; telemetry collection (logs, metrics, traces).
- **Core Functions**: Supports synchronous/asynchronous task execution, streaming output, session management, error handling and retries, in-process MCP tool bridging, and isolated configuration injection.
- Wraps the CLI subprocess lifecycle and JSONL protocol for multi-language SDKs through a unified abstraction.
- Provides consistent interfaces for session scheduling, permission governance, Hook/MCP callbacks, logging, and metrics collection.
- Aligns protocol specifications with the Claude Agent SDK to reduce collaboration costs and ecosystem integration friction across platforms.

## Architecture Overview

| Layer | Key Components | Responsibility Highlights |
| --- | --- | --- |
| Upstream Clients | TypeScript / Python / Go / Java SDK | Expose standard APIs, adapt to each language ecosystem, handle session onboarding, and register custom tools |
| Agent SDK Core | Router, ControlPlane, WorkerPool, ProcessMgr, IPC | Manage session routing, permission callbacks, worker pool lifecycle, and STDIO JSONL transport |
| CLI Worker | qwen-code CLI subprocess | Execute model inference and tool invocations, emit `chat.completion*` / `result/*` / `control_request` according to the protocol |
| Peripheral Services | LLM/MCP, monitoring, logging, tracing | Provide model services, observability data, and integration with external systems |

```mermaid
flowchart LR
    subgraph Clients["Third-Party Applications / Services"]
        direction LR
        TypeScriptSDK["qwen-agent-sdk<br/>TypeScript"]
        PythonSDK["qwen-agent-sdk<br/>Python"]
        GoSDK["qwen-agent-sdk<br/>Go (TODO)"]
        JavaSDK["qwen-agent-sdk<br/>Java (TODO)"]
    end

    subgraph AgentSDK["Qwen-Code Agent SDK"]
        direction TB
        Router["Session Scheduling<br/>Routing / Load Balancing"]
        ControlPlane["Control Protocol<br/>Hook / Permission Decisions"]
        WorkerPool["Worker Pool Management<br/>Allocation / Reclamation / Health Checks"]
        ProcessMgr["Subprocess Management<br/>Launch / Monitor / Restart"]
        IPC["IPC Adaptation Layer<br/>STDIN/STDOUT JSONL"]
    end

    subgraph Workers["qwen-code CLI Workers"]
        direction LR
        Worker1["Worker #1<br/>qwen-code CLI"]
        Worker2["Worker #2<br/>qwen-code CLI"]
        WorkerN["Worker #N"]
    end

    subgraph Services["Peripheral Services"]
        LLM_MCP["LLM Services / MCP Services"]
        Monitor["Monitoring & Alerts"]
        Logger["Logging Center"]
        Trace["Tracing"]
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
    class Services,LLM_MCP,Monitor,Logger,Trace serviceStyle
```

- The Agent SDK and CLI share a bidirectional STDIN/STDOUT JSONL channel that transports events such as `chat.completion*`, `result/*`, and `control_request`.
- Event flow: the CLI writes `chat.completion`/`result/*`/`control_request` line-by-line to stdout; the SDK parses them and, when needed, writes `request`/`control_response` back to stdin. When a `control_request{subtype:"mcp_message"}` appears, the ControlPlane forwards the JSON-RPC payload to the local MCP server and relays the resulting `mcp_response`.
- The qwen-code CLI already integrates with OpenTelemetry to report model calls, tool executions, and internal events; the Agent SDK must instrument independently and propagate trace/span IDs across the entire path to build a unified troubleshooting view.
- Control protocol semantics align with the CLI output format specification, as documented in the accompanying `stream-json` RFC.
- For details on event categories such as `result/*`, `request`, and `control_request`, refer to the “Event Classification” section of `qwen-code-cli-output-format-stream-json-rfc_cn.md`.

## Core Capability Mapping

| Capability Domain | Key Focus | Current Capability | Future Evolution |
| --- | --- | --- | --- |
| Session Scheduling | Session routing, worker binding, reuse strategies | Router and worker pool scheduling provided by the SDK | Enhance session branching and sub-agent scheduling |
| Process Governance | Subprocess launch, monitoring, restart | ProcessMgr oversees lifecycle and resource limits | Introduce resource quotas and automatic fault isolation |
| Control Protocol | Permission callbacks, hooks, MCP | ControlPlane handles `control_request` uniformly | Expand hook points and approval strategies |
| IPC Protocol | JSON Lines, input/output formats | IPC layer implements `stream-json` / `stream-chunk-json` | Enrich event types and support protocol negotiation |
| Observability | Logging, metrics, tracing | SDK and CLI both integrate OTel and emit structured logs | Standardize metric names and cross-component trace analysis |

- The scheduling and control layers must enforce worker exclusivity, session isolation, and resource reclamation.
- The control protocol follows a request/response model; the SDK must return a `control_response` before timeout to prevent the CLI from blocking.

## Agentic Session Capabilities

| Capability Block | Design Focus | Interface / Structure |
| --- | --- | --- |
| Session Loop | Stateful `QwenAgentClient`, separating connection and message flow phases | `connect()`, `disconnect()`, `Query.initialize()` |
| Session Context | Support async context management and resource teardown | `__aenter__` / `__aexit__`, `async with QwenAgentClient` |
| Message Flow Handling | Append inputs and consume streaming outputs within the same session | `query()`, `stream_input()`, `receive_messages()`, `receive_response()` |
| Dynamic Control | Switch models/permissions at runtime, trigger interrupts, retrieve initialization data | `interrupt()`, `set_permission_mode()`, `set_model()`, `get_server_info()` |
| Transport Abstraction | Pluggable transports for local/remote CLI and buffered daemons | `Transport`, `SubprocessCLITransport`, `max_buffer_size` validation |

### Session Loop and Context

- `QwenAgentClient.connect()` supports both string and async stream modes. Hooks and the SDK MCP server can be injected during the first `initialize` call to ensure multi-turn sessions across IDEs and services.
- `disconnect()` clears `_query` and the transport. Combined with `async with`, it automates connection/disposal to avoid orphaned subprocesses.
- Parameter validation should proactively reject mutually exclusive options (for example, enabling both `can_use_tool` and `permission_prompt_tool_name`) to improve configuration ergonomics.

### Message Flow Handling

- `query()` automatically fills `session_id` and writes JSONL records, allowing scripts and UIs to append messages as needed.
- `stream_input()` handles incremental writes, clears buffers on exceptions, and records debug logs to stabilize long-running flows.
- `receive_messages()` iterates over every event, while `receive_response()` stops as soon as it encounters a `ResultMessage`, helping UIs detect when a single response completes.
- The `include_partial_messages` option forwards incremental chunks. Combined with `stderr`/`debug_stderr`, it captures low-level diagnostics for real-time rendering in complex interfaces.

### Dynamic Control Interfaces

- `_send_control_request` supports subtypes such as `interrupt`, `set_permission_mode`, and `set_model`, enabling manual interruption, permission mode switching, and hot model changes.
- `get_server_info()` fetches CLI initialization capabilities (protocol versions, command set, etc.) for dynamic front-end or policy configuration.
- `async query(...)->AsyncIterator` exposes a script-friendly interface that consumes the entire response in one go while preserving the ability to swap in custom transports.

### Single-Query and Multi-Agent Orchestration

- `query()` wraps the session lifecycle for rapid integrations such as scripts or batch tasks. When a custom `Transport` is provided, remote CLIs or agent services can be reused.
- The `agents` configuration maps multi-agent topologies onto the CLI `--agents` flag. In conjunction with `fork_session`, it supports session branching and sub-agent routing.
- When generating CLI commands, the SDK must compose JSON payloads for options such as `setting_sources`, `allowed_tools`, and `mcp_servers` to ensure feature parity with the CLI.

### Hooks and MCP Bridging

- During initialization, hook definitions convert the `HookMatcher` list into `hookCallbackIds`. Subsequent `hook_callback` events use those IDs to invoke host logic at critical stages such as `PreToolUse`, `PostToolUse`, and `UserPromptSubmit`.
- On the SDK side, `create_sdk_mcp_server` / `defineTools` build an MCP server inside the host process. `mcp_message` requests trigger JSON-RPC procedures (`tools/list`, `tools/call`, `initialize`, etc.) without spawning extra subprocesses.
- Permission approvals are returned via `PermissionResultAllow` / `PermissionResultDeny` and `PermissionUpdate`, enabling fine-grained policies that can be adjusted in hooks or tool callbacks.
- **Example: Combining PreToolUse and UserPromptSubmit** (based on `third-party/anthropics/claude-agent-sdk-python/examples/hooks.py`):
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
                  "permissionDecisionReason": "Block dangerous delete command.",
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
              "additionalContext": "Remember that the user's favorite color is blue.",
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
          await client.query("Try to run: rm -rf /tmp")
          async for message in client.receive_response():
              ...


  asyncio.run(main())
  ```

### Transport Layer Extensions

- The `Transport` abstraction makes it possible to replace the default `SubprocessCLITransport` for remote CLI, agent service, or container-hosted scenarios.
- Before the handshake, the transport performs version checks and enforces `max_buffer_size`; when output exceeds the limit it raises a structured error and cleans buffers to prevent memory bloat.
- Options can specify working directory, environment variables, and stderr capture to support IDE integration and server deployments flexibly.
- `SubprocessCLITransport` must inject CLI arguments such as `--mcp-config`, `--agents`, and `--setting-sources`, and set environment variables like `CLAUDE_CODE_ENTRYPOINT` plus custom `env` and `user` values to keep subprocess capabilities aligned.
- **Example: Custom Remote Transport** (see `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/__init__.py`):
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
  options = QwenAgentOptions(system_prompt="Execute every command through the remote CLI gateway.")


  async with QwenSDKClient(options=options, transport=transport) as client:
      await client.query("Read README.md and summarize three highlights.")
      async for message in client.receive_response():
          ...
  ```

### Debugging and Environment Injection

- CLI orchestration must derive the full command list from `QwenAgentOptions`, distinguishing between streaming (`--input-format stream-json`) and single-shot (`--print`) execution.
- `options.stderr` and `debug_stderr` let the SDK capture CLI diagnostic output, while anyio `TaskGroup` consumes stderr streams in real time.
- Parameters such as `cwd`, `env`, and `user` determine the subprocess working directory and permission boundaries; the SDK should pass them explicitly at startup and reclaim resources on disconnect.
- **Example: Error Callback and Retry** (see `third-party/claude-agent-sdk-python-demo/add_my_permission.py`):
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
          return PermissionDecision(allow=False, reason="Reject commands that may break work.")
      return PermissionDecision(allow=True, updates=[PermissionUpdate(mode="allow")])


  async def main() -> None:
      options = QwenAgentOptions(
          allowed_tools=["Read", "Write"],
          permission_callback=decide_permission,
          permission_mode="ask",
      )

      async with QwenSDKClient(options=options) as client:
          try:
              await client.query("Delete all temporary files and write a new log.")
              async for message in client.receive_response():
                  ...
          except Exception:
              await client.query("Instead, only clean the ./tmp directory.")
              async for message in client.receive_response():
                  ...


  anyio.run(main)
  ```

## SDK Implementation Overview

| Language | Runtime Requirements | Distribution Form | Key Dependencies | Main Capabilities | Status |
| --- | --- | --- | --- | --- | --- |
| Python | Python 3.10+ | `pyproject + hatchling`, namespace `qwen_agent_sdk`, ships `py.typed` | `anyio>=4`, `typing_extensions`, `mcp>=0.1`, `pydantic>=2` | `query()` fast path, `QwenSDKClient`, tool registration, permission/hook callbacks, logging and OTel | Initial release |
| TypeScript | Node.js 18+ | Package `@qwen-agent/sdk`, default ESM exports, `tsup` build outputs | `@qwen-code/cli`, `zx/execa`, `eventemitter3` | `createAgentManager`, streaming iteration, permission callbacks, MCP tools, `settingSources` control | Initial release |
| Go | TBA | TBA | TBA | Reuse control protocol, expose common APIs | TODO |
| Java | TBA | TBA | TBA | SDK for enterprise scenarios | TODO |

### Python SDK Details

- **Runtime and Distribution**: Requires Python 3.10+; distributed via `pyproject.toml + hatchling`; provides the `qwen_agent_sdk` namespace plus `py.typed`.
- **Environment Dependencies**: Node.js and the `qwen-code` CLI must be installed. Before startup the SDK locates the binary via `which qwen` or the `QWEN_BIN` environment variable.
- **Core Dependencies**: `anyio>=4`, `typing_extensions`, `mcp>=0.1`, `pydantic>=2`.
- **Typical Scenarios**: Third-party backend services that need customized experiences or server-side execution.
- **API Design**:
  - `async def query(...) -> AsyncIterator[Message]`: Aligns with Anthropic’s streaming `query()` interface.
  - `class QwenSDKClient`: Supports `async with`, session continuation, and interruption management.
  - `QwenAgentOptions`: Includes parameters such as `system_prompt`, `setting_sources`, `permission_mode`, `cwd`, and `fork_session`.
  - `@tool` decorator + `create_sdk_mcp_server`: Register Python functions as MCP tools.
- **Implementation Highlights**:
  - `StdIOSubprocessTransport` launches the `qwen` CLI, writes JSONL, and reads streaming chunks.
  - `_handle_control_request()` processes subtypes such as `can_use_tool`, `hook_callback`, and `mcp_message`, writing back corresponding `control_response`.
  - **Hook System**: Supports events such as `PreToolUse`, `PostToolUse`, and `UserPromptSubmit`. Returns JSON instructions to adjust the session flow, mirroring Anthropic’s hook JSON structure.
  - `Query.initialize()` sends an initial `control_request{subtype:"initialize"}` to synchronize hook configuration and capability declarations.
  - Unifies `PermissionResult`, hook JSON, and MCP JSON-RPC payloads under a consistent abstraction.
- **Logging and Observability**:
  - Emits structured JSON logs by default and supports injecting a `structlog` logger.
  - **Lightweight Logging Convention**: Follow standard `logging`-style structured JSON output. `options.stderr`/`debug_stderr` can capture raw CLI error streams for faster troubleshooting.
  - Plans to bundle OpenTelemetry tracer/meter instrumentation for session latency, transport errors, and worker utilization.
- **Resilience**:
  - Implements retries and backoff for transient transport failures.
  - Guards against buffer overflows by leveraging `max_buffer_size`.
  - Gracefully degrades when CLI capabilities are missing, surfacing actionable errors.
- **Examples**:
  - **Streaming Query with Cost Tracking** (adapted from `third-party/anthropics/claude-agent-sdk-python/examples/basic_stream.py`):
    ```python
    import anyio
    from qwen_agent_sdk import (
        AssistantMessage,
        QwenAgentOptions,
        QwenSDKClient,
        ResultMessage,
        query,
    )


    async def main() -> None:
        options = QwenAgentOptions(model="qwen3-coder-plus")
        async for message in query(prompt="What is 2 + 2?", options=options):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if hasattr(block, "text"):
                        print(block.text)
            elif isinstance(message, ResultMessage) and message.total_cost_usd:
                print(f"Spent this round: ${message.total_cost_usd:.4f}")


    anyio.run(main)
    ```
  - **Multi-Agent and Setting Sources** (see `third-party/anthropics/claude-agent-sdk-python/examples/agents.py` and `.../setting_sources.py`):
    ```python
    from qwen_agent_sdk import AgentDefinition, QwenAgentOptions, query


    options = QwenAgentOptions(
        agents={
            "doc-writer": AgentDefinition(
                description="Produce structured documentation.",
                prompt="You are a senior documentation engineer. Explain with clear steps.",
                tools=["Read", "Write"],
            ),
            "tester": AgentDefinition(
                description="Generate and run tests.",
                prompt="You are responsible for authoring tests and verifying outcomes.",
                tools=["Read", "Write", "Bash"],
            ),
        },
        setting_sources=["user", "project"],
    )


    async for message in query(
        prompt="Invoke doc-writer to explain what AgentDefinition is for.",
        options=options,
    ):
        ...
    ```
  - **Embedded MCP Tool** (see `third-party/anthropics/claude-agent-sdk-python/examples/mcp_calculator.py`):
    ```python
    from qwen_agent_sdk import (
        AssistantMessage,
        QwenAgentOptions,
        QwenSDKClient,
        TextBlock,
        create_sdk_mcp_server,
        tool,
    )


    @tool("add", "Calculate the sum of two numbers.", {"a": float, "b": float})
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
        await client.query("Call mcp__calc__add to compute 6 + 7.")
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        print(block.text)
            else:
                ...
    ```

### TypeScript SDK Details

- **Runtime and Distribution**: Requires Node.js 18+. Package name `@qwen-agent/sdk` exports ESM by default and exposes CJS via `exports`. Uses `tsup` to generate `dist/esm`, `dist/cjs`, and `dist/types`.
- **Core Dependencies**: `@qwen-code/cli` (peer dependency), `zx/execa`, `eventemitter3`.
- **API Capabilities**:
  - `createAgentManager(options)`: Provides `createSession`, `run`, and `forkSession`.
  - `session.stream(task)`: Returns `AsyncIterable<AgentMessage>` for consumption with `for await`.
  - `onPermissionRequest`: Returns permission decisions using `allow` / `deny` / `ask` plus associated rules.
  - `settingSources`: Disabled by default; explicitly declare entries like `["user", "project", "local"]` to load corresponding settings files.
  - `defineTools`: Registers MCP tools that share context with CLI sessions.
  - `agents` option: Supports inline multi-agent topologies; combine with `forkSession` to orchestrate sub-agents.
- **Implementation Notes**:
  - Launches the CLI via `execa` and parses stdout uniformly as `AgentStreamChunk`.
  - `ProcessTransport` decodes stdout line by line (`JSON.parse`) and relays `control_request`, `result/*`, and `chat.completion*` events through `EventEmitter`, while sending all `control_response` payloads through stdin.
  - Maintains a `result/heartbeat` timer that automatically restarts workers on timeout.
  - The `pendingControl` map uses `request_id` to route `control_request` callbacks.
  - Callback promises create normalized `control_response` payloads; unregistered callbacks fall back to defaults.
  - `onPermissionRequest` and `onHookEvent` resolve to promises that generate `control_response`. If no callback is registered, the system keeps using default policies to avoid blocking the CLI.
  - `defineTools()` packages TypeScript functions into an in-process MCP server and forwards JSON-RPC calls.
  - During initialization, the SDK waits for the CLI’s first `chat.completion` handshake, then sends hook/tool capabilities via `control_request{subtype:"initialize"}`.
  - Exceptional cases log verbose diagnostics and return `control_response{subtype:"error"}`.
- **Engineering System**:
  - `tsup` produces `dist/esm`, `dist/cjs`, and `dist/types`.
  - Test matrix uses `vitest` + `tsx` combined with CLI mocks to verify streaming output and permission callbacks.
  - Exposes `enableVerboseLogging()`, `logger` / `stderr` callbacks, and plans to integrate OpenTelemetry tracing.

### Other Language Plans (TODO)

- **Go / Java**: Intend to reuse the unified control protocol and worker scheduling strategy, targeting enterprise and backend scenarios.
- Detailed SDK designs and implementations will follow once the Python/TypeScript versions stabilize.

## Control Protocol and MCP Integration

| Channel | Initiator | Typical Events | Response Requirement | Purpose |
| --- | --- | --- | --- | --- |
| `chat.completion*` | CLI → SDK | Model replies, tool invocations, closing summaries | No response required | Carries the primary conversation |
| `result/*` | CLI → SDK | `result/command`, `result/heartbeat`, `result/cancel`, `x-qwen-session-event` | No response required | Publishes status and auxiliary info |
| `*request` | SDK → CLI | `command_hint_request`, `heartbeat_request`, `control/cancel` | CLI responds with `result/*` | Triggers immediate operations |
| `control_request` | CLI → SDK | `can_use_tool`, `hook_callback`, `mcp_message` | Must return `control_response` | Executes permission checks, hooks, MCP calls |

- All control events travel through the shared STDIN/STDOUT pipes, and the SDK must respond within the agreed timeout.
- MCP integration builds the server inside the SDK process, eliminating extra subprocesses or network services.
- Authorization callbacks and MCP calls remain decoupled: the CLI still emits `can_use_tool`, the SDK handles permission logic, and only then processes `mcp_message`.

```mermaid
sequenceDiagram
    participant CLI as qwen-code CLI (stdout/stdin)
    participant Control as Agent SDK ControlPlane
    participant MCP as In-Process MCP Server
    participant Tool as User-Defined Tool

    CLI->>Control: control_request (subtype="mcp_message", stdout)
    Control->>MCP: JSON-RPC (tools/list | tools/call)
    MCP->>Tool: Invoke async handler
    Tool-->>MCP: Return result
    MCP-->>Control: jsonrpc result (mcp_response)
    Control-->>CLI: control_response (stdin)
```

- During initialization, `control_request{subtype:"initialize"}` synchronizes hook configuration and capability declarations.
- When callbacks throw, the SDK must log the failure and return `control_response{subtype:"error"}` so the CLI can safely fall back.

| `control_request.subtype` | Key Input | SDK Response Constraints | Notes |
| --- | --- | --- | --- |
| `initialize` | Includes `hooks` config and optional MCP capability declarations | Return `control_response` confirming success or failure; persist `_initialization_result` | Map `HookMatcher` callbacks to `hookCallbackIds` for later invocation |
| `can_use_tool` | Provides `tool_name`, `input`, `permission_suggestions` | Return `behavior=allow/deny`, optionally `updatedInput`, `updatedPermissions` | `updatedPermissions` is an array of `PermissionUpdate`, supporting rule, directory, and mode adjustments |
| `hook_callback` | Supplies `callback_id` and hook context | Look up and execute the matching callback, then return JSON | Cache callback mappings during connection; missing entries must yield structured errors |
| `mcp_message` | Provides `server_name` and JSON-RPC `message` | Call the SDK’s MCP server and wrap the `mcp_response` | Supports standard methods (`initialize`, `tools/list`, `tools/call`); failures must return JSON-RPC error objects |

- `PermissionUpdate` supports `addRules`, `replaceRules`, `removeRules`, `setMode`, `addDirectories`, `removeDirectories`, etc. The SDK must forward rule content and directory sets precisely to satisfy enterprise-grade governance.
- Hook configuration allows multiple events and matchers. `HookMatcher.matcher` specifies matching conditions, `hooks` lists callbacks, and the SDK generates callback IDs during initialization to route later `hook_callback` executions.

## Communication Model and MCP Capabilities

| Module | Form | Key Notes |
| --- | --- | --- |
| IPC Mode | STDIN/STDOUT JSON Lines | The SDK launches a local `qwen` subprocess and exchanges JSON Lines. Protocol details follow `qwen-code-cli-output-format-stream-json-rfc_cn.md`, preserving instant replies for `/`, `@`, and `?` commands. |
| In-Process MCP Server | SDK-embedded MCP server | Relies on `mcp>=0.1` to create an MCP server inside the host process, forwarding functions defined via `@tool` / `defineTools` without additional subprocesses or network hops. |

- **IPC Implementation Highlights**:
  - `SubprocessCLITransport` (or equivalent) handles both directions over the same STDIN/STDOUT pipes—no extra sockets required.
  - When the CLI emits `chat.completion` / `chat.completion.chunk`, the first message’s `metadata` must carry `protocol_version`, `input_format`, `output_format`, and `capabilities`.
  - Event semantics cover `result/heartbeat`, `result/cancel`, `x-qwen-session-event`, and `control_request/control_response`, and expose OpenAI-style error objects.
- **MCP Event Flow**:
  - The CLI writes JSON-RPC payloads via `control_request{subtype:"mcp_message"}`. The SDK forwards them to the local MCP server, which handles `tools/list` / `tools/call`.
  - Results are wrapped in `control_response` and written back to stdin to complete the loop.
- **Authorization Responsibilities**:
  - The CLI emits `control_request{subtype:"can_use_tool"}` while the SDK decides authorization, keeping MCP invocation separate from permission checks.
  - Executing tools inside the SDK process reduces latency. Hook capabilities can share the same channel, consistent with Claude Agent SDK practices.

## Worker Pool and Reuse

| Dimension | Design Highlights | Implementation Status |
| --- | --- | --- |
| State Machine | Idle → Busy → Idle, each worker exclusively serves a session | Designed |
| Reuse Strategy | Retain processes after sessions, clean context, and reuse | Planned rollout |
| Safety | Session isolation, resource cleanup, health checks | Delivered alongside the worker pool |
| Configuration | `min_workers`, `max_workers`, `idle_timeout`, `max_sessions_per_worker`, `health_check_interval` | Must be exposed in SDK/CLI configs |
| Observability | Structured logs, metric export, trace linkage | SDK and CLI instrument independently |

- **Environment**: Workers are qwen-code CLI subprocesses. Containers/sandboxes and tool bridging are handled by the CLI, while the SDK only schedules via STDIN/STDOUT.
- Each worker is exclusive to a session. When the session ends, the worker returns to the idle pool.
- Reuse depends on clearing session variables, closing file handles, and resetting environment variables.
- Health checks watch for memory leaks, zombie processes, and deadlocks. Failures trigger automatic restarts.
- Example configuration:

```yaml
worker_pool:
  min_workers: 5
  max_workers: 50
  idle_timeout: 1800  # 30 minutes
  max_sessions_per_worker: 100
  health_check_interval: 60
```

- Session logs should record `session_id`, `prompt_id`, elapsed time, and command summaries, then feed centralized logging.
- Metrics focus on active/idle counts, queue latency, restart counts, and failure rates. Traces must propagate across SDK → CLI → tool calls.

## Configuration Injection and Settings Management

| Item | Capability | Notes |
| --- | --- | --- |
| `settings_profile` | Assign an isolated configuration per `QwenClient` | Affects the worker pool and subprocesses owned by that client |
| `system/system_defaults` | Provide an absolute path or JSON overrides | Mapped to CLI environment variables such as `QWEN_CODE_SYSTEM_SETTINGS_PATH` |
| `user/workspace` | JSON objects or file/directory paths | SDK generates `settings.json` in a temporary directory and mounts it for the CLI |
| `overrides` | Key-value overrides such as `model.name`, `tools.allowed` | Written directly into the temporary config file |

- **Ecosystem Reuse**: Inherits the CLI’s multi-layer settings hierarchy (`SettingScope.System/SystemDefaults/User/Workspace`). Each `QwenClient` is isolated, and when no profile is provided the CLI follows its default loading order.
- **Implementation Steps**:
  1. Add a `settings_profile` field to `QwenClientOptions` / `QwenAgentOptions` across Python and TypeScript SDKs.
  2. Before launching CLI workers, write the profile into an isolated directory and configure `--setting-sources` / `--settings` (or equivalent flags).
  3. Set environment variables such as `QWEN_CODE_USER_SETTINGS_PATH` and `QWEN_CODE_WORKSPACE_SETTINGS_PATH` to point at the generated temporary files.
  4. Remove the temporary directory when the worker pool shuts down to prevent configuration leakage.
- **Logging and Troubleshooting**: Emit redacted profile summaries in logs to diagnose configuration mismatches.
- **Security Considerations**: Only the host application injects configuration—no fallback to shared paths—to prevent cross-tenant contamination. Sensitive tokens and paths must be safeguarded.
- **Compatibility**: The CLI must parse the new environment variables and safely ignore unrecognized keys.
- **Current Status Reminder**: The CLI has not yet implemented per-subprocess configuration. Future RFCs/PRs must deliver `--settings-profile` and related environment variable support.

## Agent SDK Orchestration Capabilities

| Module | Core Responsibility | Current Status | Next Steps |
| --- | --- | --- | --- |
| IPC Wrapper | Parse/write JSON Lines, route events | CLI still uses plain-text STDIN and needs enhancement | Introduce `StdinReaderService`, `StdoutWriterService`, and strengthen `main()` |
| Process Management | Launch, monitor, enforce resource limits, log | Initial design | Establish resource quotas and automatic restart policies |
| Control Protocol | Permission callbacks, hook injection | CLI only exposes ApprovalMode | Add permission APIs, hook system, and instrumentation |
| Input/Output Formats | `--input-format` / `--output-format` | CLI must support `stream-json` | Complete argument parsing and auto-disable TUI |
| Event Semantics | `result/heartbeat`, `control_request`, etc. | Under definition | Implement aligned with the CLI output format RFC |

- `docs/ipc/qwen-chat-request-schema.json` extends OpenAI `/chat/completions` by adding `session_id`, `prompt_id`, `origin`, and `tool_call_id`.
- Error semantics must match the CLI output format: fatal errors emit OpenAI-style error objects, while recoverable errors use `chat.completion`.
- Immediate responses and event dispatch are required for `/`, `@`, and `?` command requests.

## Observability and Debugging

| Area | Highlights |
| --- | --- |
| Logging | SDK writes structured JSON by default; the CLI can forward stderr and supports injecting a `logger` |
| Metrics | SDK/CLI expose active workers, queue latency, error counts, etc., with a plan to standardize metric names |
| Trace | Create session-level spans, propagate through CLI and tool invocation chains, and enable end-to-end troubleshooting |
| Debugging Tools | TypeScript offers `enableVerboseLogging()`, Python captures `debug_stderr`, and both plan to integrate OTel |

- Third-party services should record message sequences to support auditing and replay.
- CLI command samples can be reused for local debugging (see the output format RFC).

## Integration Model

| Pattern | Applicable Scenarios | Key Traits |
| --- | --- | --- |
| Host Process Integrates SDK | IDE plugins, enterprise tools, CLI extensions | Launch worker pools inside the host process, communicate with the CLI via IPC JSONL, support synchronous and streaming output |

**Quick Start Example**:

```python
from qwen_agent_sdk import QwenClient

with QwenClient(binary_path="qwen", model="qwen3-coder-plus") as client:
    result = client.chat(
        task="Scan main.py for potential bugs and fix them.",
        workspace="/repos/demo"
    )
    print(result.summary)
```

- Third-party applications can rely on `qwen-agent-sdk` to manage sessions, tools, and permission policies uniformly.
- The SDK must support session replay and cancellation, heartbeat maintenance, and timeout control.
- **Example: All-in-One Session Scaffold** (see `third-party/claude-agent-sdk-python-demo/quick_start_example.py`):
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


  @tool("get_system_info", "Retrieve system information.", {})
  async def get_system_info(_: dict[str, object]) -> dict[str, object]:
      import os
      import platform

      summary = "\n".join(
          [
              f"- OS: {platform.system()} {platform.release()}",
              f"- Python version: {platform.python_version()}",
              f"- Current directory: {os.getcwd()}",
          ]
      )
      return {"content": [{"type": "text", "text": summary}]}


  async def run_all_examples() -> None:
      # 1) Basic Q&A
      async for msg in query(prompt="Hello, introduce yourself."):
          if isinstance(msg, AssistantMessage):
              for block in msg.content:
                  if isinstance(block, TextBlock):
                      print(block.text)

      # 2) Custom parameters + streaming
      options = QwenAgentOptions(system_prompt="You are an experienced assistant. Respond step by step.")
      async for msg in query("Explain the difference between multiprocessing and multithreading.", options=options):
          ...

      # 3) Register custom tools
      server = create_sdk_mcp_server(name="my-tools", version="1.0.0", tools=[get_system_info])
      async with QwenSDKClient(
          options=QwenAgentOptions(
              mcp_servers={"tools": server},
              allowed_tools=["mcp__tools__get_system_info"],
          )
      ) as client:
          await client.query("Fetch the current runtime environment.")
          async for msg in client.receive_response():
              ...


  anyio.run(run_all_examples)
  ```

## Open Items and Future Work

| Direction | Pending Tasks |
| --- | --- |
| CLI Protocol Support | Complete `stream-json` input/output, event semantics, and handshake metadata |
| Control Protocol | Implement permission callback APIs, hook instrumentation, MCP `mcp_message` pathway |
| Worker Pool | Improve health checks, resource quotas, and automatic fault isolation |
| Configuration System | Add CLI support for `--settings-profile` and related environment variables |
| Multi-Language SDKs | Expand Go/Java versions, build a unified test matrix and documentation |
| Observability | Jointly define metric names and trace sampling strategies, refine logging guidelines |
