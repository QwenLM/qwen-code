"""Query factory function for creating Query instances.

Based on TypeScript SDK createQuery implementation.
"""

from __future__ import annotations

import asyncio
from typing import AsyncGenerator, Dict, Any, List, Optional, Literal, Union, Callable
from dataclasses import dataclass, field

from .query import Query, QueryOptions, PermissionResult
from .protocol import SDKMessage


@dataclass
class CreateQueryOptions:
    """Options for createQuery.

    Based on TypeScript SDK CreateQueryOptions.
    """

    # Command to execute
    command: List[str]

    # Working directory
    cwd: Optional[str] = None

    # Environment variables
    env: Optional[Dict[str, str]] = None

    # Abort controller for cancellation
    abort_controller: Optional[Any] = None

    # Debug mode
    debug: bool = False

    # Permission callback
    can_use_tool: Optional[
        Callable[
            [str, Dict[str, Any], Dict[str, Any]],
            Union[PermissionResult, asyncio.Future[PermissionResult]],
        ]
    ] = None

    # Timeout options
    timeout: Optional[Dict[str, int]] = None

    # Enable streaming
    streaming: bool = True

    # Single turn mode (close input after first result)
    single_turn: bool = False

    # Additional options from TS-SDK
    mcp_servers: Optional[Dict[str, Any]] = None  # MCP servers config
    agents: Optional[List[Dict[str, Any]]] = None  # Sub-agent configurations


@dataclass
class QueryResult:
    """Result from running a query."""

    result: str
    usage: Dict[str, Any]
    num_turns: int
    duration_ms: int
    is_error: bool = False
    error: Optional[str] = None


async def create_query(
    options: CreateQueryOptions,
) -> Query:
    """Create and initialize a Query instance.

    This is the main entry point for the SDK.

    Args:
        options: Options for creating the query.

    Returns:
        An initialized Query instance ready to receive messages.

    Example:
        ```python
        query = await create_query(CreateQueryOptions(
            command=["qwen", "sdk", "--channel=SDK"],
        ))

        # Send a message
        await query.stream_input([
            {"type": "user", "message": {"role": "user", "content": "Hello!"}}
        ])

        # Iterate responses
        async for message in query:
            print(message)
        ```
    """
    query_options = QueryOptions(
        command=options.command,
        cwd=options.cwd,
        env=options.env,
        abort_controller=options.abort_controller,
        debug=options.debug,
        timeout=options.timeout,
    )

    query = Query(query_options, single_turn=options.single_turn)

    if options.can_use_tool:
        query.set_permission_callback(options.can_use_tool)

    await query.initialize()

    return query


async def run_query(
    options: CreateQueryOptions,
    messages: List[Dict[str, Any]],
) -> QueryResult:
    """Run a query and get the result.

    A convenience function that creates a query, sends messages,
    and returns the final result.

    Args:
        options: Options for creating the query.
        messages: List of messages to send.

    Returns:
        The query result.

    Example:
        ```python
        result = await run_query(
            CreateQueryOptions(command=["qwen", "sdk"]),
            [
                {"type": "user", "message": {"role": "user", "content": "Hello!"}}
            ]
        )
        print(result.result)
        ```
    """
    query = await create_query(options)

    try:
        # Send messages
        await query.stream_input(iter(messages))

        # Collect all messages
        all_messages: List[SDKMessage] = []
        async for message in query:
            all_messages.append(message)

        # Find result message
        from .protocol import is_sdk_result_message

        result_message = None
        for message in reversed(all_messages):
            if is_sdk_result_message(message):
                result_message = message
                break

        if result_message:
            usage = result_message.get("usage", {})
            return QueryResult(
                result=result_message.get("result", ""),
                usage=usage,
                num_turns=result_message.get("num_turns", 0),
                duration_ms=result_message.get("duration_ms", 0),
                is_error=result_message.get("is_error", False),
                error=result_message.get("error", {}).get("message") if result_message.get("error") else None,
            )

        return QueryResult(
            result="",
            usage={},
            num_turns=0,
            duration_ms=0,
            is_error=True,
            error="No result message received",
        )

    finally:
        await query.close()


class QueryIterator:
    """A wrapper that allows async iteration on a Query object.

    This enables using async for with a synchronously created Query,
    matching the TS-SDK API pattern where query() returns immediately.
    """

    def __init__(self, query: Query, messages: List[Dict[str, Any]]):
        self._query = query
        self._messages = messages
        self._initialized = False

    async def _ensure_initialized(self):
        """Ensure the query is initialized before iterating."""
        if not self._initialized:
            await self._query.initialize()
            # Stream input messages
            async def async_messages():
                for msg in self._messages:
                    yield msg
            await self._query.stream_input(async_messages())
            self._initialized = True

    def __aiter__(self):
        """Return async iterator that ensures initialization."""
        async def iterator():
            await self._ensure_initialized()
            # Start message router in the background
            self._query._start_message_router()
            try:
                async for msg in self._query:
                    yield msg
            finally:
                # Close the query
                await self._query.close()
        return iterator()

    async def close(self):
        """Close the query."""
        await self._query.close()


def query(
    message: Union[str, List[Dict[str, Any]]],
    options: Optional[CreateQueryOptions] = None,
) -> QueryIterator:
    """Create a query (synchronous).

    This creates and initializes a Query object, returning it wrapped
    in a QueryIterator for async iteration. Based on TS-SDK query function.

    Args:
        message: The message to send (either a string or a list of message dicts).
        options: Optional query options. If not provided, default options are used.

    Returns:
        A QueryIterator for async iteration.

    Example:
        ```python
        # Simple usage
        q = query("Hello, world!")

        async for message in q:
            print(message)

        # With options
        q = query(
            "Fix the bug in calculateTotal()",
            CreateQueryOptions(command=["qwen", "sdk"])
        )
        ```
    """
    if options is None:
        options = CreateQueryOptions(command=["qwen", "sdk", "--channel=SDK"])

    # Convert string message to message list
    if isinstance(message, str):
        messages: List[Dict[str, Any]] = [
            {"type": "user", "message": {"role": "user", "content": message}}
        ]
    else:
        messages = message

    # Create query
    q = Query(
        QueryOptions(
            command=options.command,
            cwd=options.cwd,
            env=options.env,
            abort_controller=options.abort_controller,
            debug=options.debug,
            timeout=options.timeout,
        ),
        single_turn=options.single_turn,
    )

    if options.can_use_tool:
        q.set_permission_callback(options.can_use_tool)

    # Return QueryIterator which handles initialization lazily
    return QueryIterator(q, messages)


__all__ = [
    "create_query",
    "run_query",
    "query",
    "CreateQueryOptions",
    "QueryResult",
]
