"""Process transport for SDK-CLI communication via subprocess.

Based on TypeScript SDK ProcessTransport implementation.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
from dataclasses import dataclass
from typing import AsyncGenerator, Optional, List, Dict, Any

from .utils import Stream, deserialize_json_line
from .api import AbortError


class AbortController:
    """AbortController implementation for Python.

    Based on web standard AbortController API.
    """

    def __init__(self) -> None:
        self._signal = AbortSignal()
        self._signal._controller = self  # type: ignore[attr-defined]

    @property
    def signal(self) -> "AbortSignal":
        """Get the abort signal."""
        return self._signal

    def abort(self) -> None:
        """Abort the operation."""
        if self._signal.aborted:
            return
        self._signal._aborted = True
        for callback in self._signal._listeners:
            callback(self._signal)


class AbortSignal:
    """AbortSignal implementation for Python.

    Based on web standard AbortSignal API.
    """

    def __init__(self) -> None:
        self._aborted = False
        self._listeners: list = []
        self._controller: Optional[AbortController] = None

    @property
    def aborted(self) -> bool:
        """Check if signal is aborted."""
        return self._aborted

    def add_event_listener(self, event: str, callback: callable) -> None:
        """Add an event listener.

        Args:
            event: The event name (only 'abort' is supported).
            callback: The callback function.
        """
        if event == "abort":
            self._listeners.append(callback)

    def remove_event_listener(self, event: str, callback: callable) -> None:
        """Remove an event listener.

        Args:
            event: The event name.
            callback: The callback function.
        """
        if event == "abort" and callback in self._listeners:
            self._listeners.remove(callback)


@dataclass
class ProcessTransportOptions:
    """Options for ProcessTransport.

    Based on TypeScript SDK ProcessTransportOptions.
    """

    command: List[str]
    cwd: Optional[str] = None
    env: Optional[Dict[str, str]] = None
    abort_controller: Optional["AbortController"] = None
    debug: bool = False

    # Additional options from TS-SDK
    permission_mode: Optional[str] = None  # 'default' | 'plan' | 'auto-edit' | 'yolo'
    model: Optional[str] = None
    max_session_turns: Optional[int] = None
    core_tools: Optional[List[str]] = None
    exclude_tools: Optional[List[str]] = None
    allowed_tools: Optional[List[str]] = None
    auth_type: Optional[str] = None
    include_partial_messages: bool = False
    stderr: Optional[Any] = None
    spawn_info: Optional[Dict[str, Any]] = None


class ProcessTransport:
    """Transport implementation using subprocess stdin/stdout.

    Enables communication between SDK and CLI via local subprocess.
    """

    def __init__(self, options: ProcessTransportOptions) -> None:
        self.options = options
        self._process: Optional[asyncio.subprocess.Process] = None
        self._stdin_writer: Optional[asyncio.Task[None]] = None
        self._stdout_reader_task: Optional[asyncio.Task[None]] = None
        self._input_stream: Stream[str] = Stream()
        self._output_messages: Stream[Any] = Stream()
        self._ready = False
        self._exit_error: Optional[Exception] = None
        self._closed = False
        self._abort_controller = options.abort_controller or AbortController()

        self._setup_abort_handler()

    @staticmethod
    async def create(options: ProcessTransportOptions) -> "ProcessTransport":
        """Create and initialize a ProcessTransport asynchronously."""
        transport = ProcessTransport(options)
        await transport._start_process()
        return transport

    def _setup_abort_handler(self) -> None:
        """Set up handler for abort signal."""
        if self._abort_controller.signal.aborted:
            raise AbortError("Transport start aborted")

        self._abort_controller.signal.add_event_listener(
            "abort",
            self._on_abort,
        )

    def _on_abort(self) -> None:
        """Handle abort signal."""
        self._close_process()

    async def _start_process(self) -> None:
        """Start the subprocess."""
        try:
            if self._abort_controller.signal.aborted:
                raise AbortError("Transport start aborted")

            cwd = self.options.cwd or "."
            # Inherit from parent environment, then override with options.env
            env = {**os.environ.copy(), **(self.options.env or {})}
            env.update({
                "PYTHONUNBUFFERED": "1",
                "UV_SYSTEM_PYTHON": "1",
            })

            # Build command with SDK-specific arguments
            # The qwen command expects JSON messages via stdin/stdout
            command = list(self.options.command)
            # Add SDK-specific arguments if not already provided
            def has_arg(cmd_list, arg):
                """Check if arg is in command (supports --arg=value format)."""
                return any(arg in item for item in cmd_list)

            if not has_arg(command, "--input-format"):
                command.extend(["--input-format", "stream-json"])
            if not has_arg(command, "--output-format"):
                command.extend(["--output-format", "stream-json"])
            if not has_arg(command, "--channel"):
                command.extend(["--channel", "SDK"])

            # Create subprocess using asyncio (must be called in async context)
            self._process = await asyncio.create_subprocess_exec(
                *command,
                cwd=cwd,
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Start stdin writer
            self._stdin_writer = asyncio.create_task(
                self._write_stdin_loop()
            )

            # Start stdout reader
            self._stdout_reader_task = asyncio.create_task(
                self._read_stdout_loop()
            )

            self._ready = True

        except Exception as error:
            self._ready = False
            if isinstance(error, AbortError):
                self._exit_error = error
            else:
                self._exit_error = RuntimeError(
                    f"Failed to start process: {error}"
                )
            raise

    async def _write_stdin_loop(self) -> None:
        """Write messages to stdin in a loop."""
        if self._process is None or self._process.stdin is None or self._process.stdin.is_closing():
            return

        try:
            while not self._closed and not self._process.stdin.is_closing():
                # Try to get a message without blocking first
                try:
                    message = self._input_stream._queue.get_nowait()
                except asyncio.QueueEmpty:
                    # Queue is empty, wait a bit
                    await asyncio.sleep(0.1)
                    continue

                if self._process.stdin.is_closing():
                    break
                try:
                    self._process.stdin.write(message.encode("utf-8"))
                    await self._process.stdin.drain()
                except BrokenPipeError:
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    async def _read_stdout_loop(self) -> None:
        """Read messages from stdout in a loop."""
        try:
            while not self._closed:
                line = await self._process.stdout.readline()
                if not line:
                    break
                try:
                    message = deserialize_json_line(line.decode("utf-8"))
                    self._output_messages.enqueue(message)
                except Exception:
                    # Skip invalid JSON lines
                    pass

            # Process exited, mark stream as done
            self._output_messages.done()

        except asyncio.CancelledError:
            # Task was cancelled, still mark stream as done
            self._output_messages.done()
            raise
        except Exception:
            self._output_messages.done()
            pass

    async def _close_process(self) -> None:
        """Close the subprocess."""
        if self._process is None:
            return

        try:
            if self._process.stdin and not self._process.stdin.is_closing():
                self._process.stdin.close()

            try:
                await asyncio.wait_for(self._process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._process.terminate()
                await self._process.wait()
        except Exception:
            pass

    async def close(self) -> None:
        """Close the transport and terminate the process."""
        if self._closed:
            return

        self._closed = True

        # Cancel stdin writer
        if self._stdin_writer and not self._stdin_writer.done():
            self._stdin_writer.cancel()
            try:
                await self._stdin_writer
            except asyncio.CancelledError:
                pass

        # Close stdin
        if self._process and self._process.stdin and not self._process.stdin.is_closing():
            try:
                self._process.stdin.close()
            except Exception:
                pass

        # Terminate process
        await self._close_process()

        # Cancel stdout reader
        if self._stdout_reader_task and not self._stdout_reader_task.done():
            self._stdout_reader_task.cancel()
            try:
                await self._stdout_reader_task
            except asyncio.CancelledError:
                pass

        # Clean up abort handler
        try:
            self._abort_controller.signal.remove_event_listener(
                "abort",
                self._on_abort,
            )
        except Exception:
            pass

        self._ready = False

    async def waitForExit(self) -> None:
        """Wait for the process to exit."""
        if self._process is None:
            if self._exit_error:
                raise self._exit_error
            return

        if self._process.returncode is not None:
            if self._exit_error:
                raise self._exit_error
            return

        # Wait for stdout reader to finish
        if self._stdout_reader_task:
            try:
                await asyncio.wait_for(
                    self._stdout_reader_task,
                    timeout=30,
                )
            except asyncio.TimeoutError:
                pass

        # Check process exit
        if self._process.returncode is None:
            if self._abort_controller.signal.aborted:
                raise AbortError("Operation aborted")
            return

        if self._exit_error:
            raise self._exit_error

        # Check for exit code
        exit_code = self._process.returncode
        if exit_code is not None and exit_code != 0:
            raise RuntimeError(f"Process exited with code {exit_code}")

    def write(self, message: str) -> None:
        """Write a message to the transport.

        Args:
            message: The message to write.

        Raises:
            AbortError: If the transport is aborted.
            RuntimeError: If the transport is not ready or closed.
        """
        if self._abort_controller.signal.aborted:
            raise AbortError("Cannot write: operation aborted")

        if not self._ready or self._closed:
            raise RuntimeError("Transport not ready for writing")

        if self._process is None or self._process.stdin is None:
            raise RuntimeError("Process not started")

        if self._process.stdin.is_closing():
            raise RuntimeError("Cannot write to ended stream")

        if self._process.returncode is not None:
            raise RuntimeError("Cannot write to terminated process")

        if self._exit_error:
            raise RuntimeError(
                f"Cannot write to process that exited with error: {self._exit_error}"
            )

        self._input_stream.enqueue(message)

    async def readMessages(self) -> AsyncGenerator[Any, None]:
        """Read messages from the transport.

        Yields:
            Messages read from the transport.

        Raises:
            RuntimeError: If the process is not started.
        """
        if self._process is None or self._process.stdout is None:
            raise RuntimeError("Cannot read messages: process not started")

        try:
            async for message in self._output_messages:
                yield message
        finally:
            # Ensure we wait for exit when iteration is done
            await self.waitForExit()

    @property
    def isReady(self) -> bool:
        """Check if the transport is ready."""
        return self._ready

    @property
    def exitError(self) -> Optional[Exception]:
        """Get any exit error."""
        return self._exit_error

    def endInput(self) -> None:
        """End the input stream."""
        if self._process and self._process.stdin:
            try:
                self._process.stdin.close()
            except Exception:
                pass

    def getInputStream(self):
        """Get the input stream (stdin)."""
        if self._process:
            return self._process.stdin
        return None

    def getOutputStream(self):
        """Get the output stream (stdout)."""
        if self._process:
            return self._process.stdout
        return None


__all__ = [
    "ProcessTransport",
    "ProcessTransportOptions",
]
