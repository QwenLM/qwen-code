#!/usr/bin/env python3
"""Compile a reviewed five-role candidate with explicit features, without loading it."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import subprocess


ROLES = ("source", "gateway", "shim", "worker", "sandbox")
FILES = {"qwen-k2-profiles", "source-config.json", "gateway-config.json", "target.json", "runtime.json", "creation-contract.json", "qwen-k2-node-source.service", "qwen-k2-runtime-gateway.service"}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read(path, expected, limit):
    if not path.is_absolute() or path.is_symlink() or not path.is_file() or not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("an exact regular artifact and reviewed SHA-256 are required")
    with path.open("rb") as stream:
        raw = stream.read(limit + 1)
    if not raw or len(raw) > limit or digest(raw) != expected:
        raise ValueError("reviewed compile input bytes differ or exceed their bound")
    return raw


def closed(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("duplicate JSON field")
        result[name] = value
    return result


def nonfinite(value):
    raise ValueError("non-finite JSON number")


def source(raw):
    text = raw.decode("utf-8", "strict")
    if re.search(r"(?m)^\s*(?:#\s*include|include\b|alias\b|abi\b|@\{|hat\b|\^)", text):
        raise ValueError("the generated source must have no includes, aliases or ambient ABI")
    if re.search(r"(?m)^[ \t]+profile[ \t]", text):
        raise ValueError("nested profiles are outside the five-role artifact")
    expected = ["profile qwen-k2-" + name + "-v1" + (' \"/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1\"' if name == "shim" else "")
                + " flags=(mediate_deleted,attach_disconnected.path=/qwen-k2-disconnected/" + name + "/) {" for name in ROLES]
    position, inside = 0, False
    for line in text.splitlines():
        if not line.strip():
            continue
        if inside:
            if line == "}":
                inside = False
            elif not line.startswith("  ") or not line.endswith(","):
                raise ValueError("only generated flat rule lines are supported")
        elif position < len(expected) and line == expected[position]:
            position += 1
            inside = True
        else:
            raise ValueError("unexpected text outside a generated K2 profile")
    if inside or position != len(expected):
        raise ValueError("exactly the five ordered K2 profiles are required")
    return raw


def command(parser, root):
    return [str(parser), "--config-file=" + str(root / "parser.conf"), "--base=" + str(root),
            "--policy-features=" + str(root / "features"), "--kernel-features=" + str(root / "features"),
            "--skip-kernel-load", "--skip-cache", "--stdout", "--jobs=0", "--abort-on-error",
            "--Werror", "--warn=rule-not-enforced", str(root / "qwen-k2-profiles")]


def prepare(candidate, candidate_sha, parser, parser_sha, features, features_sha, output):
    raw = read(candidate / "profile-candidate.json", candidate_sha, 64 * 1024)
    manifest = json.loads(raw.decode("utf-8"), object_pairs_hook=closed, parse_constant=nonfinite)
    fields = {"format", "artifactManifestSha256", "shimConfigurationSha256", "roleConfigPaths", "boundaries", "generators", "files"}
    if not isinstance(manifest, dict) or set(manifest) != fields or manifest["format"] != "qwen-k2-profile-candidate/1" or set(manifest["files"]) != FILES:
        raise ValueError("the complete generated profile candidate is required")
    if manifest["generators"] != {name: digest(Path(__file__).with_name(name).read_bytes()) for name in ("render-profiles.py", "render-pre-exec.py", "image-catalog.py")}:
        raise ValueError("profile candidate generator versions differ")
    copied = {}
    for name, pin in manifest["files"].items():
        limit = 16 * 1024 * 1024 if name == "qwen-k2-profiles" else 64 * 1024
        if not isinstance(pin, dict) or set(pin) != {"bytes", "sha256"} or type(pin["bytes"]) is not int or not 0 < pin["bytes"] <= limit:
            raise ValueError("bounded candidate file pins are required")
        copied[name] = read(candidate / name, pin["sha256"], limit)
        if len(copied[name]) != pin["bytes"]:
            raise ValueError("profile candidate file length differs")
    profile = source(copied["qwen-k2-profiles"])
    executable = read(parser, parser_sha, 128 * 1024 * 1024)
    if executable[:6] != b"\x7fELF\x02\x01" or len(executable) < 64:
        raise ValueError("the reviewed 64-bit target parser ELF is required")
    feature_bytes = read(features, features_sha, 64 * 1024)
    if not output.is_absolute():
        raise ValueError("a new absolute compile directory is required")
    output.mkdir(mode=0o700, exist_ok=False)
    for name, content in {"parser": executable, "parser.conf": b"", "features": feature_bytes, "qwen-k2-profiles": profile, "profile-candidate.json": raw}.items():
        with (output / name).open("xb") as stream:
            stream.write(content)
        (output / name).chmod(0o500 if name == "parser" else 0o400)
    record = {"format": "qwen-k2-profile-compile-attempt/2", "command": command(output / "parser", output),
              "profileCandidateSha256": candidate_sha, "parserSha256": parser_sha, "featuresSha256": features_sha,
              "sourceSha256": digest(profile), "parserConfigurationSha256": digest(b""),
              "generatorSha256": digest(Path(__file__).read_bytes())}
    save_record(output / "attempt.json", record)
    return record


def save_record(path, record):
    path.write_text(json.dumps(record, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def compile_candidate(root, record):
    try:
        with (root / "packed.bin").open("xb") as output, (root / "compile.stderr").open("xb") as errors:
            result = subprocess.run(record["command"], stdin=subprocess.DEVNULL, stdout=output, stderr=errors,
                                    cwd=root, env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "SOURCE_DATE_EPOCH": "0"},
                                    timeout=120, check=False,
                                    preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024)))
        record["exitCode"] = result.returncode
    except subprocess.TimeoutExpired:
        record["timedOut"] = True
        save_record(root / "attempt.json", record)
        raise ValueError("profile compilation timed out; attempt bytes are preserved") from None
    except OSError as failure:
        record["startError"] = str(failure)
        save_record(root / "attempt.json", record)
        raise
    save_record(root / "attempt.json", record)
    read(root / "parser", record["parserSha256"], 128 * 1024 * 1024)
    read(root / "features", record["featuresSha256"], 64 * 1024)
    read(root / "qwen-k2-profiles", record["sourceSha256"], 16 * 1024 * 1024)
    read(root / "profile-candidate.json", record["profileCandidateSha256"], 64 * 1024)
    if (root / "parser.conf").read_bytes() != b"" or record["exitCode"] != 0:
        raise ValueError("actual profile compilation failed; attempt bytes are preserved")
    with (root / "packed.bin").open("rb") as stream:
        raw = stream.read(8 * 1024 * 1024 + 1)
    if not raw or len(raw) > 8 * 1024 * 1024:
        raise ValueError("compiled policy is empty or exceeds the source reader's 8 MiB bound")
    record = dict(record, format="qwen-k2-profile-compile/2", packedBytes=len(raw), packedSha256=digest(raw))
    (root / "packed.bin").chmod(0o400)
    save_record(root / "compile.json", record)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--profile-candidate-sha256", required=True)
    for name in ("parser", "features"):
        parser.add_argument("--" + name, type=Path, required=True)
        parser.add_argument("--" + name + "-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        record = prepare(args.candidate, args.profile_candidate_sha256, args.parser, args.parser_sha256, args.features, args.features_sha256, args.output)
        compile_candidate(args.output, record)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, subprocess.SubprocessError) as failure:
        parser.exit(1, "Profile compilation refused: " + str(failure) + "\n")


if __name__ == "__main__":
    main()
