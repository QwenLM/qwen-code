#!/usr/bin/env python3
# Copyright 2026 Qwen Team
# SPDX-License-Identifier: Apache-2.0
"""Standard zero-dependency guest lifecycle orchestrator for NIC-less
`/verify-pr` microVMs.

Drives the 7-step guest contract end-to-end using `verify-pr-vm-guest-vsock.py`:
  1. Fetch `manifest.json` (shape-validated) and `round.bundle` (verified
     against manifest `bundleBytes`/`bundleSha256`) via port 53, and write
     `entropy.hex` from `manifest.entropyHex`.
  2. Mix host-supplied entropy into /dev/urandom (or configured urandom target)
     and require the write to succeed fail-closed.
  3. Inspect guest isolation invariants (loopback-only NICs, no virtiofs/9p);
     unreadable sysfs/procfs paths fail closed.
  4. Materialize an isolated git workspace from round.bundle and assert exact
     baseRefOid / headRefOid presence (or verify the bundle header when
     `--skip-materialize` is explicitly passed for git-less minimal images).
  5. When manifest.modelProxy is present, launch loopback model-bridge using
     the negotiated `manifest.modelProxy.port` and verify GET /__health raw
     nonce equality before starting the workload.
  6. Execute either a configured workload script or the built-in self-test in a
     credential-stripped environment under a bounded timeout; any isolation or
     entropy breach refuses workload launch and emits an `inconclusive` report.
  7. In `finally`, always stop model-bridge and stream artifacts to the host
     collector (port 52).

Supports both real AF_VSOCK (CID/ports, optionally parsed from `/proc/cmdline`)
and Unix sockets (`--unix-input`/`--unix-model`/`--unix-collector`) for offline
host-side integration testing.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

DEFAULT_CID = 2
DEFAULT_COLLECTOR_PORT = 52
DEFAULT_INPUT_PORT = 53
DEFAULT_MODEL_PORT = 54
DEFAULT_WORKLOAD_TIMEOUT = 600
SHARED_FS_TYPES = frozenset({"virtiofs", "9p", "vboxsf", "vmhgfs", "fuse.sshfs"})
OID_RE = re.compile(r"^[0-9a-f]{40}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


def resolve_vsock_script(explicit_path=None):
    if explicit_path:
        path = Path(explicit_path)
        if not path.is_file():
            raise RuntimeError(f"vsock script not found: {path}")
        return path
    here = Path(__file__).resolve().parent
    for name in ("guest-vsock.py", "verify-pr-vm-guest-vsock.py"):
        candidate = here / name
        if candidate.is_file():
            return candidate
    raise RuntimeError(f"could not locate guest-vsock script next to {__file__}")


def load_vsock_module(script_path):
    spec = importlib.util.spec_from_file_location("qwen_guest_vsock", str(script_path))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"failed to load vsock module from {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_kernel_cmdline(cmdline_text):
    """Parses `qwen.*` key=value tokens from a Linux `/proc/cmdline` string."""
    parsed = {}
    try:
        tokens = shlex.split(cmdline_text)
    except ValueError:
        tokens = cmdline_text.split()
    for token in tokens:
        if "=" not in token:
            continue
        key, value = token.split("=", 1)
        if key.startswith("qwen."):
            parsed[key[5:]] = value
    return parsed


def inject_entropy(entropy_hex, urandom_path="/dev/urandom"):
    if not isinstance(entropy_hex, str) or HEX64_RE.fullmatch(entropy_hex) is None:
        raise RuntimeError("invalid entropyHex: expected 64 lowercase hex characters")
    raw = bytes.fromhex(entropy_hex)
    written = False
    error_message = None
    try:
        with open(urandom_path, "wb") as fp:
            fp.write(raw)
        written = True
    except OSError as exc:
        error_message = str(exc)
    return {"bytes": len(raw), "written": written, "error": error_message}


def inspect_guest_isolation(sys_net_dir="/sys/class/net", proc_mounts="/proc/mounts"):
    net_inspected = False
    interfaces = []
    if os.path.isdir(sys_net_dir):
        try:
            interfaces = sorted(os.listdir(sys_net_dir))
            net_inspected = True
        except OSError:
            net_inspected = False
    non_loopback = [iface for iface in interfaces if iface != "lo"]
    no_nic = net_inspected and len(non_loopback) == 0

    mounts_inspected = False
    shared_mounts = []
    if os.path.isfile(proc_mounts):
        try:
            with open(proc_mounts, "r", encoding="utf-8", errors="replace") as fp:
                for line in fp:
                    parts = line.split()
                    if len(parts) >= 3 and parts[2] in SHARED_FS_TYPES:
                        shared_mounts.append({"mountPoint": parts[1], "fsType": parts[2]})
            mounts_inspected = True
        except OSError:
            mounts_inspected = False
    return {
        "netInspected": net_inspected,
        "mountsInspected": mounts_inspected,
        "interfaces": interfaces,
        "nonLoopbackInterfaces": non_loopback,
        "noNic": no_nic,
        "sharedMounts": shared_mounts,
        "hasDirectoryShare": (not mounts_inspected) or len(shared_mounts) > 0,
    }


def start_model_bridge(vsock_script, *, cid, model_port, unix_model=None):
    cmd = [
        sys.executable,
        str(vsock_script),
        "model-bridge",
        "--listen",
        "127.0.0.1",
        "--local-port",
        "0",
    ]
    if unix_model:
        cmd.extend(["--unix", str(unix_model)])
    else:
        cmd.extend(["--cid", str(cid), "--port", str(model_port)])

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None
    first_line = proc.stdout.readline()
    if not first_line:
        stderr_out = proc.stderr.read() if proc.stderr else ""
        proc.wait(timeout=5)
        raise RuntimeError(
            f"model-bridge failed before announcing port (rc={proc.returncode}): {stderr_out.strip()}"
        )
    info = json.loads(first_line)
    host = info.get("host")
    port = info.get("port")
    if (
        host != "127.0.0.1"
        or not isinstance(port, int)
        or isinstance(port, bool)
        or not (1 <= port <= 65535)
    ):
        stop_process(proc)
        raise RuntimeError(f"model-bridge announced invalid bind address: {info!r}")
    return proc, host, port


def stop_process(proc, grace_seconds=5.0):
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
    except OSError:
        pass
    try:
        proc.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except OSError:
            pass
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            pass


def verify_model_proxy_health(host, port, expected_nonce, timeout=10.0):
    url = f"http://{host}:{port}/__health"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace").strip()
            if resp.status != 200:
                raise RuntimeError(f"model-proxy /__health returned HTTP {resp.status}")
    except (OSError, urllib.error.URLError) as exc:
        raise RuntimeError(f"model-proxy /__health check failed: {exc}") from exc
    if body != expected_nonce:
        raise RuntimeError(
            f"model-proxy /__health nonce mismatch: got {body!r}, expected {expected_nonce!r}"
        )
    return {"ok": True, "nonce": body}


def verify_bundle_header(bundle_path, base_oid, head_oid):
    """Verifies a Git v2/v3 bundle header in pure Python without requiring `git`.

    `head_oid` must appear as an advertised (non-prerequisite) ref contained in
    the bundle. `base_oid` may appear either as an advertised ref or as a
    `-`<oid> prerequisite line (incremental bundles list the base commit as a
    prerequisite).
    """
    if not OID_RE.fullmatch(base_oid) or not OID_RE.fullmatch(head_oid):
        raise RuntimeError("baseRefOid and headRefOid must be 40-char lowercase hex")
    advertised = set()
    prerequisites = set()
    with open(bundle_path, "rb") as fp:
        first = fp.readline(256).decode("utf-8", errors="replace").strip()
        if first not in ("# v2 git bundle", "# v3 git bundle"):
            raise RuntimeError(f"unexpected git bundle header: {first!r}")
        for _ in range(1024):
            raw_line = fp.readline(4096)
            if not raw_line:
                break
            line = raw_line.decode("utf-8", errors="replace").strip()
            if line == "":
                break
            if line.startswith("-"):
                token = line[1:].split(None, 1)[0]
                if OID_RE.fullmatch(token):
                    prerequisites.add(token)
            else:
                token = line.split(None, 1)[0]
                if OID_RE.fullmatch(token):
                    advertised.add(token)
    has_base = base_oid in advertised or base_oid in prerequisites
    has_head = head_oid in advertised
    if not has_base or not has_head:
        raise RuntimeError(
            f"bundle header missing required OIDs (base={has_base}, head={has_head})"
        )
    return {
        "verified": True,
        "skipped": True,
        "headerVerified": True,
        "baseRefOid": base_oid,
        "headRefOid": head_oid,
        "changedFiles": [],
    }


def materialize_bundle(bundle_path, repo_dir, base_oid, head_oid):
    if not OID_RE.fullmatch(base_oid) or not OID_RE.fullmatch(head_oid):
        raise RuntimeError("baseRefOid and headRefOid must be 40-char lowercase hex")
    os.makedirs(repo_dir, mode=0o700, exist_ok=True)
    git_env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": str(Path(repo_dir).parent),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }

    def run_git(args):
        res = subprocess.run(
            ["git", "-C", str(repo_dir), *args],
            env=git_env,
            text=True,
            capture_output=True,
            timeout=120,
        )
        if res.returncode != 0:
            raise RuntimeError(
                f"git {' '.join(args)} failed (rc={res.returncode}): {res.stderr.strip()}"
            )
        return res.stdout.strip()

    run_git(["init", "-q"])
    run_git(["bundle", "unbundle", str(bundle_path)])
    resolved_base = run_git(["rev-parse", "--verify", f"{base_oid}^{{commit}}"])
    resolved_head = run_git(["rev-parse", "--verify", f"{head_oid}^{{commit}}"])
    if resolved_base != base_oid or resolved_head != head_oid:
        raise RuntimeError(
            f"bundle OID mismatch: base={resolved_base}, head={resolved_head}"
        )
    run_git(["checkout", "-q", "--detach", head_oid])
    checked_head = run_git(["rev-parse", "HEAD"])
    if checked_head != head_oid:
        raise RuntimeError(f"checked-out HEAD {checked_head} != {head_oid}")
    diff_stat = run_git(["diff", "--name-only", f"{base_oid}..{head_oid}"])
    changed_files = [line for line in diff_stat.splitlines() if line]
    return {
        "verified": True,
        "repoDir": str(repo_dir),
        "baseRefOid": resolved_base,
        "headRefOid": checked_head,
        "changedFiles": changed_files,
    }


def write_runtime_log(
    artifacts_dir,
    *,
    manifest,
    isolation,
    entropy_status,
    materialized,
    bridge_url,
    model_probe_status,
    checks,
    error_message=None,
):
    os.makedirs(artifacts_dir, mode=0o700, exist_ok=True)
    logs_dir = Path(artifacts_dir) / "logs"
    logs_dir.mkdir(mode=0o700, exist_ok=True)
    runtime_log = {
        "schemaVersion": "verify-pr-guest-runtime-v1",
        "runId": manifest["runId"],
        "repo": manifest["repo"],
        "prNumber": manifest["prNumber"],
        "baseRefOid": manifest["baseRefOid"],
        "headRefOid": manifest["headRefOid"],
        "bundleSha256": manifest["bundleSha256"],
        "bundleBytes": manifest["bundleBytes"],
        "isolation": isolation,
        "entropy": entropy_status,
        "materialized": materialized,
        "hasModelProxy": manifest["modelProxy"] is not None,
        "bridgeUrl": bridge_url,
        "modelProbeStatus": model_probe_status,
        "checks": checks,
        "error": error_message,
    }
    (logs_dir / "guest-runtime.json").write_text(
        json.dumps(runtime_log, indent=2) + "\n", encoding="utf-8"
    )


def write_self_test_artifacts(
    artifacts_dir,
    *,
    manifest,
    isolation,
    entropy_status,
    materialized,
    model_health,
    bridge_url,
    model_probe_status,
    error_message=None,
    include_model_probe=True,
):
    os.makedirs(artifacts_dir, mode=0o700, exist_ok=True)

    checks = [
        {"name": "entropy-injected", "ok": bool(entropy_status.get("written"))},
        {"name": "guest-no-nic", "ok": bool(isolation.get("noNic"))},
        {
            "name": "guest-no-directory-share",
            "ok": not bool(isolation.get("hasDirectoryShare")),
        },
        {
            "name": "bundle-verified",
            "ok": bool(materialized and materialized.get("verified")),
        },
    ]
    if manifest["modelProxy"] is not None:
        checks.append(
            {"name": "model-proxy-health-nonce", "ok": model_health is not None}
        )
        if include_model_probe:
            checks.append(
                {"name": "model-proxy-probe", "ok": model_probe_status == 200}
            )
    if error_message is not None:
        checks.append({"name": "guest-lifecycle-error", "ok": False})

    failed = [c for c in checks if not c["ok"]]
    verdict = "merge-ready" if not failed else "inconclusive"
    passed_count = len(checks) - len(failed)
    total_count = len(checks)

    write_runtime_log(
        artifacts_dir,
        manifest=manifest,
        isolation=isolation,
        entropy_status=entropy_status,
        materialized=materialized,
        bridge_url=bridge_url,
        model_probe_status=model_probe_status,
        checks=checks,
        error_message=error_message,
    )
    (Path(artifacts_dir) / "verdict.txt").write_text(f"{verdict}\n", encoding="utf-8")
    (Path(artifacts_dir) / "assertions.json").write_text(
        json.dumps(
            {
                "pass": passed_count,
                "fail": len(failed),
                "total": total_count,
                "failures": [
                    {
                        "id": c["name"],
                        "attribution": "harness",
                        "reason": (
                            error_message
                            if c["name"] == "guest-lifecycle-error" and error_message
                            else f"guest check failed: {c['name']}"
                        ),
                    }
                    for c in failed
                ],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    changed_count = (
        len(materialized.get("changedFiles", [])) if isinstance(materialized, dict) else 0
    )
    report_lines = [
        f"{verdict} · {passed_count} passed · {len(failed)} failed · {total_count} total · {manifest['headRefOid']}",
        "",
        "## Methodology",
        "",
        "**Boundary.** Hardware-isolated microVM executed by verify-pr-vm-guest-runner.",
        "",
        f"- Run ID: `{manifest['runId']}`",
        f"- Base OID: `{manifest['baseRefOid']}`",
        f"- Head OID: `{manifest['headRefOid']}`",
        f"- Changed files in bundle: {changed_count}",
    ]
    if error_message:
        report_lines.append(f"- Guest lifecycle error: `{error_message}`")
    report_lines.append("")
    (Path(artifacts_dir) / "report.md").write_text(
        "\n".join(report_lines), encoding="utf-8"
    )
    comment_md = (
        f"{verdict} ({passed_count}/{total_count} guest checks passed for `{manifest['headRefOid']}`)\n\n"
        "_— verify-pr-guest-runner via Qwen Code /verify-pr (v0.28.7; skill guest-self-test)_\n"
    )
    (Path(artifacts_dir) / "comment.md").write_text(comment_md, encoding="utf-8")


def run_guest_round(args):
    vsock_script = resolve_vsock_script(args.vsock_script)
    vsock_mod = load_vsock_module(vsock_script)

    work_root = (
        Path(args.work_dir)
        if args.work_dir
        else Path(tempfile.mkdtemp(prefix="qc-guest-"))
    )
    work_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    inputs_dir = work_root / "inputs"
    repo_dir = work_root / "repo"
    repo_dir.mkdir(mode=0o700, exist_ok=True)
    artifacts_dir = work_root / "artifacts"
    artifacts_dir.mkdir(mode=0o700, exist_ok=True)

    # 1. Fetch manifest + bundle via vsock input port (53)
    fetch_ns = argparse.Namespace(
        cid=args.cid,
        port=args.input_port,
        unix=args.unix_input,
        out=str(inputs_dir),
    )
    rc_fetch = vsock_mod.cmd_fetch_inputs(fetch_ns)
    if rc_fetch != 0:
        raise RuntimeError(f"fetch-inputs failed with rc={rc_fetch}")

    manifest = json.loads((inputs_dir / "manifest.json").read_text(encoding="utf-8"))
    entropy_hex = (inputs_dir / "entropy.hex").read_text(encoding="utf-8").strip()
    bundle_path = inputs_dir / "round.bundle"

    # 2. Mix host-supplied entropy into /dev/urandom
    entropy_status = inject_entropy(entropy_hex, urandom_path=args.urandom_path)

    # 3. Inspect guest isolation invariants
    isolation = inspect_guest_isolation(
        sys_net_dir=args.sys_net_dir,
        proc_mounts=args.proc_mounts,
    )

    workload_path = args.workload
    if workload_path is None and os.path.isfile("/opt/qwen/workload.sh"):
        workload_path = "/opt/qwen/workload.sh"

    materialized = None
    bridge_proc = None
    bridge_url = None
    model_health = None
    model_probe_status = None
    workload_rc = 0
    round_error = None

    try:
        # Fail-closed gate for workload rounds before materialization or execution
        if workload_path is not None:
            breaches = []
            if not entropy_status["written"]:
                breaches.append(
                    f"entropy-write-failed:{entropy_status.get('error') or 'unwritten'}"
                )
            if not isolation["noNic"]:
                breaches.append(
                    f"non-loopback-nic:{','.join(isolation['nonLoopbackInterfaces']) or 'uninspected'}"
                )
            if isolation["hasDirectoryShare"]:
                breaches.append(
                    "shared-mount-detected"
                    if isolation["mountsInspected"]
                    else "mounts-uninspected"
                )
            if breaches:
                raise RuntimeError(f"guest isolation breach ({'; '.join(breaches)})")

        # 4. Materialize git workspace (or verify bundle header when --skip-materialize is requested)
        if args.skip_materialize:
            materialized = verify_bundle_header(
                bundle_path,
                manifest["baseRefOid"],
                manifest["headRefOid"],
            )
        else:
            materialized = materialize_bundle(
                bundle_path,
                repo_dir,
                manifest["baseRefOid"],
                manifest["headRefOid"],
            )

        # 5. Start loopback model-bridge when manifest.modelProxy is present
        proxy = manifest.get("modelProxy")
        if proxy is not None:
            raw_port = proxy.get("port")
            negotiated_port = (
                raw_port
                if isinstance(raw_port, int)
                and not isinstance(raw_port, bool)
                and 1 <= raw_port <= 65535
                else args.model_port
            )
            bridge_proc, b_host, b_port = start_model_bridge(
                vsock_script,
                cid=args.cid,
                model_port=negotiated_port,
                unix_model=args.unix_model,
            )
            model_health = verify_model_proxy_health(b_host, b_port, proxy["nonce"])
            base_path = proxy.get("basePath") or "/v1"
            if not base_path.startswith("/"):
                base_path = "/" + base_path
            bridge_url = f"http://{b_host}:{b_port}{base_path}"

        # 6. Run workload or built-in self-test
        if workload_path:
            write_runtime_log(
                artifacts_dir,
                manifest=manifest,
                isolation=isolation,
                entropy_status=entropy_status,
                materialized=materialized,
                bridge_url=bridge_url,
                model_probe_status=model_probe_status,
                checks=[
                    {"name": "entropy-injected", "ok": True},
                    {"name": "guest-no-nic", "ok": True},
                    {"name": "guest-no-directory-share", "ok": True},
                    {"name": "bundle-verified", "ok": True},
                ],
            )
            workload_env = {
                "PATH": os.environ.get(
                    "PATH", "/opt/python/bin:/usr/local/bin:/usr/bin:/bin"
                ),
                "HOME": str(work_root),
                "TMPDIR": str(work_root),
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "QWEN_VERIFY_RUN_ID": manifest["runId"],
                "QWEN_VERIFY_REPO": manifest["repo"],
                "QWEN_VERIFY_BASE_OID": manifest["baseRefOid"],
                "QWEN_VERIFY_HEAD_OID": manifest["headRefOid"],
                "QWEN_VERIFY_WORKSPACE": str(repo_dir),
                "QWEN_VERIFY_INPUTS_DIR": str(inputs_dir),
                "QWEN_VERIFY_ARTIFACTS_DIR": str(artifacts_dir),
            }
            if os.environ.get("LD_LIBRARY_PATH"):
                workload_env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
            if proxy is not None and bridge_url is not None:
                workload_env["OPENAI_BASE_URL"] = bridge_url
                workload_env["OPENAI_API_KEY"] = proxy["token"]
                workload_env["QWEN_VERIFY_MODEL_NONCE"] = proxy["nonce"]
            # Run workload in its own session so a timeout kills the entire
            # process group instead of leaving orphaned children writing to artifacts_dir.
            proc = subprocess.Popen(
                [workload_path],
                cwd=str(repo_dir),
                env=workload_env,
                start_new_session=True,
            )
            try:
                workload_rc = proc.wait(timeout=args.workload_timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    try:
                        proc.kill()
                    except OSError:
                        pass
                try:
                    proc.wait(timeout=5.0)
                except subprocess.TimeoutExpired:
                    pass
                raise
        else:
            if proxy is not None and bridge_url is not None:
                probe_req = urllib.request.Request(
                    f"{bridge_url.rstrip('/')}/chat/completions",
                    data=b'{"model":"verify-pr-self-test","messages":[]}',
                    headers={
                        "Authorization": f"Bearer {proxy['token']}",
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(probe_req, timeout=15.0) as resp:
                        resp.read(4096)
                        model_probe_status = resp.status
                except urllib.error.HTTPError as exc:
                    model_probe_status = exc.code
            write_self_test_artifacts(
                artifacts_dir,
                manifest=manifest,
                isolation=isolation,
                entropy_status=entropy_status,
                materialized=materialized,
                model_health=model_health,
                bridge_url=bridge_url,
                model_probe_status=model_probe_status,
            )
    except Exception as exc:
        round_error = exc
        if not (artifacts_dir / "verdict.txt").is_file():
            write_self_test_artifacts(
                artifacts_dir,
                manifest=manifest,
                isolation=isolation,
                entropy_status=entropy_status,
                materialized=materialized,
                model_health=model_health,
                bridge_url=bridge_url,
                model_probe_status=model_probe_status,
                error_message=str(exc),
                include_model_probe=(workload_path is None),
            )
        raise
    finally:
        stop_process(bridge_proc)
        # 7. Always upload produced artifacts to host collector (port 52)
        upload_ns = argparse.Namespace(
            cid=args.cid,
            port=args.collector_port,
            unix=args.unix_collector,
            dir=str(artifacts_dir),
        )
        try:
            rc_upload = vsock_mod.cmd_upload_artifacts(upload_ns)
            if rc_upload != 0 and round_error is None:
                raise RuntimeError(f"upload-artifacts failed with rc={rc_upload}")
        except Exception as upload_exc:
            if round_error is None:
                raise
            sys.stderr.write(
                f"guest-runner: artifact upload after error failed: {upload_exc}\n"
            )
    return workload_rc


def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Standard guest lifecycle runner for NIC-less /verify-pr microVMs"
    )
    parser.add_argument("--from-cmdline", action="store_true")
    parser.add_argument("--cmdline-file", default="/proc/cmdline")
    parser.add_argument("--cid", type=int, default=DEFAULT_CID)
    parser.add_argument("--collector-port", type=int, default=DEFAULT_COLLECTOR_PORT)
    parser.add_argument("--input-port", type=int, default=DEFAULT_INPUT_PORT)
    parser.add_argument("--model-port", type=int, default=DEFAULT_MODEL_PORT)
    parser.add_argument("--unix-collector", default=None)
    parser.add_argument("--unix-input", default=None)
    parser.add_argument("--unix-model", default=None)
    parser.add_argument("--vsock-script", default=None)
    parser.add_argument("--work-dir", default=None)
    parser.add_argument("--skip-materialize", action="store_true")
    parser.add_argument("--workload", default=None)
    parser.add_argument("--workload-timeout", type=int, default=DEFAULT_WORKLOAD_TIMEOUT)
    parser.add_argument("--urandom-path", default="/dev/urandom")
    parser.add_argument("--sys-net-dir", default="/sys/class/net")
    parser.add_argument("--proc-mounts", default="/proc/mounts")
    return parser


def _parse_positive_int(name, raw):
    if not isinstance(raw, str) or not re.fullmatch(r"[1-9][0-9]*", raw):
        raise RuntimeError(f"invalid cmdline qwen.{name}: expected positive integer")
    return int(raw)


def apply_cmdline_overrides(args):
    if not args.from_cmdline or not os.path.isfile(args.cmdline_file):
        return args
    text = Path(args.cmdline_file).read_text(encoding="utf-8", errors="replace")
    kv = parse_kernel_cmdline(text)
    if "cid" in kv:
        args.cid = _parse_positive_int("cid", kv["cid"])
    if "collector_port" in kv:
        args.collector_port = _parse_positive_int("collector_port", kv["collector_port"])
    if "input_port" in kv:
        args.input_port = _parse_positive_int("input_port", kv["input_port"])
    if "model_port" in kv:
        args.model_port = _parse_positive_int("model_port", kv["model_port"])
    if "workload" in kv and args.workload is None:
        args.workload = kv["workload"]
    if "workload_timeout" in kv:
        args.workload_timeout = _parse_positive_int(
            "workload_timeout", kv["workload_timeout"]
        )
    if kv.get("skip_materialize") == "1":
        args.skip_materialize = True
    return args


def main(argv=None):
    parser = build_arg_parser()
    args = apply_cmdline_overrides(parser.parse_args(argv))
    return run_guest_round(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        sys.stderr.write(f"guest-runner: {exc}\n")
        sys.exit(1)
