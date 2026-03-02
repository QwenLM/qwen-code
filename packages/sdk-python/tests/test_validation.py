"""Tests for validation utilities.

Based on TypeScript SDK queryOptionsSchema.ts tests.
"""

import pytest

from qwen_code.validation import (
    ValidationResult,
    validate_timeout,
    validate_command,
    validate_mcp_servers,
    validate_agents,
    validate_create_query_options,
    validate_options,
)


class TestValidationResult:
    """Tests for ValidationResult class."""

    def test_valid_result(self):
        """Test a valid result."""
        result = ValidationResult(valid=True)

        assert result.valid is True
        assert result.errors == []

    def test_invalid_result(self):
        """Test an invalid result."""
        result = ValidationResult(valid=False)
        result.add_error("Test error")

        assert result.valid is False
        assert "Test error" in result.errors

    def test_add_error_makes_invalid(self):
        """Test that adding an error makes the result invalid."""
        result = ValidationResult(valid=True)
        result.add_error("Error 1")

        assert result.valid is False
        assert len(result.errors) == 1

    def test_multiple_errors(self):
        """Test adding multiple errors."""
        result = ValidationResult(valid=True)
        result.add_error("Error 1")
        result.add_error("Error 2")

        assert result.valid is False
        assert len(result.errors) == 2


class TestValidateTimeout:
    """Tests for validate_timeout function."""

    def test_none_timeout(self):
        """Test with None timeout."""
        result = validate_timeout(None)

        assert result.valid is True

    def test_empty_timeout(self):
        """Test with empty timeout dict."""
        result = validate_timeout({})

        assert result.valid is True

    def test_valid_timeout_keys(self):
        """Test with valid timeout keys."""
        result = validate_timeout({
            "useTool": 30000,
            "control": 60000,
            "streamClose": 60000,
            "total": 300000,
        })

        assert result.valid is True

    def test_invalid_timeout_key(self):
        """Test with invalid timeout key."""
        result = validate_timeout({
            "invalidKey": 10000,
        })

        assert result.valid is False
        assert any("invalidKey" in error for error in result.errors)

    def test_invalid_timeout_value(self):
        """Test with invalid timeout value type."""
        result = validate_timeout({
            "useTool": "not_a_number",
        })

        assert result.valid is False
        assert any("number" in error.lower() for error in result.errors)


class TestValidateCommand:
    """Tests for validate_command function."""

    def test_empty_command(self):
        """Test with empty command list."""
        result = validate_command([])

        assert result.valid is False
        assert any("empty" in error.lower() for error in result.errors)

    def test_not_a_list(self):
        """Test with non-list command."""
        result = validate_command("not a list")

        assert result.valid is False
        assert any("list" in error.lower() for error in result.errors)

    def test_valid_command(self):
        """Test with valid command."""
        result = validate_command(["qwen-code", "sdk"])

        assert result.valid is True

    def test_command_with_empty_string(self):
        """Test command with empty string element."""
        result = validate_command(["qwen-code", ""])

        assert result.valid is False
        assert any("empty" in error.lower() for error in result.errors)

    def test_command_with_non_string(self):
        """Test command with non-string element."""
        result = validate_command(["qwen-code", 123])

        assert result.valid is False
        assert any("string" in error.lower() for error in result.errors)


class TestValidateMcpServers:
    """Tests for validate_mcp_servers function."""

    def test_none_mcp_servers(self):
        """Test with None mcp_servers."""
        result = validate_mcp_servers(None)

        assert result.valid is True

    def test_empty_mcp_servers(self):
        """Test with empty mcp_servers dict."""
        result = validate_mcp_servers({})

        assert result.valid is True

    def test_not_a_dict(self):
        """Test with non-dict mcp_servers."""
        result = validate_mcp_servers("not a dict")

        assert result.valid is False
        assert any("dictionary" in error.lower() for error in result.errors)

    def test_valid_mcp_server_with_command(self):
        """Test valid MCP server with command."""
        result = validate_mcp_servers({
            "server1": {
                "command": "npx",
                "args": ["-y", "some-server"],
            }
        })

        assert result.valid is True

    def test_valid_mcp_server_with_url(self):
        """Test valid MCP server with URL."""
        result = validate_mcp_servers({
            "server1": {
                "url": "http://localhost:3000",
            }
        })

        assert result.valid is True

    def test_invalid_mcp_server_missing_command_and_url(self):
        """Test MCP server without command or URL."""
        result = validate_mcp_servers({
            "server1": {
                "description": "A server",
            }
        })

        assert result.valid is False
        assert any("command" in error.lower() or "url" in error.lower() for error in result.errors)

    def test_mcp_server_name_not_string(self):
        """Test MCP server with non-string name."""
        result = validate_mcp_servers({
            123: {
                "command": "npx",
            }
        })

        assert result.valid is False
        assert any("name" in error.lower() for error in result.errors)

    def test_mcp_server_config_not_dict(self):
        """Test MCP server with non-dict config."""
        result = validate_mcp_servers({
            "server1": "not a dict",
        })

        assert result.valid is False
        assert any("dictionary" in error.lower() for error in result.errors)


class TestValidateAgents:
    """Tests for validate_agents function."""

    def test_none_agents(self):
        """Test with None agents."""
        result = validate_agents(None)

        assert result.valid is True

    def test_empty_agents(self):
        """Test with empty agents list."""
        result = validate_agents([])

        assert result.valid is True

    def test_not_a_list(self):
        """Test with non-list agents."""
        result = validate_agents("not a list")

        assert result.valid is False
        assert any("list" in error.lower() for error in result.errors)

    def test_valid_agent_with_name(self):
        """Test valid agent with name."""
        result = validate_agents([
            {"name": "agent1", "description": "An agent"}
        ])

        assert result.valid is True

    def test_valid_agent_with_id(self):
        """Test valid agent with id."""
        result = validate_agents([
            {"id": "agent1", "description": "An agent"}
        ])

        assert result.valid is True

    def test_invalid_agent_missing_name_and_id(self):
        """Test agent without name or id."""
        result = validate_agents([
            {"description": "An agent"}
        ])

        assert result.valid is False
        assert any("name" in error.lower() or "id" in error.lower() for error in result.errors)

    def test_agent_not_dict(self):
        """Test agent that is not a dict."""
        result = validate_agents(["not a dict"])

        assert result.valid is False
        assert any("dictionary" in error.lower() for error in result.errors)


class TestValidateCreateQueryOptions:
    """Tests for validate_create_query_options function."""

    def test_missing_command(self):
        """Test with missing command."""
        result = validate_create_query_options({})

        assert result.valid is False
        assert any("command" in error.lower() for error in result.errors)

    def test_valid_options(self):
        """Test with valid options."""
        result = validate_create_query_options({
            "command": ["qwen-code", "sdk"],
        })

        assert result.valid is True

    def test_invalid_command_in_options(self):
        """Test with invalid command in options."""
        result = validate_create_query_options({
            "command": [],
        })

        # An empty command list is invalid
        assert result.valid is False
        assert any("command" in error.lower() for error in result.errors)

    def test_invalid_timeout_in_options(self):
        """Test with invalid timeout in options."""
        result = validate_create_query_options({
            "command": ["qwen-code", "sdk"],
            "timeout": {"invalid": "value"},
        })

        # Invalid timeout should have errors
        assert result.valid is False
        assert len(result.errors) > 0

    def test_invalid_env_in_options(self):
        """Test with invalid env in options."""
        result = validate_create_query_options({
            "command": ["qwen-code", "sdk"],
            "env": "not a dict",
        })

        assert result.valid is False
        assert any("env" in error.lower() for error in result.errors)

    def test_invalid_cwd_in_options(self):
        """Test with invalid cwd in options."""
        result = validate_create_query_options({
            "command": ["qwen-code", "sdk"],
            "cwd": 123,
        })

        assert result.valid is False
        assert any("cwd" in error.lower() for error in result.errors)

    def test_valid_complex_options(self):
        """Test with valid complex options."""
        result = validate_create_query_options({
            "command": ["qwen-code", "sdk"],
            "cwd": "/home/user",
            "env": {"KEY": "value"},
            "timeout": {"useTool": 30000},
            "mcp_servers": {
                "server1": {"command": "npx", "args": ["-y", "server"]}
            },
            "agents": [
                {"name": "agent1", "description": "An agent"}
            ],
        })

        assert result.valid is True


class TestValidateOptionsAlias:
    """Tests for validate_options alias."""

    def test_validate_options_is_alias(self):
        """Test that validate_options is an alias for validate_create_query_options."""
        result = validate_options({"command": ["qwen-code", "sdk"]})

        assert result.valid is True
