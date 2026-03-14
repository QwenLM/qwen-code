"""Error types for qwen-code SDK.

Based on TypeScript SDK error handling patterns.
"""

from __future__ import annotations

from typing import Any


class AbortError(Exception):
    """Exception raised when an operation is aborted.

    Corresponds to AbortError in TypeScript SDK.
    """

    def __init__(self, message: str = "Operation aborted") -> None:
        super().__init__(message)
        self.name = "AbortError"
        self.message = message

    def __repr__(self) -> str:
        return f"AbortError({self.message!r})"

    def __str__(self) -> str:
        return self.message


def is_abort_error(error: Any) -> bool:
    """Check if an error is an AbortError.

    Args:
        error: The error to check.

    Returns:
        True if the error is an AbortError.
    """
    if isinstance(error, AbortError):
        return True
    if isinstance(error, BaseException):
        return getattr(error, "name", None) == "AbortError"
    if isinstance(error, dict):
        return error.get("name") == "AbortError"
    return False


__all__ = [
    "AbortError",
    "is_abort_error",
]
