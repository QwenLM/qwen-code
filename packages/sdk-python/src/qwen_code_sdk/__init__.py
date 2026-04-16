"""qwen_code_sdk package exports."""

from __future__ import annotations

from collections.abc import AsyncIterable

from .errors import (
    AbortError,
    ControlRequestTimeoutError,
    ProcessExitError,
    QwenSDKError,
    ValidationError,
)
from .protocol import (
    APIAssistantMessage,
    APIUserMessage,
    ContentBlock,
    SDKAssistantMessage,
    SDKMessage,
    SDKPartialAssistantMessage,
    SDKResultMessage,
    SDKSystemMessage,
    SDKUserMessage,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
    is_control_cancel,
    is_control_request,
    is_control_response,
    is_sdk_assistant_message,
    is_sdk_partial_assistant_message,
    is_sdk_result_message,
    is_sdk_system_message,
    is_sdk_user_message,
)
from .query import Query, query
from .sync_query import SyncQuery
from .types import (
    AuthType,
    CanUseTool,
    CanUseToolContext,
    PermissionAllowResult,
    PermissionDenyResult,
    PermissionMode,
    PermissionResult,
    PermissionSuggestion,
    QueryOptions,
    QueryOptionsDict,
    TimeoutOptions,
    TimeoutOptionsDict,
)


def query_sync(
    prompt: str | list[SDKUserMessage] | AsyncIterable[SDKUserMessage],
    options: QueryOptions | QueryOptionsDict | None = None,
) -> SyncQuery:
    return SyncQuery(prompt=prompt, options=options)


__all__ = [
    "APIAssistantMessage",
    "APIUserMessage",
    "AbortError",
    "AuthType",
    "CanUseTool",
    "CanUseToolContext",
    "ContentBlock",
    "ControlRequestTimeoutError",
    "PermissionAllowResult",
    "PermissionDenyResult",
    "PermissionMode",
    "PermissionResult",
    "PermissionSuggestion",
    "ProcessExitError",
    "Query",
    "QueryOptions",
    "QueryOptionsDict",
    "QwenSDKError",
    "SDKAssistantMessage",
    "SDKMessage",
    "SDKPartialAssistantMessage",
    "SDKResultMessage",
    "SDKSystemMessage",
    "SDKUserMessage",
    "SyncQuery",
    "ThinkingBlock",
    "TimeoutOptions",
    "TimeoutOptionsDict",
    "ToolResultBlock",
    "ToolUseBlock",
    "Usage",
    "ValidationError",
    "is_control_cancel",
    "is_control_request",
    "is_control_response",
    "is_sdk_assistant_message",
    "is_sdk_partial_assistant_message",
    "is_sdk_result_message",
    "is_sdk_system_message",
    "is_sdk_user_message",
    "query",
    "query_sync",
]
