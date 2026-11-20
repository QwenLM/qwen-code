#!/usr/bin/env python3
"""Produce the qwen-runtime archive directly from the current qwen-code checkout.

Replaces the candidate/base-source/patch runtime producer: the source of truth is the
pipeline's own Git checkout, identified by its full HEAD SHA. Runs the existing upstream
build entries in place (install, scripts/build.js --cli-only, generate-git-commit-info.js,
esbuild.config.js, copy_bundle_assets.js, prepare-package.js --host-runtime), stamps the
bundle identity, and packs a deterministic-ish tar.gz plus manifest, PROVENANCE.json and
LICENSE. package.json records managedPreview and sourceRevision; there is no patchSequence.
"""
import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PACKAGE_NAME = "qwen-code"
SUPPORTED_ENTRYPOINTS = ["serve --profile hosted-harness --no-web", "managed-runtime-worker"]
# Upstream build outputs are generated, not part of the source inventory.
GENERATED = {"node_modules", "dist", "target", ".git", "__pycache__", ".turbo", ".pnpm-store"}
GENERATED_SUFFIXES = (".tsbuildinfo", ".log")
REQUIRED_ROOT_ENTRIES = {
    "LICENSE", "README.md", "cli-entry.js", "cli.js", "codeModeHost.js", "execution-worker.js",
    "export-transcript-document.css", "export-transcript-document.js", "fzfWorker.js", "glob-search-worker.js",
    "mod-worker.js", "package.json", "review-sources.sha256", "sandbox-macos-permissive-closed.sb",
    "sandbox-macos-permissive-open.sb", "sandbox-macos-permissive-proxied.sb", "sandbox-macos-restrictive-closed.sb",
    "sandbox-macos-restrictive-open.sb", "sandbox-macos-restrictive-proxied.sb", "sandboxBwrapRelay.js",
    "sandboxFileWorker.js", "sandboxLandlockRelay.js",
}
# Last deployed DataAgent workspace baseline (workspace-20261116.28). Losing any required
# root entry, directory or file must fail here instead of shipping a silently smaller archive.
REQUIRED_DIRECTORY_FILE_COUNTS = {
    "bundled": 132,
    "chunks": 751,
    "examples": 21,
    "generated-ui": 4,
    "locales": 9,
    "mem0": 2,
    "opentui-assets": 14,
    "vendor": 12,
    "web-shell": 449,
}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def source_revision():
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError("git rev-parse HEAD must be a full lowercase 40-hex SHA: " + revision)
    return revision


def source_tree(source):
    """Canonical inventory of the source tree: content digest, executable bit, link target.

    Taken before install/build so generated outputs cannot enter it.
    """
    digest = hashlib.sha256()
    count = 0
    paths = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=source).split(b"\0")
    for raw in sorted(filter(None, paths)):
        relative = raw.decode()
        parts = Path(relative).parts
        if parts and parts[0] == ".aone-output":
            continue
        if any(part in GENERATED for part in parts):
            continue
        path = source / relative
        if path.is_symlink():
            entry = "l\0" + relative + "\0" + os.readlink(path) + "\n"
        elif path.is_file():
            if path.name.endswith(GENERATED_SUFFIXES):
                continue
            entry = "f\0" + relative + "\0" + sha256(path) + "\0" + ("1" if path.stat().st_mode & 0o111 else "0") + "\n"
        else:
            continue
        digest.update(entry.encode())
        count += 1
    return digest.hexdigest(), count


def manifest(archive):
    """Every file of a runtime archive, read without extracting it."""
    directories, roots, files = set(), set(), set()
    with tarfile.open(archive) as bundle:
        for member in bundle.getmembers():
            parts = member.name.split("/")
            if parts[0] != PACKAGE_NAME:
                raise RuntimeError("Unexpected archive root: " + member.name)
            if member.isdir():
                continue
            if len(parts) < 2 or not parts[-1]:
                raise RuntimeError("Unexpected archive entry: " + member.name)
            files.add("/".join(parts[1:]))
            if len(parts) == 2:
                roots.add(parts[1])
            else:
                directories.add(parts[1])
    missing_roots = sorted(REQUIRED_ROOT_ENTRIES - roots)
    if missing_roots:
        raise RuntimeError("Runtime archive lost root entries: " + ", ".join(missing_roots))
    missing_directories = sorted(set(REQUIRED_DIRECTORY_FILE_COUNTS) - directories)
    if missing_directories:
        raise RuntimeError("Runtime archive lost directories: " + ", ".join(missing_directories))
    result = {
        "directories": sorted(directories),
        "rootEntries": sorted(roots),
        "files": sorted(files),
        "rootEntriesAdded": sorted(roots - REQUIRED_ROOT_ENTRIES),
        "directoriesAdded": sorted(directories - set(REQUIRED_DIRECTORY_FILE_COUNTS)),
        "fileCounts": {},
    }
    for directory, reference in REQUIRED_DIRECTORY_FILE_COUNTS.items():
        built = sum(1 for name in files if name.startswith(directory + "/"))
        result["fileCounts"][directory] = {"reference": reference, "built": built}
        if built < reference:
            raise RuntimeError("Runtime archive lost files under " + directory)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", required=True, help="Immutable release id, e.g. managed-20261118.1")
    parser.add_argument("--source-sha", required=True, help="Full 40-hex qwen-code commit to build")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.release):
        raise SystemExit("--release must be a non-empty artifact-safe id")
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_sha):
        raise SystemExit("--source-sha must be a full lowercase 40-hex commit")
    revision = source_revision()
    if revision != args.source_sha:
        raise SystemExit("checkout does not match --source-sha: " + revision)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    steps = []

    def run(name, command, timeout=3600):
        start = time.monotonic()
        print("=== " + name, flush=True)
        with open(out / (name + ".log"), "wb") as log:
            code = subprocess.call(command, cwd=REPO, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        steps.append({"step": name, "exitCode": code, "seconds": round(time.monotonic() - start, 3)})
        (out / "steps.json").write_text(json.dumps(steps, indent=2) + "\n")
        if code:
            tail = (out / (name + ".log")).read_bytes()[-8000:].decode("utf-8", "replace")
            print(tail, flush=True)
            raise RuntimeError(name + " failed with exit code " + str(code))

    tree_sha, tree_files = source_tree(REPO)
    print("sourceTreeSha256=" + tree_sha + " sourceFiles=" + str(tree_files), flush=True)

    os.environ["COREPACK_NPM_REGISTRY"] = "https://registry.npmmirror.com"
    os.environ["npm_config_registry"] = "https://registry.npmmirror.com"
    run("node-prerequisites", ["corepack", "pnpm", "--config.registry=https://registry.npmmirror.com", "install",
                               "--frozen-lockfile", "--prefer-offline", "--reporter=append-only"])
    # dist 一律从本次 checkout 重建；不保留任何「已构建就跳过」的复用。
    shutil.rmtree(REPO / "dist", ignore_errors=True)
    os.environ["NODE_OPTIONS"] = "--max-old-space-size=6144"
    run("cli-build", ["node", "scripts/build.js", "--cli-only"], timeout=3600)
    run("bundle-generate", ["node", "scripts/generate-git-commit-info.js"])
    run("bundle-esbuild", ["node", "esbuild.config.js"], timeout=1800)
    run("bundle-assets", ["node", "scripts/copy_bundle_assets.js"], timeout=1800)
    run("prepare-package", ["node", "scripts/prepare-package.js", "--host-runtime"], timeout=1800)

    dist = REPO / "dist"
    root_manifest = json.loads((REPO / "package.json").read_text())
    package_json = dist / "package.json"
    published = json.loads(package_json.read_text())
    version = published["version"]
    if version != root_manifest["version"]:
        raise RuntimeError("Bundled CLI version differs from the source checkout")
    # The release identity is stamped only after the upstream entries produced a complete bundle:
    # it names this archive, it never relaxes one of their assertions.
    published["private"] = True
    published["managedPreview"] = args.release
    published["sourceRevision"] = revision
    published["supportedEntrypoints"] = SUPPORTED_ENTRYPOINTS
    published["sourceTreeSha256"] = tree_sha
    package_json.write_text(json.dumps(published, indent=2) + "\n")

    # `dist/` is a build directory, not the distribution: it also holds test outputs and
    # intermediate workspace files. The allowlist is the upstream manifest's own `files` plus the
    # host-runtime assets that `prepare-package.js --host-runtime` deliberately leaves out of the
    # *npm* manifest while `copy_bundle_assets.js` still produces them and the runtime reads them
    # (OTUI_ASSET_ROOT -> dist/opentui-assets).
    allowlist = list(published["files"]) + ["package.json", "review-sources.sha256", "opentui-assets"]
    pruned = []
    for entry in sorted(dist.iterdir()):
        if any(entry.name == pattern or fnmatch.fnmatch(entry.name, pattern) for pattern in allowlist):
            continue
        pruned.append(entry.name)
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
    (out / "pruned-build-outputs.json").write_text(json.dumps(pruned, indent=2) + "\n")

    archive = out / ("qwen-runtime-" + args.release + ".tar.gz")
    run("pack", ["tar", "-czf", str(archive), "-C", str(REPO), "--transform", "s|^dist|" + PACKAGE_NAME + "|",
                 "--owner=0", "--group=0", "--numeric-owner", "--sort=name", "--mtime=@0", "dist"], timeout=1800)

    entries = manifest(archive)
    (out / "runtime-manifest.json").write_text(json.dumps(entries, indent=2, sort_keys=True) + "\n")
    provenance = {
        "producer": "runtime",
        "preview": args.release,
        "version": version,
        "sourceRevision": revision,
        "sourceTreeSha256": tree_sha,
        "sourceTreeFiles": tree_files,
        "sha256": sha256(archive),
        "bytes": archive.stat().st_size,
        "directories": entries["directories"],
        "rootEntries": entries["rootEntries"],
        "rootEntriesAdded": entries["rootEntriesAdded"],
        "directoriesAdded": entries["directoriesAdded"],
        "fileCounts": entries["fileCounts"],
        "referenceBaseline": "workspace-20261116.28",
        "fileCount": len(entries["files"]),
        "prunedBuildOutputs": pruned,
        "supportedEntrypoints": SUPPORTED_ENTRYPOINTS,
    }
    (out / "PROVENANCE.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n")
    shutil.copyfile(REPO / "LICENSE", out / "LICENSE")
    print(json.dumps(provenance, indent=2, sort_keys=True), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as failure:  # noqa: BLE001 - the producer log is the evidence
        print("producer failed: " + str(failure), file=sys.stderr, flush=True)
        raise
