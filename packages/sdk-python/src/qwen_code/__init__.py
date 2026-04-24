"""qwen_code.

Python SDK for programmatic access to qwen-code CLI.
"""

__version__ = "0.1.0"

# Import modules to ensure all exports are available
from . import api
from . import protocol
from . import transport
from . import utils
from . import cli
from . import logger
from . import validation
from . import config

# Re-export all symbols
from .api import (
    AbortError,
    is_abort_error,
)
from .protocol import (
    ContentBlockType,
    MessageType,
    ControlRequestType,
    ResultSubtype,
    PermissionMode,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
    ContentBlock,
    APIUserMessage,
    APIAssistantMessage,
    Usage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessageSuccess,
    SDKResultMessageError,
    SDKResultMessage,
    SDKPartialAssistantMessage,
    SDKMessage,
    ControlMessage,
    SubagentConfig,
    ModelConfig,
    RunConfig,
    is_sdk_user_message,
    is_sdk_assistant_message,
    is_sdk_system_message,
    is_sdk_result_message,
    is_sdk_partial_assistant_message,
    is_control_request,
    is_control_response,
    is_control_cancel,
    is_text_block,
    is_thinking_block,
    is_tool_use_block,
    is_tool_result_block,
)
from .transport import (
    ProcessTransport,
    ProcessTransportOptions,
    AbortController,
    AbortSignal,
)
from .query import (
    Query,
    QueryOptions,
    PermissionResult,
)
from .create_query import (
    create_query,
    run_query,
    query,
    CreateQueryOptions,
    QueryResult,
)
from .cli import (
    SpawnInfo,
    prepare_spawn_info,
    get_qwen_code_version,
    is_qwen_code_available,
)
from .logger import (
    LogLevel,
    LoggerConfig,
    SdkLogger,
    ScopedLogger,
    get_logger,
    configure_logger,
)
from .validation import (
    ValidationResult,
    validate_timeout,
    validate_command,
    validate_mcp_servers,
    validate_agents,
    validate_create_query_options,
    validate_options,
)
from .config import (
    McpAuthConfig,
    McpServerConfig,
    CLIMcpServerConfig,
    SdkMcpServerConfig,
    McpServerConfigType,
    CanUseTool,
    PermissionModeType,
    PermissionResult as ConfigPermissionResult,
    is_sdk_mcp_server_config,
    is_mcp_server_config,
    is_permission_mode,
)

__all__ = [
    "__version__",
    # Error types
    "AbortError",
    "is_abort_error",
    # Protocol types
    "ContentBlockType",
    "MessageType",
    "ControlRequestType",
    "ResultSubtype",
    "PermissionMode",
    "TextBlock",
    "ThinkingBlock",
    "ToolUseBlock",
    "ToolResultBlock",
    "ContentBlock",
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
    "SDKMessage",
    "ControlMessage",
    # Config types
    "SubagentConfig",
    "ModelConfig",
    "RunConfig",
    # Type guards
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
    # Transport
    "ProcessTransport",
    "ProcessTransportOptions",
    "AbortController",
    "AbortSignal",
    # Query
    "Query",
    "QueryOptions",
    "PermissionResult",
    # Factory functions
    "create_query",
    "run_query",
    "query",
    "CreateQueryOptions",
    "QueryResult",
    # CLI utilities
    "SpawnInfo",
    "prepare_spawn_info",
    "get_qwen_code_version",
    "is_qwen_code_available",
    # Logger
    "LogLevel",
    "LoggerConfig",
    "SdkLogger",
    "ScopedLogger",
    "get_logger",
    "configure_logger",
    # Validation
    "ValidationResult",
    "validate_timeout",
    "validate_command",
    "validate_mcp_servers",
    "validate_agents",
    "validate_create_query_options",
    "validate_options",
    # Config
    "McpAuthConfig",
    "McpServerConfig",
    "CLIMcpServerConfig",
    "SdkMcpServerConfig",
    "McpServerConfigType",
    "CanUseTool",
    "PermissionModeType",
    "PermissionResult",
    "is_sdk_mcp_server_config",
    "is_mcp_server_config",
    "is_permission_mode",
]
