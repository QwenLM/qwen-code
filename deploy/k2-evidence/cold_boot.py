"""Fixed first-systemd byte contract; none of these checks qualify a boot."""

import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import struct
import ctypes
import ctypes.util
import io
import gzip
import lzma
import zlib


HERE = Path(__file__).resolve().parent
LANE_PATH = HERE.parents[1] / "packages/k2-node-evidence/internal/artifactset/cold-lane.json"
TARGET = b"[Unit]\nDescription=Qwen K2 cold boot endpoint\nDefaultDependencies=no\nAllowIsolate=no\n"
MANAGER = b"[Manager]\nDumpCore=no\nCrashShell=no\nCrashReboot=no\n"
GENERATORS = ("render-cold-boot.py", "package-cold-initrd.py", "cold_boot.py", "cold-lane.json")


def require(value, message):
    if not value:
        raise ValueError(message)


def closed(pairs):
    value = {}
    for name, item in pairs:
        require(name not in value, "duplicate JSON field")
        value[name] = item
    return value


def loads(raw):
    return json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=closed,
                      parse_constant=lambda _: require(False, "non-finite number"))


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def pin(raw):
    return {"bytes": len(raw), "sha256": sha(raw)}


def lane():
    return loads(LANE_PATH.read_bytes())


def generators():
    return {name: sha((LANE_PATH if name == "cold-lane.json" else HERE / name).read_bytes()) for name in GENERATORS}


def literal(name):
    require(isinstance(name, str) and name.startswith("/") and not name.startswith("//") and name != "/" and len(name) <= 2048
            and posixpath.normpath(name) == name and not any(c in name for c in "\x00\r\n"), "literal cold path required")
    return name


def resolve(name, links):
    for _ in range(41):
        parts = name.strip("/").split("/")
        for i in range(len(parts)):
            prefix = "/" + "/".join(parts[:i + 1])
            if prefix in links:
                target = links[prefix]
                if not target.startswith("/"):
                    target = posixpath.join(posixpath.dirname(prefix), target)
                name = posixpath.normpath(posixpath.join(target, *parts[i + 1:]))
                break
        else:
            return name
    raise ValueError("cold alias cycle")


def validate(raw):
    require(0 < len(raw) <= 64 * 1024, "cold bootstrap exceeds its bound")
    value, fixed = loads(raw), lane()
    require(isinstance(value, dict) and set(value) == set(fixed), "exact thirteen cold-bootstrap fields required")
    loader, systemd = value["coldInit"], value["systemd"]
    require(isinstance(loader, dict) and set(loader) == {"path", "bytes", "sha256"}
            and type(loader["bytes"]) is int and 64 <= loader["bytes"] <= 128 * 1024 * 1024
            and re.fullmatch(r"[0-9a-f]{64}", loader["sha256"]), "bounded actual cold-init identity required")
    label = systemd["label"]
    require(isinstance(label, str) and re.fullmatch(r"[A-Za-z0-9/][A-Za-z0-9._/-]{0,252}", label)
            and "//" not in label and not label.endswith("/") and label != "unconfined"
            and not label.startswith("qwen-k2-"), "confined root systemd label required")
    require(isinstance(value["generators"], dict) and set(value["generators"]) == set(GENERATORS)
            and all(isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) for v in value["generators"].values()),
            "closed cold generator set required")
    outputs = value["bootState"]["scriptOutputs"]
    mandatory = {"/init", "/scripts/functions", "/scripts/init-top/udev", "/scripts/init-bottom/udev",
                 "/scripts/init-top/ORDER", "/scripts/init-bottom/ORDER", "/scripts/local-bottom/ORDER"}
    require(isinstance(outputs, dict) and 7 <= len(outputs) <= 256 and mandatory <= set(outputs), "complete hardened entries required")
    for name, item in outputs.items():
        literal(name)
        require(name in mandatory or re.fullmatch(r"/scripts/[A-Za-z0-9._-]+/ORDER", name), "unexpected hardened path")
        require(isinstance(item, dict) and set(item) == {"bytes", "sha256"} and type(item["bytes"]) is int
                and 0 < item["bytes"] <= 1024 * 1024 and re.fullmatch(r"[0-9a-f]{64}", item["sha256"]), "bounded script pin required")
    links = value["linkPlan"]
    require(isinstance(links, dict) and len(links) <= 64, "bounded cold alias set required")
    for name, target in links.items():
        literal(name)
        require(name in ("/lib", "/lib64") or name.startswith(("/usr/lib/", "/usr/lib64/")), "unexpected cold alias")
        require(isinstance(target, str) and 0 < len(target) <= 2048 and not any(c in target for c in "\x00\r\n"), "literal cold alias target required")
    for item in value["systemdDependencies"]:
        require(resolve(item["lookupPath"], links) == item["path"], "dependency alias differs from pinned actual path")
    normalized = copy.deepcopy(value)
    normalized["coldInit"]["bytes"], normalized["coldInit"]["sha256"] = 0, ""
    normalized["systemd"]["label"] = ""
    normalized["generators"], normalized["linkPlan"], normalized["bootState"]["scriptOutputs"] = {}, {}, {}
    require(json.dumps(normalized, sort_keys=True) == json.dumps(fixed, sort_keys=True), "unsupported cold lane or startup plan")
    return value


def read(path, limit, expected=None):
    require(path.is_absolute() and not path.is_symlink(), "absolute regular input required")
    if expected is not None:
        require(isinstance(expected, dict) and type(expected["bytes"]) is int and 0 < expected["bytes"] <= limit
                and isinstance(expected["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", expected["sha256"]),
                "positive bounded cold input pin required")
        limit = expected["bytes"]
    with path.open("rb") as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "regular input required")
        raw = stream.read(limit + 1)
    require(0 < len(raw) <= limit, "cold input exceeds its bound")
    if expected is not None:
        require(len(raw) == expected["bytes"] and sha(raw) == expected["sha256"], "reviewed cold input bytes differ")
    return raw


def actual(root, name):
    """Resolve only within an offline tree; never follow a host absolute link."""
    links = {}
    for _ in range(41):
        parts = PurePosixPath(literal(name)).parts[1:]
        for i in range(len(parts)):
            current = "/" + "/".join(parts[:i + 1])
            info = (root / current[1:]).lstat()
            if stat.S_ISLNK(info.st_mode):
                target = (root / current[1:]).readlink().as_posix()
                links[current] = target
                if not target.startswith("/"):
                    target = posixpath.join(posixpath.dirname(current), target)
                name = posixpath.normpath(posixpath.join(target, *parts[i + 1:]))
                break
            require(i == len(parts) - 1 or stat.S_ISDIR(info.st_mode), "non-directory cold ancestor")
        else:
            return name, links
    raise ValueError("offline cold alias cycle")


def static_elf(raw):
    require(len(raw) >= 64 and raw[:6] == b"\x7fELF\x02\x01" and struct.unpack_from("<H", raw, 18)[0] == 62,
            "amd64 static ELF required")
    start, size, count = struct.unpack_from("<Q", raw, 32)[0], struct.unpack_from("<H", raw, 54)[0], struct.unpack_from("<H", raw, 56)[0]
    require(size == 56 and 0 < count <= 128 and start + size * count <= len(raw), "bounded ELF program headers required")
    require(all(struct.unpack_from("<I", raw, start + size * i)[0] not in (2, 3) for i in range(count)), "cold-init must have no interpreter or dynamic section")


def save(root, name, raw, mode=0o400):
    path = root / name
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(raw)
    path.chmod(mode)


EXPANDED_LIMIT = 1024 * 1024 * 1024


def zstd_frame(raw):
    library = ctypes.util.find_library("zstd")
    require(library is not None, "zstd decompression library unavailable; no candidate was produced")
    lib = ctypes.CDLL(library)
    class Buffer(ctypes.Structure):
        _fields_ = [("data", ctypes.c_void_p), ("size", ctypes.c_size_t), ("pos", ctypes.c_size_t)]
    lib.ZSTD_createDStream.restype = ctypes.c_void_p
    lib.ZSTD_initDStream.argtypes = [ctypes.c_void_p]
    lib.ZSTD_freeDStream.argtypes = [ctypes.c_void_p]
    lib.ZSTD_decompressStream.argtypes = [ctypes.c_void_p, ctypes.POINTER(Buffer), ctypes.POINTER(Buffer)]
    lib.ZSTD_decompressStream.restype = ctypes.c_size_t
    lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
    source, chunk = ctypes.create_string_buffer(raw), ctypes.create_string_buffer(1024 * 1024)
    incoming = Buffer(ctypes.cast(source, ctypes.c_void_p), len(raw), 0)
    stream = lib.ZSTD_createDStream()
    require(stream, "zstd stream unavailable")
    out = bytearray()
    try:
        require(not lib.ZSTD_isError(lib.ZSTD_initDStream(stream)), "zstd initialization failed")
        while True:
            previous = incoming.pos
            outgoing = Buffer(ctypes.cast(chunk, ctypes.c_void_p), len(chunk), 0)
            result = lib.ZSTD_decompressStream(stream, ctypes.byref(outgoing), ctypes.byref(incoming))
            require(not lib.ZSTD_isError(result), "invalid zstd initrd frame")
            out += chunk.raw[:outgoing.pos]
            require(len(out) <= EXPANDED_LIMIT, "expanded initrd exceeds its bound")
            if result == 0:
                return bytes(out), incoming.pos
            require(incoming.pos > previous or outgoing.pos > 0, "truncated zstd initrd frame")
    finally:
        lib.ZSTD_freeDStream(stream)


def unpack(raw):
    """Read concatenated kernel newc/compressed archives without extracting paths."""
    require(0 < len(raw) <= EXPANDED_LIMIT, "initrd exceeds its bound")
    entries, expanded = {}, 0
    def consume(data, compressed=False):
        nonlocal expanded
        offset, hardlinks = 0, {}
        while offset < len(data):
            if data[offset] == 0:
                offset += 1
                continue
            magic = data[offset:offset + 6]
            if magic.startswith((b"\x1f\x8b", b"\xfd7zXZ\x00", b"\x28\xb5\x2f\xfd")):
                require(not compressed, "nested compression is not a kernel initramfs archive")
                rest = data[offset:]
                if rest.startswith(b"\x28\xb5\x2f\xfd"):
                    decoded, used = zstd_frame(rest)
                else:
                    decoder = zlib.decompressobj(31) if rest.startswith(b"\x1f\x8b") else lzma.LZMADecompressor()
                    decoded = decoder.decompress(rest, EXPANDED_LIMIT + 1)
                    require(decoder.eof, "truncated or oversized compressed initrd")
                    used = len(rest) - len(decoder.unused_data)
                expanded += len(decoded)
                require(expanded <= EXPANDED_LIMIT, "expanded initrd exceeds its aggregate bound")
                consume(decoded, True)
                offset += used
                continue
            require(magic in (b"070701", b"070702") and len(data) - offset >= 110, "unsupported initrd archive")
            numbers = [int(data[offset + 6 + i * 8:offset + 14 + i * 8], 16) for i in range(13)]
            inode, mode, _, _, nlink, _, size, major, minor, _, _, namesize, checksum = numbers
            require(0 < namesize <= 4096 and 0 <= size <= 128 * 1024 * 1024, "oversized initrd member")
            start = offset + 110
            require(start + namesize <= len(data) and data[start + namesize - 1] == 0, "invalid initrd name")
            name = data[start:start + namesize - 1].decode("utf-8", "strict")
            body = (start + namesize + 3) & ~3
            require(body + size <= len(data), "truncated initrd member")
            content = data[body:body + size]
            offset = (body + size + 3) & ~3
            require(magic != b"070702" or sum(content) & 0xffffffff == checksum, "initrd CRC differs")
            if name == "TRAILER!!!":
                hardlinks = {}
                continue
            while name.startswith("./"):
                name = name[2:]
            if name == ".":
                continue
            name = literal("/" + name)
            require(len(entries) < 65536, "too many initrd entries")
            node = {"mode": mode, "data": content}
            if stat.S_ISREG(mode) and nlink > 1:
                key = (major, minor, inode)
                group = hardlinks.setdefault(key, [])
                group.append(node)
                if content:
                    for prior in group:
                        prior["data"] = content
                elif len(group) > 1:
                    node["data"] = group[0]["data"]
            entries[name] = node
    consume(raw)
    return entries


def cpio(entries):
    out = bytearray()
    for inode, (name, item) in enumerate(sorted(entries.items()) + [("/TRAILER!!!", {"mode": 0, "data": b""})], 1):
        body, filename = item["data"], name.lstrip("/").encode() + b"\0"
        numbers = (inode, item["mode"], 0, 0, 1, 0, len(body), 0, 0, 0, 0, len(filename), 0)
        out += b"070701" + b"".join(("%08x" % n).encode() for n in numbers) + filename
        out += b"\0" * (-len(out) % 4)
        out += body
        out += b"\0" * (-len(out) % 4)
    out += b"\0" * (-len(out) % 512)
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as stream:
        stream.write(out)
    return buffer.getvalue()
