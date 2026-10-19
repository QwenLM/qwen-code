#!/usr/bin/env python3
"""Package a real cold candidate and closed artifacts without installing them."""

import argparse
import io
import json
from pathlib import Path
import stat
import tarfile
import re
import importlib.util

import cold_boot as C


HOST_FILES = {"host-" + role + ".rules" for role in ("runtime", "kubelet", "registrar", "plugin", "systemd", "system-bus")}
PROFILE_FILES = {"qwen-k2-profiles", "source-config.json", "gateway-config.json", "target.json", "runtime.json",
                 "creation-contract.json", "qwen-k2-node-source.service", "qwen-k2-runtime-gateway.service",
                 "host-policies.json", "cold-bootstrap.json"} | HOST_FILES
FILES = PROFILE_FILES | {"artifact-manifest.json", "shim.json", "profile-candidate.json", "profile-compile.json",
                         "source-config.installed.json", "features", "worker-catalog.json", "sandbox-catalog.json", "packed.bin"}


def final_source(raw, packed_sha):
    value = C.loads(raw)
    C.require(isinstance(value, dict) and re.fullmatch(r"[0-9a-f]{64}", value["workerPolicySha256"]), "original source digest required")
    original = raw.decode()
    text, decoder, offset = original.lstrip(), json.JSONDecoder(), 1
    while offset < len(text):
        while text[offset].isspace(): offset += 1
        key, offset = decoder.raw_decode(text, offset)
        while text[offset].isspace(): offset += 1
        C.require(text[offset] == ":", "source object colon required")
        offset += 1
        while text[offset].isspace(): offset += 1
        start = offset
        _, offset = decoder.raw_decode(text, offset)
        if key == "workerPolicySha256":
            # Character positions are used only after strict UTF-8 decoding;
            # all bytes outside the one value token are preserved.
            leading = original[:len(original) - len(text)]
            return (leading + text[:start] + '"' + packed_sha + '"' + text[offset:]).encode()
        while text[offset].isspace(): offset += 1
        C.require(text[offset] == ",", "source digest value is absent")
        offset += 1
    raise ValueError("source digest is absent")


def installed(root):
    C.require({p.name for p in root.iterdir()} == FILES | {"installation.json"}, "exact 26 installed files required")
    manifest_raw = C.read(root / "installation.json", 64 * 1024)
    manifest = C.loads(manifest_raw)
    C.require(set(manifest) == {"format", "files"} and manifest["format"] == "qwen-k2-installed-artifacts/3"
              and set(manifest["files"]) == FILES, "closed installed-artifacts/3 required")
    files = {"installation.json": manifest_raw}
    for name in sorted(FILES):
        limit = 16 * 1024 * 1024 if name in ("qwen-k2-profiles", "worker-catalog.json", "sandbox-catalog.json") else 8 * 1024 * 1024 if name == "packed.bin" else 1024 * 1024 if name in HOST_FILES else 16 * 1024 if name == "creation-contract.json" else 32 * 1024 if name in ("shim.json", "source-config.json", "source-config.installed.json", "gateway-config.json", "target.json", "qwen-k2-node-source.service", "qwen-k2-runtime-gateway.service") else 64 * 1024
        item = manifest["files"][name]
        C.require(isinstance(item, dict) and set(item) == {"bytes", "sha256"} and type(item["bytes"]) is int, "closed installed file pin required")
        files[name] = C.read(root / name, limit, item)
    C.require(sum(map(len, files.values())) <= 64 * 1024 * 1024, "installed graph exceeds 64 MiB")
    profile, compile_record = C.loads(files["profile-candidate.json"]), C.loads(files["profile-compile.json"])
    C.require(set(profile) == {"format", "artifactManifestSha256", "shimConfigurationSha256", "roleConfigPaths", "boundaries", "generators", "files"}
              and profile["format"] == "qwen-k2-profile-candidate/3" and set(profile["files"]) == PROFILE_FILES,
              "exact sixteen candidate pins required")
    C.require(all(profile["files"][name] == C.pin(files[name]) for name in PROFILE_FILES), "original candidate pin differs")
    C.require(set(compile_record) == {"format", "command", "profileCandidateSha256", "parserSha256", "featuresSha256", "sourceSha256", "parserConfigurationSha256", "generatorSha256", "exitCode", "packedBytes", "packedSha256"}
              and compile_record["format"] == "qwen-k2-profile-compile/2" and type(compile_record["exitCode"]) is int
              and compile_record["exitCode"] == 0 and compile_record["profileCandidateSha256"] == C.sha(files["profile-candidate.json"])
              and compile_record["sourceSha256"] == C.sha(files["qwen-k2-profiles"])
              and compile_record["featuresSha256"] == C.sha(files["features"])
              and type(compile_record["packedBytes"]) is int and compile_record["packedBytes"] == len(files["packed.bin"])
              and compile_record["packedSha256"] == C.sha(files["packed.bin"]), "original compilation bytes differ")
    C.require(compile_record["parserConfigurationSha256"] == C.sha(b"") and all(re.fullmatch(r"[0-9a-f]{64}", compile_record[k]) for k in ("parserSha256", "generatorSha256")), "explicit no-load compiler pins required")
    command = compile_record["command"]
    C.require(isinstance(command, list) and command and isinstance(command[0], str) and Path(command[0]).is_absolute()
              and Path(command[0]).name == "parser", "literal original parser command required")
    C.literal(command[0])
    root = str(Path(command[0]).parent)
    C.require(root != "/", "a private original parser directory is required")
    C.require(command == [root + "/parser", "--config-file=" + root + "/parser.conf", "--base=" + root,
              "--policy-features=" + root + "/features", "--kernel-features=" + root + "/features", "--skip-kernel-load",
              "--skip-cache", "--stdout", "--jobs=0", "--abort-on-error", "--Werror", "--warn=rule-not-enforced", root + "/qwen-k2-profiles"], "ambient or loading parser command refused")
    C.require(profile["artifactManifestSha256"] == C.sha(files["artifact-manifest.json"])
              and profile["shimConfigurationSha256"] == C.sha(files["shim.json"]), "pre-exec dependency pin differs")
    C.require(final_source(files["source-config.json"], C.sha(files["packed.bin"])) == files["source-config.installed.json"], "installed source token derivation differs")
    bases = C.loads(files["host-policies.json"])
    C.require(set(bases) == {"format", "files"} and bases["format"] == "qwen-k2-host-policies/1"
              and set(bases["files"]) == HOST_FILES and all(bases["files"][name] == C.pin(files[name]) for name in HOST_FILES), "complete host base pins differ")
    spec = importlib.util.spec_from_file_location("reviewed_profile_compiler", C.HERE / "compile-profiles.py")
    compiler = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(compiler)
    policy = compiler.POLICY
    facts = policy.target(C.loads(files["target.json"]))
    source, gateway = C.loads(files["source-config.json"]), C.loads(files["gateway-config.json"])
    policy.role_configs(facts, source, gateway, C.loads(files["artifact-manifest.json"]))
    C.require(profile["roleConfigPaths"] == facts["roleConfigPaths"] and profile["boundaries"] == policy.BOUNDARIES
              and profile["generators"] == {name: C.sha((C.HERE / name).read_bytes()) for name in ("render-profiles.py", "render-pre-exec.py", "image-catalog.py")}
              and compile_record["generatorSha256"] == C.sha((C.HERE / "compile-profiles.py").read_bytes()), "reviewed profile generator contract differs")
    suffix = policy.host_profiles(facts, policy.host_inputs(files["host-policies.json"], files), source, gateway)
    C.require(files["qwen-k2-profiles"].endswith(suffix), "mandatory generated host suffix differs")
    compiler.source(files["qwen-k2-profiles"][:-len(suffix)])
    return files


def tar_payload(files, loader, plan):
    members = {"/etc/qwen-k2/artifacts/" + name: (raw, 0o400) for name, raw in files.items()}
    members[plan["coldInit"]["path"]] = (loader, 0o500)
    members[plan["rootfsPlan"]["target"]["path"]] = (C.TARGET, 0o400)
    members[plan["rootfsPlan"]["manager"]["path"]] = (C.MANAGER, 0o400)
    directories = set()
    for name in members.keys() | plan["rootfsPlan"]["links"].keys():
        directories.update(str(p) for p in Path(name).parents if str(p) != "/")
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(directories, key=lambda p: (p.count("/"), p)):
            item = tarfile.TarInfo(name.lstrip("/"))
            item.type, item.mode = tarfile.DIRTYPE, 0o700 if name.startswith("/etc/qwen-k2") else 0o755
            archive.addfile(item)
        for name, (raw, mode) in sorted(members.items()):
            item = tarfile.TarInfo(name.lstrip("/"))
            item.mode, item.size = mode, len(raw)
            archive.addfile(item, io.BytesIO(raw))
        for name, target in sorted(plan["rootfsPlan"]["links"].items()):
            item = tarfile.TarInfo(name.lstrip("/"))
            item.type, item.linkname, item.mode = tarfile.SYMTYPE, target, 0o777
            archive.addfile(item)
    return output.getvalue()


def package(base_initrd, candidate, installation, output):
    raw = C.read(candidate / "cold-bootstrap.json", 64 * 1024)
    plan = C.validate(raw)
    C.require(plan["generators"] == C.generators(), "cold generator bytes differ")
    original = C.read(base_initrd, 128 * 1024 * 1024, plan["baseInitrd"])
    loader = C.read(candidate / "k2-cold-init", 128 * 1024 * 1024, plan["coldInit"])
    C.static_elf(loader)
    record = C.loads(C.read(candidate / "candidate.json", 4096))
    C.require(record == {"format": "qwen-k2-cold-candidate/1", "coldBootstrapSha256": C.sha(raw), "nativeAcceptance": "NOT_RUN"}, "candidate byte identity differs")
    for item, expected in ((plan["rootfsPlan"]["target"], C.TARGET), (plan["rootfsPlan"]["manager"], C.MANAGER)):
        C.require(C.read(candidate / ("rootfs" + item["path"]), 4096, item) == expected, "generated fixed rootfs bytes differ")
    scripts = {name: C.read(candidate / ("overlay" + name), 1024 * 1024, item)
               for name, item in plan["bootState"]["scriptOutputs"].items()}
    spec = importlib.util.spec_from_file_location("reviewed_cold_renderer", C.HERE / "render-cold-boot.py")
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    C.require(scripts == renderer.harden(C.unpack(original), plan), "hardened boot entries differ from the actual reviewed generator")
    overlay_names = {"/" + str(p.relative_to(candidate / "overlay")) for p in (candidate / "overlay").rglob("*") if not p.is_dir()}
    C.require(overlay_names == set(scripts), "unexpected or missing overlay leaf")
    entries = {name: {"mode": stat.S_IFREG | (0o755 if name == "/init" else 0o644), "data": content} for name, content in scripts.items()}
    files = installed(installation)
    C.require(files["cold-bootstrap.json"] == raw, "installed cold contract differs")
    target = C.loads(files["target.json"])
    C.require(target["format"] == "qwen-k2-profile-target/3" and target["architecture"] == plan["architecture"] and target["coldBootstrapSha256"] == C.sha(raw)
              and all(target["hostExecutables"]["systemd"][k] == plan["systemd"][k] for k in ("path", "sha256", "label")),
              "installed cold target differs")
    final_image = original + b"\0" * (-len(original) % 4) + C.cpio(entries)
    actual = C.unpack(final_image)
    C.require(all(actual[name]["data"] == content for name, content in scripts.items()), "final initrd did not consume hardened entries")
    payload = tar_payload(files, loader, plan)
    C.require(output.is_absolute(), "new absolute package directory required")
    output.mkdir(mode=0o700, exist_ok=False)
    outputs = {"initrd.img": final_image, "rootfs.tar": payload, "boot-command-line": plan["bootState"]["cmdline"].encode(),
               "rootfs-preconditions.json": C.encoded({"format": "qwen-k2-cold-rootfs-preconditions/1", "coldBootstrapSha256": C.sha(raw),
                   "requiredImmutable": [plan["coldInit"], plan["kernel"], plan["baseInitrd"], plan["systemd"], plan["bootState"]["kernelConfiguration"]] + plan["systemdDependencies"],
                   "rootfsPlan": plan["rootfsPlan"], "nativeAcceptance": "NOT_RUN"})}
    for name, content in outputs.items():
        C.save(output, name, content)
    C.save(output, "inventory.json", C.encoded({"format": "qwen-k2-cold-package/1", "files": {name: C.pin(content) for name, content in outputs.items()},
                                               "installationSha256": C.sha(files["installation.json"]), "nativeAcceptance": "NOT_RUN"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base-initrd", "candidate", "installation", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    try:
        package(args.base_initrd, args.candidate, args.installation, args.output)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, IndexError, tarfile.TarError) as failure:
        parser.exit(1, "Cold packaging refused: " + str(failure) + "\n")


if __name__ == "__main__":
    main()
