import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("render_pre_exec", Path(__file__).with_name("render-pre-exec.py"))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class RenderPreExecTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="k2-pre-exec-render-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        header = bytearray(64)
        header[:6] = b"\x7fELF\x02\x01"
        header[18:20] = (62).to_bytes(2, "little")
        self.header = bytes(header)
        self.source, self.shim, self.runc = [self.root / name for name in ("source", "shim", "runc")]
        for path in (self.source, self.shim, self.runc):
            path.write_bytes(self.header + path.name.encode())
        self.contract = self.root / "contract.json"
        self.contract.write_bytes((Path(__file__).parents[2] / "packages/managed-agent-server/src/test/resources/contracts/k2-creation-contract-v1.fixture.json").read_bytes())
        self.output = self.root / "candidate"

    def render(self):
        renderer.render(self.source, self.shim, self.runc, "a" * 64, self.contract, self.output)

    def test_exact_artifacts_and_contract_enter_fixed_handler(self):
        self.render()
        shim = json.loads((self.output / "shim.json").read_text())
        self.assertEqual(base64.b64decode(shim["creationContract"]), self.contract.read_bytes())
        manifest = json.loads((self.output / "artifact-manifest.json").read_text())
        for role, path in (("source", self.source), ("shim", self.shim), ("runc", self.runc)):
            self.assertEqual(manifest["artifacts"][role]["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(shim["sourceSha256"], manifest["artifacts"]["source"]["sha256"])
        self.assertEqual(shim["shimSha256"], manifest["artifacts"]["shim"]["sha256"])
        self.assertEqual(shim["inputs"]["runcSha256"], manifest["artifacts"]["runc"]["sha256"])
        handler = (self.output / "runtime-handler.toml").read_text()
        self.assertIn('runtime_type = "io.containerd.qwen-k2.v1"', handler)
        self.assertIn('runtime_path = "' + shim["shimPath"] + '"', handler)
        self.assertIn('BinaryName = "' + shim["inputs"]["runcPath"] + '"', handler)
        self.assertEqual(0o400, (self.output / "shim.json").stat().st_mode & 0o777)

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        marker = self.output / "keep"
        marker.write_text("original")
        with self.assertRaises(FileExistsError):
            self.render()
        self.assertEqual([marker], list(self.output.iterdir()))
        self.assertEqual("original", marker.read_text())

    def test_mixed_architecture_refuses_before_output(self):
        header = bytearray(self.header)
        header[18:20] = (183).to_bytes(2, "little")
        self.runc.write_bytes(header)
        with self.assertRaisesRegex(ValueError, "architectures differ"):
            self.render()
        self.assertFalse(self.output.exists())

    def test_invalid_artifact_refuses_before_output(self):
        self.shim.write_text("not an ELF")
        with self.assertRaises(ValueError):
            self.render()
        self.assertFalse(self.output.exists())

    def test_duplicate_contract_field_refuses_before_output(self):
        raw = self.contract.read_text()
        self.contract.write_text(raw.replace('"format":', '"format":"duplicate","format":', 1))
        with self.assertRaisesRegex(ValueError, "duplicate JSON"):
            self.render()
        self.assertFalse(self.output.exists())

    def test_unsupported_contract_refuses_before_output(self):
        value = json.loads(self.contract.read_text())
        value["qualified"] = True
        self.contract.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            self.render()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
