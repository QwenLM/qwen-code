"""Protocol message types for qwen-code SDK.

Based on TypeScript SDK protocol definitions.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Union, Literal
from dataclasses import dataclass, field
from enum import Enum


class ContentBlockType(str, Enum):
    """Content block types."""

    TEXT = "text"
    THINKING = "thinking"
    TOOL_USE = "tool_use"
    TOOL_RESULT = "tool_result"


class MessageType(str, Enum):
    """SDK message types."""

    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    RESULT = "result"
    STREAM_EVENT = "stream_event"


class ControlRequestType(str, Enum):
    """Control request types."""

    INITIALIZE = "initialize"
    INTERRUPT = "interrupt"
    CAN_USE_TOOL = "can_use_tool"
    SET_PERMISSION_MODE = "set_permission_mode"
    SET_MODEL = "set_model"
    MCP_MESSAGE = "mcp_message"
    MCP_SERVER_STATUS = "mcp_server_status"
    HOOK_CALLBACK = "hook_callback"
    SUPPORTED_COMMANDS = "supported_commands"


class ResultSubtype(str, Enum):
    """Result message subtypes."""

    SUCCESS = "success"
    ERROR_MAX_TURNS = "error_max_turns"
    ERROR_DURING_EXECUTION = "error_during_execution"


class PermissionMode(str, Enum):
    """Permission modes."""

    DEFAULT = "default"
    PLAN = "plan"
    AUTO_EDIT = "auto-edit"
    YOLO = "yolo"


# ============================================================================
# Content Block Types
# ============================================================================


@dataclass
class TextBlock:
    """Text content block."""

    type: Literal["text"] = "text"
    text: str = ""
    annotations: Optional[List[Dict[str, str]]] = None


@dataclass
class ThinkingBlock:
    """Thinking content block."""

    type: Literal["thinking"] = "thinking"
    thinking: str = ""
    signature: Optional[str] = None
    annotations: Optional[List[Dict[str, str]]] = None


@dataclass
class ToolUseBlock:
    """Tool use content block."""

    type: Literal["tool_use"] = "tool_use"
    id: str = ""
    name: str = ""
    input: Dict[str, Any] = field(default_factory=dict)
    annotations: Optional[List[Dict[str, str]]] = None


@dataclass
class ToolResultBlock:
    """Tool result content block."""

    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str = ""
    content: Optional[Union[str, List[Any]]] = None
    is_error: bool = False
    annotations: Optional[List[Dict[str, str]]] = None


ContentBlock = Union[TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock]


# ============================================================================
# API Message Types
# ============================================================================


@dataclass
class APIUserMessage:
    """User message for API."""

    role: Literal["user"] = "user"
    content: Union[str, List[ContentBlock]] = ""


@dataclass
class Usage:
    """Token usage information."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: Optional[int] = None
    cache_read_input_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


@dataclass
class APIAssistantMessage:
    """Assistant message from API."""

    id: str = ""
    type: Literal["message"] = "message"
    role: Literal["assistant"] = "assistant"
    model: str = ""
    content: List[ContentBlock] = field(default_factory=list)
    stop_reason: Optional[str] = None
    usage: Usage = field(default_factory=Usage)


# ============================================================================
# SDK Message Types
# ============================================================================


@dataclass
class SDKUserMessage:
    """SDK user message."""

    type: Literal["user"] = "user"
    uuid: Optional[str] = None
    session_id: str = ""
    message: APIUserMessage = field(default_factory=APIUserMessage)
    parent_tool_use_id: Optional[str] = None
    options: Optional[Dict[str, Any]] = None


@dataclass
class SDKAssistantMessage:
    """SDK assistant message."""

    type: Literal["assistant"] = "assistant"
    uuid: str = ""
    session_id: str = ""
    message: APIAssistantMessage = field(default_factory=APIAssistantMessage)
    parent_tool_use_id: Optional[str] = None


@dataclass
class MCPServerStatus:
    """MCP server status."""

    name: str = ""
    status: str = ""


@dataclass
class SDKSystemMessage:
    """SDK system message."""

    type: Literal["system"] = "system"
    subtype: str = ""
    uuid: str = ""
    session_id: str = ""
    data: Optional[Dict[str, Any]] = None
    cwd: Optional[str] = None
    tools: Optional[List[str]] = None
    mcp_servers: Optional[List[MCPServerStatus]] = None
    model: Optional[str] = None
    permission_mode: Optional[str] = None
    slash_commands: Optional[List[str]] = None
    qwen_code_version: Optional[str] = None
    output_style: Optional[str] = None
    agents: Optional[List[str]] = None
    skills: Optional[List[str]] = None
    capabilities: Optional[Dict[str, Any]] = None


@dataclass
class SDKResultMessageSuccess:
    """SDK result message (success)."""

    type: Literal["result"] = "result"
    subtype: Literal["success"] = "success"
    uuid: str = ""
    session_id: str = ""
    is_error: bool = False
    duration_ms: int = 0
    duration_api_ms: int = 0
    num_turns: int = 0
    result: str = ""
    usage: Usage = field(default_factory=Usage)
    permission_denials: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class SDKResultMessageError:
    """SDK result message (error)."""

    type: Literal["result"] = "result"
    subtype: Literal["error_max_turns", "error_during_execution"] = "error_during_execution"
    uuid: str = ""
    session_id: str = ""
    is_error: bool = True
    duration_ms: int = 0
    duration_api_ms: int = 0
    num_turns: int = 0
    usage: Usage = field(default_factory=Usage)
    permission_denials: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[Dict[str, Any]] = None


SDKResultMessage = Union[SDKResultMessageSuccess, SDKResultMessageError]


# ============================================================================
# Stream Event Types
# ============================================================================


@dataclass
class MessageStartEvent:
    """Message start stream event."""

    type: Literal["message_start"] = "message_start"
    message: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ContentBlockStartEvent:
    """Content block start stream event."""

    type: Literal["content_block_start"] = "content_block_start"
    index: int = 0
    content_block: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TextDelta:
    """Text delta for streaming."""

    type: Literal["text_delta"] = "text_delta"
    text: str = ""


@dataclass
class ThinkingDelta:
    """Thinking delta for streaming."""

    type: Literal["thinking_delta"] = "thinking_delta"
    thinking: str = ""


@dataclass
class InputJsonDelta:
    """Input JSON delta for streaming."""

    type: Literal["input_json_delta"] = "input_json_delta"
    partial_json: str = ""


ContentBlockDelta = Union[TextDelta, ThinkingDelta, InputJsonDelta]


@dataclass
class ContentBlockDeltaEvent:
    """Content block delta stream event."""

    type: Literal["content_block_delta"] = "content_block_delta"
    index: int = 0
    delta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ContentBlockStopEvent:
    """Content block stop stream event."""

    type: Literal["content_block_stop"] = "content_block_stop"
    index: int = 0


@dataclass
class MessageStopEvent:
    """Message stop stream event."""

    type: Literal["message_stop"] = "message_stop"


StreamEvent = Union[
    MessageStartEvent,
    ContentBlockStartEvent,
    ContentBlockDeltaEvent,
    ContentBlockStopEvent,
    MessageStopEvent,
]


@dataclass
class SDKPartialAssistantMessage:
    """SDK partial assistant message (stream event)."""

    type: Literal["stream_event"] = "stream_event"
    uuid: str = ""
    session_id: str = ""
    event: Dict[str, Any] = field(default_factory=dict)
    parent_tool_use_id: Optional[str] = None


# ============================================================================
# Control Message Types
# ============================================================================


@dataclass
class PermissionSuggestion:
    """Permission suggestion for tool use."""

    type: Literal["allow", "deny", "modify"] = "allow"
    label: str = ""
    description: Optional[str] = None
    modified_input: Optional[Dict[str, Any]] = None


@dataclass
class HookRegistration:
    """Hook registration."""

    event: str = ""
    callback_id: str = ""


@dataclass
class SDKMcpServerConfig:
    """SDK MCP server config (wire format)."""

    type: Literal["sdk"] = "sdk"
    name: str = ""


@dataclass
class MCPServerConfig:
    """MCP server config for external servers."""

    command: Optional[str] = None
    args: Optional[List[str]] = None
    env: Optional[Dict[str, str]] = None
    cwd: Optional[str] = None
    url: Optional[str] = None
    http_url: Optional[str] = None
    headers: Optional[Dict[str, str]] = None
    timeout: Optional[int] = None
    trust: bool = False
    description: Optional[str] = None


@dataclass
class SubagentConfig:
    """Subagent configuration."""

    name: str = ""
    description: str = ""
    tools: Optional[List[str]] = None
    system_prompt: str = ""
    level: Literal["session"] = "session"


@dataclass
class ModelConfig:
    """Model configuration for the SDK."""

    model: str = ""
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    top_p: Optional[float] = None
    top_k: Optional[int] = None
    presence_penalty: Optional[float] = None
    frequency_penalty: Optional[float] = None
    stop: Optional[List[str]] = None


@dataclass
class RunConfig:
    """Run configuration for the SDK."""

    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    model: Optional[str] = None
    max_turns: Optional[int] = None
    max_duration: Optional[int] = None
    enable_memories: bool = False
    disable_memories: bool = False


@dataclass
class CLIControlInitializeRequest:
    """CLI control initialize request."""

    subtype: Literal["initialize"] = "initialize"
    hooks: Optional[List[HookRegistration]] = None
    sdk_mcp_servers: Optional[Dict[str, SDKMcpServerConfig]] = None
    mcp_servers: Optional[Dict[str, MCPServerConfig]] = None
    agents: Optional[List[SubagentConfig]] = None


@dataclass
class CLIControlPermissionRequest:
    """CLI control permission request."""

    subtype: Literal["can_use_tool"] = "can_use_tool"
    tool_name: str = ""
    tool_use_id: str = ""
    input: Dict[str, Any] = field(default_factory=dict)
    permission_suggestions: Optional[List[PermissionSuggestion]] = None
    blocked_path: Optional[str] = None


@dataclass
class CLIControlInterruptRequest:
    """CLI control interrupt request."""

    subtype: Literal["interrupt"] = "interrupt"


@dataclass
class CLIControlSetPermissionModeRequest:
    """CLI control set permission mode request."""

    subtype: Literal["set_permission_mode"] = "set_permission_mode"
    mode: str = ""


@dataclass
class CLIControlMcpMessageRequest:
    """CLI control MCP message request."""

    subtype: Literal["mcp_message"] = "mcp_message"
    server_name: str = ""
    message: Dict[str, Any] = field(default_factory=dict)


@dataclass
class CLIControlSetModelRequest:
    """CLI control set model request."""

    subtype: Literal["set_model"] = "set_model"
    model: str = ""


@dataclass
class CLIControlMcpStatusRequest:
    """CLI control MCP status request."""

    subtype: Literal["mcp_server_status"] = "mcp_server_status"


@dataclass
class CLIControlSupportedCommandsRequest:
    """CLI control supported commands request."""

    subtype: Literal["supported_commands"] = "supported_commands"


ControlRequestPayload = Union[
    CLIControlInitializeRequest,
    CLIControlPermissionRequest,
    CLIControlInterruptRequest,
    CLIControlSetPermissionModeRequest,
    CLIControlMcpMessageRequest,
    CLIControlSetModelRequest,
    CLIControlMcpStatusRequest,
    CLIControlSupportedCommandsRequest,
]


@dataclass
class CLIControlRequest:
    """CLI control request."""

    type: Literal["control_request"] = "control_request"
    request_id: str = ""
    request: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ControlResponse:
    """Control success response."""

    subtype: Literal["success"] = "success"
    request_id: str = ""
    response: Optional[Dict[str, Any]] = None


@dataclass
class ControlErrorResponse:
    """Control error response."""

    subtype: Literal["error"] = "error"
    request_id: str = ""
    error: Union[str, Dict[str, Any]] = ""


@dataclass
class CLIControlResponse:
    """CLI control response."""

    type: Literal["control_response"] = "control_response"
    response: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ControlCancelRequest:
    """Control cancel request."""

    type: Literal["control_cancel_request"] = "control_cancel_request"
    request_id: Optional[str] = None


# ============================================================================
# Type Guards (Predicate Functions)
# ============================================================================


def is_sdk_user_message(msg: Any) -> bool:
    """Check if message is SDKUserMessage."""
    return (
        isinstance(msg, dict)
        and msg.get("type") == "user"
        and "message" in msg
    )


def is_sdk_assistant_message(msg: Any) -> bool:
    """Check if message is SDKAssistantMessage."""
    return (
        isinstance(msg, dict)
        and msg.get("type") == "assistant"
        and "uuid" in msg
        and "message" in msg
        and "session_id" in msg
        and "parent_tool_use_id" in msg
    )


def is_sdk_system_message(msg: Any) -> bool:
    """Check if message is SDKSystemMessage."""
    return (
        isinstance(msg, dict)
        and msg.get("type") == "system"
        and "subtype" in msg
        and "uuid" in msg
        and "session_id" in msg
    )


def is_sdk_result_message(msg: Any) -> bool:
    """Check if message is SDKResultMessage."""
    return (
        isinstance(msg, dict)
        and msg.get("type") == "result"
        and "subtype" in msg
        and "duration_ms" in msg
        and "is_error" in msg
        and "uuid" in msg
        and "session_id" in msg
    )


def is_sdk_partial_assistant_message(msg: Any) -> bool:
    """Check if message is SDKPartialAssistantMessage."""
    return (
        isinstance(msg, dict)
        and msg.get("type") == "stream_event"
        and "uuid" in msg
        and "session_id" in msg
        and "event" in msg
        and "parent_tool_use_id" in msg
    )


def is_control_request(msg: Any) -> bool:
    """Check if message is CLIControlRequest."""
    return (
        isinstance(msg, dict)
        and msg.get("type") == "control_request"
        and "request_id" in msg
        and "request" in msg
    )


def is_control_response(msg: Any) -> bool:
    """Check if message is CLIControlResponse."""
    return (
        isinstance(msg, dict)
        and msg.get("type") == "control_response"
        and "response" in msg
    )


def is_control_cancel(msg: Any) -> bool:
    """Check if message is ControlCancelRequest."""
    return (
        isinstance(msg, dict)
        and msg.get("type") == "control_cancel_request"
        and "request_id" in msg
    )


def is_text_block(block: Any) -> bool:
    """Check if block is TextBlock."""
    return isinstance(block, dict) and block.get("type") == "text"


def is_thinking_block(block: Any) -> bool:
    """Check if block is ThinkingBlock."""
    return isinstance(block, dict) and block.get("type") == "thinking"


def is_tool_use_block(block: Any) -> bool:
    """Check if block is ToolUseBlock."""
    return isinstance(block, dict) and block.get("type") == "tool_use"


def is_tool_result_block(block: Any) -> bool:
    """Check if block is ToolResultBlock."""
    return isinstance(block, dict) and block.get("type") == "tool_result"


# ============================================================================
# Union Types
# ============================================================================


SDKMessage = Union[
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage,
    SDKPartialAssistantMessage,
]

ControlMessage = Union[
    CLIControlRequest,
    CLIControlResponse,
    ControlCancelRequest,
]


__all__ = [
    # Enums
    "ContentBlockType",
    "MessageType",
    "ControlRequestType",
    "ResultSubtype",
    "PermissionMode",
    # Content Blocks
    "TextBlock",
    "ThinkingBlock",
    "ToolUseBlock",
    "ToolResultBlock",
    "ContentBlock",
    # Messages
    "APIUserMessage",
    "APIAssistantMessage",
    "Usage",
    "SDKUserMessage",
    "SDKAssistantMessage",
    "SDKSystemMessage",
    "SDKResultMessageSuccess",
    "SDKResultMessageError",
    "SDKResultMessage",
    "SDKPartialAssistantMessage",
    # Config Types
    "SubagentConfig",
    "ModelConfig",
    "RunConfig",
    # Control Messages
    "PermissionSuggestion",
    "HookRegistration",
    "SDKMcpServerConfig",
    "MCPServerConfig",
    "CLIControlInitializeRequest",
    "CLIControlPermissionRequest",
    "CLIControlInterruptRequest",
    "CLIControlSetPermissionModeRequest",
    "CLIControlMcpMessageRequest",
    "CLIControlSetModelRequest",
    "CLIControlMcpStatusRequest",
    "CLIControlSupportedCommandsRequest",
    "CLIControlRequest",
    "ControlResponse",
    "ControlErrorResponse",
    "CLIControlResponse",
    "ControlCancelRequest",
    # Type Guards
    "is_sdk_user_message",
    "is_sdk_assistant_message",
    "is_sdk_system_message",
    "is_sdk_result_message",
    "is_sdk_partial_assistant_message",
    "is_control_request",
    "is_control_response",
    "is_control_cancel",
    "is_text_block",
    "is_thinking_block",
    "is_tool_use_block",
    "is_tool_result_block",
    # Union Types
    "SDKMessage",
    "ControlMessage",
]
