from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from ._tool_test_harness import build_env, run_tool


class MarkitdownSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.env = build_env()
        cls.tmpdir_obj = tempfile.TemporaryDirectory(prefix="markitdown-smoke-")
        cls.tmpdir = Path(cls.tmpdir_obj.name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmpdir_obj.cleanup()

    def run_markitdown(self, *args: str):
        return run_tool("markitdown", *args, env=self.env)

    def run_docx(self, *args: str):
        return run_tool("docx-tool", *args, env=self.env)

    def test_plain_text_passthrough(self) -> None:
        txt = self.tmpdir / "plain.txt"
        txt.write_text("hello craft", encoding="utf-8")

        result = self.run_markitdown(str(txt))
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("hello craft", result.stdout)

    def test_docx_fallback_path(self) -> None:
        docx = self.tmpdir / "sample.docx"
        create = self.run_docx("create", "--text", "Hello from docx", "-o", str(docx))
        self.assertEqual(create.returncode, 0, msg=create.stderr)

        result = self.run_markitdown(str(docx))
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Hello from docx", result.stdout)


if __name__ == "__main__":
    unittest.main()
