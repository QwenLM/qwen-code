from __future__ import annotations

import base64
import json
import tempfile
import unittest
from pathlib import Path

from ._tool_test_harness import build_env, run_tool


class ImgToolSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.env = build_env()
        cls.tmpdir_obj = tempfile.TemporaryDirectory(prefix="img-tool-smoke-")
        cls.tmpdir = Path(cls.tmpdir_obj.name)

        png_bytes = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5n2WQAAAAASUVORK5CYII="
        )
        cls.input_png = cls.tmpdir / "input.png"
        cls.input_png.write_bytes(png_bytes)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmpdir_obj.cleanup()

    def run_tool(self, *args: str):
        return run_tool("img-tool", *args, env=self.env)

    def test_info_resize_convert(self) -> None:
        info = self.run_tool("info", str(self.input_png))
        self.assertEqual(info.returncode, 0, msg=info.stderr)
        meta = json.loads(info.stdout)
        self.assertEqual(meta["format"], "PNG")

        resized = self.tmpdir / "resized.png"
        resize = self.run_tool("resize", str(self.input_png), "--scale", "2", "-o", str(resized))
        self.assertEqual(resize.returncode, 0, msg=resize.stderr)
        self.assertTrue(resized.exists())

        converted = self.tmpdir / "converted.jpg"
        conv = self.run_tool("convert", str(resized), "--format", "jpg", "-o", str(converted))
        self.assertEqual(conv.returncode, 0, msg=conv.stderr)
        self.assertTrue(converted.exists())

    def test_invalid_resize_fails(self) -> None:
        bad = self.tmpdir / "bad.png"
        result = self.run_tool("resize", str(self.input_png), "--scale", "0", "-o", str(bad))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be positive", result.stderr)


if __name__ == "__main__":
    unittest.main()
