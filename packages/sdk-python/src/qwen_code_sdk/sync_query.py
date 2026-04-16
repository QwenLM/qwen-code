"""Synchronous wrapper around the async Query API."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterable, Iterable, Mapping
from queue import Queue
from typing import Any, cast

from .protocol import SDKMessage, SDKUserMessage
from .query import Query, query
from .types import QueryOptions, QueryOptionsDict

_STOP = object()


class SyncQuery:
    def __init__(
        self,
        prompt: str | Iterable[SDKUserMessage] | AsyncIterable[SDKUserMessage],
        options: QueryOptions | QueryOptionsDict | Mapping[str, Any] | None = None,
    ) -> None:
        self._queue: Queue[SDKMessage | Exception | object] = Queue()
        self._ready = threading.Event()
        self._shutdown = threading.Event()
        self._thread_error: Exception | None = None
        self._query: Query | None = None
        self._consumer_task: asyncio.Task[None] | None = None

        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="qwen-sdk-sync-loop",
            daemon=True,
        )
        self._thread.start()

        if isinstance(prompt, str) or hasattr(prompt, "__aiter__"):
            source_prompt: str | AsyncIterable[SDKUserMessage] = prompt  # type: ignore[assignment]
        else:
            source_prompt = _iterable_to_async(prompt)

        future = asyncio.run_coroutine_threadsafe(
            self._bootstrap(source_prompt, options),
            self._loop,
        )
        try:
            future.result()
        except Exception:
            self._stop_loop()
            raise

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    async def _bootstrap(
        self,
        prompt: str | AsyncIterable[SDKUserMessage],
        options: QueryOptions | QueryOptionsDict | Mapping[str, Any] | None,
    ) -> None:
        self._query = query(prompt=prompt, options=options)
        self._ready.set()
        self._consumer_task = asyncio.create_task(self._consume())

    async def _consume(self) -> None:
        assert self._query is not None
        try:
            async for message in self._query:
                self._queue.put(message)
        except Exception as exc:
            self._thread_error = exc
            self._queue.put(exc)
        finally:
            self._queue.put(_STOP)

    def _require_query(self) -> Query:
        self._ready.wait(timeout=30)
        if self._query is None:
            raise RuntimeError("SyncQuery failed to initialize")
        return self._query

    def __iter__(self) -> SyncQuery:
        return self

    def __next__(self) -> SDKMessage:
        item = self._queue.get()

        if item is _STOP:
            raise StopIteration

        if isinstance(item, Exception):
            raise item

        return cast(SDKMessage, item)

    def interrupt(self) -> None:
        q = self._require_query()
        asyncio.run_coroutine_threadsafe(q.interrupt(), self._loop).result()

    def set_model(self, model: str) -> None:
        q = self._require_query()
        asyncio.run_coroutine_threadsafe(q.set_model(model), self._loop).result()

    def set_permission_mode(self, mode: str) -> None:
        q = self._require_query()
        asyncio.run_coroutine_threadsafe(
            q.set_permission_mode(mode),
            self._loop,
        ).result()

    def supported_commands(self) -> Any:
        q = self._require_query()
        return asyncio.run_coroutine_threadsafe(
            q.supported_commands(),
            self._loop,
        ).result()

    def mcp_server_status(self) -> Any:
        q = self._require_query()
        return asyncio.run_coroutine_threadsafe(
            q.mcp_server_status(),
            self._loop,
        ).result()

    def get_session_id(self) -> str:
        q = self._require_query()
        return q.get_session_id()

    def is_closed(self) -> bool:
        q = self._require_query()
        return q.is_closed()

    def close(self) -> None:
        if self._shutdown.is_set():
            return

        self._shutdown.set()

        q = self._query
        if q is not None:
            try:
                asyncio.run_coroutine_threadsafe(q.close(), self._loop).result(
                    timeout=30
                )
            except Exception:
                pass

        self._stop_loop()

    def _stop_loop(self) -> None:
        if self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)
        if not self._loop.is_closed():
            self._loop.close()


async def _iterable_to_async(
    messages: Iterable[SDKUserMessage],
) -> AsyncIterable[SDKUserMessage]:
    for message in messages:
        yield message
