#!/usr/bin/env python3
"""
Merge portable Qwen settings from local Mac into remote ~/.qwen/settings.json
without overwriting MCP command/args/cwd/env/urls.

From local (by matching mcpServers name):  readOnlyTools only.
From local (whole block):                  tools.*

Usage:
  python3 scripts/sync-qwen-portable-settings.py user@remote-host
  python3 scripts/sync-qwen-portable-settings.py user@remote-host --dry-run

Requires: ssh, scp in PATH.
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any


def run_ssh(host: str, *remote_argv: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["ssh", host, *remote_argv],
        capture_output=True,
        text=True,
        check=False,
    )


def load_local(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def remote_cat_cmd(remote_path: str) -> list[str]:
    """argv after ssh host ..."""
    # SSH expands ~ automatically, so just quote the path
    return [remote_path]


def load_remote(host: str, remote_path: str) -> dict[str, Any]:
    # Use cat directly - SSH expands ~ automatically
    r = run_ssh(host, "cat", remote_path)
    if r.returncode != 0:
        print(
            "Could not read remote settings (ssh/cat failed). "
            "Fix SSH or create ~/.qwen/settings.json on the host first.",
            file=sys.stderr,
        )
        if r.stderr:
            print(r.stderr.strip(), file=sys.stderr)
        sys.exit(1)
    raw = (r.stdout or "").strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Remote JSON parse error: {e}", file=sys.stderr)
        sys.exit(1)


def merge_portable(local: dict[str, Any], remote: dict[str, Any]) -> dict[str, Any]:
    out = json.loads(json.dumps(remote))

    if "tools" in local:
        out["tools"] = local["tools"]

    lm = local.get("mcpServers") or {}
    rm = out.get("mcpServers")
    if not isinstance(rm, dict):
        rm = {}
        out["mcpServers"] = rm

    for name, lsrv in lm.items():
        if name not in rm or not isinstance(lsrv, dict):
            continue
        if "readOnlyTools" not in lsrv:
            continue
        if not isinstance(rm[name], dict):
            rm[name] = {}
        rm[name]["readOnlyTools"] = lsrv["readOnlyTools"]

    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("ssh_host", help="e.g. user@hostname")
    ap.add_argument(
        "--local",
        type=Path,
        default=Path.home() / ".qwen" / "settings.json",
    )
    ap.add_argument(
        "--remote-path",
        default="~/.qwen/settings.json",
        help="Remote file (default ~/.qwen/settings.json)",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.local.is_file():
        print(f"Local file not found: {args.local}", file=sys.stderr)
        sys.exit(1)

    local = load_local(args.local)
    remote = load_remote(args.ssh_host, args.remote_path)
    merged = merge_portable(local, remote)
    text = json.dumps(merged, indent=2) + "\n"

    if args.dry_run:
        sys.stdout.write(text)
        return

    rid = str(uuid.uuid4())
    remote_tmp = f"/tmp/qwen-settings-{rid}.json"

    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        suffix=".json",
        delete=False,
    ) as tmp:
        tmp.write(text)
        local_tmp = tmp.name

    try:
        cp = subprocess.run(
            ["scp", "-q", local_tmp, f"{args.ssh_host}:{remote_tmp}"],
            capture_output=True,
            text=True,
        )
        if cp.returncode != 0:
            print(cp.stderr or cp.stdout or "scp failed", file=sys.stderr)
            sys.exit(1)

        # Expand ~ via SSH first to get absolute path (SSH expands ~ in unquoted args)
        if args.remote_path.startswith("~/"):
            expand_r = run_ssh(args.ssh_host, "echo", args.remote_path)
            if expand_r.returncode != 0 or not expand_r.stdout.strip():
                print("Failed to expand remote path", file=sys.stderr)
                sys.exit(1)
            # Strip quotes and whitespace (handle both single and double quotes)
            dest_abs = expand_r.stdout.strip()
            if dest_abs.startswith("'") and dest_abs.endswith("'"):
                dest_abs = dest_abs[1:-1]
            elif dest_abs.startswith('"') and dest_abs.endswith('"'):
                dest_abs = dest_abs[1:-1]
        else:
            dest_abs = args.remote_path
        dest_quoted = shlex.quote(dest_abs)
        remote_script = f"""set -e
d=$(dirname {dest_quoted})
mkdir -p "$d"
if [ -f {dest_quoted} ]; then cp -a {dest_quoted} {dest_quoted}.bak.$(date +%Y%m%d%H%M%S); fi
mv {shlex.quote(remote_tmp)} {dest_quoted}
chmod 600 {dest_quoted} 2>/dev/null || true
echo "Updated {dest_abs}"
"""
        if not dest_abs:
            print(f"ERROR: dest_abs is empty after expansion. stdout was: {repr(expand_r.stdout)}", file=sys.stderr)
            sys.exit(1)
        mv = run_ssh(args.ssh_host, "bash", "-c", remote_script)
        if mv.returncode != 0:
            print(mv.stderr or mv.stdout or "remote install failed", file=sys.stderr)
            sys.exit(1)
        print(mv.stdout.strip())
    finally:
        Path(local_tmp).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
