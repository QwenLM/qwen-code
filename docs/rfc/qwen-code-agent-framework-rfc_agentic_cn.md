# Qwen-Code Agent 框架补充清单（Agentic 加强版）

本文聚焦对现有《Qwen-Code Agent 框架架构设计（整理版）》的补充点，目标是在 SDK 侧补齐 agentic 能力，而非简单的 CLI 包装。所有建议均对齐 `@third-party/anthropics/claude-agent-sdk-python/` 已有实现。

## Agent 会话循环能力

- **结论**：需补充状态化的 `QwenAgentClient` 设计，支持流式连接、Hook 注入与 SDK MCP 注册，让 IDE / 应用能够在同一会话内执行多轮对话、动态插入消息并与控制协议交互。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py`
```python
    async def connect(
        self, prompt: str | AsyncIterable[dict[str, Any]] | None = None
    ) -> None:
        """Connect to Claude with a prompt or message stream."""

        from ._internal.query import Query
        from ._internal.transport.subprocess_cli import SubprocessCLITransport

        async def _empty_stream() -> AsyncIterator[dict[str, Any]]:
            return
            yield {}  # type: ignore[unreachable]

        actual_prompt = _empty_stream() if prompt is None else prompt

        if self.options.can_use_tool:
            if isinstance(prompt, str):
                raise ValueError(
                    "can_use_tool callback requires streaming mode. "
                    "Please provide prompt as an AsyncIterable instead of a string."
                )

            if self.options.permission_prompt_tool_name:
                raise ValueError(
                    "can_use_tool callback cannot be used with permission_prompt_tool_name. "
                    "Please use one or the other."
                )

            options = replace(self.options, permission_prompt_tool_name="stdio")
        else:
            options = self.options

        if self._custom_transport:
            self._transport = self._custom_transport
        else:
            self._transport = SubprocessCLITransport(
                prompt=actual_prompt,
                options=options,
            )
        await self._transport.connect()

        sdk_mcp_servers = {}
        if self.options.mcp_servers and isinstance(self.options.mcp_servers, dict):
            for name, config in self.options.mcp_servers.items():
                if isinstance(config, dict) and config.get("type") == "sdk":
                    sdk_mcp_servers[name] = config["instance"]

        self._query = Query(
            transport=self._transport,
            is_streaming_mode=True,
            can_use_tool=self.options.can_use_tool,
            hooks=self._convert_hooks_to_internal_format(self.options.hooks)
            if self.options.hooks
            else None,
            sdk_mcp_servers=sdk_mcp_servers,
        )
```

## 会话上下文管理

- **结论**：需展示 `QwenAgentClient` 应支持异步上下文管理与显式断连，确保资源在 Agent 会话结束后正确释放。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py`
```python
    async def disconnect(self) -> None:
        if self._query:
            await self._query.close()
            self._query = None
        self._transport = None

    async def __aenter__(self) -> "ClaudeSDKClient":
        await self.connect()
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> bool:
        await self.disconnect()
        return False
```

## 自定义 Transport 注入

- **结论**：需允许 SDK 注入自定义 Transport，以便接入远程 CLI 或代理服务，实现更灵活的部署拓扑。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py` 与 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/client.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py`
```python
    def __init__(
        self,
        options: ClaudeAgentOptions | None = None,
        transport: Transport | None = None,
    ):
        if options is None:
            options = ClaudeAgentOptions()
        self.options = options
        self._custom_transport = transport
        self._transport: Transport | None = None
```

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/client.py`
```python
        if transport is not None:
            chosen_transport = transport
        else:
            chosen_transport = SubprocessCLITransport(
                prompt=prompt, options=configured_options
            )

        await chosen_transport.connect()
```

## 会话消息流管理

- **结论**：需描述会话在连接后如何持续发送与接收消息，包括异步推送追加消息、等待模型响应以及在同一上下文中进行多轮交互。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py` 与 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py`
```python
    async def query(
        self, prompt: str | AsyncIterable[dict[str, Any]], session_id: str = "default"
    ) -> None:
        if not self._query or not self._transport:
            raise CLIConnectionError("Not connected. Call connect() first.")

        if isinstance(prompt, str):
            message = {
                "type": "user",
                "message": {"role": "user", "content": prompt},
                "parent_tool_use_id": None,
                "session_id": session_id,
            }
            await self._transport.write(json.dumps(message) + "\n")
        else:
            async for msg in prompt:
                if "session_id" not in msg:
                    msg["session_id"] = session_id
                await self._transport.write(json.dumps(msg) + "\n")

    async def receive_messages(self) -> AsyncIterator[Message]:
        if not self._query:
            raise CLIConnectionError("Not connected. Call connect() first.")

        from ._internal.message_parser import parse_message

        async for data in self._query.receive_messages():
            yield parse_message(data)
```

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py`
```python
    async def stream_input(self, stream: AsyncIterable[dict[str, Any]]) -> None:
        try:
            async for message in stream:
                if self._closed:
                    break
                await self.transport.write(json.dumps(message) + "\n")
            await self.transport.end_input()
        except Exception as e:
            logger.debug(f"Error streaming input: {e}")

    async def receive_messages(self) -> AsyncIterator[dict[str, Any]]:
        async for message in self._message_receive:
            if message.get("type") == "end":
                break
            elif message.get("type") == "error":
                raise Exception(message.get("error", "Unknown error"))

            yield message
```

## 单次查询模式

- **结论**：需提供便捷的单次查询入口，便于脚本化或批处理场景通过 `query()` 直接获取异步消息流。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/query.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/query.py`
```python
async def query(
    *,
    prompt: str | AsyncIterable[dict[str, Any]],
    options: ClaudeAgentOptions | None = None,
    transport: Transport | None = None,
) -> AsyncIterator[Message]:
    if options is None:
        options = ClaudeAgentOptions()

    os.environ["CLAUDE_CODE_ENTRYPOINT"] = "sdk-py"

    client = InternalClient()

    async for message in client.process_query(
        prompt=prompt, options=options, transport=transport
    ):
        yield message
```

## 控制协议治理

- **结论**：需要在 RFC 中明确 `can_use_tool`、Hook 回调与 SDK MCP 控制请求的全链路处理，包括权限结果结构与错误返回，确保 Qwen SDK 能覆盖真实的 Agent 审批/反馈流程。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py` 与 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/types.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py`
```python
            if subtype == "can_use_tool":
                permission_request: SDKControlPermissionRequest = request_data
                if not self.can_use_tool:
                    raise Exception("canUseTool callback is not provided")

                context = ToolPermissionContext(
                    signal=None,
                    suggestions=permission_request.get("permission_suggestions", [])
                    or [],
                )

                response = await self.can_use_tool(
                    permission_request["tool_name"],
                    permission_request["input"],
                    context,
                )

                if isinstance(response, PermissionResultAllow):
                    response_data = {"behavior": "allow"}
                    if response.updated_input is not None:
                        response_data["updatedInput"] = response.updated_input
                    if response.updated_permissions is not None:
                        response_data["updatedPermissions"] = [
                            permission.to_dict()
                            for permission in response.updated_permissions
                        ]
                elif isinstance(response, PermissionResultDeny):
                    response_data = {"behavior": "deny", "message": response.message}
                    if response.interrupt:
                        response_data["interrupt"] = response.interrupt
                else:
                    raise TypeError(
                        "Tool permission callback must return PermissionResult (PermissionResultAllow or PermissionResultDeny), got {type(response)}"
                    )

            elif subtype == "hook_callback":
                hook_callback_request: SDKHookCallbackRequest = request_data
                callback_id = hook_callback_request["callback_id"]
                callback = self.hook_callbacks.get(callback_id)
                if not callback:
                    raise Exception(f"No hook callback found for ID: {callback_id}")

                response_data = await callback(
                    request_data.get("input"),
                    request_data.get("tool_use_id"),
                    {"signal": None},
                )

            elif subtype == "mcp_message":
                server_name = request_data.get("server_name")
                mcp_message = request_data.get("message")
                if not server_name or not mcp_message:
                    raise Exception("Missing server_name or message for MCP request")

                mcp_response = await self._handle_sdk_mcp_request(
                    server_name, mcp_message
                )
                response_data = {"mcp_response": mcp_response}
```

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/types.py`
```python
@dataclass
class PermissionResultAllow:
    behavior: Literal["allow"] = "allow"
    updated_input: dict[str, Any] | None = None
    updated_permissions: list[PermissionUpdate] | None = None


@dataclass
class PermissionResultDeny:
    behavior: Literal["deny"] = "deny"
    message: str = ""
    interrupt: bool = False
```

## SDK MCP 工具桥接

- **结论**：需增加内嵌 MCP 工具服务器与 JSON-RPC 桥接的设计说明，使 Qwen SDK 能像 Claude SDK 一样直接在宿主进程中托管工具，避免额外子进程。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/__init__.py` 与 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/__init__.py`
```python
def create_sdk_mcp_server(
    name: str, version: str = "1.0.0", tools: list[SdkMcpTool[Any]] | None = None
) -> McpSdkServerConfig:
    from mcp.server import Server
    from mcp.types import TextContent, Tool

    server = Server(name, version=version)

    if tools:
        tool_map = {tool_def.name: tool_def for tool_def in tools}

        @server.list_tools()
        async def list_tools() -> list[Tool]:
            tool_list = []
            for tool_def in tools:
                if isinstance(tool_def.input_schema, dict):
                    if (
                        "type" in tool_def.input_schema
                        and "properties" in tool_def.input_schema
                    ):
                        schema = tool_def.input_schema
                    else:
                        properties = {}
                        for param_name, param_type in tool_def.input_schema.items():
                            if param_type is str:
                                properties[param_name] = {"type": "string"}
                            elif param_type is int:
                                properties[param_name] = {"type": "integer"}
                            elif param_type is float:
                                properties[param_name] = {"type": "number"}
                            elif param_type is bool:
                                properties[param_name] = {"type": "boolean"}
                            else:
                                properties[param_name] = {"type": "string"}
                        schema = {
                            "type": "object",
                            "properties": properties,
                            "required": list(properties.keys()),
                        }
                else:
                    schema = {"type": "object", "properties": {}}

                tool_list.append(
                    Tool(
                        name=tool_def.name,
                        description=tool_def.description,
                        inputSchema=schema,
                    )
                )
            return tool_list

        @server.call_tool()
        async def call_tool(name: str, arguments: dict[str, Any]) -> Any:
            if name not in tool_map:
                raise ValueError(f"Tool '{name}' not found")

            tool_def = tool_map[name]
            return await tool_def.handler(arguments)

    return {
        "type": "sdk",
        "name": name,
        "instance": server,
    }
```

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py`
```python
    async def _handle_sdk_mcp_request(
        self, server_name: str, message: dict[str, Any]
    ) -> dict[str, Any]:
        if server_name not in self.sdk_mcp_servers:
            return {
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "error": {
                    "code": -32601,
                    "message": f"Server '{server_name}' not found",
                },
            }

        server = self.sdk_mcp_servers[server_name]
        method = message.get("method")
        params = message.get("params", {})

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": message.get("id"),
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {
                        "name": server.name,
                        "version": server.version or "1.0.0",
                    },
                },
            }

        elif method == "tools/list":
            request = ListToolsRequest(method=method)
            handler = server.request_handlers.get(ListToolsRequest)
            if handler:
                result = await handler(request)
                tools_data = [
                    {
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": (
                            tool.inputSchema.model_dump()
                            if hasattr(tool.inputSchema, "model_dump")
                            else tool.inputSchema
                        )
                        if tool.inputSchema
                        else {},
                    }
                    for tool in result.root.tools
                ]
                return {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": {"tools": tools_data},
                }

        elif method == "tools/call":
            call_request = CallToolRequest(
                method=method,
                params=CallToolRequestParams(
                    name=params.get("name"), arguments=params.get("arguments", {})
                ),
            )
            handler = server.request_handlers.get(CallToolRequest)
            if handler:
                result = await handler(call_request)
                content = []
                for item in result.root.content:
                    if hasattr(item, "text"):
                        content.append({"type": "text", "text": item.text})
                    elif hasattr(item, "data") and hasattr(item, "mimeType"):
                        content.append(
                            {
                                "type": "image",
                                "data": item.data,
                                "mimeType": item.mimeType,
                            }
                        )

                response_data = {"content": content}
                if hasattr(result.root, "is_error") and result.root.is_error:
                    response_data["is_error"] = True

                return {
                    "jsonrpc": "2.0",
                    "id": message.get("id"),
                    "result": response_data,
                }
```

## 会话动态控制 API

- **结论**：需要在文档中列出会话级控制接口（中断、动态切换权限模式、热切模型等），指导上层如何通过控制协议操作运行中的 Agent。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py`
```python
    async def interrupt(self) -> None:
        await self._send_control_request({"subtype": "interrupt"})

    async def set_permission_mode(self, mode: str) -> None:
        await self._send_control_request(
            {
                "subtype": "set_permission_mode",
                "mode": mode,
            }
        )

    async def set_model(self, model: str | None) -> None:
        await self._send_control_request(
            {
                "subtype": "set_model",
                "model": model,
            }
        )
```

## 会话初始化信息

- **结论**：需支持在初始化后回读 CLI 返回的能力信息（命令、输出风格等），方便上层根据 Agent 能力动态调整界面或策略。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py`
```python
    async def get_server_info(self) -> dict[str, Any] | None:
        if not self._query:
            raise CLIConnectionError("Not connected. Call connect() first.")
        return getattr(self._query, "_initialization_result", None)
```

## 结果响应迭代器

- **结论**：需提供自动截断到 `ResultMessage` 的便捷迭代器，帮助上层准确获取完整回应并停止读取。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/client.py`
```python
    async def receive_response(self) -> AsyncIterator[Message]:
        async for message in self.receive_messages():
            yield message
            if isinstance(message, ResultMessage):
                return
```

## CLI 编排与多 Agent 配置

- **结论**：需补充 CLI 参数编排与多 Agent 配置的映射关系，让 SDK 端 `QwenAgentOptions` 能生成正确的子进程命令与配置传递，包括 MCP、Agent 定义及设置源。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py`
```python
    def _build_command(self) -> list[str]:
        cmd = [self._cli_path, "--output-format", "stream-json", "--verbose"]

        if self._options.allowed_tools:
            cmd.extend(["--allowedTools", ",".join(self._options.allowed_tools)])

        if self._options.mcp_servers:
            if isinstance(self._options.mcp_servers, dict):
                servers_for_cli: dict[str, Any] = {}
                for name, config in self._options.mcp_servers.items():
                    if isinstance(config, dict) and config.get("type") == "sdk":
                        sdk_config: dict[str, object] = {
                            k: v for k, v in config.items() if k != "instance"
                        }
                        servers_for_cli[name] = sdk_config
                    else:
                        servers_for_cli[name] = config

                if servers_for_cli:
                    cmd.extend(
                        [
                            "--mcp-config",
                            json.dumps({"mcpServers": servers_for_cli}),
                        ]
                    )
            else:
                cmd.extend(["--mcp-config", str(self._options.mcp_servers)])

        if self._options.agents:
            agents_dict = {
                name: {k: v for k, v in asdict(agent_def).items() if v is not None}
                for name, agent_def in self._options.agents.items()
            }
            cmd.extend(["--agents", json.dumps(agents_dict)])

        sources_value = (
            ",".join(self._options.setting_sources)
            if self._options.setting_sources is not None
            else ""
        )
        cmd.extend(["--setting-sources", sources_value])

        if self._is_streaming:
            cmd.extend(["--input-format", "stream-json"])
        else:
            cmd.extend(["--print", "--", str(self._prompt)])

        return cmd
```

## 工作目录与环境注入

- **结论**：需明确 CLI 子进程可继承自定义工作目录、环境变量与运行用户，确保 Agent 在不同项目根与权限模型下稳定运作。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py`
```python
            process_env = {
                **os.environ,
                **self._options.env,
                "CLAUDE_CODE_ENTRYPOINT": "sdk-py",
                "CLAUDE_AGENT_SDK_VERSION": __version__,
            }

            if self._cwd:
                process_env["PWD"] = self._cwd

            self._process = await anyio.open_process(
                cmd,
                stdin=PIPE,
                stdout=PIPE,
                stderr=stderr_dest,
                cwd=self._cwd,
                env=process_env,
                user=self._options.user,
            )
```

## 部分消息与调试输出

- **结论**：需说明 SDK 对部分消息流与调试 stderr 的处理方式，使 Agent 能在复杂界面中增量输出并捕获底层诊断信息。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py`
```python
        if self._options.include_partial_messages:
            cmd.append("--include-partial-messages")

            should_pipe_stderr = (
                self._options.stderr is not None
                or "debug-to-stderr" in self._options.extra_args
            )

            if should_pipe_stderr and self._process.stderr:
                self._stderr_stream = TextReceiveStream(self._process.stderr)
                self._stderr_task_group = anyio.create_task_group()
                await self._stderr_task_group.__aenter__()
                self._stderr_task_group.start_soon(self._handle_stderr)
```

## 缓冲与版本检查

- **结论**：需记录 SDK 内建的输出缓冲上限与 CLI 版本检查逻辑，保障 Agent 在异常输出或低版本环境下具备自诊断能力。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/subprocess_cli.py`
```python
        self._max_buffer_size = (
            options.max_buffer_size
            if options.max_buffer_size is not None
            else _DEFAULT_MAX_BUFFER_SIZE
        )

                    if len(json_buffer) > self._max_buffer_size:
                        buffer_length = len(json_buffer)
                        json_buffer = ""
                        raise SDKJSONDecodeError(
                            f"JSON message exceeded maximum buffer size of {self._max_buffer_size} bytes",
                            ValueError(
                                f"Buffer size {buffer_length} exceeds limit {self._max_buffer_size}"
                            ),
                        )

    async def _check_claude_version(self) -> None:
        # ...
        if version_parts < min_parts:
            warning = (
                f"Warning: Claude Code version {version} is unsupported in the Agent SDK. "
                f"Minimum required version is {MINIMUM_CLAUDE_CODE_VERSION}. "
                "Some features may not work correctly."
            )
            logger.warning(warning)
            print(warning, file=sys.stderr)
```

## 配置选项映射

- **结论**：需在文档中罗列 `QwenAgentOptions` 对应的核心配置项（工具权限、Hook、MCP、Agent 定义、工作目录等），确保宿主应用能够一站式传入会话所需的上下文。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/types.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/types.py`
```python
@dataclass
class ClaudeAgentOptions:
    allowed_tools: list[str] = field(default_factory=list)
    system_prompt: str | SystemPromptPreset | None = None
    mcp_servers: dict[str, McpServerConfig] | str | Path = field(default_factory=dict)
    permission_mode: PermissionMode | None = None
    continue_conversation: bool = False
    resume: str | None = None
    max_turns: int | None = None
    disallowed_tools: list[str] = field(default_factory=list)
    model: str | None = None
    permission_prompt_tool_name: str | None = None
    cwd: str | Path | None = None
    settings: str | None = None
    add_dirs: list[str | Path] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    extra_args: dict[str, str | None] = field(default_factory=dict)
    max_buffer_size: int | None = None
    debug_stderr: Any = sys.stderr
    stderr: Callable[[str], None] | None = None
    can_use_tool: CanUseTool | None = None
    hooks: dict[HookEvent, list[HookMatcher]] | None = None
    user: str | None = None
    include_partial_messages: bool = False
    fork_session: bool = False
    agents: dict[str, AgentDefinition] | None = None
    setting_sources: list[SettingSource] | None = None
```

## 内嵌工具定义

- **结论**：需强调通过装饰器快速注册 in-process 工具，并以 `SdkMcpTool` 结构封装元数据，以便 Qwen SDK 直接托管宿主进程内的函数型工具。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/__init__.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/__init__.py`
```python
@dataclass
class SdkMcpTool(Generic[T]):
    name: str
    description: str
    input_schema: type[T] | dict[str, Any]
    handler: Callable[[T], Awaitable[dict[str, Any]]]


def tool(
    name: str, description: str, input_schema: type | dict[str, Any]
) -> Callable[[Callable[[Any], Awaitable[dict[str, Any]]]], SdkMcpTool[Any]]:

    def decorator(
        handler: Callable[[Any], Awaitable[dict[str, Any]]],
    ) -> SdkMcpTool[Any]:
        return SdkMcpTool(
            name=name,
            description=description,
            input_schema=input_schema,
            handler=handler,
        )

    return decorator
```

## Hook 匹配与回调

- **结论**：需在 RFC 中补充 Hook 匹配配置与回调注册流程，说明 Agent 如何在特定事件点注入业务逻辑。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py` 与 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/types.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/query.py`
```python
        hooks_config: dict[str, Any] = {}
        if self.hooks:
            for event, matchers in self.hooks.items():
                if matchers:
                    hooks_config[event] = []
                    for matcher in matchers:
                        callback_ids = []
                        for callback in matcher.get("hooks", []):
                            callback_id = f"hook_{self.next_callback_id}"
                            self.next_callback_id += 1
                            self.hook_callbacks[callback_id] = callback
                            callback_ids.append(callback_id)
                        hooks_config[event].append(
                            {
                                "matcher": matcher.get("matcher"),
                                "hookCallbackIds": callback_ids,
                            }
                        )

        request = {
            "subtype": "initialize",
            "hooks": hooks_config if hooks_config else None,
        }
```

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/types.py`
```python
@dataclass
class HookMatcher:
    matcher: str | None = None
    hooks: list[HookCallback] = field(default_factory=list)
```

## 权限策略更新

- **结论**：需揭示权限更新的数据结构，使 SDK 支持返回细粒度的规则、目录及模式调整，保障企业级管控能力。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/types.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/types.py`
```python
@dataclass
class PermissionUpdate:
    type: Literal[
        "addRules",
        "replaceRules",
        "removeRules",
        "setMode",
        "addDirectories",
        "removeDirectories",
    ]
    rules: list[PermissionRuleValue] | None = None
    behavior: PermissionBehavior | None = None
    mode: PermissionMode | None = None
    directories: list[str] | None = None
    destination: PermissionUpdateDestination | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "type": self.type,
        }

        if self.destination is not None:
            result["destination"] = self.destination

        if self.type in ["addRules", "replaceRules", "removeRules"]:
            if self.rules is not None:
                result["rules"] = [
                    {
                        "toolName": rule.tool_name,
                        "ruleContent": rule.rule_content,
                    }
                    for rule in self.rules
                ]
            if self.behavior is not None:
                result["behavior"] = self.behavior

        elif self.type == "setMode":
            if self.mode is not None:
                result["mode"] = self.mode

        elif self.type in ["addDirectories", "removeDirectories"]:
            if self.directories is not None:
                result["directories"] = self.directories

        return result
```

## Transport 抽象

- **结论**：需指出 SDK 提供 `Transport` 抽象，便于在子进程外扩展远程或自定义通信层，形成更灵活的 Agent 部署方案。（参考 `third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/__init__.py`）

> 代码引用：`third-party/anthropics/claude-agent-sdk-python/src/claude_agent_sdk/_internal/transport/__init__.py`
```python
class Transport(ABC):
    @abstractmethod
    async def connect(self) -> None:
        pass

    @abstractmethod
    async def write(self, data: str) -> None:
        pass

    @abstractmethod
    def read_messages(self) -> AsyncIterator[dict[str, Any]]:
        pass

    @abstractmethod
    async def close(self) -> None:
        pass

    @abstractmethod
    def is_ready(self) -> bool:
        pass

    @abstractmethod
    async def end_input(self) -> None:
        pass
```
