#!/usr/bin/env python3
"""Package the reviewed static Linux executable as a scratch OCI image."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import tarfile


def encoded(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--architecture", choices=["amd64", "arm64"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.read_bytes()
    if sha256(binary) != args.expected_sha256:
        parser.error("executable differs from the reviewed digest")
    machine = {"amd64": 62, "arm64": 183}[args.architecture]
    if len(binary) < 64 or binary[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", binary, 18)[0] != machine:
        parser.error("executable is not the selected 64-bit Linux architecture")
    offset = struct.unpack_from("<Q", binary, 32)[0]
    entry_size, count = struct.unpack_from("<HH", binary, 54)
    if entry_size < 56 or offset + entry_size * count > len(binary):
        parser.error("invalid ELF program headers")
    if any(struct.unpack_from("<I", binary, offset + i * entry_size)[0] == 3 for i in range(count)):
        parser.error("executable requires a dynamic loader")

    args.output.mkdir(parents=True, exist_ok=False)
    blobs = args.output / "blobs" / "sha256"
    blobs.mkdir(parents=True)

    def blob(raw, media_type):
        digest = sha256(raw)
        (blobs / digest).write_bytes(raw)
        return {"mediaType": media_type, "digest": "sha256:" + digest, "size": len(raw)}

    layer_bytes = io.BytesIO()
    with tarfile.open(fileobj=layer_bytes, mode="w", format=tarfile.USTAR_FORMAT) as layer:
        entry = tarfile.TarInfo("k2-node-evidence")
        entry.mode = 0o555
        entry.size = len(binary)
        entry.mtime = 0
        layer.addfile(entry, io.BytesIO(binary))
    layer = blob(layer_bytes.getvalue(), "application/vnd.oci.image.layer.v1.tar")
    config = blob(encoded({
        "architecture": args.architecture,
        "os": "linux",
        "config": {"User": "0", "Entrypoint": ["/k2-node-evidence"], "WorkingDir": "/"},
        "rootfs": {"type": "layers", "diff_ids": [layer["digest"]]},
    }), "application/vnd.oci.image.config.v1+json")
    manifest = blob(encoded({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "config": config, "layers": [layer]}), "application/vnd.oci.image.manifest.v1+json")
    manifest["platform"] = {"architecture": args.architecture, "os": "linux"}
    (args.output / "index.json").write_bytes(encoded({"schemaVersion": 2, "manifests": [manifest]}))
    (args.output / "oci-layout").write_bytes(encoded({"imageLayoutVersion": "1.0.0"}))
    print(json.dumps({"imageDigest": manifest["digest"], "binarySha256": args.expected_sha256, "architecture": args.architecture, "layout": str(args.output)}))


if __name__ == "__main__":
    main()
