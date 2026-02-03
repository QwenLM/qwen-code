"""Schema validation for qwen-code SDK options.

Based on TypeScript SDK queryOptionsSchema.ts implementation.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field


@dataclass
class ValidationResult:
    """Result of validation."""

    valid: bool
    errors: List[str] = field(default_factory=list)

    def add_error(self, error: str) -> None:
        """Add an error message."""
        self.valid = False
        self.errors.append(error)


def validate_timeout(timeout: Optional[Dict[str, int]]) -> ValidationResult:
    """Validate timeout configuration.

    Args:
        timeout: Timeout configuration dict.

    Returns:
        ValidationResult indicating success or failure with errors.
    """
    result = ValidationResult(valid=True)

    if timeout is None:
        return result

    valid_keys = {"useTool", "control", "streamClose", "total"}
    for key in timeout.keys():
        if key not in valid_keys:
            result.add_error(f"Invalid timeout key: '{key}'. Valid keys: {valid_keys}")

        if not isinstance(timeout[key], (int, type(None))):
            result.add_error(f"Timeout value for '{key}' must be a number")

    return result


def validate_command(command: List[str]) -> ValidationResult:
    """Validate command configuration.

    Args:
        command: Command to execute.

    Returns:
        ValidationResult indicating success or failure with errors.
    """
    result = ValidationResult(valid=True)

    if not command:
        result.add_error("Command cannot be empty")
        return result

    if not isinstance(command, list):
        result.add_error("Command must be a list of strings")
        return result

    for i, item in enumerate(command):
        if not isinstance(item, str):
            result.add_error(f"Command[{i}] must be a string, got {type(item).__name__}")
        elif not item:
            result.add_error(f"Command[{i}] cannot be empty")

    return result


def validate_mcp_servers(
    mcp_servers: Optional[Dict[str, Any]]
) -> ValidationResult:
    """Validate MCP servers configuration.

    Args:
        mcp_servers: MCP servers configuration dict.

    Returns:
        ValidationResult indicating success or failure with errors.
    """
    result = ValidationResult(valid=True)

    if mcp_servers is None:
        return result

    if not isinstance(mcp_servers, dict):
        result.add_error("mcp_servers must be a dictionary")
        return result

    for server_name, server_config in mcp_servers.items():
        if not isinstance(server_name, str):
            result.add_error("MCP server name must be a string")

        if not isinstance(server_config, dict):
            result.add_error(f"Server '{server_name}' config must be a dictionary")
            continue

        # Check for required fields
        if "command" not in server_config and "url" not in server_config:
            result.add_error(
                f"Server '{server_name}' must have either 'command' or 'url'"
            )

    return result


def validate_agents(agents: Optional[List[Dict[str, Any]]]) -> ValidationResult:
    """Validate agents configuration.

    Args:
        agents: List of agent configurations.

    Returns:
        ValidationResult indicating success or failure with errors.
    """
    result = ValidationResult(valid=True)

    if agents is None:
        return result

    if not isinstance(agents, list):
        result.add_error("agents must be a list")
        return result

    for i, agent in enumerate(agents):
        if not isinstance(agent, dict):
            result.add_error(f"agents[{i}] must be a dictionary")
            continue

        # Agent should have a name or identifier
        if "name" not in agent and "id" not in agent:
            result.add_error(f"agents[{i}] must have 'name' or 'id' field")

    return result


def validate_create_query_options(
    options: Dict[str, Any]
) -> ValidationResult:
    """Validate CreateQueryOptions.

    Based on TypeScript SDK validateCreateQueryOptions function.

    Args:
        options: Options to validate.

    Returns:
        ValidationResult indicating success or failure with errors.
    """
    result = ValidationResult(valid=True)

    # Required fields
    if "command" not in options:
        result.add_error("Missing required field: 'command'")
    else:
        cmd_result = validate_command(options["command"])
        result.errors.extend(cmd_result.errors)

    # Optional fields validation
    if "timeout" in options:
        timeout_result = validate_timeout(options["timeout"])
        result.errors.extend(timeout_result.errors)

    if "mcp_servers" in options:
        mcp_result = validate_mcp_servers(options["mcp_servers"])
        result.errors.extend(mcp_result.errors)

    if "agents" in options:
        agents_result = validate_agents(options["agents"])
        result.errors.extend(agents_result.errors)

    # Validate env if present
    if "env" in options and options["env"] is not None:
        if not isinstance(options["env"], dict):
            result.add_error("'env' must be a dictionary")
        else:
            for key, value in options["env"].items():
                if not isinstance(key, str):
                    result.add_error(f"env key must be a string, got {type(key).__name__}")
                if not isinstance(value, str):
                    result.add_error(
                        f"env value for '{key}' must be a string, got {type(value).__name__}"
                    )

    # Validate cwd if present
    if "cwd" in options and options["cwd"] is not None:
        if not isinstance(options["cwd"], str):
            result.add_error("'cwd' must be a string")

    # Validate abort_controller if present
    if "abort_controller" in options and options["abort_controller"] is not None:
        from .transport import AbortController
        if not isinstance(options["abort_controller"], AbortController):
            result.add_error("'abort_controller' must be an AbortController instance")

    # Update valid flag based on errors
    result.valid = len(result.errors) == 0

    return result


# Alias for convenience
validate_options = validate_create_query_options


__all__ = [
    "ValidationResult",
    "validate_timeout",
    "validate_command",
    "validate_mcp_servers",
    "validate_agents",
    "validate_create_query_options",
    "validate_options",
]
