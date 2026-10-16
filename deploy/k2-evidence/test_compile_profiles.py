import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import test_render_profiles as fixtures


spec = importlib.util.spec_from_file_location("compile_profiles", Path(__file__).with_name("compile-profiles.py"))
COMPILER = importlib.util.module_from_spec(spec)
spec.loader.exec_module(COMPILER)


class CompileProfilesDataTest(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.RenderProfilesTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.render()
        self.candidate = self.fixture.output
        self.manifest = self.candidate / "profile-candidate.json"
        self.parser = self.fixture.root / "inert-parser"
        self.parser.write_bytes(fixtures.inert_elf())
        self.features = self.fixture.root / "inert-features"
        self.features.write_bytes(b"explicit synthetic feature data, never parsed\n")
        self.output = self.fixture.root / "compile-preparation"

    def prepare(self):
        with patch.object(COMPILER.subprocess, "run", side_effect=AssertionError("parser execution is outside these data tests")):
            return COMPILER.prepare(self.candidate, fixtures.digest(self.manifest), self.parser, fixtures.digest(self.parser), self.features, fixtures.digest(self.features), self.output)

    def test_preparation_copies_exact_inputs_without_executing_parser(self):
        record = self.prepare()
        for name, original in (("parser", self.parser), ("features", self.features), ("qwen-k2-profiles", self.candidate / "qwen-k2-profiles"), ("profile-candidate.json", self.manifest)):
            self.assertEqual(original.read_bytes(), (self.output / name).read_bytes())
        self.assertEqual(b"", (self.output / "parser.conf").read_bytes())
        self.assertEqual(0o500, (self.output / "parser").stat().st_mode & 0o777)
        self.assertEqual(0o400, (self.output / "features").stat().st_mode & 0o777)
        self.assertEqual(str(self.output / "parser"), record["command"][0])
        self.assertEqual(fixtures.digest(self.parser), record["parserSha256"])
        self.assertNotIn("exitCode", record)
        self.assertFalse((self.output / "packed.bin").exists())
        self.assertFalse((self.output / "compile.json").exists())

    def test_command_uses_explicit_features_no_load_and_no_cache(self):
        command = COMPILER.command(self.parser, self.output)
        self.assertEqual([
            str(self.parser), "--config-file=" + str(self.output / "parser.conf"), "--base=" + str(self.output),
            "--policy-features=" + str(self.output / "features"), "--kernel-features=" + str(self.output / "features"),
            "--skip-kernel-load", "--skip-cache", "--stdout", "--jobs=0", "--abort-on-error", "--Werror",
            "--warn=rule-not-enforced", str(self.output / "qwen-k2-profiles"),
        ], command)

    def test_changed_candidate_file_refuses_before_output(self):
        path = self.candidate / "source-config.json"
        path.chmod(0o600)
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "input bytes differ"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_candidate_path_injection_and_extra_fields_refuse(self):
        value = json.loads(self.manifest.read_bytes())
        pin = value["files"].pop("source-config.json")
        value["files"]["../source-config.json"] = pin
        self.manifest.chmod(0o600)
        self.manifest.write_bytes(fixtures.POLICY.encoded(value))
        with self.assertRaisesRegex(ValueError, "complete generated profile candidate"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_flat_source_rejects_extra_or_nested_profiles(self):
        raw = (self.candidate / "qwen-k2-profiles").read_bytes()
        COMPILER.source(raw)
        for candidate in (raw + b"profile unexpected {\n}\n", raw.replace(b"  capability sys_ptrace,", b"  profile unexpected {\n  }", 1), raw + b"}\n"):
            with self.subTest(candidate=candidate[-50:]):
                with self.assertRaises(ValueError):
                    COMPILER.source(candidate)

    def test_flat_source_rejects_ambient_policy_inputs(self):
        raw = (self.candidate / "qwen-k2-profiles").read_bytes()
        for prefix in (b"#include <tunables/global>\n", b"abi <abi/4.0>,\n", b"alias /a -> /b,\n", b"@{caller}=/**\n"):
            with self.assertRaisesRegex(ValueError, "no includes"):
                COMPILER.source(prefix + raw)

    def test_invalid_parser_is_data_refusal_without_execution(self):
        self.parser.write_bytes(b"not an executable")
        with self.assertRaisesRegex(ValueError, "parser ELF"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        marker = self.output / "keep"
        marker.write_bytes(b"original")
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual([marker], list(self.output.iterdir()))
        self.assertEqual(b"original", marker.read_bytes())


if __name__ == "__main__":
    unittest.main()
