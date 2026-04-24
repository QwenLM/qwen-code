"""Tests for protocol types."""

import pytest

from qwen_code.protocol import (
    # Enums
    ContentBlockType,
    MessageType,
    ControlRequestType,
    ResultSubtype,
    PermissionMode,
    # Type Guards
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
    # Classes
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessageSuccess,
    SDKResultMessageError,
    # Config types
    SubagentConfig,
    ModelConfig,
    RunConfig,
)


class TestContentBlockType:
    """Tests for ContentBlockType enum."""

    def test_values(self) -> None:
        """Test enum values."""
        assert ContentBlockType.TEXT.value == "text"
        assert ContentBlockType.THINKING.value == "thinking"
        assert ContentBlockType.TOOL_USE.value == "tool_use"
        assert ContentBlockType.TOOL_RESULT.value == "tool_result"


class TestMessageType:
    """Tests for MessageType enum."""

    def test_values(self) -> None:
        """Test enum values."""
        assert MessageType.USER.value == "user"
        assert MessageType.ASSISTANT.value == "assistant"
        assert MessageType.SYSTEM.value == "system"
        assert MessageType.RESULT.value == "result"
        assert MessageType.STREAM_EVENT.value == "stream_event"


class TestControlRequestType:
    """Tests for ControlRequestType enum."""

    def test_values(self) -> None:
        """Test enum values."""
        assert ControlRequestType.INITIALIZE.value == "initialize"
        assert ControlRequestType.INTERRUPT.value == "interrupt"
        assert ControlRequestType.CAN_USE_TOOL.value == "can_use_tool"
        assert ControlRequestType.SET_PERMISSION_MODE.value == "set_permission_mode"


class TestTextBlock:
    """Tests for TextBlock."""

    def test_default_values(self) -> None:
        """Test default values."""
        block = TextBlock()
        assert block.type == "text"
        assert block.text == ""
        assert block.annotations is None

    def test_with_values(self) -> None:
        """Test with custom values."""
        block = TextBlock(
            text="Hello, world!",
            annotations=[{"type": "bold", "value": "true"}]
        )
        assert block.text == "Hello, world!"
        assert len(block.annotations) == 1


class TestThinkingBlock:
    """Tests for ThinkingBlock."""

    def test_default_values(self) -> None:
        """Test default values."""
        block = ThinkingBlock()
        assert block.type == "thinking"
        assert block.thinking == ""
        assert block.signature is None

    def test_with_values(self) -> None:
        """Test with custom values."""
        block = ThinkingBlock(
            thinking="Let me think about this...",
            signature="sig123"
        )
        assert block.thinking == "Let me think about this..."
        assert block.signature == "sig123"


class TestToolUseBlock:
    """Tests for ToolUseBlock."""

    def test_default_values(self) -> None:
        """Test default values."""
        block = ToolUseBlock()
        assert block.type == "tool_use"
        assert block.id == ""
        assert block.name == ""
        assert block.input == {}

    def test_with_values(self) -> None:
        """Test with custom values."""
        block = ToolUseBlock(
            id="tool-123",
            name="read_file",
            input={"path": "/test/file.txt"}
        )
        assert block.id == "tool-123"
        assert block.name == "read_file"
        assert block.input["path"] == "/test/file.txt"


class TestToolResultBlock:
    """Tests for ToolResultBlock."""

    def test_default_values(self) -> None:
        """Test default values."""
        block = ToolResultBlock()
        assert block.type == "tool_result"
        assert block.tool_use_id == ""
        assert block.content is None
        assert block.is_error is False

    def test_with_values(self) -> None:
        """Test with custom values."""
        block = ToolResultBlock(
            tool_use_id="tool-123",
            content="File content here",
            is_error=False
        )
        assert block.tool_use_id == "tool-123"
        assert block.content == "File content here"
        assert block.is_error is False


class TestSDKUserMessage:
    """Tests for SDKUserMessage."""

    def test_default_values(self) -> None:
        """Test default values."""
        msg = SDKUserMessage()
        assert msg.type == "user"
        assert msg.session_id == ""
        assert msg.message.role == "user"
        assert msg.parent_tool_use_id is None

    def test_with_values(self) -> None:
        """Test with custom values."""
        msg = SDKUserMessage(
            uuid="uuid-123",
            session_id="session-456",
            parent_tool_use_id="parent-789"
        )
        assert msg.uuid == "uuid-123"
        assert msg.session_id == "session-456"
        assert msg.parent_tool_use_id == "parent-789"


class TestSDKAssistantMessage:
    """Tests for SDKAssistantMessage."""

    def test_default_values(self) -> None:
        """Test default values."""
        msg = SDKAssistantMessage()
        assert msg.type == "assistant"
        assert msg.session_id == ""
        assert msg.message.role == "assistant"

    def test_with_values(self) -> None:
        """Test with custom values."""
        msg = SDKAssistantMessage(
            uuid="uuid-123",
            session_id="session-456"
        )
        assert msg.uuid == "uuid-123"
        assert msg.session_id == "session-456"


class TestSDKSystemMessage:
    """Tests for SDKSystemMessage."""

    def test_default_values(self) -> None:
        """Test default values."""
        msg = SDKSystemMessage()
        assert msg.type == "system"
        assert msg.subtype == ""
        assert msg.session_id == ""

    def test_with_values(self) -> None:
        """Test with custom values."""
        msg = SDKSystemMessage(
            subtype="session_start",
            uuid="uuid-123",
            session_id="session-456",
            cwd="/home/user",
            tools=["read_file", "write_file"]
        )
        assert msg.subtype == "session_start"
        assert msg.cwd == "/home/user"
        assert "read_file" in msg.tools


class TestSDKResultMessageSuccess:
    """Tests for SDKResultMessageSuccess."""

    def test_default_values(self) -> None:
        """Test default values."""
        msg = SDKResultMessageSuccess()
        assert msg.type == "result"
        assert msg.subtype == "success"
        assert msg.is_error is False
        assert msg.result == ""

    def test_with_values(self) -> None:
        """Test with custom values."""
        msg = SDKResultMessageSuccess(
            uuid="uuid-123",
            session_id="session-456",
            result="Task completed",
            duration_ms=1500
        )
        assert msg.result == "Task completed"
        assert msg.duration_ms == 1500


class TestSDKResultMessageError:
    """Tests for SDKResultMessageError."""

    def test_default_values(self) -> None:
        """Test default values."""
        msg = SDKResultMessageError()
        assert msg.type == "result"
        assert msg.is_error is True
        assert msg.error is None

    def test_with_values(self) -> None:
        """Test with custom values."""
        msg = SDKResultMessageError(
            uuid="uuid-123",
            session_id="session-456",
            subtype="error_max_turns",
            error={"type": "timeout", "message": "Task timed out"}
        )
        assert msg.subtype == "error_max_turns"
        assert msg.error["message"] == "Task timed out"


class TestIsSdkUserMessage:
    """Tests for is_sdk_user_message function."""

    def test_returns_true_for_valid_message(self) -> None:
        """Test that function returns True for valid message."""
        msg = {"type": "user", "message": {}}
        assert is_sdk_user_message(msg) is True

    def test_returns_false_for_invalid_message(self) -> None:
        """Test that function returns False for invalid message."""
        assert is_sdk_user_message({"type": "assistant"}) is False
        assert is_sdk_user_message({}) is False
        assert is_sdk_user_message(None) is False


class TestIsSdkAssistantMessage:
    """Tests for is_sdk_assistant_message function."""

    def test_returns_true_for_valid_message(self) -> None:
        """Test that function returns True for valid message."""
        msg = {
            "type": "assistant",
            "uuid": "uuid-123",
            "message": {},
            "session_id": "session-456",
            "parent_tool_use_id": None
        }
        assert is_sdk_assistant_message(msg) is True

    def test_returns_false_for_invalid_message(self) -> None:
        """Test that function returns False for invalid message."""
        assert is_sdk_assistant_message({"type": "user"}) is False
        assert is_sdk_assistant_message({"type": "assistant"}) is False


class TestIsSdkSystemMessage:
    """Tests for is_sdk_system_message function."""

    def test_returns_true_for_valid_message(self) -> None:
        """Test that function returns True for valid message."""
        msg = {
            "type": "system",
            "subtype": "session_start",
            "uuid": "uuid-123",
            "session_id": "session-456"
        }
        assert is_sdk_system_message(msg) is True

    def test_returns_false_for_invalid_message(self) -> None:
        """Test that function returns False for invalid message."""
        assert is_sdk_system_message({"type": "user"}) is False


class TestIsSdkResultMessage:
    """Tests for is_sdk_result_message function."""

    def test_returns_true_for_valid_message(self) -> None:
        """Test that function returns True for valid message."""
        msg = {
            "type": "result",
            "subtype": "success",
            "uuid": "uuid-123",
            "session_id": "session-456",
            "duration_ms": 100,
            "is_error": False
        }
        assert is_sdk_result_message(msg) is True

    def test_returns_false_for_invalid_message(self) -> None:
        """Test that function returns False for invalid message."""
        assert is_sdk_result_message({"type": "user"}) is False


class TestIsControlRequest:
    """Tests for is_control_request function."""

    def test_returns_true_for_valid_request(self) -> None:
        """Test that function returns True for valid request."""
        msg = {
            "type": "control_request",
            "request_id": "req-123",
            "request": {}
        }
        assert is_control_request(msg) is True

    def test_returns_false_for_invalid_request(self) -> None:
        """Test that function returns False for invalid request."""
        assert is_control_request({"type": "control_response"}) is False


class TestIsControlResponse:
    """Tests for is_control_response function."""

    def test_returns_true_for_valid_response(self) -> None:
        """Test that function returns True for valid response."""
        msg = {
            "type": "control_response",
            "response": {}
        }
        assert is_control_response(msg) is True

    def test_returns_false_for_invalid_response(self) -> None:
        """Test that function returns False for invalid response."""
        assert is_control_response({"type": "control_request"}) is False


class TestIsControlCancel:
    """Tests for is_control_cancel function."""

    def test_returns_true_for_valid_cancel(self) -> None:
        """Test that function returns True for valid cancel."""
        msg = {
            "type": "control_cancel_request",
            "request_id": "req-123"
        }
        assert is_control_cancel(msg) is True

    def test_returns_false_for_invalid_cancel(self) -> None:
        """Test that function returns False for invalid cancel."""
        assert is_control_cancel({"type": "control_request"}) is False


class TestContentBlockTypeGuards:
    """Tests for content block type guards."""

    def test_is_text_block(self) -> None:
        """Test is_text_block function."""
        assert is_text_block({"type": "text"}) is True
        assert is_text_block({"type": "tool_use"}) is False
        assert is_text_block(None) is False

    def test_is_thinking_block(self) -> None:
        """Test is_thinking_block function."""
        assert is_thinking_block({"type": "thinking"}) is True
        assert is_thinking_block({"type": "text"}) is False

    def test_is_tool_use_block(self) -> None:
        """Test is_tool_use_block function."""
        assert is_tool_use_block({"type": "tool_use"}) is True
        assert is_tool_use_block({"type": "text"}) is False

    def test_is_tool_result_block(self) -> None:
        """Test is_tool_result_block function."""
        assert is_tool_result_block({"type": "tool_result"}) is True
        assert is_tool_result_block({"type": "text"}) is False


class TestSubagentConfig:
    """Tests for SubagentConfig dataclass."""

    def test_default_config(self) -> None:
        """Test default SubagentConfig."""
        config = SubagentConfig()

        assert config.name == ""
        assert config.description == ""
        assert config.tools is None
        assert config.system_prompt == ""
        assert config.level == "session"

    def test_custom_config(self) -> None:
        """Test custom SubagentConfig."""
        config = SubagentConfig(
            name="file-agent",
            description="Handles file operations",
            tools=["read_file", "write_file"],
            system_prompt="You are a file agent.",
            level="session",
        )

        assert config.name == "file-agent"
        assert config.tools == ["read_file", "write_file"]


class TestModelConfig:
    """Tests for ModelConfig dataclass."""

    def test_default_config(self) -> None:
        """Test default ModelConfig."""
        config = ModelConfig()

        assert config.model == ""
        assert config.temperature is None
        assert config.max_tokens is None

    def test_custom_config(self) -> None:
        """Test custom ModelConfig."""
        config = ModelConfig(
            model="qwen-turbo",
            temperature=0.7,
            max_tokens=1000,
            top_p=0.9,
        )

        assert config.model == "qwen-turbo"
        assert config.temperature == 0.7
        assert config.max_tokens == 1000


class TestRunConfig:
    """Tests for RunConfig dataclass."""

    def test_default_config(self) -> None:
        """Test default RunConfig."""
        config = RunConfig()

        assert config.temperature is None
        assert config.max_tokens is None
        assert config.model is None
        assert config.max_turns is None
        assert config.enable_memories is False
        assert config.disable_memories is False

    def test_custom_config(self) -> None:
        """Test custom RunConfig."""
        config = RunConfig(
            temperature=0.5,
            max_tokens=2000,
            model="qwen-plus",
            max_turns=10,
            enable_memories=True,
        )

        assert config.temperature == 0.5
        assert config.enable_memories is True
