"""Query class - Main orchestrator for qwen-code SDK.

Manages SDK workflow, routes messages, and handles lifecycle.
Implements AsyncIterator protocol for message consumption.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import AsyncGenerator, AsyncIterable, Callable, Dict, Any, Optional, List, Union
from dataclasses import dataclass, field

from .utils import Stream, serialize_json_line
from .api import AbortError, is_abort_error
from .transport import AbortController, ProcessTransport, ProcessTransportOptions
from .protocol import (
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage,
    SDKPartialAssistantMessage,
    is_sdk_user_message,
    is_sdk_assistant_message,
    is_sdk_system_message,
    is_sdk_result_message,
    is_sdk_partial_assistant_message,
    is_control_request,
    is_control_response,
    is_control_cancel,
)


@dataclass
class QueryOptions:
    """Options for Query.

    Based on TypeScript SDK QueryOptions.
    """

    command: List[str]
    cwd: Optional[str] = None
    env: Optional[Dict[str, str]] = None
    abort_controller: Optional[Any] = None
    debug: bool = False
    timeout: Optional[Dict[str, int]] = None

    # Additional options from TS-SDK
    mcp_servers: Optional[Dict[str, Any]] = None  # MCP servers config
    agents: Optional[List[Dict[str, Any]]] = None  # Sub-agent configurations


@dataclass
class PermissionResult:
    """Result from permission callback."""

    behavior: str  # "allow" or "deny"
    updated_input: Optional[Dict[str, Any]] = None
    message: Optional[str] = None
    interrupt: bool = False


QueryCanUseToolCallback = Optional[
    Callable[
        [str, Dict[str, Any], Dict[str, Any]],
        Union[PermissionResult, asyncio.Future[PermissionResult]],
    ]
]


class Query(AsyncIterable[SDKMessage]):
    """Main orchestrator for qwen-code SDK.

    Manages SDK workflow, routes messages, and handles lifecycle.
    Implements AsyncIterator protocol for message consumption.
    """

    DEFAULT_CAN_USE_TOOL_TIMEOUT = 60_000
    DEFAULT_CONTROL_REQUEST_TIMEOUT = 60_000
    DEFAULT_STREAM_CLOSE_TIMEOUT = 60_000

    def __init__(
        self,
        options: QueryOptions,
        single_turn: bool = False,
    ) -> None:
        self.options = options
        self._session_id = str(uuid.uuid4())
        self._transport: Optional[ProcessTransport] = None
        self._input_stream: Stream[SDKMessage] = Stream()
        self._sdk_messages: Optional[AsyncGenerator[SDKMessage]] = None
        self._abort_controller = options.abort_controller or AbortController()
        self._pending_control_requests: Dict[str, Dict[str, Any]] = {}
        self._closed = False
        self._message_router_started = False
        self._can_use_tool: QueryCanUseToolCallback = None
        self._is_single_turn = single_turn

        # Timeout settings
        self._tool_callback_timeout = self.DEFAULT_CAN_USE_TOOL_TIMEOUT
        self._control_request_timeout = self.DEFAULT_CONTROL_REQUEST_TIMEOUT
        self._stream_close_timeout = self.DEFAULT_STREAM_CLOSE_TIMEOUT

        # Event listeners
        self._event_listeners: Dict[str, List[Callable]] = {}

        # Request ID to tool use ID mapping
        self._request_id_to_tool_use_id: Dict[str, str] = {}

        # Default subagent options
        self._default_subagent_options: Optional[Dict[str, Any]] = None

        # Control request handler
        self._control_request_handler: Optional[Callable] = None

    async def _start_transport(self) -> None:
        """Start the transport."""
        options = ProcessTransportOptions(
            command=self.options.command,
            cwd=self.options.cwd,
            env=self.options.env,
            abort_controller=self._abort_controller,
            debug=self.options.debug,
        )
        self._transport = await ProcessTransport.create(options)

    async def initialize(self) -> None:
        """Initialize the Query."""
        await self._start_transport()

        # Create async generator proxy
        self._sdk_messages = self._read_sdk_messages()

        # Set up abort handler
        if self._abort_controller.signal.aborted:
            self._input_stream.error(AbortError("Query aborted by user"))
            await self.close()
        else:
            self._abort_controller.signal.add_event_listener(
                "abort",
                self._on_abort,
            )

        self._start_message_router()

    def _on_abort(self) -> None:
        """Handle abort signal."""
        self._input_stream.error(AbortError("Query aborted by user"))
        # Close will be called when user tries to iterate

    def _start_message_router(self) -> None:
        """Start the message router."""
        if self._message_router_started:
            return

        self._message_router_started = True

        # Start router in background
        asyncio.create_task(self._run_message_router())

    async def _run_message_router(self) -> None:
        """Run the message router."""
        if not self._transport:
            return

        try:
            async for message in self._transport.readMessages():
                await self._route_message(message)

                if self._closed:
                    break
        except Exception as error:
            self._input_stream.error(
                AbortError(str(error)) if is_abort_error(error) else error
            )
        finally:
            # Mark input stream as done when router exits
            self._input_stream.done()

    async def _route_message(self, message: Dict[str, Any]) -> None:
        """Route a message to the appropriate handler."""
        if is_control_request(message):
            await self._handle_control_request(message)
            return

        if is_control_response(message):
            self._handle_control_response(message)
            return

        if is_control_cancel(message):
            self._handle_control_cancel_request(message)
            return

        if is_sdk_system_message(message):
            self._input_stream.enqueue(message)
            return

        if is_sdk_result_message(message):
            self._input_stream.enqueue(message)
            return

        if (
            is_sdk_assistant_message(message)
            or is_sdk_user_message(message)
            or is_sdk_partial_assistant_message(message)
        ):
            self._input_stream.enqueue(message)
            return

        # Unknown message type, enqueue anyway
        self._input_stream.enqueue(message)

    async def _handle_control_request(
        self, request: Dict[str, Any]
    ) -> None:
        """Handle a control request."""
        request_id = request.get("request_id", "")
        payload = request.get("request", {})
        subtype = payload.get("subtype", "")

        try:
            response_data: Optional[Dict[str, Any]] = None

            if subtype == "can_use_tool":
                response_data = await self._handle_permission_request(payload)
            else:
                raise ValueError(f"Unknown control request subtype: {subtype}")

            await self._send_control_response(request_id, True, response_data)
        except Exception as error:
            error_message = str(error)
            await self._send_control_response(
                request_id, False, {"message": error_message}
            )

    async def _handle_permission_request(
        self, payload: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Handle a permission request."""
        tool_name = payload.get("tool_name", "")
        tool_use_id = payload.get("tool_use_id", "")
        tool_input = payload.get("input", {})
        permission_suggestions = payload.get("permission_suggestions", [])

        # Store mapping of request ID to tool use ID
        request_id = payload.get("request_id", "")
        if request_id and tool_use_id:
            self._request_id_to_tool_use_id[request_id] = tool_use_id

        if not self._can_use_tool:
            return {"behavior": "deny", "message": "Denied"}

        try:
            # Use configurable timeout
            timeout = self._tool_callback_timeout

            result = await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: self._can_use_tool(
                        tool_name, tool_input, {"suggestions": permission_suggestions}
                    ),
                ),
                timeout=timeout / 1000,
            )

            if result.behavior == "allow":
                return {
                    "behavior": "allow",
                    "updatedInput": result.updated_input or tool_input,
                }
            else:
                return {
                    "behavior": "deny",
                    "message": result.message or "Denied",
                    **({"interrupt": result.interrupt} if result.interrupt else {}),
                }
        except asyncio.TimeoutError:
            return {"behavior": "deny", "message": "Permission callback timeout"}
        except Exception as error:
            return {
                "behavior": "deny",
                "message": f"Permission check failed: {str(error)}",
            }

    def _handle_control_response(self, response: Dict[str, Any]) -> None:
        """Handle a control response."""
        payload = response.get("response", {})
        request_id = payload.get("request_id", "")

        pending = self._pending_control_requests.get(request_id)
        if not pending:
            return

        # Clean up timeout
        timeout = pending.get("timeout")
        if timeout:
            asyncio.get_event_loop().call_later(0, lambda: None)  # Placeholder

        del self._pending_control_requests[request_id]

        if payload.get("subtype") == "success":
            pending["resolve"](payload.get("response"))
        else:
            error = payload.get("error", {})
            error_message = error.get("message", error if isinstance(error, str) else "Unknown error")
            pending["reject"](ValueError(error_message))

    def _handle_control_cancel_request(self, request: Dict[str, Any]) -> None:
        """Handle a control cancel request."""
        request_id = request.get("request_id", "")

        if not request_id:
            return

        pending = self._pending_control_requests.get(request_id)
        if pending:
            pending["abort_controller"].abort()
            pending["reject"](AbortError("Request cancelled"))

    async def _send_control_request(
        self,
        subtype: str,
        data: Dict[str, Any] = {},
    ) -> Optional[Dict[str, Any]]:
        """Send a control request."""
        if self._closed:
            raise ValueError("Query is closed")

        request_id = str(uuid.uuid4())

        request = {
            "type": "control_request",
            "request_id": request_id,
            "request": {"subtype": subtype, **data},
        }

        loop = asyncio.get_event_loop()
        response_future = loop.create_future()

        # Use configurable timeout
        timeout = self._control_request_timeout

        async def timeout_handler() -> None:
            await asyncio.sleep(timeout / 1000)
            if not response_future.done():
                response_future.set_exception(
                    TimeoutError(f"Control request timeout: {subtype}")
                )

        asyncio.create_task(timeout_handler())

        abort_controller = AbortController()
        self._pending_control_requests[request_id] = {
            "resolve": response_future.set_result,
            "reject": response_future.set_exception,
            "abort_controller": abort_controller,
        }

        if self._transport:
            self._transport.write(serialize_json_line(request))

        return await response_future

    async def _send_control_response(
        self,
        request_id: str,
        success: bool,
        response_or_error: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Send a control response."""
        response = {
            "type": "control_response",
            "response": {
                "subtype": "success" if success else "error",
                "request_id": request_id,
                "response": response_or_error,
            }
            if success
            else {"subtype": "error", "request_id": request_id, "error": response_or_error},
        }

        if self._transport:
            self._transport.write(serialize_json_line(response))

    async def close(self) -> None:
        """Close the Query."""
        if self._closed:
            return

        self._closed = True

        # Cancel pending requests
        for pending in self._pending_control_requests.values():
            pending["abort_controller"].abort()
            if not pending["resolve"].cancelled():
                try:
                    pending["reject"](ValueError("Query is closed"))
                except Exception:
                    pass

        self._pending_control_requests.clear()

        # Close transport
        if self._transport:
            await self._transport.close()

        # Complete input stream - mark done so iteration can finish
        if self._input_stream.has_error is None:
            if self._abort_controller.signal.aborted:
                self._input_stream.error(AbortError("Query aborted"))
            else:
                self._input_stream.done()

    async def _read_sdk_messages(self) -> AsyncGenerator[SDKMessage, None]:
        """Read SDK messages from the input stream."""
        if self._sdk_messages is None:
            self._sdk_messages = self._input_stream.__aiter__()
        async for message in self._input_stream:
            yield message

    def __aiter__(self) -> AsyncGenerator[SDKMessage, None]:
        """Return async iterator."""
        if self._sdk_messages is None:
            self._sdk_messages = self._input_stream.__aiter__()
        return self._sdk_messages

    async def stream_input(
        self, messages: AsyncIterable[SDKUserMessage]
    ) -> None:
        """Stream input messages to the Query.

        Args:
            messages: Async iterable of user messages.
        """
        if self._closed:
            raise ValueError("Query is closed")

        # Initialize if not already done
        if self._transport is None:
            await self.initialize()

        async for message in messages:
            if self._abort_controller.signal.aborted:
                break
            if self._transport:
                self._transport.write(serialize_json_line(message))

        # End input stream to signal no more messages
        if self._transport:
            self._transport.endInput()

    def set_permission_callback(
        self, callback: QueryCanUseToolCallback
    ) -> None:
        """Set the permission callback.

        Args:
            callback: A callable that takes (tool_name, tool_input, context)
                     and returns a PermissionResult.
        """
        self._can_use_tool = callback

    @property
    def is_closed(self) -> bool:
        """Check if the Query is closed."""
        return self._closed

    @property
    def session_id(self) -> str:
        """Get the session ID."""
        return self._session_id

    # Timeout setting methods

    def set_tool_callback_timeout(self, timeout_ms: int) -> None:
        """Set the timeout for tool callback.

        Args:
            timeout_ms: Timeout in milliseconds.
        """
        self._tool_callback_timeout = timeout_ms

    def set_control_request_timeout(self, timeout_ms: int) -> None:
        """Set the timeout for control requests.

        Args:
            timeout_ms: Timeout in milliseconds.
        """
        self._control_request_timeout = timeout_ms

    def set_stream_close_timeout(self, timeout_ms: int) -> None:
        """Set the timeout for stream close.

        Args:
            timeout_ms: Timeout in milliseconds.
        """
        self._stream_close_timeout = timeout_ms

    # Event listener methods

    def add_event_listener(
        self, event: str, callback: Callable, *, once: bool = False
    ) -> None:
        """Add an event listener.

        Args:
            event: Event name.
            callback: Callback function.
            once: If True, listener will be removed after first call.
        """
        if event not in self._event_listeners:
            self._event_listeners[event] = []

        self._event_listeners[event].append(
            {"callback": callback, "once": once, "listener": self}
        )

    def remove_event_listener(self, event: str, callback: Callable) -> None:
        """Remove an event listener.

        Args:
            event: Event name.
            callback: Callback function to remove.
        """
        if event not in self._event_listeners:
            return

        self._event_listeners[event] = [
            listener
            for listener in self._event_listeners[event]
            if listener["callback"] != callback
        ]

        if not self._event_listeners[event]:
            del self._event_listeners[event]

    def _emit_event(self, event: str, *args: Any, **kwargs: Any) -> None:
        """Emit an event to all listeners.

        Args:
            event: Event name.
            *args: Positional arguments to pass to callbacks.
            **kwargs: Keyword arguments to pass to callbacks.
        """
        if event not in self._event_listeners:
            return

        listeners_to_remove = []

        for listener in self._event_listeners[event]:
            try:
                listener["callback"](*args, **kwargs)
            except Exception:
                pass

            if listener["once"]:
                listeners_to_remove.append(listener["callback"])

        # Remove once listeners
        for callback in listeners_to_remove:
            self.remove_event_listener(event, callback)

    # Helper methods

    async def _send_message(self, message: SDKMessage) -> None:
        """Send a message to the transport.

        Args:
            message: Message to send.
        """
        if self._closed:
            raise ValueError("Query is closed")

        if self._transport is None:
            await self.initialize()

        if self._transport:
            self._transport.write(serialize_json_line(message))

    def _get_default_subagent_options(self) -> Optional[Dict[str, Any]]:
        """Get the default subagent options.

        Returns:
            Default subagent options or None.
        """
        return self._default_subagent_options

    def set_default_subagent_options(self, options: Dict[str, Any]) -> None:
        """Set the default subagent options.

        Args:
            options: Default subagent options.
        """
        self._default_subagent_options = options

    def get_tool_use_id_by_request_id(self, request_id: str) -> Optional[str]:
        """Get the tool use ID for a request ID.

        Args:
            request_id: The request ID.

        Returns:
            Tool use ID or None if not found.
        """
        return self._request_id_to_tool_use_id.get(request_id)

    def set_control_request_handler(self, handler: Callable) -> None:
        """Set the control request handler.

        Args:
            handler: A callable that handles control requests.
                     Should accept (request_id, request) and return response.
        """
        self._control_request_handler = handler

    def clear_default_subagent_options(self) -> None:
        """Clear the default subagent options."""
        self._default_subagent_options = None


__all__ = [
    "Query",
    "QueryOptions",
    "PermissionResult",
]
