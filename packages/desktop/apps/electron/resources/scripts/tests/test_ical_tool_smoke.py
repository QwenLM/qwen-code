from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ._tool_test_harness import build_env, run_tool


class IcalToolSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.env = build_env()
        cls.tmpdir_obj = tempfile.TemporaryDirectory(prefix="ical-tool-smoke-")
        cls.tmpdir = Path(cls.tmpdir_obj.name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmpdir_obj.cleanup()

    def run_tool(self, *args: str):
        return run_tool("ical-tool", *args, env=self.env)

    def test_create_read_filter(self) -> None:
        calendar = self.tmpdir / "calendar.ics"
        data = json.dumps([
            {
                "summary": "Planning",
                "start": "2026-03-10T10:00:00",
                "end": "2026-03-10T11:00:00",
                "location": "Budapest",
            }
        ])

        create = self.run_tool("create", "--data", data, "--cal-name", "Smoke", "-o", str(calendar))
        self.assertEqual(create.returncode, 0, msg=create.stderr)
        self.assertTrue(calendar.exists())

        read = self.run_tool("read", str(calendar), "--format", "json")
        self.assertEqual(read.returncode, 0, msg=read.stderr)
        parsed = json.loads(read.stdout)
        self.assertEqual(parsed["event_count"], 1)
        self.assertEqual(parsed["events"][0]["summary"], "Planning")

        filtered = self.run_tool(
            "filter",
            str(calendar),
            "--start",
            "2026-03-01",
            "--end",
            "2026-03-31",
            "--format",
            "json",
        )
        self.assertEqual(filtered.returncode, 0, msg=filtered.stderr)
        filtered_json = json.loads(filtered.stdout)
        self.assertEqual(filtered_json["event_count"], 1)

    def test_read_malformed_fails(self) -> None:
        bad = self.tmpdir / "bad.ics"
        bad.write_text("not-a-valid-ics", encoding="utf-8")

        result = self.run_tool("read", str(bad))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Error:", result.stderr)


if __name__ == "__main__":
    unittest.main()
