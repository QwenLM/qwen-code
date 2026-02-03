"""Tests for error types (api module)."""

import pytest

from qwen_code.api import AbortError, is_abort_error


class TestAbortError:
    """Tests for AbortError class."""

    def test_default_message(self) -> None:
        """Test default abort error message."""
        error = AbortError()
        assert error.message == "Operation aborted"
        assert error.name == "AbortError"

    def test_custom_message(self) -> None:
        """Test custom abort error message."""
        error = AbortError("Custom abort message")
        assert error.message == "Custom abort message"
        assert error.name == "AbortError"

    def test_repr(self) -> None:
        """Test __repr__ method."""
        error = AbortError("test message")
        assert repr(error) == "AbortError('test message')"

    def test_str(self) -> None:
        """Test __str__ method returns message."""
        error = AbortError("test message")
        assert str(error) == "test message"

    def test_isinstance(self) -> None:
        """Test that AbortError is instance of Exception."""
        error = AbortError()
        assert isinstance(error, Exception)
        assert isinstance(error, AbortError)


class TestIsAbortError:
    """Tests for is_abort_error function."""

    def test_returns_true_for_abort_error(self) -> None:
        """Test that function returns True for AbortError."""
        error = AbortError()
        assert is_abort_error(error) is True

    def test_returns_true_for_custom_message(self) -> None:
        """Test with custom message."""
        error = AbortError("custom message")
        assert is_abort_error(error) is True

    def test_returns_false_for_standard_error(self) -> None:
        """Test that function returns False for other exceptions."""
        assert is_abort_error(ValueError("test")) is False
        assert is_abort_error(RuntimeError("test")) is False
        assert is_abort_error(Exception("test")) is False

    def test_returns_false_for_non_exceptions(self) -> None:
        """Test that function returns False for non-exception values."""
        assert is_abort_error("string") is False
        assert is_abort_error(123) is False
        assert is_abort_error(None) is False

    def test_checks_name_attribute(self) -> None:
        """Test checking name attribute on exception."""
        class CustomError(Exception):
            def __init__(self, message: str) -> None:
                super().__init__(message)
                self.name = "AbortError"

        error = CustomError("test")
        assert is_abort_error(error) is True

    def test_checks_dict(self) -> None:
        """Test checking dict with name field."""
        assert is_abort_error({"name": "AbortError"}) is True
        assert is_abort_error({"name": "OtherError"}) is False
        assert is_abort_error({}) is False
