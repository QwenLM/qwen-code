"""Tests for query factory functions.

Based on TypeScript SDK createQuery tests.
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock
import asyncio
import sys

# Import the module using importlib to avoid name conflicts
from importlib import import_module

# Get the module
create_query_module = import_module("qwen_code.create_query")

from qwen_code.create_query import (
    CreateQueryOptions,
    QueryResult,
    query,
)


class TestCreateQueryOptions:
    """Tests for CreateQueryOptions dataclass."""

    def test_default_options(self):
        """Test default CreateQueryOptions."""
        options = CreateQueryOptions(command=["qwen", "sdk"])

        assert options.command == ["qwen", "sdk"]
        assert options.cwd is None
        assert options.env is None
        assert options.abort_controller is None
        assert options.debug is False
        assert options.can_use_tool is None
        assert options.timeout is None
        assert options.streaming is True
        assert options.single_turn is False
        assert options.mcp_servers is None
        assert options.agents is None

    def test_custom_options(self):
        """Test custom CreateQueryOptions."""
        options = CreateQueryOptions(
            command=["qwen-code", "sdk", "--channel=SDK"],
            cwd="/home/user",
            env={"KEY": "value"},
            debug=True,
            streaming=True,
            single_turn=False,
            mcp_servers={"server1": {"command": "npx"}},
            agents=[{"name": "agent1"}],
        )

        assert options.command == ["qwen-code", "sdk", "--channel=SDK"]
        assert options.cwd == "/home/user"
        assert options.debug is True
        assert options.mcp_servers["server1"]["command"] == "npx"


class TestQueryResult:
    """Tests for QueryResult dataclass."""

    def test_success_result(self):
        """Test successful query result."""
        result = QueryResult(
            result="Hello, world!",
            usage={"input_tokens": 10, "output_tokens": 20},
            num_turns=1,
            duration_ms=1000,
        )

        assert result.result == "Hello, world!"
        assert result.is_error is False
        assert result.error is None

    def test_error_result(self):
        """Test error query result."""
        result = QueryResult(
            result="",
            usage={},
            num_turns=0,
            duration_ms=0,
            is_error=True,
            error="Something went wrong",
        )

        assert result.is_error is True
        assert result.error == "Something went wrong"


class TestQueryFunction:
    """Tests for query() convenience function."""

    def test_query_with_string_message(self):
        """Test query with string message returns async iterator."""
        with patch.object(create_query_module, "Query") as MockQuery:
            mock_query = MagicMock()
            MockQuery.return_value = mock_query
            mock_query.initialize = AsyncMock()
            mock_query.stream_input = AsyncMock()

            result = query("Hello!")

            # Should return an async iterable
            assert hasattr(result, "__aiter__")
            assert hasattr(result, "__anext__")

            # Should create Query with correct options
            MockQuery.assert_called_once()

            # Query should be initialized
            mock_query.initialize.assert_called_once()
            mock_query.stream_input.assert_called_once()

            # Check that the message was converted correctly
            call_args = mock_query.stream_input.call_args
            # stream_input now receives an async generator

    def test_query_with_message_list(self):
        """Test query with message list."""
        with patch.object(create_query_module, "Query") as MockQuery:
            mock_query = MagicMock()
            MockQuery.return_value = mock_query
            mock_query.initialize = AsyncMock()
            mock_query.stream_input = AsyncMock()

            messages = [
                {"type": "user", "message": {"role": "user", "content": "Hello!"}},
                {"type": "user", "message": {"role": "user", "content": "How are you?"}},
            ]

            result = query(messages)

            assert hasattr(result, "__aiter__")
            mock_query.stream_input.assert_called_once()

    def test_query_with_options(self):
        """Test query with custom options."""
        with patch.object(create_query_module, "Query") as MockQuery:
            mock_query = MagicMock()
            MockQuery.return_value = mock_query
            mock_query.initialize = AsyncMock()
            mock_query.stream_input = AsyncMock()

            options = CreateQueryOptions(command=["qwen-code", "sdk", "--debug"])
            result = query("Hello!", options)

            assert hasattr(result, "__aiter__")

            # Check that custom options were used
            call_args = MockQuery.call_args
            passed_options = call_args[0][0]
            assert passed_options.command == ["qwen-code", "sdk", "--debug"]

    def test_query_default_options(self):
        """Test query with default options."""
        with patch.object(create_query_module, "Query") as MockQuery:
            mock_query = MagicMock()
            MockQuery.return_value = mock_query
            mock_query.initialize = AsyncMock()
            mock_query.stream_input = AsyncMock()

            result = query("Hello!")

            # Check default options
            call_args = MockQuery.call_args
            passed_options = call_args[0][0]
            assert passed_options.command == ["qwen", "sdk", "--channel=SDK"]

    def test_query_with_permission_callback(self):
        """Test query with permission callback."""
        with patch.object(create_query_module, "Query") as MockQuery:
            mock_query = MagicMock()
            MockQuery.return_value = mock_query
            mock_query.initialize = AsyncMock()
            mock_query.stream_input = AsyncMock()

            def permission_callback(tool_name, input, context):
                from qwen_code import PermissionResult
                return PermissionResult(behavior="allow")

            options = CreateQueryOptions(
                command=["qwen-code", "sdk"],
                can_use_tool=permission_callback,
            )
            result = query("Hello!", options)

            # Check that permission callback was set
            mock_query.set_permission_callback.assert_called_once()


class TestCreateQueryFunction:
    """Tests for create_query() function."""

    @pytest.mark.asyncio
    async def test_create_query(self):
        """Test create_query function."""
        with patch.object(create_query_module, "Query") as MockQuery:
            mock_query = MagicMock()
            MockQuery.return_value = mock_query
            mock_query.initialize = AsyncMock()

            options = CreateQueryOptions(command=["qwen", "sdk"])
            result = await create_query_module.create_query(options)

            MockQuery.assert_called_once()
            mock_query.initialize.assert_called_once()

    @pytest.mark.asyncio
    async def test_create_query_with_permission_callback(self):
        """Test create_query with permission callback."""
        with patch.object(create_query_module, "Query") as MockQuery:
            mock_query = MagicMock()
            MockQuery.return_value = mock_query
            mock_query.initialize = AsyncMock()

            def permission_callback(tool_name, input, context):
                from qwen_code import PermissionResult
                return PermissionResult(behavior="allow")

            options = CreateQueryOptions(
                command=["qwen-code", "sdk"],
                can_use_tool=permission_callback,
            )

            result = await create_query_module.create_query(options)

            mock_query.set_permission_callback.assert_called_once()


class TestRunQueryFunction:
    """Tests for run_query() function."""

    @pytest.mark.asyncio
    async def test_run_query_success(self):
        """Test run_query with successful result."""
        with patch.object(create_query_module, "create_query", new_callable=AsyncMock) as mock_create:
            mock_query = MagicMock()
            mock_create.return_value = mock_query
            mock_query.stream_input = AsyncMock()
            mock_query.close = AsyncMock()

            # Create a mock async generator for iteration
            async def mock_iterate():
                yield {
                    "type": "result",
                    "subtype": "success",
                    "result": "Answer",
                    "usage": {"input_tokens": 10, "output_tokens": 20},
                    "num_turns": 1,
                    "duration_ms": 500,
                    "is_error": False,
                    "uuid": "test-uuid",
                    "session_id": "test-session",
                }

            mock_query.__aiter__ = lambda self: mock_iterate()

            options = CreateQueryOptions(command=["qwen", "sdk"])
            messages = [{"type": "user", "message": {"role": "user", "content": "Hello!"}}]

            result = await create_query_module.run_query(options, messages)

            mock_query.stream_input.assert_called_once()
            mock_query.close.assert_called_once()
            assert result.result == "Answer"

    @pytest.mark.asyncio
    async def test_run_query_error(self):
        """Test run_query with error result."""
        with patch.object(create_query_module, "create_query", new_callable=AsyncMock) as mock_create:
            mock_query = MagicMock()
            mock_create.return_value = mock_query
            mock_query.stream_input = AsyncMock()
            mock_query.close = AsyncMock()

            # Create a mock async generator with no result message
            async def mock_iterate():
                yield {
                    "type": "assistant",
                    "uuid": "test-uuid",
                    "session_id": "test-session",
                }

            mock_query.__aiter__ = lambda self: mock_iterate()

            options = CreateQueryOptions(command=["qwen", "sdk"])
            messages = [{"type": "user", "message": {"role": "user", "content": "Hello!"}}]

            result = await create_query_module.run_query(options, messages)

            mock_query.stream_input.assert_called_once()
            mock_query.close.assert_called_once()
            assert result.is_error is True
