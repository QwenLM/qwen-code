"""Tests for configuration types.

Based on TypeScript SDK types.ts tests.
"""

import pytest

from qwen_code.config import (
    McpAuthConfig,
    McpServerConfig,
    CLIMcpServerConfig,
    SdkMcpServerConfig,
    McpServerConfigType,
    CanUseTool,
    PermissionModeType,
    PermissionResult,
    is_sdk_mcp_server_config,
    is_mcp_server_config,
    is_permission_mode,
)


class TestMcpAuthConfig:
    """Tests for McpAuthConfig dataclass."""

    def test_default_config(self):
        """Test default configuration."""
        config = McpAuthConfig()

        assert config.type == ""
        assert config.endpoint is None
        assert config.client_id is None
        assert config.client_secret is None

    def test_custom_config(self):
        """Test custom configuration."""
        config = McpAuthConfig(
            type="bearer",
            endpoint="https://auth.example.com",
            client_id="client123",
            client_secret="secret456",
        )

        assert config.type == "bearer"
        assert config.endpoint == "https://auth.example.com"
        assert config.client_id == "client123"


class TestMcpServerConfig:
    """Tests for McpServerConfig dataclass."""

    def test_default_config(self):
        """Test default configuration."""
        config = McpServerConfig()

        assert config.command is None
        assert config.url is None
        assert config.trust is False

    def test_custom_config(self):
        """Test custom configuration."""
        config = McpServerConfig(
            command="npx",
            args=["-y", "mcp-server"],
            env={"KEY": "value"},
            url="http://localhost:3000",
            timeout=30,
            trust=True,
        )

        assert config.command == "npx"
        assert config.url == "http://localhost:3000"
        assert config.trust is True


class TestCLIMcpServerConfig:
    """Tests for CLIMcpServerConfig dataclass."""

    def test_default_config(self):
        """Test default configuration."""
        config = CLIMcpServerConfig()

        assert config.command == []
        assert config.env is None

    def test_custom_config(self):
        """Test custom configuration."""
        config = CLIMcpServerConfig(
            command=["npx", "-y", "mcp-server"],
            env={"VAR": "value"},
            cwd="/path/to/server",
        )

        assert config.command == ["npx", "-y", "mcp-server"]
        assert config.env["VAR"] == "value"


class TestSdkMcpServerConfig:
    """Tests for SdkMcpServerConfig dataclass."""

    def test_default_config(self):
        """Test default configuration."""
        config = SdkMcpServerConfig()

        assert config.type == "sdk"
        assert config.name == ""

    def test_custom_config(self):
        """Test custom configuration."""
        config = SdkMcpServerConfig(
            type="sdk",
            name="my-server",
        )

        assert config.type == "sdk"
        assert config.name == "my-server"


class TestIsSdkMcpServerConfig:
    """Tests for is_sdk_mcp_server_config function."""

    def test_valid_sdk_config(self):
        """Test valid SDK MCP server config."""
        config = {
            "type": "sdk",
            "name": "my-server",
        }

        assert is_sdk_mcp_server_config(config) is True

    def test_missing_type(self):
        """Test config without type."""
        config = {
            "name": "my-server",
        }

        assert is_sdk_mcp_server_config(config) is False

    def test_wrong_type(self):
        """Test config with wrong type."""
        config = {
            "type": "cli",
            "name": "my-server",
        }

        assert is_sdk_mcp_server_config(config) is False

    def test_missing_name(self):
        """Test config without name."""
        config = {
            "type": "sdk",
        }

        assert is_sdk_mcp_server_config(config) is False

    def test_not_a_dict(self):
        """Test with non-dict input."""
        assert is_sdk_mcp_server_config("not a dict") is False
        assert is_sdk_mcp_server_config(None) is False
        assert is_sdk_mcp_server_config(123) is False


class TestIsMcpServerConfig:
    """Tests for is_mcp_server_config function."""

    def test_cli_config(self):
        """Test CLI MCP server config."""
        config = {
            "command": ["npx", "server"],
        }

        assert is_mcp_server_config(config) is True

    def test_url_config(self):
        """Test URL-based MCP server config."""
        config = {
            "url": "http://localhost:3000",
        }

        assert is_mcp_server_config(config) is True

    def test_sdk_config(self):
        """Test SDK MCP server config."""
        config = {
            "type": "sdk",
            "name": "my-server",
        }

        assert is_mcp_server_config(config) is True

    def test_invalid_config(self):
        """Test invalid config."""
        config = {
            "description": "A server",
        }

        assert is_mcp_server_config(config) is False

    def test_not_a_dict(self):
        """Test with non-dict input."""
        assert is_mcp_server_config("not a dict") is False


class TestIsPermissionMode:
    """Tests for is_permission_mode function."""

    def test_valid_modes(self):
        """Test valid permission modes."""
        assert is_permission_mode("default") is True
        assert is_permission_mode("plan") is True
        assert is_permission_mode("auto-edit") is True
        assert is_permission_mode("yolo") is True

    def test_invalid_mode(self):
        """Test invalid permission mode."""
        assert is_permission_mode("invalid") is False
        assert is_permission_mode("") is False

    def test_not_a_string(self):
        """Test with non-string input."""
        assert is_permission_mode(123) is False
        assert is_permission_mode(None) is False
        assert is_permission_mode(["default"]) is False


class TestCanUseTool:
    """Tests for CanUseTool dataclass."""

    def test_default_config(self):
        """Test default configuration."""
        tool = CanUseTool()

        assert tool.name == ""
        assert tool.allowed is True
        assert tool.denied_message is None

    def test_custom_config(self):
        """Test custom configuration."""
        tool = CanUseTool(
            name="read_file",
            allowed=False,
            denied_message="Access denied",
        )

        assert tool.name == "read_file"
        assert tool.allowed is False
        assert tool.denied_message == "Access denied"


class TestPermissionResult:
    """Tests for PermissionResult dataclass."""

    def test_default_result(self):
        """Test default permission result."""
        result = PermissionResult()

        assert result.behavior == "allow"
        assert result.updated_input is None
        assert result.message is None
        assert result.interrupt is False

    def test_allow_result(self):
        """Test allowing a permission."""
        result = PermissionResult(
            behavior="allow",
            message="Permission granted",
        )

        assert result.behavior == "allow"

    def test_deny_result(self):
        """Test denying a permission."""
        result = PermissionResult(
            behavior="deny",
            message="Permission denied",
        )

        assert result.behavior == "deny"

    def test_modify_result(self):
        """Test modifying input."""
        result = PermissionResult(
            behavior="modify",
            updated_input={"new_key": "new_value"},
        )

        assert result.behavior == "modify"
        assert result.updated_input == {"new_key": "new_value"}


class TestPermissionModeType:
    """Tests for PermissionModeType type alias."""

    def test_valid_modes(self):
        """Test that valid modes are accepted."""
        modes: PermissionModeType = ["default", "plan", "auto-edit", "yolo"]

        assert len(modes) == 4


class TestConfigIntegration:
    """Integration tests for config types."""

    def test_nested_config(self):
        """Test nested configuration structures."""
        auth = McpAuthConfig(
            type="bearer",
            token_url="https://auth.example.com/token",
        )

        server = McpServerConfig(
            command="npx",
            args=["-y", "mcp-server"],
            auth=auth,
        )

        assert server.auth.type == "bearer"

    def test_sdk_config_with_tools(self):
        """Test SDK config with tool permissions."""
        tools = [
            CanUseTool(name="read_file", allowed=True),
            CanUseTool(name="write_file", allowed=False),
        ]

        assert len(tools) == 2
        assert tools[0].name == "read_file"
        assert tools[1].allowed is False
