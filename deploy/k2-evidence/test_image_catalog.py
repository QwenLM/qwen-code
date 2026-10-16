import gzip
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import runpy
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("image_catalog", Path(__file__).with_name("image-catalog.py"))
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


def inert_elf(architecture="amd64", interpreter=None):
    raw = bytearray(120 if interpreter is None else 176 + len(interpreter.encode()) + 1)
    raw[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<HH", raw, 16, 3, {"amd64": 62, "arm64": 183}[architecture])
    struct.pack_into("<Q", raw, 32, 64)
    struct.pack_into("<HH", raw, 54, 56, 1 if interpreter is None else 2)
    struct.pack_into("<I", raw, 64, 1)
    struct.pack_into("<Q", raw, 96, len(raw))
    if interpreter is not None:
        struct.pack_into("<I", raw, 120, 3)
        struct.pack_into("<Q", raw, 128, 176)
        struct.pack_into("<Q", raw, 152, len(interpreter.encode()) + 1)
        raw[176:] = interpreter.encode() + b"\0"
    return bytes(raw)


def blob(root, raw):
    sha = hashlib.sha256(raw).hexdigest()
    (root / "blobs/sha256").mkdir(parents=True, exist_ok=True)
    (root / "blobs/sha256" / sha).write_bytes(raw)
    return sha


def json_blob(root, value):
    raw = json.dumps(value, separators=(",", ":")).encode()
    return blob(root, raw), len(raw)


def image(root, layers, architecture="amd64", compressed=False):
    descriptors, diff_ids = [], []
    for entries in layers:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, value in entries:
                member = tarfile.TarInfo(name)
                member.mode = value.get("mode", 0o755) if isinstance(value, dict) else 0o755
                if isinstance(value, dict):
                    member.type = value.get("type", tarfile.DIRTYPE)
                    member.linkname = value.get("target", "")
                    archive.addfile(member)
                else:
                    member.size = len(value)
                    archive.addfile(member, io.BytesIO(value))
        expanded = buffer.getvalue()
        raw = gzip.compress(expanded, mtime=0) if compressed else expanded
        sha = blob(root, raw)
        descriptors.append({"mediaType": catalog.LAYER + ("+gzip" if compressed else ""), "digest": "sha256:" + sha, "size": len(raw)})
        diff_ids.append("sha256:" + hashlib.sha256(expanded).hexdigest())
    config, size = json_blob(root, {"os": "linux", "architecture": architecture, "rootfs": {"type": "layers", "diff_ids": diff_ids}})
    manifest, _ = json_blob(root, {"schemaVersion": 2, "mediaType": catalog.MANIFEST, "config": {"mediaType": catalog.CONFIG, "digest": "sha256:" + config, "size": size}, "layers": descriptors})
    return manifest


def contract(entry="/node"):
    roles = {}
    for name, command in (("worker", entry), ("sandbox", "/pause")):
        roles[name] = {"args": [command], "env": [], "cwd": "/", "seccomp": {"defaultAction": "SCMP_ACT_ERRNO"},
                       "mounts": [], "devices": [], "deviceCgroupRules": [], "maskedPaths": [], "readonlyPaths": []}
    return {"format": "qwen-k2-creation-contract/1", **roles}


class ImageCatalogTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="k2-image-catalog-data-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_layer_whiteout_and_opaque_directory_preserve_only_final_tree(self):
        sha = image(self.root, [[("node", inert_elf()), ("dir", {}), ("dir/old", b"old"), ("remove", b"gone"), ("keep", b"kept")],
                                [("dir/.wh..wh..opq", b""), ("dir/new", b"new"), (".wh.remove", b"")]], compressed=True)
        result = catalog.catalogue(self.root, sha, "worker", contract())
        entries = {entry["path"]: entry for entry in result["entries"]}
        self.assertEqual(set(entries), {"/node", "/dir", "/dir/new", "/keep"})
        self.assertEqual(entries["/dir/new"]["sha256"], hashlib.sha256(b"new").hexdigest())
        self.assertEqual(len(result["layers"]), 2)

    def test_whiteout_requires_surviving_or_same_layer_directory_parents(self):
        for old_parent in ([], [("ghost", b"file")], [("ghost", {"type": tarfile.SYMTYPE, "target": "/"})]):
            for marker in ("ghost/.wh..wh..opq", "ghost/.wh.child"):
                with self.subTest(old_parent=old_parent, marker=marker):
                    sha = image(self.root, [[("node", inert_elf()), *old_parent], [(marker, b"")]])
                    with self.assertRaisesRegex(ValueError, "whiteout requires explicit directory"):
                        catalog.catalogue(self.root, sha, "worker", contract())
        sha = image(self.root, [[("node", inert_elf()), ("ghost", {}), ("ghost/old", b"old")],
                                [(".wh.ghost", b""), ("ghost/.wh..wh..opq", b"")]])
        with self.assertRaisesRegex(ValueError, "whiteout requires explicit directory"):
            catalog.catalogue(self.root, sha, "worker", contract())
        sha = image(self.root, [[("node", inert_elf())], [("ghost", {}), ("ghost/.wh..wh..opq", b""), ("ghost/new", b"new")]])
        result = catalog.catalogue(self.root, sha, "worker", contract())
        self.assertEqual({item["path"] for item in result["entries"]}, {"/node", "/ghost", "/ghost/new"})

    def test_upper_file_wins_over_whiteout_of_the_lower_file(self):
        sha = image(self.root, [[("node", inert_elf()), ("data", b"old")], [(".wh.data", b""), ("data", b"new")]])
        result = catalog.catalogue(self.root, sha, "worker", contract())
        data = next(item for item in result["entries"] if item["path"] == "/data")
        self.assertEqual(data["sha256"], hashlib.sha256(b"new").hexdigest())

    def test_symlink_entry_and_dynamic_loader_are_measured_without_execution(self):
        sha = image(self.root, [[("usr", {}), ("usr/bin", {}), ("usr/bin/node", inert_elf(interpreter="/lib/loader")),
                                ("lib", {}), ("lib/loader", inert_elf()), ("bin", {}),
                                ("bin/node", {"type": tarfile.SYMTYPE, "target": "../usr/bin/node"}),
                                ("helper", inert_elf())]])
        result = catalog.catalogue(self.root, sha, "worker", contract("/bin/node"))
        self.assertEqual(result["entry"], "/usr/bin/node")
        entries = {entry["path"]: entry for entry in result["entries"]}
        self.assertEqual(entries["/usr/bin/node"]["elf"]["interpreter"], "/lib/loader")
        self.assertIsNotNone(entries["/helper"]["elf"])
        self.assertEqual(entries["/bin/node"]["kind"], "symlink")

    def test_missing_loader_refuses(self):
        sha = image(self.root, [[("node", inert_elf(interpreter="/missing"))]])
        with self.assertRaisesRegex(ValueError, "interpreter must be present"):
            catalog.catalogue(self.root, sha, "worker", contract())

    def test_parent_component_runs_after_the_intermediate_symlink(self):
        deep, wrong = inert_elf() + b"DEEP", inert_elf() + b"ROOT"
        sha = image(self.root, [[("deep", {}), ("deep/dir", {}), ("deep/bin", {}), ("deep/bin/node", deep),
                                ("bin", {}), ("bin/node", wrong), ("a", {"type": tarfile.SYMTYPE, "target": "/deep/dir"}),
                                ("node", {"type": tarfile.SYMTYPE, "target": "a/../bin/node"})]])
        result = catalog.catalogue(self.root, sha, "worker", contract())
        self.assertEqual(result["entry"], "/deep/bin/node")
        entry = next(item for item in result["entries"] if item["path"] == result["entry"])
        self.assertEqual(entry["sha256"], hashlib.sha256(deep).hexdigest())
        self.assertNotEqual(entry["sha256"], hashlib.sha256(wrong).hexdigest())

    def test_parent_component_cannot_hide_a_missing_or_regular_prefix(self):
        for prefix in ([], [("prefix", b"regular")]):
            sha = image(self.root, [[("node", inert_elf()), *prefix,
                                    ("alias", {"type": tarfile.SYMTYPE, "target": "prefix/../node"})]])
            with self.assertRaisesRegex(ValueError, "missing or non-directory"):
                catalog.catalogue(self.root, sha, "worker", contract())

    def test_loader_link_obeys_the_same_component_order(self):
        sha = image(self.root, [[("node", inert_elf(interpreter="/ld")), ("deep", {}), ("deep/dir", {}),
                                ("deep/bin", {}), ("deep/bin/ld", inert_elf()),
                                ("a", {"type": tarfile.SYMTYPE, "target": "/deep/dir"}),
                                ("ld", {"type": tarfile.SYMTYPE, "target": "a/../bin/ld"})]])
        result = catalog.catalogue(self.root, sha, "worker", contract())
        self.assertEqual(result["entry"], "/node")
        entries = {item["path"]: item for item in result["entries"]}
        self.assertEqual(catalog.resolve(entries, entries["/node"]["elf"]["interpreter"]), "/deep/bin/ld")

    def test_layer_blob_tampering_and_diff_id_mismatch_refuse(self):
        sha = image(self.root, [[("node", inert_elf())]])
        manifest, _ = catalog.json_blob(self.root, sha)
        layer_path = self.root / "blobs/sha256" / manifest["layers"][0]["digest"][7:]
        layer_path.write_bytes(layer_path.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "layer bytes"):
            catalog.catalogue(self.root, sha, "worker", contract())
        sha = image(self.root, [[("node", inert_elf())]])
        manifest, _ = catalog.json_blob(self.root, sha)
        config, _ = catalog.json_blob(self.root, manifest["config"]["digest"][7:])
        config["rootfs"]["diff_ids"][0] = "sha256:" + "0" * 64
        config_sha, size = json_blob(self.root, config)
        manifest["config"].update(digest="sha256:" + config_sha, size=size)
        changed, _ = json_blob(self.root, manifest)
        with self.assertRaisesRegex(ValueError, "diff ID"):
            catalog.catalogue(self.root, changed, "worker", contract())

    def test_hardlink_preserves_earlier_same_layer_inode_metadata(self):
        sha = image(self.root, [[("node", inert_elf()), ("alias", {"type": tarfile.LNKTYPE, "target": "node"})]])
        entries = catalog.catalogue(self.root, sha, "worker", contract())["entries"]
        self.assertEqual(entries[0]["sha256"], entries[1]["sha256"])
        bad = image(self.root, [[("node", inert_elf()), ("alias", {"type": tarfile.LNKTYPE, "target": "node", "mode": 0o600})]])
        with self.assertRaisesRegex(ValueError, "hardlink metadata"):
            catalog.catalogue(self.root, bad, "worker", contract())
        cross_layer = image(self.root, [[("node", inert_elf())], [("alias", {"type": tarfile.LNKTYPE, "target": "node"})]])
        with self.assertRaisesRegex(ValueError, "same layer"):
            catalog.catalogue(self.root, cross_layer, "worker", contract())

    def test_escaping_and_cyclic_links_refuse(self):
        for entries in [[("node", {"type": tarfile.SYMTYPE, "target": "../outside"})],
                        [("node", {"type": tarfile.SYMTYPE, "target": "alias"}), ("alias", {"type": tarfile.SYMTYPE, "target": "node"})]]:
            with self.subTest(entries=entries):
                sha = image(self.root, [entries])
                with self.assertRaises(ValueError):
                    catalog.catalogue(self.root, sha, "worker", contract())

    def test_non_directory_or_implicit_parent_refuses(self):
        for entries in [[("node", inert_elf()), ("node/child", b"unreachable")], [("node", inert_elf()), ("missing/child", b"implicit")]]:
            with self.subTest(entries=entries):
                sha = image(self.root, [entries])
                with self.assertRaisesRegex(ValueError, "explicit directory"):
                    catalog.catalogue(self.root, sha, "worker", contract())

    def test_nonfinite_and_duplicate_image_json_refuse(self):
        for raw in [b'{"value":NaN}', b'{"value":1,"value":2}']:
            sha = blob(self.root, raw)
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                catalog.json_blob(self.root, sha)

    def test_external_layer_and_foreign_elf_refuse(self):
        sha = image(self.root, [[("node", inert_elf())]])
        manifest, _ = catalog.json_blob(self.root, sha)
        manifest["layers"][0]["urls"] = ["https://invalid.example/layer"]
        changed, _ = json_blob(self.root, manifest)
        with self.assertRaisesRegex(ValueError, "external"):
            catalog.catalogue(self.root, changed, "worker", contract())
        foreign = image(self.root, [[("node", inert_elf("arm64"))]])
        with self.assertRaisesRegex(ValueError, "architecture"):
            catalog.catalogue(self.root, foreign, "worker", contract())

    def test_partial_or_unknown_creation_role_refuses(self):
        sha = image(self.root, [[("node", inert_elf())]])
        for mutation in (lambda value: value["worker"].pop("mounts"),
                         lambda value: value["sandbox"].update(qualified=True)):
            value = contract()
            mutation(value)
            with self.assertRaisesRegex(ValueError, "complete closed creation role"):
                catalog.catalogue(self.root, sha, "worker", value)

    def test_real_worker_composer_normalizes_docker_gzip_for_the_oci_consumer(self):
        base = self.root / "base"
        sha = image(base, [[("usr", {}), ("usr/local", {}), ("usr/local/bin", {}),
                            ("usr/local/bin/node", inert_elf())]], compressed=True)
        manifest, _ = catalog.json_blob(base, sha)
        config, _ = catalog.json_blob(base, manifest["config"]["digest"][7:])
        config["config"] = {"Env": ["NODE_VERSION=22.14.0"]}
        config_sha, size = json_blob(base, config)
        manifest["config"].update(digest="sha256:" + config_sha, size=size)
        original = dict(manifest["layers"][0])
        bundle = self.root / "worker.mjs"
        bundle.write_bytes(b"// inert test data; never executed\n")
        for ordinal, media in enumerate((catalog.LAYER + "+gzip", "application/vnd.docker.image.rootfs.diff.tar.gzip")):
            with self.subTest(media=media):
                manifest["layers"][0]["mediaType"] = media
                base_sha, _ = json_blob(base, manifest)
                output = self.root / ("worker-" + str(ordinal))
                argv = ["package-worker.py", "--base-layout", str(base), "--base-manifest", "sha256:" + base_sha,
                        "--bundle", str(bundle), "--bundle-sha256", hashlib.sha256(bundle.read_bytes()).hexdigest(),
                        "--architecture", "amd64", "--output", str(output)]
                with patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()) as printed:
                    runpy.run_path(str(Path(__file__).with_name("package-worker.py")), run_name="__main__")
                result = json.loads(printed.getvalue())
                produced, _ = catalog.json_blob(output, result["manifest"]["digest"][7:])
                self.assertEqual(produced["layers"][0], original)
                self.assertEqual((output / "blobs/sha256" / original["digest"][7:]).read_bytes(),
                                 (base / "blobs/sha256" / original["digest"][7:]).read_bytes())
                reviewed = contract("/usr/local/bin/node")
                reviewed["worker"]["args"] += ["/opt/qwen-k2/worker.mjs", "managed-runtime-worker", "--container-boot", "/var/run/qwen-runtime/boot.json"]
                catalogue = catalog.catalogue(output, result["manifest"]["digest"][7:], "worker", reviewed)
                self.assertEqual(catalogue["entry"], "/usr/local/bin/node")
                self.assertIn("/opt/qwen-k2/worker.mjs", {item["path"] for item in catalogue["entries"]})


if __name__ == "__main__":
    unittest.main()
