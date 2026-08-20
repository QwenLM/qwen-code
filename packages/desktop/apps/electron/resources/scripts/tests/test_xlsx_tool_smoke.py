from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ._tool_test_harness import build_env, run_tool


class XlsxToolSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.env = build_env()
        cls.tmpdir_obj = tempfile.TemporaryDirectory(prefix="xlsx-tool-smoke-")
        cls.tmpdir = Path(cls.tmpdir_obj.name)
        cls.book = cls.tmpdir / "workbook.xlsx"
        bootstrap = run_tool(
            "xlsx-tool",
            "write",
            str(cls.book),
            "--cell",
            "A1",
            "--value",
            "bootstrap",
            env=cls.env,
        )
        if bootstrap.returncode != 0:
            raise RuntimeError(f"Failed to initialize xlsx fixture: {bootstrap.stderr}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmpdir_obj.cleanup()

    def run_tool(self, *args: str):
        return run_tool("xlsx-tool", *args, env=self.env)

    def test_write_read_info_export_and_add_sheet(self) -> None:
        write_a1 = self.run_tool("write", str(self.book), "--cell", "A1", "--value", "name")
        self.assertEqual(write_a1.returncode, 0, msg=write_a1.stderr)

        write_b1 = self.run_tool("write", str(self.book), "--cell", "B1", "--value", "score")
        self.assertEqual(write_b1.returncode, 0, msg=write_b1.stderr)

        write_a2 = self.run_tool("write", str(self.book), "--cell", "A2", "--value", "alice")
        self.assertEqual(write_a2.returncode, 0, msg=write_a2.stderr)

        write_b2 = self.run_tool(
            "write", str(self.book), "--cell", "B2", "--value", "42", "--type", "number"
        )
        self.assertEqual(write_b2.returncode, 0, msg=write_b2.stderr)

        info = self.run_tool("info", str(self.book))
        self.assertEqual(info.returncode, 0, msg=info.stderr)
        meta = json.loads(info.stdout)
        self.assertGreaterEqual(meta["sheet_count"], 1)

        read_json = self.run_tool("read", str(self.book), "--format", "json")
        self.assertEqual(read_json.returncode, 0, msg=read_json.stderr)
        rows = json.loads(read_json.stdout)
        self.assertEqual(rows[0]["name"], "alice")
        self.assertEqual(rows[0]["score"], 42)

        csv_path = self.tmpdir / "workbook.csv"
        exp = self.run_tool("export", str(self.book), "--format", "csv", "-o", str(csv_path))
        self.assertEqual(exp.returncode, 0, msg=exp.stderr)
        self.assertTrue(csv_path.exists())

        add_sheet = self.run_tool("add-sheet", str(self.book), "--name", "Data")
        self.assertEqual(add_sheet.returncode, 0, msg=add_sheet.stderr)

        info2 = self.run_tool("info", str(self.book))
        self.assertEqual(info2.returncode, 0, msg=info2.stderr)
        self.assertIn("Data", info2.stdout)

    def test_invalid_sheet_errors(self) -> None:
        result = self.run_tool("read", str(self.book), "--sheet", "Missing")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not found", result.stderr)


if __name__ == "__main__":
    unittest.main()
