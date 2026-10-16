#!/usr/bin/env python3
"""Catalogue reviewed OCI layer bytes without extracting or executing their contents."""

import argparse
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import struct
import tarfile


JSON_LIMIT = 64 * 1024
LAYER_LIMIT = 1024 * 1024 * 1024
IMAGE_LIMIT = 4 * LAYER_LIMIT
ENTRY_LIMIT = 65536
CATALOG_LIMIT = 16 * 1024 * 1024
MANIFEST = "application/vnd.oci.image.manifest.v1+json"
CONFIG = "application/vnd.oci.image.config.v1+json"
LAYER = "application/vnd.oci.image.layer.v1.tar"


def closed(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate image field")
        result[key] = value
    return result


def nonfinite(value):
    raise ValueError("non-finite image JSON number")


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ValueError("a canonical sha256 image digest is required")
    return value[7:]


def path(value, absolute=False):
    if not isinstance(value, str) or not value or len(value) > 1024 or any(ord(c) < 32 for c in value) or "\\" in value:
        raise ValueError("an image pathname must be bounded text")
    if value.startswith("/") != absolute or value.startswith("//") or value.endswith("/"):
        raise ValueError("image pathname root differs")
    parts = value.strip("/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("image path components must be canonical")
    return "/" + "/".join(parts)


def link_parts(target):
    if not isinstance(target, str) or not target or len(target) > 1024 or "\\" in target or any(ord(c) < 32 for c in target):
        raise ValueError("a bounded image symlink is required")
    return target.split("/")


def resolve(entries, name):
    pending, resolved, links = name.split("/"), [], 0
    while pending:
        part, pending = pending[0], pending[1:]
        if part in ("", "."):
            continue
        if part == "..":
            if not resolved:
                raise ValueError("image symlink escapes its root")
            resolved.pop()
            continue
        candidate = path("/" + "/".join(resolved + [part]), True)
        item = entries.get(candidate)
        if item and item["kind"] == "symlink":
            links += 1
            if links > 40:
                raise ValueError("image symlink cycle or excessive depth")
            target = item["target"]
            if target.startswith("/"):
                resolved = []
            pending = link_parts(target) + pending
        else:
            if pending and (item is None or item["kind"] != "directory"):
                raise ValueError("image symlink traverses a missing or non-directory parent")
            resolved.append(part)
    return "/" + "/".join(resolved)


def descriptor(value, media, limit):
    fields = {"mediaType", "digest", "size", "annotations", "urls", "data"}
    if not isinstance(value, dict) or not {"mediaType", "digest", "size"} <= set(value) or not set(value) <= fields:
        raise ValueError("unsupported image descriptor")
    if value["mediaType"] not in media or type(value["size"]) is not int or not 0 < value["size"] <= limit:
        raise ValueError("image descriptor media type or size differs")
    if "urls" in value and value["urls"] != [] or "data" in value and value["data"] != "":
        raise ValueError("external or inline image descriptors are unsupported")
    if "annotations" in value and (not isinstance(value["annotations"], dict) or not all(isinstance(v, str) for v in value["annotations"].values())):
        raise ValueError("descriptor annotations must be strings")
    return digest(value["digest"])


def json_blob(root, sha, size=None):
    with (root / "blobs/sha256" / sha).open("rb") as stream:
        raw = stream.read(JSON_LIMIT + 1)
    if not raw or len(raw) > JSON_LIMIT or size is not None and len(raw) != size or hashlib.sha256(raw).hexdigest() != sha:
        raise ValueError("image JSON bytes differ from their bounded digest and size")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=closed, parse_constant=nonfinite)
    if not isinstance(value, dict):
        raise ValueError("an image JSON object is required")
    return value, len(raw)


class HashReader:
    def __init__(self, stream, limit):
        self.stream, self.limit = stream, limit
        self.hash, self.size = hashlib.sha256(), 0

    def read(self, count=-1):
        count = min(count if count >= 0 else self.limit + 1, self.limit - self.size + 1)
        raw = self.stream.read(count)
        self.size += len(raw)
        if self.size > self.limit:
            raise ValueError("image layer exceeds its byte bound")
        self.hash.update(raw)
        return raw


def drain(stream):
    while stream.read(1024 * 1024):
        pass


def elf(header, total, architecture):
    if not header.startswith(b"\x7fELF"):
        return None
    machine = {"amd64": 62, "arm64": 183}[architecture]
    if len(header) < 64 or header[4:6] != b"\x02\x01" or struct.unpack_from("<H", header, 18)[0] != machine:
        raise ValueError("unsupported image ELF class, byte order or architecture")
    kind = struct.unpack_from("<H", header, 16)[0]
    offset = struct.unpack_from("<Q", header, 32)[0]
    size, count = struct.unpack_from("<HH", header, 54)
    if kind not in (2, 3) or size < 56 or not count or offset < 64 or offset + size * count > len(header):
        raise ValueError("unsupported image ELF program headers")
    interpreter, loaded = None, False
    for index in range(count):
        start = offset + index * size
        segment = struct.unpack_from("<I", header, start)[0]
        source, length = struct.unpack_from("<Q", header, start + 8)[0], struct.unpack_from("<Q", header, start + 32)[0]
        if source + length > total:
            raise ValueError("image ELF segment exceeds file bytes")
        loaded |= segment == 1
        if segment == 3:
            if interpreter is not None or not 2 <= length <= 1024 or source + length > len(header):
                raise ValueError("unsupported image ELF interpreter")
            raw = header[source:source + length]
            if raw[-1:] != b"\0" or b"\0" in raw[:-1]:
                raise ValueError("image ELF interpreter must be one path")
            interpreter = path(raw[:-1].decode("utf-8"), True)
    if not loaded:
        raise ValueError("image ELF requires a load segment")
    return {"type": kind, "interpreter": interpreter}


def read_layer(root, value, diff, entries, architecture):
    sha = descriptor(value, {LAYER, LAYER + "+gzip"}, LAYER_LIMIT)
    changes, whiteouts, opaque, whiteout_parents, names = {}, [], [], set(), set()
    with (root / "blobs/sha256" / sha).open("rb") as stream:
        original = HashReader(stream, LAYER_LIMIT)
        compressed = gzip.GzipFile(fileobj=original) if value["mediaType"].endswith("+gzip") else original
        expanded = HashReader(compressed, LAYER_LIMIT)
        with tarfile.open(fileobj=expanded, mode="r|") as archive:
            count = 0
            for member in archive:
                count += 1
                if count > ENTRY_LIMIT:
                    raise ValueError("image layer has too many entries")
                if member.name in (".", "./") and member.isdir():
                    continue
                name = member.name[2:] if member.name.startswith("./") else member.name
                name = path(name.rstrip("/"))
                if name in names:
                    raise ValueError("duplicate pathname within an image layer")
                names.add(name)
                leaf = name.rsplit("/", 1)[-1]
                if leaf.startswith(".wh."):
                    if not member.isfile() or member.size != 0:
                        raise ValueError("whiteout must be an empty regular entry")
                    parent = name.rsplit("/", 1)[0] or "/"
                    whiteout_parents.add(parent)
                    if leaf == ".wh..wh..opq":
                        opaque.append(parent)
                    else:
                        whiteouts.append(path(parent.rstrip("/") + "/" + leaf[4:], True))
                    continue
                if not 0 <= member.mode <= 0o7777 or not 0 <= member.uid <= 0xffffffff or not 0 <= member.gid <= 0xffffffff or any(key.startswith(("SCHILY.xattr.", "GNU.sparse")) for key in member.pax_headers):
                    raise ValueError("unsupported image mode, ownership, xattrs or sparse entry")
                item = {"path": name, "mode": format(member.mode, "04o"), "uid": member.uid, "gid": member.gid}
                if member.isdir():
                    item["kind"] = "directory"
                elif member.issym():
                    link_parts(member.linkname)
                    item.update(kind="symlink", target=member.linkname)
                elif member.islnk():
                    target = path(member.linkname[2:] if member.linkname.startswith("./") else member.linkname)
                    old = changes.get(target)
                    if old is None or old["kind"] != "file":
                        raise ValueError("hardlink target must be an earlier regular entry in the same layer")
                    if (member.mode, member.uid, member.gid) != (int(old["mode"], 8), old["uid"], old["gid"]):
                        raise ValueError("hardlink metadata must preserve its target inode")
                    item = dict(old, path=name)
                elif member.isfile():
                    if not 0 <= member.size <= LAYER_LIMIT:
                        raise ValueError("image file exceeds its bound")
                    data = archive.extractfile(member)
                    measured, header = hashlib.sha256(), bytearray()
                    seen = 0
                    while True:
                        raw = data.read(1024 * 1024)
                        if not raw:
                            break
                        seen += len(raw)
                        measured.update(raw)
                        header.extend(raw[:max(0, JSON_LIMIT - len(header))])
                    if seen != member.size:
                        raise ValueError("truncated image file")
                    item.update(kind="file", bytes=seen, sha256=measured.hexdigest(), elf=elf(header, seen, architecture))
                else:
                    raise ValueError("only regular files, directories and image links are supported")
                changes[name] = item
        drain(expanded)
        if compressed is not original:
            compressed.close()
        drain(original)
        if original.size != value["size"] or original.hash.hexdigest() != sha or expanded.hash.hexdigest() != digest(diff):
            raise ValueError("layer bytes, size or uncompressed diff ID differs")
    for target in whiteouts + opaque:
        for name in list(entries):
            if name.startswith(target.rstrip("/") + "/") or target in whiteouts and name == target:
                del entries[name]
    for name in sorted(whiteout_parents):
        for parent in (name, *(str(item) for item in PurePosixPath(name).parents)):
            if parent == "/":
                continue
            old = changes.get(parent, entries.get(parent))
            if old is None or old["kind"] != "directory":
                raise ValueError("whiteout requires explicit directory parents")
    for name, item in changes.items():
        for parent in PurePosixPath(name).parents:
            if str(parent) == "/":
                continue
            old = changes.get(str(parent), entries.get(str(parent)))
            if old is None or old["kind"] != "directory":
                raise ValueError("layer entry requires explicit directory parents")
        if item["kind"] != "directory":
            for child in list(entries):
                if child.startswith(name + "/"):
                    del entries[child]
        entries[name] = item
    if len(entries) > ENTRY_LIMIT:
        raise ValueError("merged image has too many entries")
    return {"sha256": sha, "diffId": diff, "bytes": original.size, "expandedBytes": expanded.size}


def catalogue(root, manifest_sha, role, contract):
    digest("sha256:" + manifest_sha)
    manifest, manifest_size = json_blob(root, manifest_sha)
    fields = {"schemaVersion", "mediaType", "config", "layers", "annotations"}
    if not {"schemaVersion", "mediaType", "config", "layers"} <= set(manifest) or not set(manifest) <= fields or type(manifest["schemaVersion"]) is not int or manifest["schemaVersion"] != 2 or manifest["mediaType"] != MANIFEST:
        raise ValueError("a concrete OCI image manifest is required")
    config_sha = descriptor(manifest["config"], {CONFIG}, JSON_LIMIT)
    config, config_size = json_blob(root, config_sha, manifest["config"]["size"])
    if manifest_size + config_size > JSON_LIMIT or config.get("os") != "linux" or config.get("architecture") not in ("amd64", "arm64"):
        raise ValueError("bounded Linux amd64/arm64 image configuration is required")
    layers, rootfs = manifest["layers"], config.get("rootfs")
    if not isinstance(layers, list) or not 1 <= len(layers) <= 64 or not isinstance(rootfs, dict) or set(rootfs) != {"type", "diff_ids"} or rootfs["type"] != "layers" or not isinstance(rootfs["diff_ids"], list) or len(rootfs["diff_ids"]) != len(layers):
        raise ValueError("the complete ordered image layers and diff IDs are required")
    if not isinstance(contract, dict) or set(contract) != {"format", "worker", "sandbox"} or contract["format"] != "qwen-k2-creation-contract/1":
        raise ValueError("a reviewed creation contract is required")
    fields = {"args", "env", "cwd", "seccomp", "mounts", "devices", "deviceCgroupRules", "maskedPaths", "readonlyPaths"}
    for name in ("worker", "sandbox"):
        value = contract[name]
        if not isinstance(value, dict) or set(value) != fields:
            raise ValueError("a complete closed creation role is required")
        for field in ("args", "env", "maskedPaths", "readonlyPaths"):
            if not isinstance(value[field], list) or not all(isinstance(item, str) and "\0" not in item for item in value[field]):
                raise ValueError("creation role string arrays are required")
        for field in ("mounts", "devices", "deviceCgroupRules"):
            if not isinstance(value[field], list) or not all(isinstance(item, dict) for item in value[field]):
                raise ValueError("creation role object arrays are required")
        if not isinstance(value["cwd"], str) or not value["cwd"].startswith("/") or not isinstance(value["seccomp"], dict):
            raise ValueError("creation role cwd and seccomp are required")
    if role not in ("worker", "sandbox"):
        raise ValueError("unsupported image role")
    args = contract[role]["args"]
    if not isinstance(args, list) or not args or not all(isinstance(arg, str) for arg in args) or role == "sandbox" and args != ["/pause"]:
        raise ValueError("the reviewed complete command is required")
    entry = path(args[0], True)
    entries, measured = {}, []
    for layer, diff in zip(layers, rootfs["diff_ids"]):
        measured.append(read_layer(root, layer, diff, entries, config["architecture"]))
        if sum(item["expandedBytes"] for item in measured) > IMAGE_LIMIT:
            raise ValueError("whole image exceeds its expanded byte bound")
    resolved = resolve(entries, entry)
    command = entries.get(resolved)
    if command is None or command["kind"] != "file" or not command["elf"] or not int(command["mode"], 8) & 0o111:
        raise ValueError("the command must resolve to an executable image ELF")
    for item in entries.values():
        if item["kind"] == "symlink":
            resolve(entries, item["path"])
        interpreter = item.get("elf", {}) or {}
        if interpreter.get("interpreter"):
            loader = entries.get(resolve(entries, interpreter["interpreter"]))
            if loader is None or loader["kind"] != "file" or not loader["elf"] or not int(loader["mode"], 8) & 0o111:
                raise ValueError("the actual ELF interpreter must be present as an executable image ELF")
    return {"format": "qwen-k2-image-catalog/1", "role": role, "architecture": config["architecture"],
            "manifestSha256": manifest_sha, "configurationSha256": config_sha, "args": args,
            "entry": resolved, "layers": measured, "entries": [entries[name] for name in sorted(entries)]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--layout", type=Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--role", choices=("worker", "sandbox"), required=True)
    parser.add_argument("--creation-contract", type=Path, required=True)
    parser.add_argument("--creation-contract-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if not all(value.is_absolute() for value in (args.layout, args.creation_contract, args.output)):
            raise ValueError("absolute artifact and new output paths are required")
        digest("sha256:" + args.creation_contract_sha256)
        with args.creation_contract.open("rb") as stream:
            raw = stream.read(16 * 1024 + 1)
        if not raw or len(raw) > 16 * 1024 or hashlib.sha256(raw).hexdigest() != args.creation_contract_sha256:
            raise ValueError("creation contract bytes differ or exceed their bound")
        value = catalogue(args.layout, args.manifest_sha256, args.role, json.loads(raw, object_pairs_hook=closed, parse_constant=nonfinite))
        value["creationContractSha256"] = args.creation_contract_sha256
        output = (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()
        if len(output) > CATALOG_LIMIT:
            raise ValueError("image catalogue exceeds its byte bound")
        with args.output.open("xb") as stream:
            stream.write(output)
        args.output.chmod(0o400)
        print(json.dumps({"catalogue": str(args.output), "entries": len(value["entries"]), "bytes": len(output), "sha256": hashlib.sha256(output).hexdigest()}))
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, EOFError, tarfile.TarError, struct.error) as failure:
        parser.error(str(failure))


if __name__ == "__main__":
    main()
