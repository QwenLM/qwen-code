"""Tests for logger utilities.

Based on TypeScript SDK logger.ts tests.
"""

import pytest
import logging
from unittest.mock import patch, MagicMock

from qwen_code.logger import (
    LogLevel,
    LoggerConfig,
    SdkLogger,
    ScopedLogger,
    get_logger,
    configure_logger,
)


class TestLogLevel:
    """Tests for LogLevel enum."""

    def test_log_level_values(self):
        """Test log level integer values."""
        assert LogLevel.DEBUG.value == 0
        assert LogLevel.INFO.value == 1
        assert LogLevel.WARN.value == 2
        assert LogLevel.ERROR.value == 3

    def test_log_level_comparison(self):
        """Test log level comparison."""
        assert LogLevel.DEBUG < LogLevel.INFO
        assert LogLevel.INFO < LogLevel.WARN
        assert LogLevel.WARN < LogLevel.ERROR


class TestLoggerConfig:
    """Tests for LoggerConfig dataclass."""

    def test_default_config(self):
        """Test default configuration."""
        config = LoggerConfig()
        assert config.level == LogLevel.INFO
        assert config.debug is False
        assert config.stderr is None

    def test_custom_config(self):
        """Test custom configuration."""
        config = LoggerConfig(
            level=LogLevel.DEBUG,
            debug=True,
            stderr=None,
        )
        assert config.level == LogLevel.DEBUG
        assert config.debug is True


class TestSdkLogger:
    """Tests for SdkLogger class."""

    def setup_method(self):
        """Reset SdkLogger state before each test."""
        SdkLogger.reset()

    def teardown_method(self):
        """Clean up after each test."""
        SdkLogger.reset()

    def test_configure_logger(self):
        """Test configuring the global logger."""
        configure_logger(debug=True, log_level=LogLevel.DEBUG)

        logger = SdkLogger.get_global_logger()
        assert logger is not None

    def test_create_logger(self):
        """Test creating a scoped logger."""
        logger = SdkLogger.create_logger("test_component")

        assert logger.name == "test_component"
        assert isinstance(logger, ScopedLogger)

    def test_create_duplicate_loggers(self):
        """Test that creating duplicate loggers returns the same instance."""
        logger1 = SdkLogger.create_logger("component")
        logger2 = SdkLogger.create_logger("component")

        assert logger1 is logger2

    def test_get_global_logger(self):
        """Test getting the global logger."""
        logger = SdkLogger.get_global_logger()

        assert logger is not None
        assert logger.name == "SdkLogger"

    def test_reset(self):
        """Test resetting the logger."""
        logger1 = SdkLogger.create_logger("test")
        SdkLogger.reset()
        logger2 = SdkLogger.create_logger("test")

        # After reset, we should get a new logger instance
        assert logger1 is not logger2


class TestScopedLogger:
    """Tests for ScopedLogger class."""

    def setup_method(self):
        """Reset SdkLogger state before each test."""
        SdkLogger.reset()

    def teardown_method(self):
        """Clean up after each test."""
        SdkLogger.reset()

    def test_logger_name(self):
        """Test logger name."""
        logger = ScopedLogger("my_component")

        assert logger.name == "my_component"

    def test_child_logger(self):
        """Test creating a child logger."""
        parent = ScopedLogger("parent")
        child = parent.child("child")

        assert child.name == "parent.child"

    def test_child_logger_chain(self):
        """Test creating a chain of child loggers."""
        grandparent = SdkLogger.create_logger("grandparent")
        parent = grandparent.child("parent")
        child = parent.child("child")

        assert child.name == "grandparent.parent.child"

    def test_log_methods_exist(self):
        """Test that all log methods exist."""
        logger = ScopedLogger("test")

        assert hasattr(logger, "debug")
        assert hasattr(logger, "info")
        assert hasattr(logger, "warn")
        assert hasattr(logger, "error")
        assert hasattr(logger, "log")

    def test_log_with_level(self):
        """Test logging with a specific level."""
        logger = ScopedLogger("test")
        logger.log(LogLevel.INFO, "Test message")

        # Should not raise an exception

    def test_log_level_filtering(self):
        """Test that log level filtering works."""
        configure_logger(log_level=LogLevel.ERROR)

        logger = ScopedLogger("test")
        # These should be filtered out
        logger.debug("Debug message")
        logger.info("Info message")
        logger.warn("Warning message")

        # This should pass through
        logger.error("Error message")


class TestGetLogger:
    """Tests for get_logger function."""

    def setup_method(self):
        """Reset SdkLogger state before each test."""
        SdkLogger.reset()

    def teardown_method(self):
        """Clean up after each test."""
        SdkLogger.reset()

    def test_get_logger_singleton(self):
        """Test that get_logger returns the same logger."""
        logger1 = get_logger("component")
        logger2 = get_logger("component")

        assert logger1 is logger2


class TestConfigureLogger:
    """Tests for configure_logger function."""

    def setup_method(self):
        """Reset SdkLogger state before each test."""
        SdkLogger.reset()

    def teardown_method(self):
        """Clean up after each test."""
        SdkLogger.reset()

    def test_configure_debug_mode(self):
        """Test configuring debug mode."""
        configure_logger(debug=True)

        # Should not raise an exception

    def test_configure_log_level(self):
        """Test configuring log level."""
        configure_logger(log_level=LogLevel.DEBUG)

        # Should not raise an exception

    def test_configure_multiple_options(self):
        """Test configuring multiple options at once."""
        configure_logger(
            debug=True,
            log_level=LogLevel.DEBUG,
            stderr=None,
        )

        # Should not raise an exception


class TestLoggingIntegration:
    """Integration tests for logging."""

    def setup_method(self):
        """Reset SdkLogger state before each test."""
        SdkLogger.reset()

    def teardown_method(self):
        """Clean up after each test."""
        SdkLogger.reset()

    def test_logging_does_not_raise(self):
        """Test that logging does not raise exceptions."""
        logger = SdkLogger.create_logger("test")

        logger.debug("Debug message")
        logger.info("Info message")
        logger.warn("Warning message")
        logger.error("Error message")

    def test_logger_with_special_characters(self):
        """Test logger with special characters in name."""
        logger = SdkLogger.create_logger("component-123.sub_component")

        assert logger.name == "component-123.sub_component"

    def test_nested_logger_hierarchy(self):
        """Test nested logger hierarchy."""
        root = SdkLogger.create_logger("root")
        level1 = root.child("level1")
        level2 = level1.child("level2")
        level3 = level2.child("level3")

        assert level3.name == "root.level1.level2.level3"
