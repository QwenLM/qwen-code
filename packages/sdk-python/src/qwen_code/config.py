"""Configuration types for qwen-code SDK.

Based on TypeScript SDK types.ts implementation.
"""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional, Union
from dataclasses import dataclass, field


# ============================================================================
# Permission Types
# ============================================================================


@dataclass
class McpAuthConfig:
    """MCP authentication configuration."""

    type: str = ""  # 'none' | 'basic' | 'bearer' | 'oauth'
    endpoint: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    scope: Optional[str] = None
    token_url: Optional[str] = None
    refresh_token: Optional[str] = None


@dataclass
class McpServerConfig:
    """MCP server configuration for external servers."""

    command: Optional[str] = None
    args: Optional[list[str]] = None
    env: Optional[Dict[str, str]] = None
    cwd: Optional[str] = None
    url: Optional[str] = None
    http_url: Optional[str] = None
    headers: Optional[Dict[str, str]] = None
    timeout: Optional[int] = None
    trust: bool = False
    description: Optional[str] = None
    auth: Optional[McpAuthConfig] = None


@dataclass
class CLIMcpServerConfig:
    """CLI MCP server configuration."""

    command: list[str] = field(default_factory=list)
    env: Optional[Dict[str, str]] = None
    cwd: Optional[str] = None


@dataclass
class SdkMcpServerConfig:
    """SDK MCP server configuration (for internal SDK servers)."""

    type: Literal["sdk"] = "sdk"
    name: str = ""


McpServerConfigType = Union[McpServerConfig, CLIMcpServerConfig, SdkMcpServerConfig]


# ============================================================================
# Permission Configuration
# ============================================================================


@dataclass
class CanUseTool:
    """Tool permission configuration."""

    name: str = ""
    allowed: bool = True
    denied_message: Optional[str] = None


PermissionModeType = Literal["default", "plan", "auto-edit", "yolo"]


@dataclass
class PermissionResult:
    """Permission result for tool use.

    Based on TypeScript SDK PermissionResult.
    """

    behavior: Literal["allow", "deny", "modify"] = "allow"
    updated_input: Optional[Dict[str, Any]] = None
    message: Optional[str] = None
    interrupt: bool = False


# ============================================================================
# Type Guard Functions
# ============================================================================


def is_sdk_mcp_server_config(config: Any) -> bool:
    """Check if the config is an SDK MCP server config.

    Based on TypeScript SDK isSdkMcpServerConfig function.

    Args:
        config: Configuration object to check.

    Returns:
        True if it's an SDK MCP server config, False otherwise.
    """
    return (
        isinstance(config, dict)
        and config.get("type") == "sdk"
        and "name" in config
    )


def is_mcp_server_config(config: Any) -> bool:
    """Check if the config is an MCP server config.

    Args:
        config: Configuration object to check.

    Returns:
        True if it's an MCP server config, False otherwise.
    """
    if not isinstance(config, dict):
        return False

    # Check for CLI MCP server config
    if "command" in config and isinstance(config["command"], list):
        return True

    # Check for external MCP server config
    if "url" in config or "command" in config:
        return True

    # Check for SDK MCP server config
    if is_sdk_mcp_server_config(config):
        return True

    return False


def is_permission_mode(mode: Any) -> bool:
    """Check if the value is a valid permission mode.

    Args:
        mode: Value to check.

    Returns:
        True if it's a valid permission mode, False otherwise.
    """
    if not isinstance(mode, str):
        return False
    return mode in ["default", "plan", "auto-edit", "yolo"]


__all__ = [
    # Auth Config
    "McpAuthConfig",
    # Server Configs
    "McpServerConfig",
    "CLIMcpServerConfig",
    "SdkMcpServerConfig",
    "McpServerConfigType",
    # Permission Types
    "CanUseTool",
    "PermissionModeType",
    "PermissionResult",
    # Type Guards
    "is_sdk_mcp_server_config",
    "is_mcp_server_config",
    "is_permission_mode",
]
