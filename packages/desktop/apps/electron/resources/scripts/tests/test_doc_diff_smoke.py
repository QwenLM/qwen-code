from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from ._tool_test_harness import build_env, run_tool


class DocDiffSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.env = build_env()
        cls.tmpdir_obj = tempfile.TemporaryDirectory(prefix="doc-diff-smoke-")
        cls.tmpdir = Path(cls.tmpdir_obj.name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmpdir_obj.cleanup()

    def run_tool(self, *args: str):
        return run_tool("doc-diff", *args, env=self.env)

    def test_diff_summary_works(self) -> None:
        f1 = self.tmpdir / "a.txt"
        f2 = self.tmpdir / "b.txt"
        f1.write_text("hello\nworld\n", encoding="utf-8")
        f2.write_text("hello\ncraft\n", encoding="utf-8")

        result = self.run_tool(str(f1), str(f2), "--format", "summary")
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Comparison:", result.stdout)
        self.assertIn("Similarity:", result.stdout)

    def test_missing_file_fails(self) -> None:
        f1 = self.tmpdir / "exists.txt"
        f1.write_text("x", encoding="utf-8")
        missing = self.tmpdir / "missing.txt"

        result = self.run_tool(str(f1), str(missing))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not exist", result.stderr)


if __name__ == "__main__":
    unittest.main()
