"""Error types for qwen_code_sdk."""

from __future__ import annotations


class QwenSDKError(Exception):
    """Base error for all SDK failures."""


class ValidationError(QwenSDKError):
    """Raised when query options are invalid."""


class AbortError(QwenSDKError):
    """Raised when an operation is aborted by caller or transport."""


class ProcessExitError(QwenSDKError):
    """Raised when qwen CLI exits with non-zero status or signal."""


class ControlRequestTimeoutError(QwenSDKError):
    """Raised when a control request times out waiting for response."""
