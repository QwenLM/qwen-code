"""Protocol message types and helpers for qwen stream-json."""

from __future__ import annotations

from typing import Any, Literal, TypeAlias

from typing_extensions import NotRequired, TypedDict

from .types import PermissionMode, PermissionSuggestion


class Annotation(TypedDict):
    type: str
    value: str


class Usage(TypedDict):
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: NotRequired[int]
    cache_read_input_tokens: NotRequired[int]
    total_tokens: NotRequired[int]


class ExtendedUsage(Usage, total=False):
    server_tool_use: dict[str, int]
    service_tier: str
    cache_creation: dict[str, int]


class CLIPermissionDenial(TypedDict):
    tool_name: str
    tool_use_id: str
    tool_input: Any


class TextBlock(TypedDict):
    type: Literal["text"]
    text: str
    annotations: NotRequired[list[Annotation]]


class ThinkingBlock(TypedDict):
    type: Literal["thinking"]
    thinking: str
    signature: NotRequired[str]
    annotations: NotRequired[list[Annotation]]


class ToolUseBlock(TypedDict):
    type: Literal["tool_use"]
    id: str
    name: str
    input: Any
    annotations: NotRequired[list[Annotation]]


class ToolResultBlock(TypedDict):
    type: Literal["tool_result"]
    tool_use_id: str
    content: NotRequired[str | list[ContentBlock]]
    is_error: NotRequired[bool]
    annotations: NotRequired[list[Annotation]]


ContentBlock: TypeAlias = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock


class APIUserMessage(TypedDict):
    role: Literal["user"]
    content: str | list[ContentBlock]


class APIAssistantMessage(TypedDict):
    role: Literal["assistant"]
    content: list[ContentBlock]
    id: NotRequired[str]
    type: NotRequired[Literal["message"]]
    model: NotRequired[str]
    stop_reason: NotRequired[str | None]
    usage: NotRequired[Usage]


class SDKUserMessage(TypedDict):
    type: Literal["user"]
    session_id: str
    message: APIUserMessage
    parent_tool_use_id: str | None
    uuid: NotRequired[str]
    options: NotRequired[dict[str, Any]]


class SDKAssistantMessage(TypedDict):
    type: Literal["assistant"]
    uuid: str
    session_id: str
    message: APIAssistantMessage
    parent_tool_use_id: str | None


class MCPServerState(TypedDict):
    name: str
    status: str


class SDKSystemMessage(TypedDict):
    type: Literal["system"]
    subtype: str
    uuid: str
    session_id: str
    data: NotRequired[Any]
    cwd: NotRequired[str]
    tools: NotRequired[list[str]]
    mcp_servers: NotRequired[list[MCPServerState]]
    model: NotRequired[str]
    permission_mode: NotRequired[str]
    slash_commands: NotRequired[list[str]]
    qwen_code_version: NotRequired[str]
    output_style: NotRequired[str]
    agents: NotRequired[list[str]]
    skills: NotRequired[list[str]]
    capabilities: NotRequired[dict[str, Any]]


class SDKResultMessageSuccess(TypedDict):
    type: Literal["result"]
    subtype: Literal["success"]
    uuid: str
    session_id: str
    is_error: Literal[False]
    duration_ms: int
    duration_api_ms: int
    num_turns: int
    result: str
    usage: ExtendedUsage
    permission_denials: list[CLIPermissionDenial]


class ResultErrorObject(TypedDict):
    message: str
    type: NotRequired[str]


class SDKResultMessageError(TypedDict):
    type: Literal["result"]
    subtype: Literal["error_max_turns", "error_during_execution"]
    uuid: str
    session_id: str
    is_error: Literal[True]
    duration_ms: int
    duration_api_ms: int
    num_turns: int
    usage: ExtendedUsage
    permission_denials: list[CLIPermissionDenial]
    error: NotRequired[ResultErrorObject]


SDKResultMessage: TypeAlias = SDKResultMessageSuccess | SDKResultMessageError


class MessageStartStreamEvent(TypedDict):
    type: Literal["message_start"]
    message: dict[str, Any]


class ContentBlockStartEvent(TypedDict):
    type: Literal["content_block_start"]
    index: int
    content_block: ContentBlock


class ContentBlockDeltaEvent(TypedDict):
    type: Literal["content_block_delta"]
    index: int
    delta: dict[str, Any]


class ContentBlockStopEvent(TypedDict):
    type: Literal["content_block_stop"]
    index: int


class MessageStopStreamEvent(TypedDict):
    type: Literal["message_stop"]


StreamEvent: TypeAlias = (
    MessageStartStreamEvent
    | ContentBlockStartEvent
    | ContentBlockDeltaEvent
    | ContentBlockStopEvent
    | MessageStopStreamEvent
)


class SDKPartialAssistantMessage(TypedDict):
    type: Literal["stream_event"]
    uuid: str
    session_id: str
    event: StreamEvent
    parent_tool_use_id: str | None


class CLIControlInterruptRequest(TypedDict):
    subtype: Literal["interrupt"]


class CLIControlPermissionRequest(TypedDict):
    subtype: Literal["can_use_tool"]
    tool_name: str
    tool_use_id: str
    input: Any
    permission_suggestions: list[PermissionSuggestion] | None
    blocked_path: str | None


class CLIControlInitializeRequest(TypedDict):
    subtype: Literal["initialize"]
    hooks: NotRequired[Any]
    mcpServers: NotRequired[dict[str, dict[str, Any]]]


class CLIControlSetPermissionModeRequest(TypedDict):
    subtype: Literal["set_permission_mode"]
    mode: PermissionMode


class CLIControlSetModelRequest(TypedDict):
    subtype: Literal["set_model"]
    model: str


class CLIControlMcpStatusRequest(TypedDict):
    subtype: Literal["mcp_server_status"]


class CLIControlSupportedCommandsRequest(TypedDict):
    subtype: Literal["supported_commands"]


ControlRequestPayload: TypeAlias = (
    CLIControlInterruptRequest
    | CLIControlPermissionRequest
    | CLIControlInitializeRequest
    | CLIControlSetPermissionModeRequest
    | CLIControlSetModelRequest
    | CLIControlMcpStatusRequest
    | CLIControlSupportedCommandsRequest
    | dict[str, Any]
)


class CLIControlRequest(TypedDict):
    type: Literal["control_request"]
    request_id: str
    request: ControlRequestPayload


class ControlResponseSuccess(TypedDict):
    subtype: Literal["success"]
    request_id: str
    response: Any


class ControlResponseError(TypedDict):
    subtype: Literal["error"]
    request_id: str
    error: str | dict[str, Any]


class CLIControlResponse(TypedDict):
    type: Literal["control_response"]
    response: ControlResponseSuccess | ControlResponseError


class ControlCancelRequest(TypedDict):
    type: Literal["control_cancel_request"]
    request_id: NotRequired[str]


SDKMessage: TypeAlias = (
    SDKUserMessage
    | SDKAssistantMessage
    | SDKSystemMessage
    | SDKResultMessage
    | SDKPartialAssistantMessage
)


ControlMessage: TypeAlias = (
    CLIControlRequest | CLIControlResponse | ControlCancelRequest
)


def is_sdk_user_message(msg: Any) -> bool:
    return isinstance(msg, dict) and msg.get("type") == "user" and "message" in msg


def is_sdk_assistant_message(msg: Any) -> bool:
    return (
        isinstance(msg, dict)
        and msg.get("type") == "assistant"
        and "session_id" in msg
        and "message" in msg
    )


def is_sdk_system_message(msg: Any) -> bool:
    return (
        isinstance(msg, dict)
        and msg.get("type") == "system"
        and "subtype" in msg
        and "session_id" in msg
    )


def is_sdk_result_message(msg: Any) -> bool:
    return (
        isinstance(msg, dict)
        and msg.get("type") == "result"
        and "subtype" in msg
        and "session_id" in msg
    )


def is_sdk_partial_assistant_message(msg: Any) -> bool:
    return (
        isinstance(msg, dict)
        and msg.get("type") == "stream_event"
        and "session_id" in msg
        and "event" in msg
    )


def is_control_request(msg: Any) -> bool:
    return (
        isinstance(msg, dict)
        and msg.get("type") == "control_request"
        and "request_id" in msg
        and "request" in msg
    )


def is_control_response(msg: Any) -> bool:
    return isinstance(msg, dict) and msg.get("type") == "control_response"


def is_control_cancel(msg: Any) -> bool:
    return isinstance(msg, dict) and msg.get("type") == "control_cancel_request"
