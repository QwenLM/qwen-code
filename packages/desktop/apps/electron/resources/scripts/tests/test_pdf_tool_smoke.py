"""Smoke tests for pdf_tool hardening behaviors.

Run manually:
    cd /Users/balintorosz/Documents/GitHub/craft-agents
    python3 -m unittest apps.electron.resources.scripts.tests.test_pdf_tool_smoke
"""

from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from ._tool_test_harness import REPO_ROOT, build_env, run_tool


class PdfToolSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.env = build_env()

        cls.tmpdir_obj = tempfile.TemporaryDirectory(prefix="pdf-tool-smoke-")
        cls.tmpdir = Path(cls.tmpdir_obj.name)

        # Small 1x1 transparent PNG.
        png_bytes = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5n2WQAAAAASUVORK5CYII="
        )
        image_paths: list[Path] = []
        for i in range(3):
            tiny_img = cls.tmpdir / f"tiny_img_{i + 1}.png"
            tiny_img.write_bytes(png_bytes)
            img_path = cls.tmpdir / f"img_{i + 1}.png"
            resized = run_tool(
                "img-tool",
                "resize",
                str(tiny_img),
                "--width",
                "200",
                "--height",
                "200",
                "-o",
                str(img_path),
                env=cls.env,
            )
            if resized.returncode != 0:
                raise RuntimeError(f"Failed to resize fixture image: {resized.stderr}")
            image_paths.append(img_path)

        cls.input_pdf = cls.tmpdir / "input.pdf"
        result = run_tool(
            "pdf-tool",
            "from-image",
            *(str(p) for p in image_paths),
            "-o",
            str(cls.input_pdf),
            env=cls.env,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to create fixture PDF: {result.stderr}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmpdir_obj.cleanup()

    def run_tool(self, *args: str):
        return run_tool("pdf-tool", *args, env=self.env)

    def test_invalid_pages_out_of_range_fails(self) -> None:
        result = self.run_tool("extract", str(self.input_pdf), "--pages", "999")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("out of bounds", result.stderr)

    def test_reorder_conflicting_flags_fails(self) -> None:
        output = self.tmpdir / "reordered.pdf"
        result = self.run_tool(
            "reorder",
            str(self.input_pdf),
            "--order",
            "1,2",
            "--reverse",
            "-o",
            str(output),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("mutually exclusive", result.stderr)

    def test_duplicate_copies_lower_bound_fails(self) -> None:
        output = self.tmpdir / "dup.pdf"
        result = self.run_tool(
            "duplicate",
            str(self.input_pdf),
            "--pages",
            "1",
            "--copies",
            "1",
            "-o",
            str(output),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("x>=2", result.stderr)

    def test_to_pptx_invalid_selection_fails_gracefully(self) -> None:
        output = self.tmpdir / "out.pptx"
        result = self.run_tool(
            "to-pptx",
            str(self.input_pdf),
            "--pages",
            "999",
            "-o",
            str(output),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("out of bounds", result.stderr)
        self.assertNotIn("IndexError", result.stderr)

    def test_sanitize_happy_path(self) -> None:
        output = self.tmpdir / "sanitized.pdf"
        result = self.run_tool("sanitize", str(self.input_pdf), "-o", str(output))
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertTrue(output.exists())


if __name__ == "__main__":
    unittest.main()
