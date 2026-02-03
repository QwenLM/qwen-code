"""Tests for transport module."""

import pytest
from unittest.mock import Mock, patch, MagicMock

from qwen_code.transport import (
    AbortController,
    AbortSignal,
)


class TestAbortController:
    """Tests for AbortController."""

    def test_init(self) -> None:
        """Test AbortController initialization."""
        controller = AbortController()
        assert controller.signal.aborted is False

    def test_abort(self) -> None:
        """Test aborting the controller."""
        controller = AbortController()
        callback = Mock()
        controller.signal.add_event_listener("abort", callback)

        controller.abort()

        assert controller.signal.aborted is True
        callback.assert_called_once()

    def test_multiple_aborts(self) -> None:
        """Test multiple abort calls."""
        controller = AbortController()
        callback = Mock()
        controller.signal.add_event_listener("abort", callback)

        controller.abort()
        controller.abort()  # Should not call callback again

        callback.assert_called_once()

    def test_remove_listener(self) -> None:
        """Test removing event listener."""
        controller = AbortController()
        callback = Mock()
        controller.signal.add_event_listener("abort", callback)
        controller.signal.remove_event_listener("abort", callback)

        controller.abort()

        callback.assert_not_called()


class TestAbortSignal:
    """Tests for AbortSignal."""

    def test_not_aborted_initially(self) -> None:
        """Test signal is not aborted initially."""
        signal = AbortSignal()
        assert signal.aborted is False

    def test_aborted_property(self) -> None:
        """Test aborted property."""
        signal = AbortSignal()
        assert signal.aborted is False
        signal._aborted = True
        assert signal.aborted is True


class TestProcessTransportOptions:
    """Tests for ProcessTransportOptions."""

    def test_default_values(self) -> None:
        """Test default option values."""
        from qwen_code.transport import ProcessTransportOptions

        options = ProcessTransportOptions(command=["test"])
        assert options.cwd is None
        assert options.env is None
        assert options.abort_controller is None
        assert options.debug is False

    def test_custom_values(self) -> None:
        """Test custom option values."""
        from qwen_code.transport import ProcessTransportOptions

        abort_controller = AbortController()
        options = ProcessTransportOptions(
            command=["test", "arg"],
            cwd="/tmp",
            env={"KEY": "value"},
            abort_controller=abort_controller,
            debug=True,
        )
        assert options.command == ["test", "arg"]
        assert options.cwd == "/tmp"
        assert options.env == {"KEY": "value"}
        assert options.abort_controller is abort_controller
        assert options.debug is True


class TestAbortControllerEdgeCases:
    """Edge case tests for AbortController."""

    def test_abort_calls_callback_with_signal(self) -> None:
        """Test that abort calls callback with the signal."""
        controller = AbortController()
        captured_signal = []

        def callback(signal):
            captured_signal.append(signal)

        controller.signal.add_event_listener("abort", callback)
        controller.abort()

        assert len(captured_signal) == 1
        assert captured_signal[0] is controller.signal

    def test_signal_refers_to_controller(self) -> None:
        """Test that signal refers back to controller."""
        controller = AbortController()
        # The signal should have a reference to its controller
        assert hasattr(controller.signal, "_controller")
        assert controller.signal._controller is controller

    def test_no_callback_registered(self) -> None:
        """Test abort with no callback registered."""
        controller = AbortController()
        # Should not raise
        controller.abort()
        assert controller.signal.aborted is True


class TestAbortSignalEdgeCases:
    """Edge case tests for AbortSignal."""

    def test_callback_not_called_if_not_aborted(self) -> None:
        """Test that callback is not called if not aborted."""
        signal = AbortSignal()
        callback = Mock()
        signal.add_event_listener("abort", callback)

        # Do not abort
        assert signal.aborted is False
        callback.assert_not_called()

    def test_multiple_callbacks(self) -> None:
        """Test multiple callbacks registered."""
        signal = AbortSignal()
        callback1 = Mock()
        callback2 = Mock()
        signal.add_event_listener("abort", callback1)
        signal.add_event_listener("abort", callback2)

        signal._aborted = True
        for callback in signal._listeners:
            callback(signal)

        callback1.assert_called_once()
        callback2.assert_called_once()

    def test_remove_nonexistent_listener(self) -> None:
        """Test removing a listener that was never added."""
        signal = AbortSignal()
        callback = Mock()
        # Should not raise
        signal.remove_event_listener("abort", callback)
