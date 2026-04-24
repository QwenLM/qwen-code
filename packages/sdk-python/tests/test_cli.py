"""Tests for CLI utilities.

Based on TypeScript SDK cliPath.ts tests.
"""

import pytest
import os
import sys
from unittest.mock import patch, MagicMock

from qwen_code.cli import (
    SpawnInfo,
    prepare_spawn_info,
    get_qwen_code_version,
    is_qwen_code_available,
)


class TestSpawnInfo:
    """Tests for SpawnInfo dataclass."""

    def test_spawn_info_creation(self):
        """Test creating a SpawnInfo object."""
        spawn_info = SpawnInfo(
            type="path",
            command="/usr/bin/qwen-code",
            args=[],
        )
        assert spawn_info.type == "path"
        assert spawn_info.command == "/usr/bin/qwen-code"
        assert spawn_info.args == []

    def test_spawn_info_default_args(self):
        """Test SpawnInfo with default args."""
        spawn_info = SpawnInfo(
            type="command",
            command="npx",
        )
        # args defaults to empty list
        assert spawn_info.args == [] or spawn_info.args is None


class TestPrepareSpawnInfo:
    """Tests for prepare_spawn_info function."""

    @patch("qwen_code.cli.shutil.which")
    def test_with_explicit_path(self, mock_which):
        """Test with explicit path provided."""
        mock_which.return_value = "/usr/local/bin/qwen-code"

        result = prepare_spawn_info("/custom/path/qwen-code")

        assert result.type == "path"
        assert result.command == "/custom/path/qwen-code"
        mock_which.assert_not_called()

    @patch("qwen_code.cli.shutil.which")
    def test_find_in_path(self, mock_which):
        """Test finding qwen-code in PATH."""
        mock_which.return_value = "/usr/bin/qwen-code"

        result = prepare_spawn_info()

        assert result.type == "path"
        assert result.command == "/usr/bin/qwen-code"

    @patch("qwen_code.cli.shutil.which")
    def test_not_found(self, mock_which):
        """Test when qwen-code is not found."""
        mock_which.return_value = None

        with pytest.raises(FileNotFoundError) as exc_info:
            prepare_spawn_info()

        assert "qwen-code executable not found" in str(exc_info.value)


class TestGetQwenCodeVersion:
    """Tests for get_qwen_code_version function."""

    @patch("qwen_code.cli.prepare_spawn_info")
    def test_get_version_not_available(self, mock_prepare):
        """Test when version is not available."""
        mock_prepare.side_effect = FileNotFoundError("Not found")

        version = get_qwen_code_version()

        assert version is None


class TestIsQwenCodeAvailable:
    """Tests for is_qwen_code_available function."""

    @patch("qwen_code.cli.prepare_spawn_info")
    def test_available(self, mock_prepare):
        """Test when qwen-code is available."""
        mock_prepare.return_value = SpawnInfo(
            type="path",
            command="/usr/bin/qwen-code",
        )

        result = is_qwen_code_available()

        assert result is True

    @patch("qwen_code.cli.prepare_spawn_info")
    def test_not_available(self, mock_prepare):
        """Test when qwen-code is not available."""
        mock_prepare.side_effect = FileNotFoundError("Not found")

        result = is_qwen_code_available()

        assert result is False


class TestIntegration:
    """Integration tests for CLI utilities."""

    def test_spawn_info_repr(self):
        """Test SpawnInfo string representation."""
        spawn_info = SpawnInfo(
            type="path",
            command="/usr/bin/qwen-code",
            args=["--flag"],
        )
        repr_str = repr(spawn_info)
        assert "SpawnInfo" in repr_str
        assert "path" in repr_str
