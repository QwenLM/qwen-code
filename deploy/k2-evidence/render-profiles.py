#!/usr/bin/env python3
"""Render a complete offline policy candidate from pinned pre-exec inputs."""

import argparse
import base64
import hashlib
import importlib.util
import ipaddress
import itertools
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


spec = importlib.util.spec_from_file_location("k2_pre_exec", Path(__file__).with_name("render-pre-exec.py"))
PRE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(PRE)
IMAGE = PRE.IMAGE
ROLES = ("source", "gateway", "shim", "worker", "sandbox")
HOST_ROLES = ("runtime", "kubelet", "registrar", "plugin", "systemd", "system-bus")
HOST_FILES = {"host-" + role + ".rules" for role in HOST_ROLES}
CID = "[0-9a-f]" * 64
UUID = "-".join("[0-9a-f]" * count for count in (8, 4, 4, 4, 12))
INPUT = "/var/lib/qwen-k2/inputs/" + CID
PROC = "/proc/{self,thread-self,[0-9]*,[0-9]*/task/[0-9]*}"
FLAGS = {"ro", "rw", "nosuid", "nodev", "noexec", "sync", "dirsync", "noatime", "nodiratime", "bind", "rbind", "relatime", "strictatime", "private", "rprivate", "slave", "rslave", "shared", "rshared", "remount"}
BOUNDARIES = [
    "Mount data, device numbers and DBus message bodies require the pinned creator/consumer; LSM rules do not compare them.",
    "Pathname Unix sockets use file rules; Unix peer-label rules cover abstract/anonymous sockets, not pathname peer enforcement.",
    "Numeric proc attr writes require the actual kernel self-only write check; UID ownership is not process ownership.",
    "SDK parent/child OOM targets require the pinned manager call and original runtime actor; proc path rules do not prove that relationship.",
    "Disconnected object naming, reciprocal host profiles and exclusive actor/CSI wiring require actual installation qualification.",
    "Generated source is not parser, loaded policy, installation or physical-release evidence.",
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def read_json(path, expected, limit):
    IMAGE.digest("sha256:" + expected)
    with path.open("rb") as stream:
        raw = stream.read(limit + 1)
    require(0 < len(raw) <= limit and sha(raw) == expected, "reviewed JSON bytes differ or exceed their bound")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=IMAGE.closed, parse_constant=IMAGE.nonfinite)
    require(isinstance(value, dict), "a reviewed JSON object is required")
    return raw, value


def literal(value):
    require(isinstance(value, str) and re.fullmatch(r"/[A-Za-z0-9._:/-]+", value), "literal canonical paths are required")
    IMAGE.path(value, True)
    return value


def quoted(value):
    return '"' + value + '"'


def file_literal(value):
    return '"' + "".join("\\" + char if char in "\\\"*?[]{}^" else char for char in value) + '"'


def under(path, parent):
    return path == parent or path.startswith(parent + "/")


def host_body(raw):
    require(0 < len(raw) <= 1024 * 1024 and raw.endswith(b"\n"), "a complete bounded host base ending in newline is required")
    text = raw.decode("utf-8", "strict")
    require(not any(ord(char) < 32 and char != "\n" for char in text) and "@{" not in text, "host bases cannot contain controls or variables")
    rules = 0
    for line in text.splitlines():
        if not line:
            continue
        require(line.startswith("  ") and line.endswith(","), "host bases require flat comma-terminated rule lines")
        masked, inside, escaped, depth = [], False, False, 0
        for index, char in enumerate(line):
            if inside:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    inside = False
                    masked.append('""')
            elif char == '"':
                inside = True
            else:
                require(char not in "{}#\\", "host bases cannot contain structures, comments or continuations")
                if char == "(":
                    depth += 1
                elif char == ")":
                    depth -= 1
                require(0 <= depth <= 32, "host base parentheses are invalid")
                require(char != "," or depth != 0 or index == len(line) - 1, "exactly one host base rule per line is required")
                masked.append(char)
        require(not inside and not escaped and depth == 0, "host base quoting or parentheses are incomplete")
        rule = "".join(masked).strip()
        denied = False
        while re.match(r"^(?:audit|deny|owner|allow) ", rule):
            qualifier, rule = rule.split(" ", 1)
            denied |= qualifier == "deny"
            rule = rule.lstrip()
        file_rule = re.fullmatch(r'(?:file )?"" +([A-Za-z]+),', rule)
        if file_rule:
            mode = file_rule[1] if denied else file_rule[1].replace("ix", "")
            require(mode or "ix" in file_rule[1], "host file permissions are required")
            require(all(char in ("rwalmkx" if denied else "rwalmk") for char in mode), "host base execution must inherit confinement")
        else:
            kind = rule.split(" ", 1)[0].rstrip(",")
            require(kind in {"capability", "network", "unix", "ptrace", "signal", "dbus", "mount", "remount", "umount", "pivot_root", "link", "set", "mqueue", "io_uring", "userns"}, "unsupported host base rule or profile transition")
            require("->" not in rule or kind in {"mount", "remount", "link"}, "host base profile transitions are code-owned")
        rules += 1
    require(rules > 0, "a nonempty complete host base is required")
    return raw


def host_inputs(raw, files):
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=IMAGE.closed, parse_constant=IMAGE.nonfinite)
    require(isinstance(value, dict) and set(value) == {"format", "files"} and value["format"] == "qwen-k2-host-policies/1" and isinstance(value["files"], dict) and set(value["files"]) == HOST_FILES, "the complete fixed host policy manifest is required")
    bases = {}
    for role in HOST_ROLES:
        name = "host-" + role + ".rules"
        pin = value["files"][name]
        require(isinstance(pin, dict) and set(pin) == {"bytes", "sha256"} and type(pin["bytes"]) is int and 0 < pin["bytes"] <= 1024 * 1024, "bounded complete host base pins are required")
        content = files[name]
        require(len(content) == pin["bytes"] and sha(content) == pin["sha256"], "complete host base bytes differ")
        bases[role] = host_body(content)
    return bases


def host_profiles(facts, bases, source, gateway):
    target(facts)
    hosts, bus = facts["hostExecutables"], facts["systemBus"]
    label = lambda role: quoted(bus["label"] if role == "system-bus" else hosts[role]["label"])
    additions = {role: [] for role in HOST_ROLES}
    for role in ("runtime", "kubelet", "registrar", "plugin", "systemd"):
        readers = ("source", "gateway") if role == "systemd" else ("gateway",) if role == "runtime" else ("source",)
        additions[role] += ["ptrace (readby) peer=qwen-k2-" + reader + "-v1," for reader in readers]
    for role in ("kubelet", "registrar"):
        additions[role] += [file_literal(source["frontendSocket"]) + " rw,", "unix (connect,send,receive) type=stream peer=(label=qwen-k2-source-v1),"]
    additions["plugin"] += [file_literal(source["pluginSocket"]) + " rw,", "unix (accept,send,receive) type=stream peer=(label=qwen-k2-source-v1),"]
    additions["runtime"] += [file_literal(gateway["runtimeSocket"]) + " rw,", '"/run/containerd/containerd.sock.ttrpc" rw,', "unix (accept,send,receive) type=stream peer=(label=qwen-k2-gateway-v1),", "unix (accept,send,receive) type=stream peer=(label=qwen-k2-shim-v1),", '"/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1" mrPx -> qwen-k2-shim-v1,']
    for role in ("source", "gateway"):
        additions["systemd"] += ["unix (accept,send,receive) type=stream peer=(label=qwen-k2-" + role + "-v1),", "signal (send) set=(term,int,kill) peer=qwen-k2-" + role + "-v1,", "change_profile -> qwen-k2-" + role + "-v1,"]
    additions["systemd"] += [file_literal(bus["privateSocket"]) + " rw,", "unix (accept,send,receive) type=stream peer=(label=qwen-k2-shim-v1),", 'dbus (send,receive) bus=system path="/org/freedesktop/systemd1{,/**}" interface="org.freedesktop.systemd1.{Manager,Unit,Scope}" peer=(label=qwen-k2-shim-v1),']
    additions["system-bus"] += [file_literal(bus["socket"]) + " rw,", "unix (accept,send,receive) type=stream peer=(label=qwen-k2-shim-v1),", 'dbus receive bus=system path=/org/freedesktop/DBus interface=org.freedesktop.DBus member="{Hello,AddMatch,RemoveMatch}" peer=(label=qwen-k2-shim-v1),']
    groups = {}
    for role in HOST_ROLES:
        key = label(role)
        if key in groups:
            require(groups[key][0] == bases[role], "host roles sharing a label require identical complete bases")
            groups[key][2].extend(additions[role])
        else:
            attachment = " " + file_literal(hosts[role]["path"]) if role != "system-bus" else ""
            groups[key] = (bases[role], attachment, list(additions[role]))
    result = bytearray()
    for name, (base, attachment, rules) in groups.items():
        result += ("profile " + name + attachment + " flags=(enforce,mediate_deleted) {\n").encode()
        result += base
        result += ("\n".join("  " + rule for rule in sorted(set(rules))) + "\n}\n\n").encode()
    return bytes(result)


def target(value):
    fields = {"format", "architecture", "hostExecutables", "snapshotRoot", "podSlicePrefix", "apparmorExportRoot", "systemBus", "volumeSerialPath", "roleConfigPaths", "sandboxNetworkNamespaceSource", "rootfsMounts", "oldRootPath", "hugepageSizes"}
    require(set(value) == fields and value["format"] == "qwen-k2-profile-target/2" and value["architecture"] in ("amd64", "arm64"), "complete closed profile target facts are required")
    hosts = value["hostExecutables"]
    require(isinstance(hosts, dict) and set(hosts) == {"runtime", "kubelet", "registrar", "plugin", "systemd"}, "all host peer identities are required")
    labels = []
    for item in hosts.values():
        require(isinstance(item, dict) and set(item) == {"path", "sha256", "label"}, "closed host executable identities are required")
        literal(item["path"])
        IMAGE.digest("sha256:" + item["sha256"])
        label = item["label"]
        require(host_label(label), "distinct confined root host labels are required")
        labels.append(label)
    require(len(set(labels)) == len(labels), "host peer labels must be distinct")
    for key in ("snapshotRoot", "podSlicePrefix", "apparmorExportRoot", "volumeSerialPath"):
        literal(value[key])
    require(value["snapshotRoot"] == "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots", "only the fixed overlay snapshot root is supported")
    require(re.fullmatch(r"/sys/fs/cgroup/kubepods\.slice/(?:kubepods-(?:burstable|besteffort)\.slice/)?kubepods(?:-(?:burstable|besteffort))?-pod", value["podSlicePrefix"]), "a supported Pod slice prefix is required")
    require(under(value["apparmorExportRoot"], "/qwen-k2-disconnected/source") and value["apparmorExportRoot"] != "/qwen-k2-disconnected/source", "a specific source exporter path is required")
    require(under(value["volumeSerialPath"], "/sys/devices") and value["volumeSerialPath"].endswith("/serial"), "the final block serial path is required")
    configs = value["roleConfigPaths"]
    require(isinstance(configs, dict) and set(configs) == {"source", "gateway"}, "both deployed configuration paths are required")
    for path in configs.values():
        require(re.fullmatch(r"/etc/qwen-k2/[A-Za-z0-9._-]+\.json", literal(path)), "role configurations require literal protected JSON paths")
    require(len(set(configs.values()) | {"/etc/qwen-k2/shim.json"}) == 3, "role configuration paths must be distinct")
    bus = value["systemBus"]
    require(isinstance(bus, dict) and set(bus) == {"socket", "privateSocket", "label"}, "closed system bus facts are required")
    require(bus["socket"] in ("/run/dbus/system_bus_socket", "/var/run/dbus/system_bus_socket") and bus["privateSocket"] == "/run/systemd/private", "fixed system bus sockets are required")
    require(host_label(bus["label"]), "a confined root bus label is required")
    require(not bus["label"].startswith("/") or bus["label"] in labels, "a distinct bus label cannot imply an executable attachment")
    namespace = value["sandboxNetworkNamespaceSource"]
    require(isinstance(namespace, str) and re.fullmatch(r"/run/netns/[A-Za-z0-9._-]*\$\{(?:SANDBOX_ID|NETWORK_NAMESPACE_ID)\}[A-Za-z0-9._-]*", namespace), "the fixed identity network namespace template is required")
    require(under(literal(value["oldRootPath"]), "/qwen-k2-disconnected/shim") and value["oldRootPath"] != "/qwen-k2-disconnected/shim", "a specific old-root disconnected path is required")
    sizes = value["hugepageSizes"]
    require(isinstance(sizes, list) and len(sizes) <= 128 and all(isinstance(size, str) and re.fullmatch(r"[1-9][0-9]{0,9}(?:KB|MB|GB)", size) for size in sizes) and len(set(sizes)) == len(sizes), "bounded semantic hugepage sizes are required")
    require(isinstance(value["rootfsMounts"], dict) and set(value["rootfsMounts"]) == {"worker", "sandbox"}, "both actual outer rootfs mount contracts are required")
    return value


def host_label(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9/][A-Za-z0-9._/-]{0,252}", value) and "//" not in value and not value.endswith("/") and value != "unconfined" and not value.startswith("qwen-k2-")


def role_configs(facts, source, gateway, manifest):
    common = {"listen", "certificate", "key", "authority", "coordinatorPrincipal"}
    source_fields = common | {"nodeUid", "driver", "journalRoot", "pluginSocket", "pluginDigest", "frontendSocket", "kubeletDigest", "registrarDigest", "gatewayUrl", "gatewayPrincipal", "runtimeDigest", "gatewayClientCertificate", "gatewayClientKey", "workerPolicySha256", "sandboxImageSha256"}
    require(set(source) == source_fields and set(gateway) == common | {"sourcePrincipal", "runtimeSocket", "runtimeDigest"}, "complete closed source/gateway configurations are required")
    require(all(isinstance(item, str) and item and "\0" not in item for config in (source, gateway) for item in config.values()), "nonempty service configuration strings are required")
    paths = {}
    for role, config in (("source", source), ("gateway", gateway)):
        names = ("certificate", "key", "authority") + (("gatewayClientCertificate", "gatewayClientKey") if role == "source" else ())
        paths[role] = {facts["roleConfigPaths"][role]} | {literal(config[name]) for name in names}
        require(all(re.fullmatch(r"/etc/qwen-k2/[A-Za-z0-9._-]+", path) for path in paths[role]), "all role files must remain in the protected configuration directory")
    private = {source["key"], source["gatewayClientKey"], gateway["key"]}
    public = {source["certificate"], source["authority"], source["gatewayClientCertificate"], gateway["certificate"], gateway["authority"]}
    configurations = set(facts["roleConfigPaths"].values()) | {"/etc/qwen-k2/shim.json"}
    require(len(private) == 3 and not private.intersection(public | configurations), "private keys cannot alias other role inputs")
    require(not public.intersection(configurations), "TLS inputs cannot alias configuration files")
    require(not paths["source"].intersection({gateway["key"], facts["roleConfigPaths"]["gateway"]}) and not paths["gateway"].intersection({source["key"], source["gatewayClientKey"], facts["roleConfigPaths"]["source"]}), "role files cannot cross private role boundaries")
    host = facts["hostExecutables"]
    protected = ("/etc/qwen-k2", "/var/lib/qwen-k2", "/run/qwen-k2", "/var/lib/kubelet", "/proc", "/sys", "/dev", "/tmp")
    require(all(not under(item["path"], root) for item in host.values() for root in protected), "host executable paths cannot alias role inputs or protected roots")
    for name, field in (("runtime", "runtimeDigest"), ("plugin", "pluginDigest"), ("kubelet", "kubeletDigest"), ("registrar", "registrarDigest")):
        require(source[field] == host[name]["sha256"], "source and host executable digests differ")
    require(gateway["runtimeDigest"] == source["runtimeDigest"], "gateway runtime digest differs")
    require(source["sandboxImageSha256"] == manifest["sandboxImageSha256"], "sandbox image differs from the artifact")
    IMAGE.digest("sha256:" + source["workerPolicySha256"])
    require(source["coordinatorPrincipal"] == gateway["coordinatorPrincipal"] and len({source["gatewayPrincipal"], gateway["sourcePrincipal"], source["coordinatorPrincipal"]}) == 3, "service principals must retain their separate roles")
    require(source["journalRoot"] == "/var/lib/qwen-k2/journal" and under(literal(source["pluginSocket"]), "/run/qwen-k2/backend") and str(Path(source["pluginSocket"]).parent) == "/run/qwen-k2/backend", "journal/backend paths are outside the first lane")
    require(str(Path(literal(source["frontendSocket"])).parent) == "/run/qwen-k2/source" and source["frontendSocket"] != "/run/qwen-k2/source/birth.sock" and gateway["runtimeSocket"] == "/run/containerd/containerd.sock", "frontend/runtime socket paths differ from the fixed lane")
    listeners = []
    for config in (source, gateway):
        text = config["listen"]
        host_ip, separator, port = text.rpartition(":")
        require(separator and port.isdigit() and 1024 <= int(port) <= 65535, "a nonprivileged IP listener is required")
        ip = ipaddress.ip_address(host_ip.strip("[]"))
        require(not ip.is_unspecified and not ip.is_multicast, "a concrete listener IP is required")
        canonical = ("[" + str(ip) + "]" if ip.version == 6 else str(ip)) + ":" + str(int(port))
        require(getattr(ip, "scope_id", None) is None and text == canonical, "a canonical Go IP listener is required")
        listeners.append((ip, int(port)))
    require(listeners[0] != listeners[1], "service listeners must differ")
    url = urlsplit(source["gatewayUrl"])
    require(url.scheme == "https" and url.username is None and url.password is None and not url.query and not url.fragment and url.path in ("", "/") and (ipaddress.ip_address(url.hostname), url.port or 443) == listeners[1], "the gateway URL must name its actual IP listener")
    return paths


def image_rules(catalogue, prefix=""):
    rules = []
    for item in catalogue["entries"]:
        if item["kind"] == "directory":
            rules.append(quoted(prefix + file_literal(item["path"] + "/")[1:-1]) + " r,")
        elif item["kind"] == "file":
            mode = "mrix" if item["path"] == catalogue["entry"] else "mr" if item["elf"] else "r"
            rules.append(quoted(prefix + file_literal(item["path"])[1:-1]) + " " + mode + ",")
    return rules


def source_mount(value):
    substitutions = {"${POD_UID}": UUID, "${POD_UID_SYSTEMD}": UUID.replace("-", "_"), "${CONTAINER_ID}": CID, "${SANDBOX_ID}": CID, "${NETWORK_NAMESPACE_ID}": UUID}
    require(isinstance(value, str) and value, "a mount source string is required")
    clean = value
    for token in substitutions:
        clean = clean.replace(token, "identity")
    require(re.fullmatch(r"[A-Za-z0-9._:/-]+", clean), "only literal mount sources and fixed identity substitutions are supported")
    if clean.startswith("/"):
        literal(clean)
    for token, pattern in substitutions.items():
        value = value.replace(token, pattern)
    return value


def flag_variants(flags, bits=("nosuid", "nodev", "noexec")):
    variants = []
    for switches in itertools.product((False, True), repeat=len(bits)):
        value = set(flags) | {bit for bit, enabled in zip(bits, switches) if enabled}
        if "ro" in value:
            value.discard("rw")
        variants.append(sorted(value))
    return variants


def mount_rule(flags, destination, source=None, filesystem=None):
    condition = ("fstype=" + filesystem + " ") if filesystem else ""
    origin = quoted(source) + " " if source is not None else ""
    return "mount " + condition + "options=(" + ",".join(flags) + ") " + origin + "-> " + quoted(destination + ("{,/}" if destination != "/" else "")) + ","


def mount_rules(contract, facts, catalogs):
    rules = []
    root = INPUT + "/rootfs"
    rules += [mount_rule(["rslave"], "/"), mount_rule(["private"], root), mount_rule(["rbind"], root, root)]
    rules += [mount_rule(flags, "/") for flags in flag_variants(["bind", "remount", "ro"])]
    rules += [mount_rule(["rslave"], facts["oldRootPath"]), "umount " + file_literal(facts["oldRootPath"] + "/") + ","]
    propagation = {"private", "rprivate", "slave", "rslave", "shared", "rshared"}
    for role in ("worker", "sandbox"):
        value = contract[role]
        entries = {item["path"]: item for item in catalogs[role]["entries"]}
        resolved = lambda path: literal(IMAGE.resolve(entries, literal(path), allow_missing_parents=True))
        outer = facts["rootfsMounts"][role]
        require(isinstance(outer, list) and len(outer) == 1 and isinstance(outer[0], dict) and set(outer[0]) == {"type", "source", "options"} and outer[0]["type"] == "overlay" and outer[0]["source"] == "overlay", "the exact single outer overlay mount is required")
        options = outer[0]["options"]
        require(isinstance(options, list) and len(options) <= 128 and all(isinstance(option, str) and option and "\0" not in option for option in options), "bounded outer rootfs options are required")
        require(len(options) == len(set(options)) and all(option in FLAGS or re.fullmatch(r"(?:lowerdir|upperdir|workdir)=[A-Za-z0-9._:/-]+", option) for option in options), "unsupported outer rootfs option")
        require(sum(option.startswith("lowerdir=") for option in options) == 1, "the complete outer lowerdir data is required")
        flags = [option for option in options if option in FLAGS and option not in propagation]
        require(not {"ro", "rw"}.issubset(flags) and "remount" not in flags and not {"bind", "rbind"}.intersection(flags), "unsupported outer mount flags")
        rules.append(mount_rule(flags or ["rw"], root, "overlay", "overlay"))
        rules += [mount_rule([option], root) for option in options if option in propagation]
        for mount in value["mounts"]:
            require(set(mount) == {"destination", "type", "source", "options"} and mount["type"] in ("bind", "proc", "sysfs", "tmpfs", "devpts", "mqueue", "cgroup2"), "unsupported consumed mount")
            destination = resolved(mount["destination"])
            source = source_mount(mount["source"])
            require(mount["type"] != "bind" or source.startswith("/"), "bind sources must be absolute")
            options = mount["options"]
            require(isinstance(options, list) and options and len(options) == len(set(options)) and all(isinstance(option, str) and re.fullmatch(r"[A-Za-z0-9._:=/-]+", option) for option in options), "closed literal mount options are required")
            flags = [option for option in options if option in FLAGS and option not in propagation]
            data = [option for option in options if option not in FLAGS]
            require(flags and all(re.fullmatch(r"(?:size|mode|uid|gid|nr_inodes|newinstance|ptmxmode)=[A-Za-z0-9._-]+|newinstance", option) for option in data), "unsupported mount flag or data option")
            require(not {"ro", "rw"}.issubset(flags) and "remount" not in flags and not {"bind", "rbind"}.issubset(flags), "contradictory or phase-specific mount flags are unsupported")
            require(mount["type"] != "bind" or bool({"bind", "rbind"}.intersection(flags)) and not data, "bind mounts require their actual bind flag and no data")
            initial = [flag for flag in flags if flag != "ro"] if mount["type"] == "tmpfs" or destination == "/dev" else flags
            rules.append(mount_rule(initial or ["rw"], root + destination, source, None if mount["type"] == "bind" else mount["type"]))
            rules += [mount_rule([option], root + destination) for option in options if option in propagation]
            if mount["type"] == "bind":
                remount = [flag for flag in flags if flag not in ("bind", "rbind")] + ["bind", "remount"]
                rules += [mount_rule(variant, root + destination) for variant in flag_variants(remount, ("ro", "nosuid", "nodev", "noexec"))]
            elif mount["type"] == "cgroup2":
                rules.append(mount_rule(sorted(set(flags) | {"bind"}), root + destination, "/sys/fs/cgroup"))
            if "ro" in flags and (mount["type"] == "tmpfs" or destination == "/dev"):
                rules.append(mount_rule(sorted(set(flags) | {"bind", "remount", "ro"}), destination))
            for parent in (destination, *[str(path) for path in Path(destination).parents if str(path) != "/"]):
                rules += [quoted(root + parent + "/") + " rw,"]
            rules.append(quoted(root + destination) + " rw,")
        for path in value["readonlyPaths"]:
            destination = resolved(path)
            rules.append(mount_rule(["rbind"], destination, destination))
            rules += [mount_rule(variant, destination, destination) for variant in flag_variants(["bind", "remount", "ro"])]
        masked = [resolved(path) for path in value["maskedPaths"]]
        require(len(masked) <= 64, "masked path matrix exceeds its bound")
        for index, destination in enumerate(masked):
            rules += [mount_rule(["bind"], destination, "/dev/null"), mount_rule(["ro"], destination, "tmpfs", "tmpfs")]
            rules += [mount_rule(["bind"], destination, previous) for previous in masked[:index]]
        for device in value["devices"]:
            fields = {"path", "type", "major", "minor", "fileMode", "uid", "gid"}
            allowed = {"/dev/null": (1, 3), "/dev/zero": (1, 5), "/dev/full": (1, 7), "/dev/random": (1, 8), "/dev/urandom": (1, 9), "/dev/tty": (5, 0)}
            require(set(device) == fields and device["path"] in allowed and device["type"] == "c" and all(type(device[key]) is int for key in ("major", "minor", "fileMode", "uid", "gid")) and (device["major"], device["minor"]) == allowed[device["path"]] and (device["fileMode"], device["uid"], device["gid"]) == (0o666, 0, 0), "unsupported device contract")
            rules.append(quoted(INPUT + "/rootfs" + device["path"]) + " rw,")
            rules += [mount_rule(["bind"], root + device["path"], device["path"]), file_literal(device["path"]) + " r,"]
        for device_rule in value["deviceCgroupRules"]:
            require(set(device_rule) <= {"allow", "type", "major", "minor", "access"} and {"allow", "access"} <= set(device_rule) and type(device_rule["allow"]) is bool and device_rule["access"] in ("rwm", "rw", "m") and device_rule.get("type", "a") in ("a", "c") and all(type(device_rule[key]) is int and device_rule[key] >= 0 for key in ("major", "minor") if key in device_rule), "unsupported device cgroup rule")
            require(not device_rule["allow"] or device_rule.get("type") == "c" and (device_rule.get("major"), device_rule.get("minor")) in {(1, 3), (1, 5), (1, 7), (1, 8), (1, 9), (5, 0), (5, 2)}, "unbounded device grants are unsupported")
        rules += [quoted(root + "/dev/{,pts/,shm/,ptmx,fd,stdin,stdout,stderr,core}") + " rw,"]
    return rules


def profiles(facts, contract, catalogs, runtime, source, gateway, manifest):
    facts = target(facts)
    role_files = role_configs(facts, source, gateway, manifest)
    require(isinstance(runtime.get("command"), list) and runtime["command"] and all(isinstance(arg, str) for arg in runtime["command"]), "the original Runtime command is required")
    require(contract["worker"]["args"] == runtime["command"] + ["managed-runtime-worker", "--container-boot", "/var/run/qwen-runtime/boot.json"], "Runtime and creation commands differ")
    require(isinstance(runtime.get("registration"), dict), "Runtime registration is required")
    mount_root = literal(runtime["registration"].get("mountRoot"))
    require(not any(under(mount_root, path) or under(path, mount_root) for path in ("/tmp", "/proc", "/sys", "/dev", "/run", "/etc", "/opt", "/usr", "/var")), "the worker mount root overlaps a protected root")
    require(all(not under(item["path"], mount_root) for item in facts["hostExecutables"].values()), "host executables cannot occupy writable worker roots")
    require(isinstance(runtime.get("image"), str) and runtime["image"].endswith("@sha256:" + manifest["workerImageSha256"]), "Runtime worker image differs")
    for role, catalog in catalogs.items():
        require(catalog["architecture"] == facts["architecture"] and catalog["args"] == contract[role]["args"], "catalogue and target/contract differ")
        require(not any(item["kind"] == "file" and (under(item["path"], "/tmp") or under(item["path"], mount_root)) for item in catalog["entries"]), "image files cannot overlap writable roots")
        entries = {item["path"]: item for item in catalog["entries"]}
        require(all(IMAGE.resolve(entries, path, allow_missing_parents=True) == path for path in ("/tmp", mount_root)), "writable roots cannot be image aliases")
    hosts = facts["hostExecutables"]
    peer = lambda name: quoted(hosts[name]["label"])
    network = ["network inet stream,", "network inet6 stream,"]
    basic = ['"/" r,', '"/proc/" r,', '"/proc/sys/kernel/random/boot_id" r,', '"/dev/{null,zero,urandom}" rw,']
    own = [quoted(PROC + suffix) + " r," for suffix in ("/", "/stat", "/status", "/uid_map", "/cgroup", "/exe", "/attr/{current,apparmor/current}")]
    service = basic + own + network + ['capability sys_ptrace,', '"/opt/qwen-k2/bin/k2-node-evidence" mrix,', '"/etc/qwen-k2/shim.json" r,']
    entries = {role: [] for role in ROLES}
    for role in ("source", "gateway"):
        entries[role] = service + [file_literal(path) + " r," for path in role_files[role]] + ["signal (send,receive) peer=qwen-k2-" + role + "-v1,", "signal (receive) set=(term,int,kill) peer=" + peer("systemd") + ","]
        artifact_names = "installation.json,artifact-manifest.json,shim.json,profile-candidate.json,profile-compile.json,source-config.json,source-config.installed.json,gateway-config.json,target.json,runtime.json,creation-contract.json,qwen-k2-node-source.service,qwen-k2-runtime-gateway.service,features,qwen-k2-profiles,worker-catalog.json,sandbox-catalog.json,packed.bin,host-policies.json," + ",".join(sorted(HOST_FILES))
        entries[role] += ['"/etc/" r,', '"/etc/qwen-k2/{,artifacts/}" r,', '"/etc/qwen-k2/artifacts/{' + artifact_names + '}" r,']
        unit = "qwen-k2-node-source.service" if role == "source" else "qwen-k2-runtime-gateway.service"
        entries[role] += ['"/etc/systemd/system/' + unit + '" r,']
        entries[role] += ['"/run/systemd/private" rw,', file_literal(hosts["systemd"]["path"]) + " r,", "ptrace (read) peer=" + peer("systemd") + ",", "unix (connect,send,receive) type=stream peer=(label=" + peer("systemd") + "),"]
    src = entries["source"]
    for root in ("/sys/kernel/security/apparmor/policy", facts["apparmorExportRoot"]):
        src += [quoted(root + suffix) + " r," for suffix in ("/", "/revision", "/profiles/", "/profiles/*/", "/profiles/*/{name,mode,raw_data,raw_abi,raw_sha256}", "/raw_data/", "/raw_data/[0-9]*/", "/raw_data/[0-9]*/{raw_data,abi,revision,sha256}")]
    src += ['"/sys/{,kernel/,kernel/security/,kernel/security/apparmor/}" r,', '"/sys/kernel/security/apparmor/{.ns_level,.ns_name,.stacked,.ns_stacked}" r,', '"/sys/module/{,apparmor/,apparmor/parameters/,apparmor/parameters/{enabled,mode,lock_policy,hash_policy,export_binary}}" r,', quoted(PROC + "/ns/{user,mnt,cgroup,pid,net,ipc,uts}") + " r,", quoted(PROC + "/root/") + " r,", quoted(source_mount(facts["sandboxNetworkNamespaceSource"])) + " r,", '"/var/lib/kubelet/{,pods/}" r,', quoted("/var/lib/kubelet/pods/" + UUID + "/volumes/kubernetes.io~csi/*/{,mount/}") + " r,", '"/var/lib/qwen-k2/inputs/" r,', quoted(INPUT + "/{,rootfs/,config.json,original.create.pb,consumed.create.pb,original.config.json}") + " r,", '"/opt/qwen-k2/bin/{runc,containerd-shim-qwen-k2-v1}" r,', '"/var/lib/qwen-k2/journal/" r,', '"/var/lib/qwen-k2/journal/source.lock" rwk,', quoted("/var/lib/qwen-k2/journal/" + "[0-9a-f]" * 32 + ".journal") + " rw,", '"/run/qwen-k2/source/" rw,', file_literal(source["frontendSocket"]) + " rw,", '"/run/qwen-k2/source/birth.sock" rw,', file_literal(source["pluginSocket"]) + " rw,"]
    for name in ("kubelet", "registrar", "plugin"):
        src += [file_literal(hosts[name]["path"]) + " r,", "ptrace (read) peer=" + peer(name) + ","]
    src += ["ptrace (read) peer=qwen-k2-" + role + "-v1," for role in ("shim", "worker", "sandbox")]
    src += ["ptrace (readby) peer=qwen-k2-shim-v1,", 'unix (create,bind,listen,getattr,setattr,getopt,setopt,shutdown) type=seqpacket,', 'unix (accept,send,receive) type=seqpacket peer=(label=qwen-k2-shim-v1),', 'unix (create,bind,listen,getattr,setattr,getopt,setopt,shutdown) type=stream,']
    for name in ("kubelet", "registrar"):
        src += ["unix (accept,send,receive) type=stream peer=(label=" + peer(name) + "),"]
    src += ["unix (connect,send,receive) type=stream peer=(label=" + peer("plugin") + "),"]
    entries["gateway"] += [quoted(PROC + "/ns/{user,mnt}") + " r,", file_literal(gateway["runtimeSocket"]) + " rw,", file_literal(hosts["runtime"]["path"]) + " r,", "ptrace (read) peer=" + peer("runtime") + ",", "unix (create,getattr,getopt,setopt,shutdown) type=stream,", "unix (connect,send,receive) type=stream peer=(label=" + peer("runtime") + "),"]
    shim = entries["shim"]
    shim += basic + own + ['"/etc/qwen-k2/shim.json" r,', '"/opt/qwen-k2/bin/{containerd-shim-qwen-k2-v1,runc}" mrix,', '"/opt/qwen-k2/bin/k2-node-evidence" r,', '"/run/containerd/containerd.sock.ttrpc" rw,', '"/run/qwen-k2/source/birth.sock" rw,', quoted("/run/qwen-k2/shims/{," + CID + "}") + " rw,", '"/var/lib/qwen-k2/inputs/" rw,', quoted(INPUT + "/") + " rw,", quoted(INPUT + "/{config.json,original.create.pb,consumed.create.pb,original.config.json,options.json,runtime,log.json,.init.pid,init.pid}") + " rw,", quoted(INPUT + "/{rootfs,work}/") + " rw,", '"/run/qwen-k2/runc/{,k8s.io/}" rw,', quoted("/run/qwen-k2/runc/k8s.io/" + CID + "/{,state.json,state-*,exec.fifo}") + " rw,", quoted("/run/containerd/io.containerd.runtime.v2.task/k8s.io/" + CID + "/") + " r,", quoted("/run/containerd/io.containerd.runtime.v2.task/k8s.io/" + CID + "/{config.json,address}") + " r,", quoted("/run/containerd/io.containerd.runtime.v2.task/k8s.io/" + CID + "/s") + " rw,", quoted(PROC + "/{oom_score_adj,mountinfo,fd/,fd/*,ns/{user,mnt,cgroup,pid,net,ipc,uts}}") + " r,", '"/proc/[0-9]*/oom_score_adj" w,', quoted(PROC + "/attr/{exec,apparmor/exec}") + " w,", "ptrace (read,readby) peer=qwen-k2-shim-v1,", "ptrace (read) peer=qwen-k2-source-v1,", "ptrace (readby) peer=qwen-k2-source-v1,", "signal (send,receive) peer=qwen-k2-shim-v1,"]
    shim += ["capability " + name + "," for name in ("sys_admin", "linux_immutable", "chown", "dac_override", "setuid", "setgid", "setpcap", "sys_chroot", "mknod", "kill")]
    fifo = "/run/containerd/io.containerd.grpc.v1.cri/containers/" + CID + "/io/*/" + CID + "-{stdout,stderr}"
    src += [quoted(fifo) + " r,"]
    shim += [quoted(fifo) + " rw,", quoted(facts["snapshotRoot"] + "/[0-9]*/{,fs/,fs/**,work/,work/**}") + " r,", "umount " + quoted(INPUT + "/rootfs{,/**}") + ",", "pivot_root " + quoted(INPUT + "/rootfs/") + ","]
    pod = facts["podSlicePrefix"] + UUID.replace("-", "_") + ".slice"
    leaf = pod + "/cri-containerd-" + CID + ".scope/"
    src += [quoted(pod + "/") + " r,", quoted(pod + "/cgroup.events") + " r,", quoted(leaf) + " r,", quoted(leaf + "cgroup.events") + " r,"]
    shim += [quoted(pod + "/{,cgroup.events,cgroup.procs,cgroup.controllers,cgroup.subtree_control}") + " r,", quoted(leaf) + " rw,", quoted(leaf + "{cgroup.events,cgroup.procs,cgroup.controllers,cgroup.type,cpu.stat,cpu.pressure,memory.stat,memory.events,memory.events.local,memory.current,memory.peak,memory.swap.current,memory.swap.peak,memory.pressure,rdma.current,rdma.max,io.stat,io.pressure,pids.current,pids.events}") + " r,", quoted(leaf + "{cgroup.procs,cpu.max,cpu.weight,memory.max,memory.high,memory.swap.max,pids.max}") + " rw,"]
    shim += ['"/sys/fs/cgroup/cgroup.controllers" r,', '"/sys/kernel/mm/hugepages/" r,']
    shim += [quoted(leaf + "hugetlb." + size + ".{max,current,events}") + " r," for size in facts["hugepageSizes"]]
    bus = facts["systemBus"]
    shim += [file_literal(bus["socket"]) + " rw,", file_literal(bus["privateSocket"]) + " rw,", "unix (create,bind,listen,getattr,setattr,getopt,setopt,shutdown) type=stream,", "unix (connect,accept,send,receive) type=stream peer=(label=qwen-k2-shim-v1),", "unix (connect,send,receive) type=stream peer=(label=" + peer("runtime") + "),", "unix (connect,send,receive) type=stream peer=(label=" + quoted(bus["label"]) + "),", "unix (connect,send,receive) type=stream peer=(label=" + peer("systemd") + "),", "unix (create,getattr,getopt,setopt,shutdown) type=seqpacket,", 'unix (connect,send,receive) type=seqpacket peer=(label=qwen-k2-source-v1),', "dbus (send,receive) bus=system path=/org/freedesktop/systemd1{,/**} interface=org.freedesktop.systemd1.{Manager,Unit,Scope} peer=(name=org.freedesktop.systemd1 label=" + peer("systemd") + "),", "dbus send bus=system path=/org/freedesktop/DBus interface=org.freedesktop.DBus member={Hello,AddMatch,RemoveMatch} peer=(name=org.freedesktop.DBus label=" + quoted(bus["label"]) + "),"]
    shim += mount_rules(contract, facts, catalogs)
    for role in ("worker", "sandbox"):
        shim += image_rules(catalogs[role]) + image_rules(catalogs[role], INPUT + "/rootfs")
        shim += ["change_profile " + file_literal(catalogs[role]["entry"]) + " -> qwen-k2-" + role + "-v1,", "signal (send) set=(term,kill,int,chld,cont) peer=qwen-k2-" + role + "-v1,"]
        entries[role] += image_rules(catalogs[role]) + ['"/dev/null" rw,', "ptrace (readby) peer=qwen-k2-source-v1,", "signal (send,receive) peer=qwen-k2-" + role + "-v1,", "signal (receive) set=(term,kill,int,cont) peer=qwen-k2-shim-v1,"]
    worker_files = {item["path"]: item for item in catalogs["worker"]["entries"]}
    boot = literal(IMAGE.resolve(worker_files, "/var/run/qwen-runtime/boot.json", allow_missing_parents=True))
    chunks = literal(IMAGE.resolve(worker_files, "/var/run/qwen-worker-parts/chunks", allow_missing_parents=True))
    entries["worker"] += network + ['"/tmp/{,**}" rw,', quoted(mount_root + "/{,**}") + " rw,", file_literal(boot) + " r,", file_literal(chunks)[:-1] + '/{,**}" r,', '"/proc/self/{mountinfo,fd/,fd/*}" r,', file_literal(facts["volumeSerialPath"]) + " r,", '"/dev/urandom" rw,']
    lines = []
    for role in ROLES:
        attachment = ' "/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1"' if role == "shim" else ""
        lines += ["profile qwen-k2-" + role + "-v1" + attachment + " flags=(mediate_deleted,attach_disconnected.path=/qwen-k2-disconnected/" + role + "/) {"]
        lines += ["  " + rule for rule in sorted(set(entries[role]))] + ["}", ""]
    raw = "\n".join(lines).encode("utf-8")
    require(len(raw) <= 16 * 1024 * 1024, "profile source exceeds its byte bound")
    return raw


def render(candidate, candidate_sha, target_file, target_sha, runtime_file, runtime_sha, source_file, source_sha, gateway_file, gateway_sha, worker_layout, sandbox_layout, host_policy, host_policy_sha, output):
    manifest_raw, manifest = read_json(candidate / "artifact-manifest.json", candidate_sha, 64 * 1024)
    require(set(manifest) == {"format", "artifacts", "creationContractSha256", "sandboxImageSha256", "workerImageSha256", "catalogues", "generators"} and manifest["format"] == "qwen-k2-pre-exec-artifacts/2", "exact version-2 artifacts are required")
    for role in ("source", "shim", "runc"):
        item = manifest["artifacts"][role]
        require(set(item) == {"sha256", "bytes", "architecture"} and type(item["bytes"]) is int and 64 <= item["bytes"] <= 128 * 1024 * 1024, "bounded host artifact identities are required")
        IMAGE.digest("sha256:" + item["sha256"])
    require(set(manifest["artifacts"]) == {"source", "shim", "runc"} and len({item["architecture"] for item in manifest["artifacts"].values()}) == 1, "host artifact architectures differ")
    require(manifest["generators"] == {name: sha(Path(__file__).with_name(name).read_bytes()) for name in ("render-pre-exec.py", "image-catalog.py")}, "artifact generator versions differ")
    with (candidate / "shim.json").open("rb") as stream:
        shim_raw = stream.read(32 * 1024 + 1)
    require(0 < len(shim_raw) <= 32 * 1024, "shim configuration exceeds its bound")
    shim = json.loads(shim_raw.decode("utf-8"), object_pairs_hook=IMAGE.closed, parse_constant=IMAGE.nonfinite)
    contract_raw = base64.b64decode(shim["creationContract"], validate=True)
    require(0 < len(contract_raw) <= 16 * 1024 and sha(contract_raw) == manifest["creationContractSha256"], "original creation contract differs")
    contract = json.loads(contract_raw.decode("utf-8"), object_pairs_hook=IMAGE.closed, parse_constant=IMAGE.nonfinite)
    expected = {"inputs": {"bundleRoot": "/run/containerd/io.containerd.runtime.v2.task/k8s.io", "inputRoot": "/var/lib/qwen-k2/inputs", "runcPath": "/opt/qwen-k2/bin/runc", "runcRoot": "/run/qwen-k2/runc", "runcSha256": manifest["artifacts"]["runc"]["sha256"]}, "sourceSocket": "/run/qwen-k2/source/birth.sock", "sourceSha256": manifest["artifacts"]["source"]["sha256"], "shimPath": "/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1", "shimSha256": manifest["artifacts"]["shim"]["sha256"], "socketRoot": "/run/qwen-k2/shims", "containerdGrpc": "/run/containerd/containerd.sock", "containerdTtrpc": "/run/containerd/containerd.sock.ttrpc", "creationContract": base64.b64encode(contract_raw).decode("ascii")}
    require(shim == expected, "shim configuration differs from the artifact lane")
    catalogs = {}
    require(set(manifest["catalogues"]) == {"worker-catalog.json", "sandbox-catalog.json"}, "both catalogue identities are required")
    for role, layout in (("worker", worker_layout), ("sandbox", sandbox_layout)):
        name = role + "-catalog.json"
        pin = manifest["catalogues"][name]
        require(set(pin) == {"bytes", "sha256"} and type(pin["bytes"]) is int and 0 < pin["bytes"] <= IMAGE.CATALOG_LIMIT, "bounded catalogue pins are required")
        raw, catalog = read_json(candidate / name, pin["sha256"], IMAGE.CATALOG_LIMIT)
        require(len(raw) == pin["bytes"], "catalogue length differs")
        actual = IMAGE.catalogue(layout, manifest[role + "ImageSha256"], role, contract)
        require(raw == encoded(actual) and catalog == actual, "original image catalogue differs")
        catalogs[role] = actual
    target_raw, facts = read_json(target_file, target_sha, 32 * 1024)
    runtime_raw, runtime = read_json(runtime_file, runtime_sha, 64 * 1024)
    source_raw, source = read_json(source_file, source_sha, 32 * 1024)
    gateway_raw, gateway = read_json(gateway_file, gateway_sha, 32 * 1024)
    require(facts["architecture"] == manifest["artifacts"]["source"]["architecture"], "target and host architecture differ")
    profile = profiles(facts, contract, catalogs, runtime, source, gateway, manifest)
    host_raw, host_manifest = read_json(host_policy / "host-policies.json", host_policy_sha, 64 * 1024)
    require(set(host_manifest.get("files", {})) == HOST_FILES, "the complete fixed host policy manifest is required")
    files = {"host-policies.json": host_raw}
    for name in sorted(HOST_FILES):
        with (host_policy / name).open("rb") as stream:
            files[name] = stream.read(1024 * 1024 + 1)
    bases = host_inputs(host_raw, files)
    profile += host_profiles(facts, bases, source, gateway)
    require(len(profile) <= 16 * 1024 * 1024, "complete profile source exceeds its byte bound")
    files.update({"qwen-k2-profiles": profile, "source-config.json": source_raw, "gateway-config.json": gateway_raw, "target.json": target_raw, "runtime.json": runtime_raw, "creation-contract.json": contract_raw})
    for role, template_name in (("source", "qwen-k2-node-source.service"), ("gateway", "qwen-k2-runtime-gateway.service")):
        template = (Path(__file__).parent / "host-services" / template_name).read_bytes()
        old = ("ExecStart=/opt/qwen-k2/bin/k2-node-evidence " + role + " /etc/qwen-k2/" + role + ".json").encode()
        require(template.count(old) == 1, "the service template argv differs")
        files[template_name] = template.replace(old, ("ExecStart=/opt/qwen-k2/bin/k2-node-evidence " + role + " " + facts["roleConfigPaths"][role]).encode())
    document = {"format": "qwen-k2-profile-candidate/2", "artifactManifestSha256": sha(manifest_raw), "shimConfigurationSha256": sha(shim_raw), "roleConfigPaths": facts["roleConfigPaths"], "boundaries": BOUNDARIES, "generators": {name: sha(Path(__file__).with_name(name).read_bytes()) for name in ("render-profiles.py", "render-pre-exec.py", "image-catalog.py")}, "files": {name: {"bytes": len(raw), "sha256": sha(raw)} for name, raw in files.items()}}
    files["profile-candidate.json"] = encoded(document)
    output.mkdir(mode=0o700, exist_ok=False)
    for name, raw in files.items():
        with (output / name).open("xb") as stream:
            stream.write(raw)
        (output / name).chmod(0o400)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--artifact-manifest-sha256", required=True)
    for name in ("target", "runtime", "source-config", "gateway-config"):
        parser.add_argument("--" + name, type=Path, required=True)
        parser.add_argument("--" + name + "-sha256", required=True)
    for name in ("worker-layout", "sandbox-layout", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--host-policy", type=Path, required=True)
    parser.add_argument("--host-policy-sha256", required=True)
    args = parser.parse_args()
    try:
        render(args.candidate, args.artifact_manifest_sha256, args.target, args.target_sha256, args.runtime, args.runtime_sha256, args.source_config, args.source_config_sha256, args.gateway_config, args.gateway_config_sha256, args.worker_layout, args.sandbox_layout, args.host_policy, args.host_policy_sha256, args.output)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, EOFError, IMAGE.tarfile.TarError, IMAGE.struct.error) as failure:
        parser.exit(1, "Profile candidate rendering refused: " + str(failure) + "\n")


if __name__ == "__main__":
    main()
