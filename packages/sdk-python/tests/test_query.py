"""Tests for Query class."""

import asyncio
import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from qwen_code.query import Query, QueryOptions, PermissionResult


class TestQueryOptions:
    """Test QueryOptions dataclass."""

    def test_basic_options(self):
        """Test basic QueryOptions creation."""
        options = QueryOptions(command=["test", "cmd"])
        assert options.command == ["test", "cmd"]
        assert options.cwd is None
        assert options.env is None
        assert options.abort_controller is None
        assert options.debug is False
        assert options.timeout is None
        assert options.mcp_servers is None
        assert options.agents is None

    def test_full_options(self):
        """Test QueryOptions with all fields."""
        options = QueryOptions(
            command=["node", "test.js"],
            cwd="/test/path",
            env={"TEST": "value"},
            debug=True,
            timeout={"canUseTool": 30000},
            mcp_servers={"server1": {"url": "http://localhost:3000"}},
            agents=[{"name": "agent1", "config": {}}],
        )
        assert options.command == ["node", "test.js"]
        assert options.cwd == "/test/path"
        assert options.env == {"TEST": "value"}
        assert options.debug is True
        assert options.timeout == {"canUseTool": 30000}
        assert options.mcp_servers == {"server1": {"url": "http://localhost:3000"}}
        assert options.agents == [{"name": "agent1", "config": {}}]


class TestPermissionResult:
    """Test PermissionResult dataclass."""

    def test_allow_result(self):
        """Test allow PermissionResult."""
        result = PermissionResult(behavior="allow")
        assert result.behavior == "allow"
        assert result.updated_input is None
        assert result.message is None
        assert result.interrupt is False

    def test_deny_result(self):
        """Test deny PermissionResult."""
        result = PermissionResult(behavior="deny", message="Not allowed")
        assert result.behavior == "deny"
        assert result.message == "Not allowed"

    def test_allow_with_updated_input(self):
        """Test allow with updated input."""
        result = PermissionResult(
            behavior="allow",
            updated_input={"param": "new_value"},
        )
        assert result.behavior == "allow"
        assert result.updated_input == {"param": "new_value"}

    def test_interrupt_result(self):
        """Test interrupt PermissionResult."""
        result = PermissionResult(behavior="deny", interrupt=True)
        assert result.interrupt is True


class TestQueryTimeoutMethods:
    """Test Query timeout setting methods."""

    @pytest.fixture
    def query(self):
        """Create a Query instance for testing."""
        options = QueryOptions(command=["test"])
        query = Query(options)
        return query

    def test_default_tool_callback_timeout(self, query):
        """Test default tool callback timeout."""
        assert query._tool_callback_timeout == Query.DEFAULT_CAN_USE_TOOL_TIMEOUT

    def test_default_control_request_timeout(self, query):
        """Test default control request timeout."""
        assert query._control_request_timeout == Query.DEFAULT_CONTROL_REQUEST_TIMEOUT

    def test_default_stream_close_timeout(self, query):
        """Test default stream close timeout."""
        assert query._stream_close_timeout == Query.DEFAULT_STREAM_CLOSE_TIMEOUT

    def test_set_tool_callback_timeout(self, query):
        """Test set_tool_callback_timeout method."""
        query.set_tool_callback_timeout(45000)
        assert query._tool_callback_timeout == 45000

    def test_set_control_request_timeout(self, query):
        """Test set_control_request_timeout method."""
        query.set_control_request_timeout(90000)
        assert query._control_request_timeout == 90000

    def test_set_stream_close_timeout(self, query):
        """Test set_stream_close_timeout method."""
        query.set_stream_close_timeout(120000)
        assert query._stream_close_timeout == 120000

    def test_set_timeout_to_zero(self, query):
        """Test setting timeout to zero."""
        query.set_tool_callback_timeout(0)
        assert query._tool_callback_timeout == 0


class TestQueryEventListeners:
    """Test Query event listener methods."""

    @pytest.fixture
    def query(self):
        """Create a Query instance for testing."""
        options = QueryOptions(command=["test"])
        return Query(options)

    def test_add_event_listener(self, query):
        """Test add_event_listener method."""
        callback = MagicMock()
        query.add_event_listener("test_event", callback)

        assert "test_event" in query._event_listeners
        assert len(query._event_listeners["test_event"]) == 1

    def test_add_multiple_listeners(self, query):
        """Test adding multiple listeners to same event."""
        callback1 = MagicMock()
        callback2 = MagicMock()

        query.add_event_listener("test_event", callback1)
        query.add_event_listener("test_event", callback2)

        assert len(query._event_listeners["test_event"]) == 2

    def test_remove_event_listener(self, query):
        """Test remove_event_listener method."""
        callback = MagicMock()
        query.add_event_listener("test_event", callback)
        query.remove_event_listener("test_event", callback)

        assert "test_event" not in query._event_listeners

    def test_remove_nonexistent_listener(self, query):
        """Test removing a listener that doesn't exist."""
        callback = MagicMock()
        # Should not raise
        query.remove_event_listener("test_event", callback)

    def test_remove_listener_from_nonexistent_event(self, query):
        """Test removing listener from nonexistent event."""
        callback = MagicMock()
        # Should not raise
        query.remove_event_listener("nonexistent", callback)

    def test_event_listener_once_flag(self, query):
        """Test once flag for event listeners."""
        callback = MagicMock()
        query.add_event_listener("test_event", callback, once=True)

        # Emit twice
        query._emit_event("test_event", "arg1", kwarg1="kwval1")
        query._emit_event("test_event", "arg2", kwarg2="kwval2")

        # Should only be called once
        assert callback.call_count == 1
        # Listener should be removed
        assert "test_event" not in query._event_listeners

    def test_emit_event_with_args(self, query):
        """Test emitting event with arguments."""
        callback = MagicMock()
        query.add_event_listener("test_event", callback)

        query._emit_event("test_event", "arg1", "arg2", key="value")

        callback.assert_called_once_with("arg1", "arg2", key="value")

    def test_emit_nonexistent_event(self, query):
        """Test emitting a nonexistent event."""
        # Should not raise
        query._emit_event("nonexistent_event")

    def test_multiple_events(self, query):
        """Test multiple different events."""
        callback1 = MagicMock()
        callback2 = MagicMock()

        query.add_event_listener("event1", callback1)
        query.add_event_listener("event2", callback2)

        query._emit_event("event1")
        query._emit_event("event2")

        callback1.assert_called_once()
        callback2.assert_called_once()


class TestQueryHelperMethods:
    """Test Query helper methods."""

    @pytest.fixture
    def query(self):
        """Create a Query instance for testing."""
        options = QueryOptions(command=["test"])
        return Query(options)

    def test_default_subagent_options(self, query):
        """Test _get_default_subagent_options method."""
        assert query._get_default_subagent_options() is None

    def test_set_default_subagent_options(self, query):
        """Test set_default_subagent_options method."""
        options = {"name": "agent1", "config": {"setting": "value"}}
        query.set_default_subagent_options(options)

        assert query._get_default_subagent_options() == options

    def test_get_tool_use_id_by_request_id_missing(self, query):
        """Test get_tool_use_id_by_request_id with missing ID."""
        result = query.get_tool_use_id_by_request_id("nonexistent")
        assert result is None

    def test_get_tool_use_id_by_request_id_found(self, query):
        """Test get_tool_use_id_by_request_id with existing ID."""
        # Simulate storing a request ID to tool use ID mapping
        query._request_id_to_tool_use_id["req_123"] = "tool_use_456"

        result = query.get_tool_use_id_by_request_id("req_123")
        assert result == "tool_use_456"

    def test_initial_event_listeners_empty(self, query):
        """Test that event listeners are initially empty."""
        assert query._event_listeners == {}

    def test_initial_request_id_mapping_empty(self, query):
        """Test that request ID to tool use ID mapping is initially empty."""
        assert query._request_id_to_tool_use_id == {}


class TestQueryProperties:
    """Test Query properties."""

    @pytest.fixture
    def query(self):
        """Create a Query instance for testing."""
        options = QueryOptions(command=["test"])
        return Query(options)

    def test_is_closed_initial(self, query):
        """Test is_closed property initially returns False."""
        assert query.is_closed is False

    def test_is_closed_after_close(self, query):
        """Test is_closed property after close."""
        # Need to mock transport to avoid initialization
        mock_transport = AsyncMock()
        query._transport = mock_transport
        asyncio.get_event_loop().run_until_complete(query.close())
        assert query.is_closed is True

    def test_session_id(self, query):
        """Test session_id property."""
        session_id = query.session_id
        assert isinstance(session_id, str)
        assert len(session_id) > 0

    def test_session_id_unique(self, query):
        """Test that session IDs are unique."""
        options = QueryOptions(command=["test"])
        query1 = Query(options)
        query2 = Query(options)
        assert query1.session_id != query2.session_id


class TestQueryPermissionCallback:
    """Test Query permission callback methods."""

    @pytest.fixture
    def query(self):
        """Create a Query instance for testing."""
        options = QueryOptions(command=["test"])
        return Query(options)

    def test_set_permission_callback(self, query):
        """Test set_permission_callback method."""
        callback = MagicMock()
        query.set_permission_callback(callback)

        assert query._can_use_tool == callback

    def test_permission_callback_initially_none(self, query):
        """Test that permission callback is initially None."""
        assert query._can_use_tool is None


class TestQuerySingleTurn:
    """Test Query single turn mode."""

    def test_single_turn_false_by_default(self):
        """Test single_turn is False by default."""
        options = QueryOptions(command=["test"])
        query = Query(options)
        assert query._is_single_turn is False

    def test_single_turn_true(self):
        """Test single_turn can be set to True."""
        options = QueryOptions(command=["test"])
        query = Query(options, single_turn=True)
        assert query._is_single_turn is True


class TestQueryControlRequestHandler:
    """Test Query control request handler methods."""

    @pytest.fixture
    def query(self):
        """Create a Query instance for testing."""
        options = QueryOptions(command=["test"])
        return Query(options)

    def test_set_control_request_handler(self, query):
        """Test set_control_request_handler method."""
        handler = MagicMock()
        query.set_control_request_handler(handler)

        assert query._control_request_handler == handler

    def test_control_request_handler_initially_none(self, query):
        """Test that control request handler is initially None."""
        assert query._control_request_handler is None

    def test_set_control_request_handler_overwrites(self, query):
        """Test that set_control_request_handler overwrites previous handler."""
        handler1 = MagicMock()
        handler2 = MagicMock()

        query.set_control_request_handler(handler1)
        assert query._control_request_handler == handler1

        query.set_control_request_handler(handler2)
        assert query._control_request_handler == handler2


class TestQueryClearDefaultSubagentOptions:
    """Test Query clear_default_subagent_options method."""

    @pytest.fixture
    def query(self):
        """Create a Query instance for testing."""
        options = QueryOptions(command=["test"])
        return Query(options)

    def test_clear_when_none(self, query):
        """Test clear_default_subagent_options when options are None."""
        # Initially None
        assert query._default_subagent_options is None
        # Clear should still be None
        query.clear_default_subagent_options()
        assert query._default_subagent_options is None

    def test_clear_after_setting(self, query):
        """Test clear_default_subagent_options after setting options."""
        options = {"name": "agent1", "config": {}}
        query.set_default_subagent_options(options)
        assert query._default_subagent_options == options

        # Clear should set to None
        query.clear_default_subagent_options()
        assert query._default_subagent_options is None

    def test_set_after_clear(self, query):
        """Test setting options after clearing."""
        options1 = {"name": "agent1"}
        options2 = {"name": "agent2"}

        query.set_default_subagent_options(options1)
        assert query._default_subagent_options == options1

        query.clear_default_subagent_options()
        query.set_default_subagent_options(options2)
        assert query._default_subagent_options == options2


class TestQueryAsyncMethods:
    """Test Query async methods."""

    @pytest.fixture
    def query(self):
        """Create a Query instance for testing."""
        options = QueryOptions(command=["test"])
        return Query(options)

    @pytest.mark.asyncio
    async def test_close_already_closed(self, query):
        """Test calling close multiple times."""
        # Mock transport with async close method
        mock_transport = AsyncMock()
        query._transport = mock_transport
        await query.close()
        # Should not raise - second close
        await query.close()
        # Transport should only be closed once
        mock_transport.close.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_close_with_aborted_controller(self, query):
        """Test close with aborted controller."""
        # Don't set _transport - it will be None
        query._abort_controller.abort()
        # close() should handle the case when _transport is None
        await query.close()
        assert query.is_closed is True

    @pytest.mark.asyncio
    async def test_stream_input_not_initialized(self, query):
        """Test stream_input when not initialized."""
        # Create a proper async iterator
        async def async_messages():
            return
            yield  # Make this a generator

        # Should initialize transport - transport is None initially
        with patch.object(query, '_start_transport', new_callable=AsyncMock) as mock_start:
            await query.stream_input(async_messages())
            mock_start.assert_called_once()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
