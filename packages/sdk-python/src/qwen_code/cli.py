"""CLI path utilities for qwen-code SDK.

Based on TypeScript SDK cliPath.ts implementation.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from typing import Optional, Dict, Any

# Optional: whichcraft for more sophisticated command lookup
try:
    import whichcraft
    WHICHCRAFT_AVAILABLE = True
except ImportError:
    WHICHCRAFT_AVAILABLE = False


@dataclass
class SpawnInfo:
    """Information about how to spawn the CLI."""

    type: str  # 'path' | 'command'
    command: str
    args: list[str] = None


def prepare_spawn_info(
    path_to_qwen_executable: Optional[str] = None,
) -> SpawnInfo:
    """Prepare spawn information for the qwen-code CLI.

    Based on TypeScript SDK prepareSpawnInfo function.

    Args:
        path_to_qwen_executable: Optional explicit path to the qwen-code executable.

    Returns:
        SpawnInfo object with command and arguments.

    Raises:
        FileNotFoundError: If qwen-code executable is not found.
    """
    # If explicit path is provided, use it directly
    if path_to_qwen_executable:
        # Resolve to absolute path if needed
        if not os.path.isabs(path_to_qwen_executable):
            resolved = shutil.which(path_to_qwen_executable)
            if resolved:
                return SpawnInfo(
                    type="path",
                    command=resolved,
                    args=[],
                )
        else:
            return SpawnInfo(
                type="path",
                command=path_to_qwen_executable,
                args=[],
            )

    # Try to find qwen-code in PATH
    executable_path = shutil.which("qwen-code")
    if executable_path:
        return SpawnInfo(
            type="path",
            command=executable_path,
            args=[],
        )

    # Try common installation paths
    common_paths = [
        "/usr/local/bin/qwen-code",
        "/usr/bin/qwen-code",
        os.path.expanduser("~/.local/bin/qwen-code"),
    ]

    for path in common_paths:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return SpawnInfo(
                type="path",
                command=path,
                args=[],
            )

    # If still not found, try using whichcraft for more sophisticated lookup
    if WHICHCRAFT_AVAILABLE:
        try:
            command = whichcraft.which("qwen-code")
            if command:
                return SpawnInfo(
                    type="command",
                    command=command,
                    args=[],
                )
        except whichcraft.CommandNotFound:
            pass

    # If using npx (common for development)
    if os.path.isfile(os.path.join(os.getcwd(), "package.json")):
        try:
            import subprocess
            result = subprocess.run(
                ["npx", "--yes", "qwen-code", "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0:
                return SpawnInfo(
                    type="command",
                    command="npx",
                    args=["--yes", "qwen-code"],
                )
        except (subprocess.SubprocessError, FileNotFoundError):
            pass

    raise FileNotFoundError(
        "qwen-code executable not found in PATH. "
        "Please install qwen-code or provide an explicit path."
    )


def get_qwen_code_version() -> Optional[str]:
    """Get the version of qwen-code CLI if available.

    Returns:
        Version string if found, None otherwise.
    """
    try:
        spawn_info = prepare_spawn_info()
    except FileNotFoundError:
        return None

    try:
        import subprocess
    except ImportError:
        return None

    try:
        result = subprocess.run(
            [spawn_info.command, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )

        if result.returncode == 0:
            # Parse version from output (format varies)
            output = result.stdout.strip() or result.stderr.strip()
            # Common patterns: "qwen-code x.y.z" or "x.y.z"
            parts = output.split()
            if len(parts) >= 2:
                return parts[-1]
            elif parts:
                return parts[0]

    except (FileNotFoundError, subprocess.SubprocessError):
        pass

    return None


def is_qwen_code_available() -> bool:
    """Check if qwen-code CLI is available.

    Returns:
        True if qwen-code is available, False otherwise.
    """
    try:
        prepare_spawn_info()
        return True
    except FileNotFoundError:
        return False


__all__ = [
    "SpawnInfo",
    "prepare_spawn_info",
    "get_qwen_code_version",
    "is_qwen_code_available",
]
