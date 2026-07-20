from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Any


class Artifacts:
    def __init__(self, root: Path, run_id: str):
        self.path = root / run_id
        self.path.mkdir(parents=True, exist_ok=True)

    def write_json(self, relative_path: str, value: Any) -> Path:
        target = self.path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(
            json.dumps(value, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, target)
        return target

    def copy(self, source: Path, relative_path: str) -> Path:
        target = self.path / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".tmp")
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
        return target

    def copy_tree(self, source: Path, relative_path: str) -> None:
        if not source.exists():
            return
        target = self.path / relative_path
        target.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target, dirs_exist_ok=True)

    def write_checksums(self) -> Path:
        lines: list[str] = []
        for path in sorted(self.path.rglob("*")):
            if not path.is_file() or path.name == "checksums.sha256":
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            lines.append(f"{digest}  {path.relative_to(self.path)}")
        target = self.path / "checksums.sha256"
        target.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return target
