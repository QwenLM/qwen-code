from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from ._tool_test_harness import build_env, run_tool


class DocxToolSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.env = build_env()
        cls.tmpdir_obj = tempfile.TemporaryDirectory(prefix="docx-tool-smoke-")
        cls.tmpdir = Path(cls.tmpdir_obj.name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmpdir_obj.cleanup()

    def run_tool(self, *args: str):
        return run_tool("docx-tool", *args, env=self.env)

    def test_create_extract_template_and_replace(self) -> None:
        created = self.tmpdir / "created.docx"
        create = self.run_tool(
            "create",
            "--text",
            "# Report\n\nHello **world**",
            "--title",
            "Q1",
            "-o",
            str(created),
        )
        self.assertEqual(create.returncode, 0, msg=create.stderr)
        self.assertTrue(created.exists())

        extracted = self.run_tool("extract", str(created))
        self.assertEqual(extracted.returncode, 0, msg=extracted.stderr)
        self.assertIn("Report", extracted.stdout)
        self.assertIn("Hello", extracted.stdout)

        template_doc = self.tmpdir / "template.docx"
        tmpl = self.run_tool("create", "--text", "Hello {{name}}", "-o", str(template_doc))
        self.assertEqual(tmpl.returncode, 0, msg=tmpl.stderr)

        filled_doc = self.tmpdir / "filled.docx"
        fill = self.run_tool(
            "template",
            str(template_doc),
            "--data",
            '{"name":"Balint"}',
            "-o",
            str(filled_doc),
        )
        self.assertEqual(fill.returncode, 0, msg=fill.stderr)

        extracted_filled = self.run_tool("extract", str(filled_doc))
        self.assertEqual(extracted_filled.returncode, 0, msg=extracted_filled.stderr)
        self.assertIn("Balint", extracted_filled.stdout)

        replaced_doc = self.tmpdir / "replaced.docx"
        repl = self.run_tool(
            "replace",
            str(filled_doc),
            "--find",
            "Balint",
            "--replace-with",
            "Craft Agent",
            "-o",
            str(replaced_doc),
        )
        self.assertEqual(repl.returncode, 0, msg=repl.stderr)

        extracted_replaced = self.run_tool("extract", str(replaced_doc))
        self.assertIn("Craft Agent", extracted_replaced.stdout)

    def test_template_invalid_json_fails(self) -> None:
        template_doc = self.tmpdir / "bad-template.docx"
        create = self.run_tool("create", "--text", "Hello {{name}}", "-o", str(template_doc))
        self.assertEqual(create.returncode, 0, msg=create.stderr)

        out = self.tmpdir / "bad-output.docx"
        result = self.run_tool("template", str(template_doc), "--data", "{not-json}", "-o", str(out))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Error parsing JSON", result.stderr)


if __name__ == "__main__":
    unittest.main()
