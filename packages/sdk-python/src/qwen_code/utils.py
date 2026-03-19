"""AsyncIterable stream utilities for qwen-code SDK.

Based on TypeScript SDK Stream implementation.
"""

from __future__ import annotations

import asyncio
from typing import AsyncGenerator, Generic, TypeVar, Optional, Any


T = TypeVar("T")


class Stream(Generic[T]):
    """AsyncIterable stream that supports enqueue, error, and done operations.

    Similar to the TypeScript Stream class for managing async message streams.
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[T] = asyncio.Queue()
        self._error: Optional[Exception] = None
        self._done = False
        self._has_error: Optional[bool] = None

    @property
    def has_error(self) -> Optional[bool]:
        """Check if stream has an error."""
        return self._has_error

    def enqueue(self, item: T) -> None:
        """Add an item to the stream.

        Args:
            item: The item to add.

        Raises:
            asyncio.QueueFull: If the queue is full.
            RuntimeError: If the stream is done or has an error.
        """
        if self._done or self._has_error is not None:
            raise RuntimeError("Stream is done or has an error")
        self._queue.put_nowait(item)

    def error(self, error: Exception) -> None:
        """Set an error on the stream.

        Args:
            error: The error to set.
        """
        self._error = error
        self._has_error = True

    def done(self) -> None:
        """Mark the stream as done."""
        self._done = True

    def _check_error(self) -> None:
        """Check if stream has an error and raise if so."""
        if self._has_error and self._error is not None:
            raise self._error

    async def _consume(self) -> AsyncGenerator[T, None]:
        """Consume items from the stream."""
        while True:
            self._check_error()

            if self._done and self._queue.empty():
                break

            try:
                item = await asyncio.wait_for(
                    self._queue.get(),
                    timeout=0.1
                )
                self._check_error()
                yield item
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                raise
            except Exception:
                continue

    def __aiter__(self) -> AsyncGenerator[T, None]:
        """Return async iterator."""
        return self._consume()

    def __repr__(self) -> str:
        return f"Stream(queue_size={self._queue.qsize()}, done={self._done}, has_error={self._has_error})"


def serialize_json_line(obj: Any) -> str:
    """Serialize an object to JSON Lines format.

    Args:
        obj: The object to serialize.

    Returns:
        A JSON string followed by a newline character.
    """
    import json

    return json.dumps(obj, separators=(",", ":")) + "\n"


def deserialize_json_line(line: str) -> Any:
    """Deserialize a JSON Lines string to an object.

    Args:
        line: The JSON line string.

    Returns:
        The deserialized object.
    """
    import json

    return json.loads(line.strip())


__all__ = [
    "Stream",
    "serialize_json_line",
    "deserialize_json_line",
]
