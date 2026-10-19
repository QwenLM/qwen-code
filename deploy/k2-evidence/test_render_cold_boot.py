"""Software fixtures change only test-copy lane pins; no fixture ELF executes."""

import importlib.util
import os
import signal
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import unittest

import cold_boot as C


INIT = b'''#!/bin/sh
mount -t proc proc /proc
# shellcheck disable=SC2013
for x in $(cat /proc/cmdline); do :; done
if [ "$quiet" != "y" ]; then quiet=n; fi
. /scripts/functions
# Parse command line options
init=/bin/sh
# Default to BOOT=local if no boot script defined.
run_scripts /scripts/init-top
run_scripts /scripts/init-bottom
validate_init() { :; }
# don't leak too much of env
mount -n -o move /proc /root/proc
# Chain to real filesystem
exec /bin/sh
'''
FUNCTIONS = b'''panic()
{
 /bin/sh -i
 reboot -f
}
maybe_break() { panic; }
run_scripts() { . "$1/ORDER"; }
# Load custom modules first
load_modules() {
 /sbin/modprobe $m
}
'''


def inert_static_elf():
    raw = bytearray(120)
    raw[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", raw, 18, 62)
    struct.pack_into("<Q", raw, 32, 64)
    struct.pack_into("<H", raw, 54, 56)
    struct.pack_into("<H", raw, 56, 1)
    struct.pack_into("<I", raw, 64, 1)
    return bytes(raw)


class ColdFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="k2-cold-byte-fixture-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.tools = self.repo / "deploy/k2-evidence"
        self.tools.mkdir(parents=True)
        for name in ("render-cold-boot.py", "package-cold-initrd.py", "cold_boot.py", "compile-profiles.py", "render-profiles.py", "render-pre-exec.py", "image-catalog.py"):
            shutil.copyfile(C.HERE / name, self.tools / name)
        self.lane_path = self.repo / "packages/k2-node-evidence/internal/artifactset/cold-lane.json"
        self.lane_path.parent.mkdir(parents=True)
        self.plan = C.lane()
        self.tree, self.system = self.root / "initrd-inputs", self.root / "system-root"
        self.tree.mkdir(); self.system.mkdir()
        entries = {}
        for name, item in self.plan["initrdInputs"].items():
            if name == "/init": raw = INIT
            elif name == "/scripts/functions": raw = FUNCTIONS
            elif name.endswith("/ORDER"): raw = (name[:-5] + 'udev "$@"\n[ -e /conf/param.conf ] && . /conf/param.conf\n').encode() if "init-" in name else b'/scripts/local-bottom/check "$@"\n'
            elif name.startswith("/scripts/"): raw = b"inert original udev fixture\n"
            else: raw = inert_static_elf() + b"inert initrd helper data"
            # Aliases to the same actual file must retain identical bytes.
            actual = item["actualPath"]
            raw = entries.get(actual, {}).get("data", raw)
            entries[actual] = {"mode": stat.S_IFREG | 0o755, "data": raw}
            item.update(C.pin(raw))
            for link, target in item["links"].items():
                entries[link] = {"mode": stat.S_IFLNK | 0o777, "data": target.encode()}
        entries["/scripts/init-premount/ORDER"] = {"mode": stat.S_IFREG | 0o644, "data": b'/scripts/init-premount/check "$@"\n'}
        for name, node in sorted(entries.items(), key=lambda pair: pair[0].count("/")):
            path = self.tree / name[1:]
            path.parent.mkdir(parents=True, exist_ok=True)
            if stat.S_ISLNK(node["mode"]): path.symlink_to(node["data"].decode())
            else: path.write_bytes(node["data"])
        self.base = self.root / "base.img"
        self.base.write_bytes(C.cpio(entries))
        self.plan["baseInitrd"].update(C.pin(self.base.read_bytes()))
        root_files = [self.plan["kernel"], self.plan["bootState"]["kernelConfiguration"], self.plan["systemd"]] + self.plan["systemdDependencies"]
        for item in root_files:
            path = self.system / item["path"][1:]
            path.parent.mkdir(parents=True, exist_ok=True)
            raw = inert_static_elf() + item["path"].encode()
            if path.exists(): raw = path.read_bytes()
            else: path.write_bytes(raw)
            item.update(C.pin(raw))
        links = {"/lib": "usr/lib", "/lib64": "usr/lib64", "/usr/lib64/ld-linux-x86-64.so.2": "../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"}
        for item in self.plan["systemdDependencies"]:
            name = item["lookupPath"]
            if name.startswith("/lib/"): name = "/usr" + name
            if name != item["path"] and not name.startswith("/lib64/"): links[name] = Path(item["path"]).name
        for name, target in sorted(links.items(), key=lambda pair: pair[0].count("/")):
            path = self.system / name[1:]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target)
        self.lane_path.write_bytes(C.encoded(self.plan))
        self.loader = self.root / "inert-cold-init"
        self.loader.write_bytes(inert_static_elf())
        self.output = self.root / "candidate"

    def cli(self, script, args, success=True):
        env = {"PATH": "/usr/bin:/bin", "LANG": "C", "HOME": str(self.root), "TMPDIR": str(self.root),
               "PYTHONPYCACHEPREFIX": str(self.root / "pycache")}
        result = subprocess.run([sys.executable, str(self.tools / script)] + args, env=env, cwd=self.root,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(result.returncode == 0, success, (result.stdout + result.stderr).decode())
        return result

    def render(self, success=True):
        return self.cli("render-cold-boot.py", ["--base-initrd", str(self.base), "--initrd-inputs", str(self.tree),
            "--cold-init", str(self.loader), "--system-root", str(self.system), "--systemd-label", "host-systemd", "--output", str(self.output)], success)


class RenderColdBootTest(ColdFixture):
    def test_real_cli_consumes_known_entry_and_closes_fallbacks(self):
        self.render()
        plan = C.loads((self.output / "cold-bootstrap.json").read_bytes())
        self.assertEqual(13, len(plan)); self.assertEqual(15, len(plan["initrdInputs"]))
        self.assertEqual(24, len(plan["systemdDependencies"]))
        text = (self.output / "overlay/init").read_text()
        self.assertIn("exec /usr/bin/env -i LANG=C /usr/bin/run-init /root /opt/qwen-k2/bin/k2-cold-init", text)
        self.assertNotIn("exec /bin/sh", text)
        self.assertNotIn("init=/bin/sh", text)
        self.assertIn("panic()", text[:text.index("mount -t proc")])
        functions = (self.output / "overlay/scripts/functions").read_text()
        self.assertNotIn("sh -i", functions); self.assertNotIn("reboot -f", functions)
        top = (self.output / "overlay/scripts/init-top/ORDER").read_text()
        self.assertIn(". /scripts/init-top/udev || panic", top)
        bottom = (self.output / "overlay/scripts/init-bottom/udev").read_text()
        self.assertLess(bottom.index("wait"), bottom.index("mount -n"))
        for name in plan["bootState"]["scriptOutputs"]:
            path = self.output / ("overlay" + name)
            self.assertEqual(C.pin(path.read_bytes()), plan["bootState"]["scriptOutputs"][name])
            subprocess.run(["/bin/sh", "-n", str(path)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.render(False)

    def test_changed_base_or_dynamic_loader_refuses_before_output(self):
        original = self.base.read_bytes(); self.base.write_bytes(original + b"changed")
        self.render(False); self.assertFalse(self.output.exists())
        self.base.write_bytes(original)
        raw = bytearray(inert_static_elf()); struct.pack_into("<I", raw, 64, 3)
        self.loader.write_bytes(raw)
        self.render(False); self.assertFalse(self.output.exists())

    def test_alias_target_or_independent_extraction_mismatch_refuses(self):
        path = self.tree / "init"; path.write_bytes(path.read_bytes() + b"changed")
        self.render(False); self.assertFalse(self.output.exists())

    def run_owned_shell(self, text):
        script = self.root / "owned-non-pid1-harness.sh"
        script.write_text(text)
        child = subprocess.Popen(["/bin/sh", str(script)], start_new_session=True, cwd=self.root,
                                 env={"PATH": "/usr/bin:/bin", "HOME": str(self.root), "TMPDIR": str(self.root)},
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            output = child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            output = child.communicate(timeout=3)
            self.fail("owned shell timed out: " + repr(output))
        return child.returncode, output

    def test_generated_order_stops_on_an_early_failure_before_a_later_success(self):
        self.render()
        order = self.root / "scripts/init-premount"
        order.mkdir(parents=True)
        early, later = self.root / "early", self.root / "later"
        early.write_text("#!/bin/sh\nexit 17\n"); early.chmod(0o700)
        later.write_text("#!/bin/sh\n: > later-ran\n"); later.chmod(0o700)
        generated = (self.output / "overlay/scripts/init-premount/ORDER").read_text()
        self.assertEqual(1, generated.count('/scripts/init-premount/check "$@" || panic'))
        # Only inert fixture paths are relocated; the generated failure guards
        # and actual run_scripts implementation execute unchanged.
        (order / "ORDER").write_text(generated.replace('/scripts/init-premount/check', str(early))
                                    + str(later) + ' "$@" || panic\n')
        status, output = self.run_owned_shell('. "' + str(self.output / "overlay/scripts/functions")
            + '"\nrun_scripts "' + str(order) + '"\n: > after-order\n')
        self.assertEqual(1, status, output)
        self.assertIn(b"K2 cold boot stopped", output[1])
        self.assertFalse((self.root / "later-ran").exists())
        self.assertFalse((self.root / "after-order").exists())

    def test_generated_udev_exit_request_joins_its_actual_owned_child(self):
        self.render()
        helper = self.root / "inert-udevd.sh"
        helper.write_text('#!/bin/sh\nwhile [ ! -f stop-child ]; do sleep 0.01; done\nsleep 0.05\n: > joined-child\n')
        top = (self.output / "overlay/scripts/init-top/udev").read_text()
        self.assertEqual(1, top.count('/usr/lib/systemd/systemd-udevd'))
        top = top.replace('/usr/lib/systemd/systemd-udevd', '/bin/sh "' + str(helper) + '"')
        bottom = (self.output / "overlay/scripts/init-bottom/udev").read_text()
        text = '. "' + str(self.output / "overlay/scripts/functions") + '"\n'
        text += 'rootmnt=/inert-root\n'
        text += 'udevadm() { if [ "$1" = control ]; then : > stop-child; fi; }\n'
        text += 'mount() { [ -f joined-child ] || return 1; : > after-join; }\nrm() { :; }\nln() { :; }\n'
        text += top + bottom + '[ -z "${K2_UDEV_PID:-}" ]\n'
        status, output = self.run_owned_shell(text)
        self.assertEqual(0, status, output)
        self.assertTrue((self.root / "joined-child").exists())
        self.assertTrue((self.root / "after-join").exists())

    def test_closed_contract_rejects_helper_zero_write_and_optional_fields(self):
        self.render()
        spec = importlib.util.spec_from_file_location("private_fixture_cold", self.tools / "cold_boot.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        plan = module.validate((self.output / "cold-bootstrap.json").read_bytes())
        plan["bootState"]["helpers"]["/proc/sys/kernel/modprobe"] = ""
        with self.assertRaises(ValueError): module.validate(C.encoded(plan))
        plan = module.loads((self.output / "cold-bootstrap.json").read_bytes()); plan["qualified"] = True
        with self.assertRaises(ValueError): module.validate(C.encoded(plan))


if __name__ == "__main__": unittest.main()
