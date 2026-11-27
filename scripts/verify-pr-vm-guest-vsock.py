#!/usr/bin/env python3
# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0
"""Minimal zero-dependency guest-side AF_VSOCK (and Unix socket) bridge for
NIC-less `/verify-pr` microVMs.

Subcommands:
  fetch-inputs      Fetch manifest.json and round.bundle from host input port
                    (default vsock CID=2 port=53) and verify SHA-256 fail-closed.
  model-bridge      Listen on loopback TCP (127.0.0.1:<port>) and transparently
                    relay each connection to host model proxy (default port=54).
  upload-artifacts  Stream regular files from an artifact directory to the host
                    bounded collector (default port=52) using its exact frame
                    protocol.
"""

import argparse
import hashlib
import json
import math
import os
import re
import signal
import socket
import stat
import struct
import sys
import threading

GREETING = b"guest-vsock-ready"
ACK = b"host-vsock-ack"
MAX_MANIFEST_BYTES = 256 * 1024
MAX_BUNDLE_BYTES = 128 * 1024 * 1024
MAX_BRIDGE_CONNECTIONS = 64
CHUNK_SIZE = 64 * 1024
# Host collector defaults: maxChunkBytes=2048, maxFrameBytes=4096.
UPLOAD_CHUNK_SIZE = 2048


def connect_endpoint(args, timeout=15.0):
    if args.unix:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect(args.unix)
        return sock
    if not hasattr(socket, "AF_VSOCK"):
        raise RuntimeError("socket.AF_VSOCK is unavailable on this platform")
    sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    sock.connect((args.cid, args.port))
    return sock


def recv_exact(sock, n):
    out = bytearray()
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise EOFError(f"unexpected EOF ({len(out)}/{n} bytes)")
        out.extend(chunk)
    return bytes(out)


def recv_line(sock, max_len=256):
    out = bytearray()
    while len(out) <= max_len:
        ch = sock.recv(1)
        if not ch:
            raise EOFError("unexpected EOF before header newline")
        if ch == b"\n":
            return bytes(out).decode("utf-8")
        out.extend(ch)
    raise ValueError("header line exceeded maximum length")


def fetch_framed_item(args, command, max_bytes, out_file=None):
    with connect_endpoint(args) as sock:
        sock.sendall(f"{command}\n".encode("ascii"))
        header = recv_line(sock)
        if header.startswith("ERR "):
            raise RuntimeError(f"host rejected {command}: {header[4:]}")
        match = re.fullmatch(r"OK ([0-9]+)", header)
        if match is None:
            raise RuntimeError(f"malformed host header: {header!r}")
        expected = int(match[1])
        if expected < 0 or expected > max_bytes:
            raise RuntimeError(f"declared size {expected} exceeds max {max_bytes}")

        digest = hashlib.sha256()
        remaining = expected
        if out_file is not None:
            with open(out_file, "wb") as fp:
                while remaining > 0:
                    chunk = sock.recv(min(CHUNK_SIZE, remaining))
                    if not chunk:
                        raise EOFError(
                            f"truncated payload ({expected - remaining}/{expected} bytes)"
                        )
                    digest.update(chunk)
                    fp.write(chunk)
                    remaining -= len(chunk)
            trailing = sock.recv(1)
            if trailing:
                raise RuntimeError("unexpected trailing bytes after declared payload")
            return expected, digest.hexdigest(), None

        buf = bytearray()
        while remaining > 0:
            chunk = sock.recv(min(CHUNK_SIZE, remaining))
            if not chunk:
                raise EOFError(
                    f"truncated payload ({expected - remaining}/{expected} bytes)"
                )
            digest.update(chunk)
            buf.extend(chunk)
            remaining -= len(chunk)
        trailing = sock.recv(1)
        if trailing:
            raise RuntimeError("unexpected trailing bytes after declared payload")
        return expected, digest.hexdigest(), bytes(buf)


def positive_safe_integer(value):
    # Numeric spellings such as 4.0 and 4e0 are also integers to the Node client.
    return (
        type(value) in (int, float)
        and 0 < value < 2**53
        and math.isfinite(value)
        and value == math.trunc(value)
    )


def validate_input_manifest(manifest):
    def invalid(field):
        raise RuntimeError(f"invalid manifest field: {field}")

    def require_hex(field, length):
        value = manifest.get(field)
        if not isinstance(value, str) or re.fullmatch(
            rf"[0-9a-f]{{{length}}}", value
        ) is None:
            invalid(field)

    if not isinstance(manifest, dict):
        raise RuntimeError("invalid manifest: expected an object")
    allowed = {
        "schemaVersion",
        "runId",
        "repo",
        "prNumber",
        "baseRefOid",
        "headRefOid",
        "bundleSha256",
        "bundleBytes",
        "entropyHex",
        "modelProxy",
    }
    if set(manifest) - allowed:
        invalid("unknown-field")
    if manifest.get("schemaVersion") != "verify-pr-input-v1":
        raise RuntimeError(
            f"unsupported manifest schema: {manifest.get('schemaVersion')!r}"
        )
    run_id = manifest.get("runId")
    if not isinstance(run_id, str) or re.fullmatch(r"[A-Za-z0-9._-]{1,32}", run_id) is None:
        invalid("runId")
    repo = manifest.get("repo")
    if not isinstance(repo, str):
        invalid("repo")
    if "prNumber" not in manifest:
        invalid("prNumber")
    pr_number = manifest["prNumber"]
    if pr_number is not None:
        if not positive_safe_integer(pr_number):
            invalid("prNumber")
        manifest["prNumber"] = int(pr_number)
    require_hex("baseRefOid", 40)
    require_hex("headRefOid", 40)
    require_hex("bundleSha256", 64)
    require_hex("entropyHex", 64)
    bundle_bytes = manifest.get("bundleBytes")
    if not positive_safe_integer(bundle_bytes) or bundle_bytes > MAX_BUNDLE_BYTES:
        invalid("bundleBytes")
    manifest["bundleBytes"] = int(bundle_bytes)

    if "modelProxy" not in manifest:
        invalid("modelProxy")
    proxy = manifest["modelProxy"]
    if proxy is not None:
        if not isinstance(proxy, dict) or set(proxy) - {"port", "basePath", "token", "nonce"}:
            invalid("modelProxy")
        port = proxy.get("port")
        if not positive_safe_integer(port):
            invalid("modelProxy.port")
        proxy["port"] = int(port)
        for key in ("token", "nonce"):
            if (
                not isinstance(proxy.get(key), str)
                or not proxy[key]
                or all(c.isspace() or c == "\ufeff" for c in proxy[key])
            ):
                invalid(f"modelProxy.{key}")
        base_path = proxy.get("basePath")
        if base_path is not None and not isinstance(base_path, str):
            invalid("modelProxy.basePath")


def cmd_fetch_inputs(args):
    os.makedirs(args.out, mode=0o700, exist_ok=True)
    _, _, manifest_bytes = fetch_framed_item(
        args, "GET manifest", MAX_MANIFEST_BYTES
    )
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"invalid manifest JSON/UTF-8: {exc}") from exc
    validate_input_manifest(manifest)

    tmp_bundle = os.path.join(args.out, f".round.bundle.tmp.{os.getpid()}")
    tmp_manifest = os.path.join(args.out, f".manifest.json.tmp.{os.getpid()}")
    tmp_entropy = os.path.join(args.out, f".entropy.hex.tmp.{os.getpid()}")
    staged = [
        (tmp_bundle, os.path.join(args.out, "round.bundle")),
        (tmp_manifest, os.path.join(args.out, "manifest.json")),
        (tmp_entropy, os.path.join(args.out, "entropy.hex")),
    ]
    promoted = []
    try:
        size, sha, _ = fetch_framed_item(
            args, "GET bundle", MAX_BUNDLE_BYTES, out_file=tmp_bundle
        )
        if size != manifest["bundleBytes"] or sha != manifest["bundleSha256"]:
            raise RuntimeError(
                f"bundle integrity mismatch: got {size}B/{sha}, "
                f"expected {manifest['bundleBytes']}B/{manifest['bundleSha256']}"
            )
        result = {
            "runId": manifest["runId"],
            "baseRefOid": manifest["baseRefOid"],
            "headRefOid": manifest["headRefOid"],
            "bundleBytes": size,
            "bundleSha256": sha,
            "hasModelProxy": manifest["modelProxy"] is not None,
        }

        with open(tmp_manifest, "wb") as fp:
            fp.write(manifest_bytes)
        with open(tmp_entropy, "w", encoding="utf-8") as fp:
            fp.write(f"{manifest['entropyHex']}\n")
        for temp_path, _ in staged:
            os.chmod(temp_path, 0o600)
        for temp_path, output_path in staged:
            os.replace(temp_path, output_path)
            promoted.append(output_path)
    except Exception:
        for temp_path, _ in staged:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        for output_path in promoted:
            try:
                os.unlink(output_path)
            except OSError:
                pass
        raise

    sys.stdout.write(json.dumps(result) + "\n")
    return 0


def relay_half(src, dst):
    try:
        while True:
            data = src.recv(CHUNK_SIZE)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle_bridge_client(client, args, on_done):
    upstream = None
    try:
        upstream = connect_endpoint(args, timeout=30.0)
        upstream.settimeout(None)
        client.settimeout(None)
        t1 = threading.Thread(target=relay_half, args=(client, upstream), daemon=True)
        t2 = threading.Thread(target=relay_half, args=(upstream, client), daemon=True)
        try:
            t1.start()
            t2.start()
            t1.join()
            t2.join()
        except RuntimeError:
            # A relay which has already started may be blocked on a peer recv.
            for sock in (client, upstream):
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
    except OSError:
        pass
    finally:
        for sock in (client, upstream):
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
        on_done()


def cmd_model_bridge(args):
    if args.listen not in ("127.0.0.1", "::1", "localhost"):
        raise RuntimeError(
            f"model-bridge refuses non-loopback listen address: {args.listen!r}"
        )
    stop_event = threading.Event()

    def _stop(_signum, _frame):
        stop_event.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    family = socket.AF_INET6 if args.listen == "::1" else socket.AF_INET
    server = socket.socket(family, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.listen, args.local_port))
    server.listen(32)
    server.settimeout(0.25)
    host, port = server.getsockname()[:2]
    sys.stdout.write(json.dumps({"host": host, "port": port}) + "\n")
    sys.stdout.flush()

    active_connections = 0
    connections_lock = threading.Lock()
    saturation_reported = False

    def finish_client():
        nonlocal active_connections
        with connections_lock:
            active_connections -= 1

    try:
        while not stop_event.is_set():
            try:
                client, _ = server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with connections_lock:
                if active_connections >= MAX_BRIDGE_CONNECTIONS:
                    if not saturation_reported:
                        saturation_reported = True
                        print(
                            f"model bridge: connection limit {MAX_BRIDGE_CONNECTIONS} reached; refusing extra client",
                            file=sys.stderr,
                            flush=True,
                        )
                    client.close()
                    continue
                active_connections += 1
            try:
                threading.Thread(
                    target=handle_bridge_client,
                    args=(client, args, finish_client),
                    daemon=True,
                ).start()
            except RuntimeError:
                finish_client()
                try:
                    client.close()
                except OSError:
                    pass
                continue
    finally:
        server.close()
    return 0


def send_frame(sock, kind, payload):
    sock.sendall(struct.pack(">cI", kind.encode("ascii"), len(payload)) + payload)


def collect_regular_files(root_dir):
    files = []
    for entry in sorted(os.listdir(root_dir)):
        full = os.path.join(root_dir, entry)
        st = os.lstat(full)
        if stat.S_ISREG(st.st_mode):
            files.append((entry, full, st.st_size))
        elif stat.S_ISDIR(st.st_mode) and entry in ("evidence", "logs"):
            for sub in sorted(os.listdir(full)):
                sub_full = os.path.join(full, sub)
                sub_st = os.lstat(sub_full)
                if stat.S_ISREG(sub_st.st_mode):
                    files.append((f"{entry}/{sub}", sub_full, sub_st.st_size))
    return files


def cmd_upload_artifacts(args):
    files = collect_regular_files(args.dir)
    with connect_endpoint(args, timeout=30.0) as sock:
        sock.sendall(GREETING)
        ack = recv_exact(sock, len(ACK))
        if ack != ACK:
            raise RuntimeError(f"unexpected collector ack: {ack!r}")
        send_frame(sock, "H", b"report-v1")
        for rel_name, full_path, _ in files:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(full_path, flags)
            try:
                f_st = os.fstat(fd)
                if not stat.S_ISREG(f_st.st_mode):
                    raise RuntimeError(f"refusing non-regular file: {rel_name}")
                file_size = f_st.st_size
                send_frame(
                    sock,
                    "B",
                    struct.pack(">Q", file_size) + rel_name.encode("utf-8"),
                )
                digest = hashlib.sha256()
                remaining = file_size
                with os.fdopen(fd, "rb") as fp:
                    fd = -1
                    while remaining > 0:
                        chunk = fp.read(min(UPLOAD_CHUNK_SIZE, remaining))
                        if not chunk:
                            raise RuntimeError(
                                f"file shrank while uploading: {rel_name}"
                            )
                        digest.update(chunk)
                        send_frame(sock, "C", chunk)
                        remaining -= len(chunk)
            finally:
                if fd >= 0:
                    os.close(fd)
            send_frame(sock, "E", digest.hexdigest().encode("ascii"))
        send_frame(sock, "R", b"")
        reply = sock.recv(256)
        if not reply.startswith(b"O"):
            raise RuntimeError(f"collector rejected round: {reply!r}")
    sys.stdout.write(
        json.dumps({"uploaded": [name for name, _, _ in files], "ok": True}) + "\n"
    )
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Guest vsock bridge for /verify-pr")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add_transport(p, default_port):
        p.add_argument("--cid", type=int, default=2)
        p.add_argument("--port", type=int, default=default_port)
        p.add_argument("--unix", default=None)

    p_fetch = sub.add_parser("fetch-inputs")
    add_transport(p_fetch, 53)
    p_fetch.add_argument("--out", required=True)

    p_bridge = sub.add_parser("model-bridge")
    add_transport(p_bridge, 54)
    p_bridge.add_argument("--listen", default="127.0.0.1")
    p_bridge.add_argument("--local-port", type=int, default=0)

    p_up = sub.add_parser("upload-artifacts")
    add_transport(p_up, 52)
    p_up.add_argument("--dir", required=True)

    args = parser.parse_args(argv)
    if args.cmd == "fetch-inputs":
        return cmd_fetch_inputs(args)
    if args.cmd == "model-bridge":
        return cmd_model_bridge(args)
    if args.cmd == "upload-artifacts":
        return cmd_upload_artifacts(args)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.stderr.write(f"guest-vsock: {exc}\n")
        sys.exit(1)
