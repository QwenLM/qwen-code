import importlib.util
from unittest.mock import patch
import shutil
import tarfile
import unittest

import cold_boot as C
import test_render_profiles as profile_fixture
from test_render_cold_boot import ColdFixture


class PackageColdInitrdTest(ColdFixture):
    def setUp(self):
        super().setUp()
        services = self.tools / "host-services"
        services.mkdir()
        for name in ("qwen-k2-node-source.service", "qwen-k2-runtime-gateway.service"):
            shutil.copyfile(C.HERE / "host-services" / name, services / name)
        self.render()
        cold = C.loads((self.output / "cold-bootstrap.json").read_bytes())
        fixture = profile_fixture.RenderProfilesTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.target["coldBootstrapSha256"] = C.sha((self.output / "cold-bootstrap.json").read_bytes())
        fixture.target["hostExecutables"]["systemd"] = {k: cold["systemd"][k] for k in ("path", "sha256", "label")}
        fixture.write_inputs()
        profiles = self.root / "profiles"
        args = ["--candidate", str(fixture.candidate), "--artifact-manifest-sha256", profile_fixture.digest(fixture.candidate / "artifact-manifest.json"),
                "--cold-bootstrap", str(self.output / "cold-bootstrap.json"), "--worker-layout", str(fixture.worker), "--sandbox-layout", str(fixture.sandbox),
                "--host-policy", str(fixture.host_policy), "--host-policy-sha256", profile_fixture.digest(fixture.host_policy / "host-policies.json"), "--output", str(profiles)]
        for name, path in fixture.inputs.items(): args += ["--" + name, str(path), "--" + name + "-sha256", profile_fixture.digest(path)]
        self.cli("render-profiles.py", args)
        self.installation = self.root / "installation"
        self.installation.mkdir()
        files = {p.name: p.read_bytes() for p in profiles.iterdir()}
        for name in ("artifact-manifest.json", "shim.json", "worker-catalog.json", "sandbox-catalog.json"):
            files[name] = (fixture.candidate / name).read_bytes()
        # The compilation metadata is synthetic byte-graph data, not a claim of
        # actual parser execution or an acceptable native packed policy.
        files["packed.bin"] = b"INERT SOFTWARE FIXTURE; NEVER LOAD"
        files["features"] = b"INERT FEATURES; NOT TARGET KERNEL EVIDENCE"
        compiler_root = "/inert-fixture/compile"
        command = [compiler_root + "/parser", "--config-file=" + compiler_root + "/parser.conf", "--base=" + compiler_root,
                   "--policy-features=" + compiler_root + "/features", "--kernel-features=" + compiler_root + "/features", "--skip-kernel-load",
                   "--skip-cache", "--stdout", "--jobs=0", "--abort-on-error", "--Werror", "--warn=rule-not-enforced", compiler_root + "/qwen-k2-profiles"]
        compile_record = {"format": "qwen-k2-profile-compile/2", "command": command, "profileCandidateSha256": C.sha(files["profile-candidate.json"]),
            "parserSha256": "e" * 64, "featuresSha256": C.sha(files["features"]), "sourceSha256": C.sha(files["qwen-k2-profiles"]),
            "parserConfigurationSha256": C.sha(b""), "generatorSha256": C.sha((self.tools / "compile-profiles.py").read_bytes()), "exitCode": 0,
            "packedBytes": len(files["packed.bin"]), "packedSha256": C.sha(files["packed.bin"])}
        files["profile-compile.json"] = C.encoded(compile_record)
        old = b'"workerPolicySha256": "' + b"9" * 64 + b'"'
        self.assertEqual(1, files["source-config.json"].count(old))
        files["source-config.installed.json"] = files["source-config.json"].replace(old, b'"workerPolicySha256": "' + C.sha(files["packed.bin"]).encode() + b'"')
        for name, raw in files.items(): (self.installation / name).write_bytes(raw)
        self.repin()
        self.package_output = self.root / "package"

    def repin(self):
        files = {p.name: C.pin(p.read_bytes()) for p in self.installation.iterdir() if p.name != "installation.json"}
        (self.installation / "installation.json").write_bytes(C.encoded({"format": "qwen-k2-installed-artifacts/3", "files": files}))

    def package(self, success=True):
        return self.cli("package-cold-initrd.py", ["--base-initrd", str(self.base), "--candidate", str(self.output),
            "--installation", str(self.installation), "--output", str(self.package_output)], success)

    def test_real_cli_packages_consumed_init_and_rootfs_without_a_digest_cycle(self):
        self.package()
        actual = C.unpack((self.package_output / "initrd.img").read_bytes())
        self.assertEqual((self.output / "overlay/init").read_bytes(), actual["/init"]["data"])
        inventory = C.loads((self.package_output / "inventory.json").read_bytes())
        self.assertEqual("NOT_RUN", inventory["nativeAcceptance"])
        for name, pin in inventory["files"].items(): self.assertEqual(C.pin((self.package_output / name).read_bytes()), pin)
        with tarfile.open(self.package_output / "rootfs.tar") as archive:
            names = archive.getnames()
            artifacts = [name for name in names if name.startswith("etc/qwen-k2/artifacts/")]
            self.assertEqual(26, len(artifacts))
            self.assertEqual(C.TARGET, archive.extractfile("etc/qwen-k2/cold-systemd/units/qwen-k2-cold.target").read())
            self.assertEqual("qwen-k2-cold.target", archive.getmember("etc/qwen-k2/cold-systemd/units/default.target").linkname)
            self.assertEqual("/dev/null", archive.getmember("etc/qwen-k2/cold-systemd/units/apparmor.service").linkname)
        self.assertFalse(any("qualified" in key.lower() for key in C.loads((self.output / "cold-bootstrap.json").read_bytes())))
        self.package(False)

    def test_repin_cannot_repair_changed_packed_bytes(self):
        packed = self.installation / "packed.bin"
        packed.write_bytes(packed.read_bytes() + b"changed"); self.repin()
        self.package(False); self.assertFalse(self.package_output.exists())

    def test_repinned_target_cannot_change_the_cold_architecture(self):
        path = self.installation / "target.json"
        target = C.loads(path.read_bytes()); target["architecture"] = "arm64"
        path.write_bytes(C.encoded(target))
        candidate = C.loads((self.installation / "profile-candidate.json").read_bytes())
        candidate["files"]["target.json"] = C.pin(path.read_bytes())
        (self.installation / "profile-candidate.json").write_bytes(C.encoded(candidate))
        compilation = C.loads((self.installation / "profile-compile.json").read_bytes())
        compilation["profileCandidateSha256"] = C.sha(C.encoded(candidate))
        (self.installation / "profile-compile.json").write_bytes(C.encoded(compilation))
        self.repin()
        result = self.package(False)
        self.assertIn(b"installed cold target differs", result.stderr)
        self.assertFalse(self.package_output.exists())

    def test_repin_cannot_remove_the_mandatory_systemd_denials(self):
        path = self.installation / "qwen-k2-profiles"
        line = b'  deny "/proc/sys/kernel/core_pattern" w,\n'
        self.assertEqual(1, path.read_bytes().count(line))
        path.write_bytes(path.read_bytes().replace(line, b""))
        candidate = C.loads((self.installation / "profile-candidate.json").read_bytes())
        candidate["files"]["qwen-k2-profiles"] = C.pin(path.read_bytes())
        (self.installation / "profile-candidate.json").write_bytes(C.encoded(candidate))
        compilation = C.loads((self.installation / "profile-compile.json").read_bytes())
        compilation["sourceSha256"] = C.sha(path.read_bytes())
        compilation["profileCandidateSha256"] = C.sha(C.encoded(candidate))
        (self.installation / "profile-compile.json").write_bytes(C.encoded(compilation))
        self.repin()
        result = self.package(False)
        self.assertIn(b"mandatory generated host suffix differs", result.stderr)
        self.assertFalse(self.package_output.exists())

    def test_output_and_generated_input_must_not_be_reused_or_silently_ignored(self):
        path = self.output / "rootfs/etc/systemd/system.conf"
        path.chmod(0o600); path.write_bytes(b"unexpected manager configuration")
        self.package(False); self.assertFalse(self.package_output.exists())

    def test_changed_overlay_cannot_be_repaired_by_new_script_and_candidate_pins(self):
        script = self.output / "overlay/init"
        script.chmod(0o600); script.write_bytes(b"#!/bin/sh\nexec /bin/sh\n")
        path = self.output / "cold-bootstrap.json"
        plan = C.loads(path.read_bytes()); plan["bootState"]["scriptOutputs"]["/init"] = C.pin(script.read_bytes())
        path.chmod(0o600); path.write_bytes(C.encoded(plan))
        record = self.output / "candidate.json"
        record.chmod(0o600); record.write_bytes(C.encoded({"format": "qwen-k2-cold-candidate/1", "coldBootstrapSha256": C.sha(path.read_bytes()), "nativeAcceptance": "NOT_RUN"}))
        result = self.package(False)
        self.assertIn(b"hardened boot entries differ", result.stderr)
        self.assertFalse(self.package_output.exists())

    def test_missing_cold_leaf_or_extra_installation_file_refuses(self):
        path = self.installation / "cold-bootstrap.json"
        raw = path.read_bytes(); path.unlink()
        self.package(False); self.assertFalse(self.package_output.exists())
        path.write_bytes(raw)
        (self.installation / "foreign.json").write_bytes(b"foreign")
        self.package(False); self.assertFalse(self.package_output.exists())


class SourceTokenTest(unittest.TestCase):
    def test_invalid_length_pins_refuse_before_opening_or_unbounded_read(self):
        for size in (-2, 0, True, 1 << 40):
            with self.subTest(size=size), patch.object(type(C.HERE), "open", side_effect=AssertionError("must not open")):
                with self.assertRaises(ValueError):
                    C.read(C.HERE / "inert-no-read", 32 * 1024, {"bytes": size, "sha256": "a" * 64})

    def test_only_the_one_top_level_value_changes_with_utf8_and_escaped_key(self):
        spec = importlib.util.spec_from_file_location("package_token_test", C.HERE / "package-cold-initrd.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        old = "9" * 64
        raw = ('  {"prefix":"é' + old + '", "workerPolicy\\u0053ha256" : "' + old + '", "nested":{"workerPolicySha256":"' + old + '"}}\n').encode()
        expected = raw.replace((' : "' + old + '"').encode(), (' : "' + "a" * 64 + '"').encode(), 1)
        self.assertEqual(expected, module.final_source(raw, "a" * 64))
        with self.assertRaises(ValueError):
            module.final_source(b'{"workerPolicySha256":"' + old.encode() + b'","workerPolicy\\u0053ha256":"' + old.encode() + b'"}', "a" * 64)


if __name__ == "__main__": unittest.main()
