#!/usr/bin/env python3
"""Render an offline candidate for one reviewed pre-execution runtime lane."""

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path


spec = importlib.util.spec_from_file_location("k2_image_catalog", Path(__file__).with_name("image-catalog.py"))
IMAGE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(IMAGE)


def require(valid, message):
    if not valid:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        require(name not in result, "duplicate JSON field")
        result[name] = value
    return result


def contract_bytes(path):
    with path.open("rb") as source:
        raw = source.read(16 * 1024 + 1)
    require(0 < len(raw) <= 16 * 1024, "creation contract exceeds its bound")
    document = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                          parse_constant=lambda value: require(False, "non-finite JSON number"))
    require(isinstance(document, dict) and set(document) == {"format", "worker", "sandbox"}, "closed creation contract required")
    require(document["format"] == "qwen-k2-creation-contract/1", "unsupported creation contract")
    fields = {"args", "env", "cwd", "seccomp", "mounts", "devices", "deviceCgroupRules", "maskedPaths", "readonlyPaths"}
    for role in ("worker", "sandbox"):
        value = document[role]
        require(isinstance(value, dict) and set(value) == fields, "complete creation role required")
    return raw


def artifact(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        header = source.read(64)
        require(len(header) == 64 and header[:6] == b"\x7fELF\x02\x01", "64-bit little-endian ELF candidate required")
        machine = int.from_bytes(header[18:20], "little")
        require(machine in (62, 183), "unsupported ELF architecture")
        digest.update(header)
        length = len(header)
        while chunk := source.read(1024 * 1024):
            length += len(chunk)
            require(length <= 128 * 1024 * 1024, "artifact exceeds its bound")
            digest.update(chunk)
    return {"sha256": digest.hexdigest(), "bytes": length, "architecture": "amd64" if machine == 62 else "arm64"}


def render(source, shim, runc, worker_layout, worker_image, sandbox_layout, sandbox_image, contract, output):
    inputs = {"source": artifact(source), "shim": artifact(shim), "runc": artifact(runc)}
    require(len({value["architecture"] for value in inputs.values()}) == 1, "artifact architectures differ")
    raw = contract_bytes(contract)
    document = json.loads(raw, object_pairs_hook=unique_object)
    catalogues = {
        "worker": IMAGE.catalogue(worker_layout, worker_image, "worker", document),
        "sandbox": IMAGE.catalogue(sandbox_layout, sandbox_image, "sandbox", document),
    }
    require(all(value["architecture"] == inputs["source"]["architecture"] for value in catalogues.values()),
            "image and host artifact architectures differ")
    catalog_files = {}
    for role, catalogue in catalogues.items():
        content = json.dumps(catalogue, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
        require(len(content.encode("utf-8")) <= IMAGE.CATALOG_LIMIT, "image catalogue exceeds its byte bound")
        catalog_files[role + "-catalog.json"] = content
    configuration = {
        "inputs": {
            "bundleRoot": "/run/containerd/io.containerd.runtime.v2.task/k8s.io",
            "inputRoot": "/var/lib/qwen-k2/inputs",
            "runcPath": "/opt/qwen-k2/bin/runc",
            "runcRoot": "/run/qwen-k2/runc",
            "runcSha256": inputs["runc"]["sha256"],
        },
        "sourceSocket": "/run/qwen-k2/source/birth.sock",
        "sourceSha256": inputs["source"]["sha256"],
        "shimPath": "/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1",
        "shimSha256": inputs["shim"]["sha256"],
        "socketRoot": "/run/qwen-k2/shims",
        "containerdGrpc": "/run/containerd/containerd.sock",
        "containerdTtrpc": "/run/containerd/containerd.sock.ttrpc",
        "creationContract": base64.b64encode(raw).decode("ascii"),
    }
    runtime = '''[plugins."io.containerd.cri.v1.runtime"]
  disable_apparmor = false
  enable_selinux = false
  enable_cdi = false
  enable_criu = false
  enable_experimental_restore_via_create = false
  netns_mounts_under_state_dir = false
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.qwen-k2-runc-v1]
  runtime_type = "io.containerd.runc.v2"
  runtime_path = "/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1"
  snapshotter = "overlayfs"
  sandboxer = "podsandbox"
  io_type = "fifo"
  [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.qwen-k2-runc-v1.options]
    BinaryName = "/opt/qwen-k2/bin/runc"
    Root = "/run/qwen-k2/runc"
    SystemdCgroup = true
'''
    manifest = {
        "format": "qwen-k2-pre-exec-artifacts/2",
        "artifacts": inputs,
        "creationContractSha256": hashlib.sha256(raw).hexdigest(),
        "sandboxImageSha256": sandbox_image,
        "workerImageSha256": worker_image,
        "catalogues": {
            name: {"bytes": len(content.encode("utf-8")), "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest()}
            for name, content in catalog_files.items()
        },
        "generators": {
            name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in ("render-pre-exec.py", "image-catalog.py")
        },
    }
    files = {
        "shim.json": json.dumps(configuration, indent=2) + "\n",
        "runtime-handler.toml": runtime,
        "source-config.patch.json": json.dumps({"sandboxImageSha256": sandbox_image}, indent=2) + "\n",
        "artifact-manifest.json": json.dumps(manifest, indent=2) + "\n",
        "qwen-k2-pre-exec.conf": "d /var/lib/qwen-k2/inputs 0700 root root -\nd /run/qwen-k2/source 0700 root root -\nd /run/qwen-k2/shims 0700 root root -\nd /run/qwen-k2/runc 0700 root root -\n",
        **catalog_files,
    }
    os.mkdir(output, 0o700)
    for name, value in files.items():
        with (output / name).open("x", encoding="utf-8") as target:
            target.write(value)
        (output / name).chmod(0o400)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "shim", "runc", "worker-layout", "sandbox-layout", "creation-contract", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--worker-image-sha256", required=True)
    parser.add_argument("--sandbox-image-sha256", required=True)
    args = parser.parse_args()
    try:
        render(args.source, args.shim, args.runc, args.worker_layout, args.worker_image_sha256,
               args.sandbox_layout, args.sandbox_image_sha256, args.creation_contract, args.output)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, EOFError, IMAGE.tarfile.TarError, IMAGE.struct.error) as failure:
        parser.exit(1, "Pre-exec candidate rendering refused: " + str(failure) + "\n")


if __name__ == "__main__":
    main()
