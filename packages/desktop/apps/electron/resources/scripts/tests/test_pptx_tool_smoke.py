from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ._tool_test_harness import build_env, run_tool


class PptxToolSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.env = build_env()
        cls.tmpdir_obj = tempfile.TemporaryDirectory(prefix="pptx-tool-smoke-")
        cls.tmpdir = Path(cls.tmpdir_obj.name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmpdir_obj.cleanup()

    def run_tool(self, *args: str):
        return run_tool("pptx-tool", *args, env=self.env)

    def test_create_info_extract(self) -> None:
        deck = self.tmpdir / "deck.pptx"
        create = self.run_tool(
            "create",
            "--title",
            "Smoke Deck",
            "--text",
            "# Slide One\nHello slide\n---\n# Slide Two\nWorld",
            "-o",
            str(deck),
        )
        self.assertEqual(create.returncode, 0, msg=create.stderr)
        self.assertTrue(deck.exists())

        info = self.run_tool("info", str(deck))
        self.assertEqual(info.returncode, 0, msg=info.stderr)
        meta = json.loads(info.stdout)
        self.assertGreaterEqual(meta["slide_count"], 2)

        extracted = self.run_tool("extract", str(deck))
        self.assertEqual(extracted.returncode, 0, msg=extracted.stderr)
        self.assertIn("Hello slide", extracted.stdout)
        self.assertIn("World", extracted.stdout)

    def test_extract_invalid_slide_fails(self) -> None:
        deck = self.tmpdir / "bad-slide.pptx"
        create = self.run_tool("create", "--title", "One", "-o", str(deck))
        self.assertEqual(create.returncode, 0, msg=create.stderr)

        result = self.run_tool("extract", str(deck), "--slide", "99")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("out of range", result.stderr)


if __name__ == "__main__":
    unittest.main()
