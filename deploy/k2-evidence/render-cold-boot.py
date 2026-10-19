#!/usr/bin/env python3
"""Generate the fixed first-systemd boot candidate; never install or qualify it."""

import argparse
from pathlib import Path
import re
import stat

import cold_boot as C


def replace(raw, old, new):
    C.require(raw.count(old) == 1, "reviewed initrd anchor differs")
    return raw.replace(old, new)


def harden(entries, plan):
    raw = entries["/init"]["data"].decode()
    start = raw.index("# shellcheck disable=SC2013")
    end = raw.index('if [ "$quiet" != "y" ]; then', start)
    cmdline = plan["bootState"]["cmdline"].rstrip("\n")
    C.require("'" not in cmdline, "fixed cmdline cannot contain shell quoting")
    raw = raw[:start] + 'read -r k2_cmdline </proc/cmdline || exit 1\n[ "$k2_cmdline" = \'' + cmdline + "' ] || exit 1\nquiet=y\n\n" + raw[end:]
    start, end = raw.index("# Parse command line options"), raw.index("# Default to BOOT=local")
    root = re.search(r"(?:^| )root=([^ ]+)", cmdline)[1]
    raw = raw[:start] + ('ROOT="' + root + '"\nBOOT=local\ninit=/opt/qwen-k2/bin/k2-cold-init\nrootmnt=/root\nreadonly=y\nnoresume=y\nRESUME=none\nIP=none\nIP6=none\nbreak=\ndebug=\npanic=0\ndrop_caps=\nnetconsole=\nlog_output=\n\n') + raw[end:]
    start, end = raw.index("validate_init()"), raw.index("# don't leak too much of env")
    raw = raw[:start] + '/usr/bin/run-init -n /root /opt/qwen-k2/bin/k2-cold-init || panic\n\n' + raw[end:]
    raw = raw[:raw.index("# Chain to real filesystem")] + '''# Only the reviewed cold entry is reachable; a failed exec stops PID1.
exec /usr/bin/env -i LANG=C /usr/bin/run-init /root /opt/qwen-k2/bin/k2-cold-init </root/dev/console >/root/dev/console 2>&1
panic
'''
    raw = replace(raw, "#!/bin/sh\n", "#!/bin/sh\nunset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_PROFILE LD_ORIGIN_PATH LD_ASSUME_KERNEL ENV BASH_ENV GODEBUG GOTRACEBACK\nexport LANG=C\nset --\npanic() { printf '%s\\n' 'K2 cold boot stopped' >&2; exit 1; }\n")
    lines = []
    for line in raw.splitlines():
        stripped = line.lstrip()
        if re.match(r"^(?:mount(?: |$)|mkdir |run_scripts |mount_top$|mount_premount$|mountroot$|mountfs |mount_bottom$|nfs_bottom$|local_bottom$|load_modules$|parse_numeric |configure_networking$|ln |\. )", stripped) and not stripped.endswith(("|| true", "|| panic")):
            line += " || panic"
        if stripped.endswith("|| true"):
            line = line[:-len("|| true")] + "|| panic"
        if stripped == '[ -f "${conf}" ] && . "${conf}"':
            line = '    if [ -f "${conf}" ]; then . "${conf}" || panic; fi'
        if re.match(r'^\[ -d /(dev|root|sys|proc|tmp) \] \|\| mkdir', stripped):
            line += " || panic"
        lines.append(line)
    outputs = {"/init": ("\n".join(lines) + "\n").encode()}
    functions = entries["/scripts/functions"]["data"].decode()
    start, end = functions.index("panic()\n"), functions.index("# Load custom modules first")
    functions = functions[:start] + '''panic() { printf '%s\\n' 'K2 cold boot stopped' >&2; exit 1; }
maybe_break() { [ -z "${break}" ] || panic; }
run_scripts() {
    initdir=${1}
    [ -d "${initdir}" ] || return 0
    shift
    [ -f "${initdir}/ORDER" ] || panic
    . "${initdir}/ORDER" || panic
}

''' + functions[end:]
    functions = replace(functions, "/sbin/modprobe $m\n", "/sbin/modprobe $m || panic\n")
    outputs["/scripts/functions"] = functions.encode()
    outputs["/scripts/init-top/udev"] = b'''# Sourced by the original PID1 so its udev child can actually be joined.
[ -z "${K2_UDEV_PID:-}" ] || panic
SYSTEMD_LOG_LEVEL=notice /usr/lib/systemd/systemd-udevd --resolve-names=never &
K2_UDEV_PID=$!
udevadm trigger --type=subsystems --action=add || panic
udevadm trigger --type=devices --action=add || panic
udevadm settle || panic
'''
    outputs["/scripts/init-bottom/udev"] = b'''case "${K2_UDEV_PID:-}" in ''|*[!0-9]*) panic;; esac
[ "$K2_UDEV_PID" -gt 1 ] || panic
udevadm control --exit || panic
wait "$K2_UDEV_PID" || panic
unset K2_UDEV_PID
mount -n -o move /dev "${rootmnt:?}/dev" || mount -n --move /dev "${rootmnt}/dev" || panic
rm -rf /dev || panic
ln -s "${rootmnt}/dev" /dev || panic
'''
    for name, node in entries.items():
        if re.fullmatch(r"/scripts/[A-Za-z0-9._-]+/ORDER", name):
            C.require(stat.S_ISREG(node["mode"]), "regular ORDER required")
            lines = []
            for line in node["data"].decode().splitlines():
                if not line or line == '[ -e /conf/param.conf ] && . /conf/param.conf':
                    continue
                C.require(re.fullmatch(r'/scripts/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+ "\$@"', line), "unreviewed ORDER grammar")
                if line.split()[0] in ("/scripts/init-top/udev", "/scripts/init-bottom/udev"):
                    line = ". " + line.split()[0]
                lines.append(line + " || panic")
            outputs[name] = ("\n".join(lines) + "\n" if lines else ":\n").encode()
    return outputs


def render(base_initrd, initrd_inputs, cold_init, system_root, systemd_label, output):
    plan = C.lane()
    original = C.read(base_initrd, 128 * 1024 * 1024, plan["baseInitrd"])
    entries = C.unpack(original)
    for name, expected in plan["initrdInputs"].items():
        resolved = C.resolve(name, {k: v["data"].decode() for k, v in entries.items() if stat.S_ISLNK(v["mode"])})
        node = entries.get(resolved)
        C.require(resolved == expected["actualPath"] and node and stat.S_ISREG(node["mode"])
                  and C.pin(node["data"]) == {k: expected[k] for k in ("bytes", "sha256")}, "base initrd member differs")
        actual, links = C.actual(initrd_inputs, name)
        C.require(actual == expected["actualPath"] and links == expected["links"], "independent initrd aliases differ")
        C.read(initrd_inputs / actual[1:], 32 * 1024 * 1024, expected)
    elf = C.read(cold_init, 128 * 1024 * 1024)
    C.static_elf(elf)
    plan["coldInit"].update(C.pin(elf))
    plan["systemd"]["label"] = systemd_label
    for item in [plan["kernel"], plan["bootState"]["kernelConfiguration"], plan["systemd"]] + plan["systemdDependencies"]:
        name = item.get("lookupPath", item["path"])
        actual, links = C.actual(system_root, name)
        C.require(actual == item["path"], "rootfs actual cold path differs")
        for key, target in links.items():
            C.require(key not in plan["linkPlan"] or plan["linkPlan"][key] == target, "ambiguous rootfs alias")
            plan["linkPlan"][key] = target
        C.read(system_root / actual[1:], 128 * 1024 * 1024, item)
    scripts = harden(entries, plan)
    plan["bootState"]["scriptOutputs"] = {name: C.pin(raw) for name, raw in scripts.items()}
    plan["generators"] = C.generators()
    raw = C.encoded(plan)
    C.validate(raw)
    C.require(output.is_absolute(), "new absolute output required")
    output.mkdir(mode=0o700, exist_ok=False)
    C.save(output, "cold-bootstrap.json", raw)
    for name, content in scripts.items():
        C.save(output, "overlay" + name, content, 0o500 if name == "/init" else 0o400)
    C.save(output, "k2-cold-init", elf, 0o500)
    C.save(output, "rootfs/etc/qwen-k2/cold-systemd/units/qwen-k2-cold.target", C.TARGET)
    C.save(output, "rootfs/etc/systemd/system.conf", C.MANAGER)
    C.save(output, "candidate.json", C.encoded({"format": "qwen-k2-cold-candidate/1", "coldBootstrapSha256": C.sha(raw), "nativeAcceptance": "NOT_RUN"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base-initrd", "initrd-inputs", "cold-init", "system-root", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--systemd-label", required=True)
    args = parser.parse_args()
    try:
        render(args.base_initrd, args.initrd_inputs, args.cold_init, args.system_root, args.systemd_label, args.output)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, IndexError) as failure:
        parser.exit(1, "Cold candidate refused: " + str(failure) + "\n")


if __name__ == "__main__":
    main()
