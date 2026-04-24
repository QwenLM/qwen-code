"""Pytest configuration for qwen-code SDK tests."""

import sys
from pathlib import Path

# Add src directory to path for testing
src_path = Path(__file__).parent.parent / "src"
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))
