"""Logging utilities for qwen-code SDK.

Based on TypeScript SDK SdkLogger implementation.
"""

from __future__ import annotations

import sys
import logging
from enum import Enum
from typing import Optional, Dict, Any, Callable
from dataclasses import dataclass, field


class LogLevel(int, Enum):
    """Log levels matching TypeScript SDK."""

    DEBUG = 0
    INFO = 1
    WARN = 2
    ERROR = 3


# Default log level
DEFAULT_LOG_LEVEL = LogLevel.INFO

# Global logger configuration
_global_config: Dict[str, Any] = {
    "level": DEFAULT_LOG_LEVEL,
    "debug": False,
    "stderr": None,
    "log_level": None,
}


@dataclass
class LoggerConfig:
    """Logger configuration."""

    level: LogLevel = DEFAULT_LOG_LEVEL
    debug: bool = False
    stderr: Optional[Any] = None
    log_level: Optional[LogLevel] = None


class SdkLogger:
    """Logger for qwen-code SDK.

    Based on TypeScript SDK SdkLogger class.
    """

    _loggers: Dict[str, "ScopedLogger"] = {}
    _global_logger: Optional["ScopedLogger"] = None

    @staticmethod
    def configure(
        debug: Optional[bool] = None,
        stderr: Optional[Any] = None,
        log_level: Optional[LogLevel] = None,
    ) -> None:
        """Configure global logger settings.

        Args:
            debug: Enable debug mode.
            stderr: Custom stderr stream.
            log_level: Minimum log level.
        """
        if debug is not None:
            _global_config["debug"] = debug
        if stderr is not None:
            _global_config["stderr"] = stderr
        if log_level is not None:
            _global_config["log_level"] = log_level
            _global_config["level"] = log_level

    @staticmethod
    def create_logger(name: str) -> "ScopedLogger":
        """Create a scoped logger with the given name.

        Args:
            name: The logger name (typically class or module name).

        Returns:
            A ScopedLogger instance.
        """
        if name not in SdkLogger._loggers:
            SdkLogger._loggers[name] = ScopedLogger(name)
        return SdkLogger._loggers[name]

    @staticmethod
    def get_global_logger() -> "ScopedLogger":
        """Get the global logger.

        Returns:
            The global ScopedLogger instance.
        """
        if SdkLogger._global_logger is None:
            SdkLogger._global_logger = ScopedLogger("SdkLogger")
        return SdkLogger._global_logger

    @staticmethod
    def reset() -> None:
        """Reset all loggers and configuration."""
        SdkLogger._loggers.clear()
        SdkLogger._global_logger = None
        _global_config["level"] = DEFAULT_LOG_LEVEL
        _global_config["debug"] = False
        _global_config["stderr"] = None


class ScopedLogger:
    """A scoped logger for a specific component.

    Based on TypeScript SDK ScopedLogger implementation.
    """

    def __init__(self, name: str) -> None:
        """Initialize a scoped logger.

        Args:
            name: The scope name.
        """
        self._name = name
        self._logger = logging.getLogger(f"qwen_code.{name}")
        self._configure_logger()

    def _configure_logger(self) -> None:
        """Configure the underlying logger."""
        self._logger.setLevel(logging.DEBUG)
        
        # Add console handler if none exists
        if not self._logger.handlers:
            handler = logging.StreamHandler(sys.stderr)
            handler.setLevel(logging.DEBUG)
            formatter = logging.Formatter(
                "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
            )
            handler.setFormatter(formatter)
            self._logger.addHandler(handler)

    def _should_log(self, level: LogLevel) -> bool:
        """Check if the given level should be logged."""
        config_level = _global_config.get("log_level") or _global_config.get(
            "level", DEFAULT_LOG_LEVEL
        )
        return level.value >= config_level.value

    def debug(self, *args: Any, **kwargs: Any) -> None:
        """Log a debug message."""
        if self._should_log(LogLevel.DEBUG):
            self._logger.debug(*args, **kwargs)

    def info(self, *args: Any, **kwargs: Any) -> None:
        """Log an info message."""
        if self._should_log(LogLevel.INFO):
            self._logger.info(*args, **kwargs)

    def warn(self, *args: Any, **kwargs: Any) -> None:
        """Log a warning message."""
        if self._should_log(LogLevel.WARN):
            self._logger.warning(*args, **kwargs)

    def error(self, *args: Any, **kwargs: Any) -> None:
        """Log an error message."""
        if self._should_log(LogLevel.ERROR):
            self._logger.error(*args, **kwargs)

    def log(
        self,
        level: LogLevel,
        *args: Any,
        **kwargs: Any
    ) -> None:
        """Log a message with the specified level."""
        if self._should_log(level):
            if level == LogLevel.DEBUG:
                self._logger.debug(*args, **kwargs)
            elif level == LogLevel.INFO:
                self._logger.info(*args, **kwargs)
            elif level == LogLevel.WARN:
                self._logger.warning(*args, **kwargs)
            elif level == LogLevel.ERROR:
                self._logger.error(*args, **kwargs)

    @property
    def name(self) -> str:
        """Get the logger name."""
        return self._name

    def child(self, suffix: str) -> "ScopedLogger":
        """Create a child logger with the given suffix.

        Args:
            suffix: The suffix to append to the name.

        Returns:
            A new ScopedLogger instance.
        """
        return SdkLogger.create_logger(f"{self._name}.{suffix}")


# Convenience functions
def get_logger(name: str) -> ScopedLogger:
    """Get a logger with the given name.

    Args:
        name: The logger name.

    Returns:
        A ScopedLogger instance.
    """
    return SdkLogger.create_logger(name)


def configure_logger(
    debug: Optional[bool] = None,
    stderr: Optional[Any] = None,
    log_level: Optional[LogLevel] = None,
) -> None:
    """Configure the global logger.

    Args:
        debug: Enable debug mode.
        stderr: Custom stderr stream.
        log_level: Minimum log level.
    """
    SdkLogger.configure(debug=debug, stderr=stderr, log_level=log_level)


__all__ = [
    "LogLevel",
    "LoggerConfig",
    "SdkLogger",
    "ScopedLogger",
    "get_logger",
    "configure_logger",
]
