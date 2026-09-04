#!/usr/bin/env python3
"""Capture and diff redacted local state for reference agent reproduction."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

AGENT_ROOTS = {
    "codex": ".codex",
    "claude-code": ".claude",
}

TEXT_EXTENSIONS = {
    ".cfg",
    ".conf",
    ".ini",
    ".json",
    ".jsonc",
    ".lock",
    ".md",
    ".mjs",
    ".py",
    ".sh",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}

TEXT_NAMES = {
    "config",
    "settings",
    "preferences",
}

SENSITIVE_PATH_PARTS = {
    "access_token",
    "auth",
    "cache",
    "cert",
    "certificate",
    "conversation",
    "conversations",
    "cookie",
    "cookies",
    "credential",
    "credentials",
    "docker",
    "env",
    "gcloud",
    "gh",
    "gnupg",
    "history",
    "id_ed25519",
    "id_rsa",
    "identity",
    "key",
    "keys",
    "kube",
    "log",
    "logs",
    "netrc",
    "npmrc",
    "oauth",
    "pgp",
    "private_key",
    "pypirc",
    "refresh_token",
    "secret",
    "secrets",
    "session",
    "sessions",
    "ssh",
    "token",
    "tokens",
    "transcript",
    "transcripts",
}

SENSITIVE_KEY_PATTERN = (
    r"[A-Za-z0-9_.-]*(?:api[_-]?key|authorization|cookie|password|secret|"
    r"token|credential|access[_-]?token|refresh[_-]?token|"
    r"client[_-]?secret)[A-Za-z0-9_.-]*"
)
QUOTED_KEY_QUOTED_VALUE_RE = re.compile(
    rf"(?i)([\"'])({SENSITIVE_KEY_PATTERN})\1(\s*:\s*)([\"'])(.*?)\4"
)
UNQUOTED_KEY_QUOTED_VALUE_RE = re.compile(
    rf"(?i)(\b(?:{SENSITIVE_KEY_PATTERN})\b)(\s*[=:]\s*)([\"'])(.*?)\3"
)
QUOTED_KEY_BARE_VALUE_RE = re.compile(
    rf"(?i)([\"'])({SENSITIVE_KEY_PATTERN})\1(\s*:\s*)([^\"'\s,}}]+)"
)
UNQUOTED_KEY_BARE_VALUE_RE = re.compile(
    rf"(?i)(\b(?:{SENSITIVE_KEY_PATTERN})\b)(\s*[=:]\s*)([^\"'\s,}}]+)"
)
BEARER_RE = re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+")
OPENAI_STYLE_KEY_RE = re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b")
GITHUB_TOKEN_RE = re.compile(r"\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{20,}\b")
GITHUB_PAT_RE = re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")
AWS_KEY_RE = re.compile(r"\bAKIA[0-9A-Z]{16}\b")
GOOGLE_API_KEY_RE = re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b")
GENERIC_AUTH_RE = re.compile(r"(?i)\b(?:token|basic)\s+[a-z0-9._~+/=-]{8,}")
PEM_KEY_RE = re.compile(
    r"-----BEGIN\s+\w+(?:\s+\w+)*\s+PRIVATE\s+KEY-----.*?"
    r"-----END\s+\w+(?:\s+\w+)*\s+PRIVATE\s+KEY-----",
    re.DOTALL,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def resolve_root(agent: str, root: Path | None) -> Path:
    if root is not None:
        return root.expanduser().resolve()
    return (Path.home() / AGENT_ROOTS[agent]).resolve()


def sha256_file(path: Path, max_bytes: int) -> str | None:
    size = path.stat().st_size
    if size > max_bytes:
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_sensitive_path(rel_path: str) -> bool:
    # Match whole path segments (split on `/`) and check the full basename so
    # composite filenames keep their identity. The previous regex split on
    # `[/._ -]+`, which produced both false negatives (`id_rsa` -> `["id",
    # "rsa"]` missed `id_rsa`) and false positives (`tokenizer.json` ->
    # `["token", "izer", "json"]` matched `token`). Hidden directories like
    # `.ssh` / `.gnupg` are still matched via their non-dot equivalent, and
    # basenames are also checked with their suffix stripped so files like
    # `credentials.json` continue to match `credentials`.
    lower = rel_path.lower()
    parts = lower.split("/")
    basename = parts[-1] if parts else lower
    if basename in SENSITIVE_PATH_PARTS:
        return True
    stem = basename.rsplit(".", 1)[0] if "." in basename else basename
    if stem and stem in SENSITIVE_PATH_PARTS:
        return True
    for part in parts:
        if part in SENSITIVE_PATH_PARTS:
            return True
        if part.startswith(".") and part[1:] in SENSITIVE_PATH_PARTS:
            return True
    return False


def looks_like_text_path(path: Path) -> bool:
    if path.suffix.lower() in TEXT_EXTENSIONS:
        return True
    return path.name.lower() in TEXT_NAMES


def redact_text(text: str) -> str:
    home = str(Path.home())
    text = re.sub(re.escape(home) + r"(?=[/\s\"',;]|$)", "~", text)
    text = BEARER_RE.sub("Bearer <redacted>", text)
    text = OPENAI_STYLE_KEY_RE.sub("sk-<redacted>", text)
    text = GITHUB_TOKEN_RE.sub("gh_<redacted>", text)
    text = GITHUB_PAT_RE.sub("github_pat_<redacted>", text)
    text = AWS_KEY_RE.sub("AKIA<redacted>", text)
    text = GOOGLE_API_KEY_RE.sub("AIza<redacted>", text)
    text = GENERIC_AUTH_RE.sub(lambda m: m.group(0).split()[0] + " <redacted>", text)
    text = PEM_KEY_RE.sub(
        "-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----",
        text,
    )

    def replace_quoted_key_quoted_value(match: re.Match[str]) -> str:
        return (
            f"{match.group(1)}{match.group(2)}{match.group(1)}"
            f"{match.group(3)}{match.group(4)}<redacted>{match.group(4)}"
        )

    text = QUOTED_KEY_QUOTED_VALUE_RE.sub(
        replace_quoted_key_quoted_value,
        text,
    )
    text = UNQUOTED_KEY_QUOTED_VALUE_RE.sub(r"\1\2\3<redacted>\3", text)
    text = QUOTED_KEY_BARE_VALUE_RE.sub(r"\1\2\1\3<redacted>", text)
    return UNQUOTED_KEY_BARE_VALUE_RE.sub(r"\1\2<redacted>", text)


def capture_text(
    path: Path,
    rel_path: str,
    max_text_bytes: int,
) -> tuple[str, str | None]:
    if is_sensitive_path(rel_path):
        return "sensitive_path", None
    if path.stat().st_size > max_text_bytes:
        return "too_large", None
    if not looks_like_text_path(path):
        return "not_text_path", None

    raw = path.read_bytes()
    if b"\0" in raw:
        return "binary", None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return "decode_error", None
    return "captured", redact_text(text)


def entry_for_file(
    path: Path,
    rel_path: str,
    max_hash_bytes: int,
    max_text_bytes: int,
) -> dict[str, Any]:
    stat = path.lstat()
    sensitive = is_sensitive_path(rel_path)
    digest = None if sensitive else sha256_file(path, max_hash_bytes)
    entry: dict[str, Any] = {
        "kind": "file",
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "mode": oct(stat.st_mode & 0o777),
        "sha256": digest,
        "hash_status": hash_status(sensitive, digest),
    }
    text_status, redacted_text = capture_text(path, rel_path, max_text_bytes)
    entry["text_status"] = text_status
    if redacted_text is not None:
        entry["redacted_text"] = redacted_text
    return entry


def entry_for_symlink(path: Path) -> dict[str, Any]:
    try:
        target = os.readlink(path)
    except OSError:
        target = None
    return {"kind": "symlink", "target": target}


def collect_entries(
    root: Path,
    max_hash_bytes: int,
    max_text_bytes: int,
) -> dict[str, dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        walkable_dirnames = []
        for dirname in sorted(dirnames):
            path = Path(dirpath) / dirname
            rel_path = path.relative_to(root).as_posix()
            try:
                if path.is_symlink():
                    entries[rel_path] = entry_for_symlink(path)
                else:
                    walkable_dirnames.append(dirname)
            except OSError as exc:
                entries[rel_path] = {"kind": "error", "error": str(exc)}
        dirnames[:] = walkable_dirnames
        for filename in sorted(filenames):
            path = Path(dirpath) / filename
            rel_path = path.relative_to(root).as_posix()
            try:
                if path.is_symlink():
                    entries[rel_path] = entry_for_symlink(path)
                elif path.is_file():
                    entries[rel_path] = entry_for_file(
                        path,
                        rel_path,
                        max_hash_bytes,
                        max_text_bytes,
                    )
                else:
                    entries[rel_path] = {"kind": "other"}
            except OSError as exc:
                entries[rel_path] = {"kind": "error", "error": str(exc)}
    return entries


def hash_status(sensitive: bool, digest: str | None) -> str:
    if sensitive:
        return "sensitive_path"
    if digest is None:
        return "too_large"
    return "captured"


def write_snapshot(args: argparse.Namespace) -> int:
    root = resolve_root(args.agent, args.root)
    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": now_iso(),
        "agent": args.agent,
        "root": str(root),
        "root_exists": root.exists(),
        "max_hash_bytes": args.max_hash_bytes,
        "max_text_bytes": args.max_text_bytes,
        "entries": {},
    }
    if root.exists():
        manifest["entries"] = collect_entries(
            root,
            args.max_hash_bytes,
            args.max_text_bytes,
        )

    manifest_path = out_dir / "state-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    os.chmod(manifest_path, 0o600)
    print(manifest_path)
    return 0


def load_manifest(path: Path) -> dict[str, Any]:
    manifest_path = path / "state-manifest.json" if path.is_dir() else path
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def changed_fields(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    fields = []
    for field in (
        "kind",
        "size",
        "mtime_ns",
        "mode",
        "sha256",
        "hash_status",
        "text_status",
        "target",
    ):
        if before.get(field) != after.get(field):
            fields.append(field)
    return fields


def compact_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in entry.items() if key != "redacted_text"}


def redacted_text_lines(
    entry: dict[str, Any],
    max_lines: int,
) -> tuple[list[str], bool]:
    text = entry.get("redacted_text")
    if not isinstance(text, str):
        return [], False
    lines = text.splitlines()
    truncated = len(lines) > max_lines
    return lines[:max_lines], truncated


def added_or_removed_item(
    path: str,
    entry: dict[str, Any],
    max_lines: int,
) -> dict[str, Any]:
    lines, truncated = redacted_text_lines(entry, max_lines)
    return {
        "path": path,
        "entry": compact_entry(entry),
        "redacted_text": lines,
        "redacted_text_truncated": truncated,
    }


def text_diff(
    path: str,
    before: dict[str, Any],
    after: dict[str, Any],
    max_lines: int,
) -> tuple[list[str], bool]:
    before_text = before.get("redacted_text")
    after_text = after.get("redacted_text")
    if not isinstance(before_text, str) or not isinstance(after_text, str):
        return [], False

    lines = list(
        difflib.unified_diff(
            before_text.splitlines(),
            after_text.splitlines(),
            fromfile=f"before/{path}",
            tofile=f"after/{path}",
            lineterm="",
        )
    )
    truncated = len(lines) > max_lines
    return lines[:max_lines], truncated


def build_diff(
    before_manifest: dict[str, Any],
    after_manifest: dict[str, Any],
    max_diff_lines: int,
) -> dict[str, Any]:
    before_entries = before_manifest.get("entries") or {}
    after_entries = after_manifest.get("entries") or {}
    before_paths = set(before_entries)
    after_paths = set(after_entries)

    added = sorted(after_paths - before_paths)
    removed = sorted(before_paths - after_paths)
    common = sorted(before_paths & after_paths)
    modified = []
    unchanged_count = 0

    for path in common:
        before = before_entries[path]
        after = after_entries[path]
        fields = changed_fields(before, after)
        if not fields:
            unchanged_count += 1
            continue
        diff_lines, truncated = text_diff(path, before, after, max_diff_lines)
        modified.append(
            {
                "path": path,
                "changed_fields": fields,
                "before": compact_entry(before),
                "after": compact_entry(after),
                "text_diff": diff_lines,
                "text_diff_truncated": truncated,
            }
        )

    return {
        "schema_version": 1,
        "created_at": now_iso(),
        "agent": after_manifest.get("agent") or before_manifest.get("agent"),
        "before_root": before_manifest.get("root"),
        "after_root": after_manifest.get("root"),
        "root_exists_before": before_manifest.get("root_exists"),
        "root_exists_after": after_manifest.get("root_exists"),
        "summary": {
            "added": len(added),
            "removed": len(removed),
            "modified": len(modified),
            "unchanged": unchanged_count,
        },
        "added": [
            added_or_removed_item(path, after_entries[path], max_diff_lines)
            for path in added
        ],
        "removed": [
            added_or_removed_item(path, before_entries[path], max_diff_lines)
            for path in removed
        ],
        "modified": modified,
    }


def metadata_line(entry: dict[str, Any]) -> str:
    parts = [f"kind={entry.get('kind')}"]
    for key in ("size", "mode", "sha256", "hash_status", "text_status", "target"):
        value = entry.get(key)
        if value is not None:
            parts.append(f"{key}={value}")
    return ", ".join(parts)


def markdown_for_diff(diff: dict[str, Any]) -> str:
    summary = diff["summary"]
    lines = [
        "# Agent State Diff",
        "",
        f"- agent: `{diff.get('agent')}`",
        f"- before_root: `{diff.get('before_root')}`",
        f"- after_root: `{diff.get('after_root')}`",
        (
            f"- summary: added={summary['added']}, removed={summary['removed']}, "
            f"modified={summary['modified']}, unchanged={summary['unchanged']}"
        ),
        "",
    ]

    if diff["added"]:
        lines.extend(["## Added", ""])
        for item in diff["added"]:
            lines.append(f"- `{item['path']}` ({metadata_line(item['entry'])})")
            if item["redacted_text"]:
                lines.extend(["", "```"])
                lines.extend(item["redacted_text"])
                if item["redacted_text_truncated"]:
                    lines.append("... <content truncated>")
                lines.extend(["```", ""])
        lines.append("")

    if diff["removed"]:
        lines.extend(["## Removed", ""])
        for item in diff["removed"]:
            lines.append(f"- `{item['path']}` ({metadata_line(item['entry'])})")
            if item["redacted_text"]:
                lines.extend(["", "```"])
                lines.extend(item["redacted_text"])
                if item["redacted_text_truncated"]:
                    lines.append("... <content truncated>")
                lines.extend(["```", ""])
        lines.append("")

    if diff["modified"]:
        lines.extend(["## Modified", ""])
        for item in diff["modified"]:
            lines.append(f"### `{item['path']}`")
            lines.append("")
            lines.append(f"- changed_fields: {', '.join(item['changed_fields'])}")
            lines.append(f"- before: {metadata_line(item['before'])}")
            lines.append(f"- after: {metadata_line(item['after'])}")
            if item["text_diff"]:
                lines.extend(["", "```diff"])
                lines.extend(item["text_diff"])
                if item["text_diff_truncated"]:
                    lines.append("... <diff truncated>")
                lines.append("```")
            else:
                before_status = item["before"].get("text_status")
                after_status = item["after"].get("text_status")
                lines.append(
                    f"- content_diff: omitted ({before_status} -> {after_status})"
                )
            lines.append("")

    if not diff["added"] and not diff["removed"] and not diff["modified"]:
        lines.append("No state differences found.")
        lines.append("")

    return "\n".join(lines)


def write_diff(args: argparse.Namespace) -> int:
    before = load_manifest(args.before)
    after = load_manifest(args.after)
    diff = build_diff(before, after, args.max_diff_lines)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.out_dir / "state-diff.json"
    md_path = args.out_dir / "state-diff.md"
    json_path.write_text(
        json.dumps(diff, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    md_path.write_text(
        markdown_for_diff(diff),
        encoding="utf-8",
    )
    os.chmod(json_path, 0o600)
    os.chmod(md_path, 0o600)
    print(md_path)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("out_dir", type=Path)
    snapshot.add_argument("--agent", choices=sorted(AGENT_ROOTS), required=True)
    snapshot.add_argument("--root", type=Path)
    snapshot.add_argument("--max-hash-bytes", type=int, default=10 * 1024 * 1024)
    snapshot.add_argument("--max-text-bytes", type=int, default=200 * 1024)
    snapshot.set_defaults(func=write_snapshot)

    diff = subparsers.add_parser("diff")
    diff.add_argument("before", type=Path)
    diff.add_argument("after", type=Path)
    diff.add_argument("--out-dir", type=Path, required=True)
    diff.add_argument("--max-diff-lines", type=int, default=400)
    diff.set_defaults(func=write_diff)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
