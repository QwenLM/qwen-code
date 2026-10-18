import hashlib
import importlib.util
import json
from pathlib import Path
import runpy
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from test_image_catalog import image, inert_elf


spec = importlib.util.spec_from_file_location("render_profiles", Path(__file__).with_name("render-profiles.py"))
POLICY = importlib.util.module_from_spec(spec)
spec.loader.exec_module(POLICY)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class RenderProfilesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="k2-offline-profiles-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.binaries = [self.root / name for name in ("source", "shim", "runc")]
        for path in self.binaries:
            path.write_bytes(inert_elf() + path.name.encode())
        self.contract = self.root / "contract.json"
        contract = json.loads((Path(__file__).parents[2] / "packages/managed-agent-server/src/test/resources/contracts/k2-creation-contract-v1.fixture.json").read_bytes())
        contract["worker"]["args"] += ["managed-runtime-worker", "--container-boot", "/var/run/qwen-runtime/boot.json"]
        self.contract.write_bytes(POLICY.encoded(contract))
        self.worker, self.sandbox = self.root / "worker", self.root / "sandbox"
        self.worker_sha = image(self.worker, [[("usr", {}), ("usr/local", {}), ("usr/local/bin", {}),
                                              ("usr/local/bin/node", inert_elf()), ("worker.mjs", b"inert JavaScript data"),
                                              ("other-elf", inert_elf())]])
        self.sandbox_sha = image(self.sandbox, [[("pause", inert_elf())]])
        self.candidate, self.output = self.root / "candidate", self.root / "profiles"
        self.prepare_candidate()
        hosts = {name: {"path": "/usr/bin/" + name, "sha256": str(index) * 64, "label": "host-" + name}
                 for index, name in enumerate(("runtime", "kubelet", "registrar", "plugin", "systemd"), 1)}
        self.target = {
            "format": "qwen-k2-profile-target/2", "architecture": "amd64", "hostExecutables": hosts,
            "snapshotRoot": "/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots",
            "podSlicePrefix": "/sys/fs/cgroup/kubepods.slice/kubepods-pod",
            "apparmorExportRoot": "/qwen-k2-disconnected/source/apparmorfs",
            "volumeSerialPath": "/sys/devices/pci0000:00/block/vdb/serial",
            "systemBus": {"socket": "/run/dbus/system_bus_socket", "privateSocket": "/run/systemd/private", "label": "host-dbus"},
            "roleConfigPaths": {"source": "/etc/qwen-k2/actual-source.json", "gateway": "/etc/qwen-k2/actual-gateway.json"},
            "sandboxNetworkNamespaceSource": "/run/netns/cni-${SANDBOX_ID}",
            "rootfsMounts": {role: [{"type": "overlay", "source": "overlay", "options": ["rw", "lowerdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/1/fs"]}] for role in ("worker", "sandbox")},
            "oldRootPath": "/qwen-k2-disconnected/shim/oldroot",
            "hugepageSizes": ["2MB", "1GB"],
        }
        self.source = {
            "listen": "127.0.0.1:9443", "certificate": "/etc/qwen-k2/s-cert", "key": "/etc/qwen-k2/s-key", "authority": "/etc/qwen-k2/ca",
            "coordinatorPrincipal": "spiffe://k2/coordinator", "nodeUid": "owned-inert-node", "driver": "test.csi.example",
            "journalRoot": "/var/lib/qwen-k2/journal", "pluginSocket": "/run/qwen-k2/backend/actual-plugin.sock", "pluginDigest": hosts["plugin"]["sha256"],
            "frontendSocket": "/run/qwen-k2/source/actual-frontend.sock", "kubeletDigest": hosts["kubelet"]["sha256"], "registrarDigest": hosts["registrar"]["sha256"],
            "gatewayUrl": "https://127.0.0.1:9444", "gatewayPrincipal": "spiffe://k2/gateway", "runtimeDigest": hosts["runtime"]["sha256"],
            "gatewayClientCertificate": "/etc/qwen-k2/s-client-cert", "gatewayClientKey": "/etc/qwen-k2/s-client-key",
            "workerPolicySha256": "9" * 64, "sandboxImageSha256": self.sandbox_sha,
        }
        self.gateway = {"listen": "127.0.0.1:9444", "certificate": "/etc/qwen-k2/g-cert", "key": "/etc/qwen-k2/g-key", "authority": "/etc/qwen-k2/ca",
                        "coordinatorPrincipal": "spiffe://k2/coordinator", "sourcePrincipal": "spiffe://k2/source", "runtimeSocket": "/run/containerd/containerd.sock", "runtimeDigest": hosts["runtime"]["sha256"]}
        self.runtime = {"command": ["/usr/local/bin/node", "/worker.mjs"], "image": "registry.example/inert@sha256:" + self.worker_sha,
                        "registration": {"mountRoot": "/workspace"}}
        self.inputs = {name: self.root / (name + ".json") for name in ("target", "runtime", "source-config", "gateway-config")}
        self.host_policy = self.root / "host-policy"
        self.host_policy.mkdir()
        for name in POLICY.HOST_FILES:
            (self.host_policy / name).write_bytes(b'  "/explicit-inert-base-only" r,\n  deny "/explicit-inert-deny" w,\n')
        self.write_host_manifest()

    def write_host_manifest(self):
        manifest = {"format": "qwen-k2-host-policies/1", "files": {name: {"bytes": len((self.host_policy / name).read_bytes()), "sha256": digest(self.host_policy / name)} for name in POLICY.HOST_FILES}}
        (self.host_policy / "host-policies.json").write_bytes(POLICY.encoded(manifest))

    def prepare_candidate(self):
        POLICY.PRE.render(*self.binaries, self.worker, self.worker_sha, self.sandbox, self.sandbox_sha, self.contract, self.candidate)

    def write_inputs(self):
        for name, value in (("target", self.target), ("runtime", self.runtime), ("source-config", self.source), ("gateway-config", self.gateway)):
            self.inputs[name].write_bytes(POLICY.encoded(value))

    def render(self):
        self.write_inputs()
        args = [self.candidate, digest(self.candidate / "artifact-manifest.json")]
        for name in ("target", "runtime", "source-config", "gateway-config"):
            args += [self.inputs[name], digest(self.inputs[name])]
        POLICY.render(*args, self.worker, self.sandbox, self.host_policy, digest(self.host_policy / "host-policies.json"), self.output)

    def role(self, name):
        text = (self.output / "qwen-k2-profiles").read_text()
        return text.split("profile qwen-k2-" + name + "-v1", 1)[1].split("\n}\n", 1)[0]

    def refuses(self, pattern):
        with self.assertRaisesRegex(ValueError, pattern):
            self.render()
        self.assertFalse(self.output.exists())

    def test_real_pipeline_pins_configs_units_and_all_five_roles(self):
        self.render()
        text = (self.output / "qwen-k2-profiles").read_text()
        self.assertEqual(11, sum(line.startswith("profile ") for line in text.splitlines()))
        manifest = json.loads((self.output / "profile-candidate.json").read_text())
        self.assertEqual(digest(self.candidate / "artifact-manifest.json"), manifest["artifactManifestSha256"])
        self.assertEqual(digest(self.candidate / "shim.json"), manifest["shimConfigurationSha256"])
        for name, pin in manifest["files"].items():
            path = self.output / name
            self.assertEqual({"bytes": len(path.read_bytes()), "sha256": digest(path)}, pin)
            self.assertEqual(0o400, path.stat().st_mode & 0o777)
        for role, filename in (("source", "qwen-k2-node-source.service"), ("gateway", "qwen-k2-runtime-gateway.service")):
            self.assertIn("ExecStart=/opt/qwen-k2/bin/k2-node-evidence " + role + " " + self.target["roleConfigPaths"][role] + "\n", (self.output / filename).read_text())
            self.assertIn('"' + self.target["roleConfigPaths"][role] + '" r,', self.role(role))
        self.assertIn('"/etc/qwen-k2/s-client-key" r,', self.role("source"))
        self.assertNotIn("s-client-key", self.role("gateway"))
        self.assertNotIn("g-key", self.role("source"))
        self.assertIn(self.source["pluginSocket"], self.role("source"))
        self.assertIn(self.source["frontendSocket"], self.role("source"))
        self.assertNotIn("containerd.sock", self.role("source"))
        self.assertNotIn("/var/lib/qwen-k2", self.role("gateway"))
        self.assertEqual(self.source, json.loads((self.output / "source-config.json").read_bytes()))
        self.assertTrue(any("not parser" in item for item in manifest["boundaries"]))

    def test_complete_host_bases_and_owned_reciprocal_permissions(self):
        self.render()
        text = (self.output / "qwen-k2-profiles").read_text()
        for role, host in self.target["hostExecutables"].items():
            header = 'profile "' + host["label"] + '" "' + host["path"] + '" flags=(enforce,mediate_deleted) {'
            body = text.split(header + "\n", 1)[1].split("\n}\n", 1)[0]
            self.assertTrue(body.startswith((self.host_policy / ("host-" + role + ".rules")).read_text()))
            self.assertIn('deny "/explicit-inert-deny" w,', body)
        self.assertIn('mrPx -> qwen-k2-shim-v1,', text)
        for name in POLICY.HOST_FILES | {"host-policies.json"}:
            self.assertEqual((self.host_policy / name).read_bytes(), (self.output / name).read_bytes())
            for role in ("source", "gateway"):
                self.assertIn(name, self.role(role))
        self.assertIn('dbus receive bus=system', text.split('profile "host-dbus"', 1)[1])

    def test_pathname_sockets_use_literal_file_leaves_without_unix_addr(self):
        self.render()
        text = (self.output / "qwen-k2-profiles").read_text()
        self.assertNotIn('addr="/', text)
        for label, path in (("host-runtime", self.gateway["runtimeSocket"]), ("host-plugin", self.source["pluginSocket"]),
                            ("host-systemd", self.target["systemBus"]["privateSocket"]), ("host-dbus", self.target["systemBus"]["socket"])):
            body = text.split('profile "' + label + '"', 1)[1].split("\n}\n", 1)[0]
            self.assertIn(POLICY.file_literal(path) + " rw,", body)
        manifest = json.loads((self.output / "profile-candidate.json").read_bytes())
        self.assertTrue(any("not pathname peer enforcement" in item for item in manifest["boundaries"]))

    def test_distinct_bus_label_cannot_create_implicit_exec_attachment(self):
        self.target["systemBus"]["label"] = "/usr/bin/other-daemon"
        self.refuses("distinct bus label cannot imply")
        self.target["hostExecutables"]["systemd"]["label"] = "/usr/bin/explicit-host-label"
        self.target["systemBus"]["label"] = "/usr/bin/explicit-host-label"
        self.render()
        text = (self.output / "qwen-k2-profiles").read_text()
        self.assertEqual(1, text.count('profile "/usr/bin/explicit-host-label" "/usr/bin/systemd"'))
        self.assertEqual(10, sum(line.startswith("profile ") for line in text.splitlines()))

    def test_bus_shared_host_label_requires_identical_complete_base(self):
        self.target["systemBus"]["label"] = self.target["hostExecutables"]["systemd"]["label"]
        self.render()
        text = (self.output / "qwen-k2-profiles").read_text()
        self.assertEqual(10, sum(line.startswith("profile ") for line in text.splitlines()))
        body = text.split('profile "host-systemd"', 1)[1]
        self.assertIn('change_profile -> qwen-k2-source-v1,', body)
        self.assertIn('dbus receive bus=system', body)

    def test_shared_label_with_different_base_refuses(self):
        self.target["systemBus"]["label"] = self.target["hostExecutables"]["systemd"]["label"]
        (self.host_policy / "host-system-bus.rules").write_bytes(b'  "/different-base" r,\n')
        self.write_host_manifest()
        self.refuses("identical complete bases")

    def test_changed_or_missing_host_base_refuses_without_output(self):
        path = self.host_policy / "host-runtime.rules"
        path.write_bytes(path.read_bytes() + b'  "/changed" r,\n')
        self.refuses("complete host base bytes differ")
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.render()
        self.assertFalse(self.output.exists())

    def test_fixed_host_manifest_rejects_extra_or_caller_paths(self):
        path = self.host_policy / "host-policies.json"
        value = json.loads(path.read_bytes())
        value["files"]["../host-runtime.rules"] = value["files"].pop("host-runtime.rules")
        path.write_bytes(POLICY.encoded(value))
        self.refuses("complete fixed host policy")

    def test_flat_base_accepts_quoted_escaped_aare_and_preserves_denials(self):
        raw = b'  "/var/lib/{one,two}/\\{literal\\}\\\"quote" rw,\n  deny "/bin/{a,b}" x,\n  "/bin/helper" mrix,\n  mount options=(bind) "/a/{b,c}" -> "/d/",\n'
        self.assertEqual(raw, POLICY.host_body(raw))

    def test_flat_base_refuses_structural_ambient_and_transition_inputs(self):
        bad = [b'  } profile injected { "/a" r,\n', b'  profile nested {\n', b'  #include <abstractions/base>\n',
               b'  include "/tmp/rules",\n', b'  abi <abi/4.0>,\n', b'  alias /a -> /b,\n',
               b'  "@{HOME}/a" r,\n', b'  audit { "/a" r,\n', b'  ^hat {\n', b'  change_profile -> unconfined,\n',
               b'  pivot_root "/new" -> unconfined,\n', b'  "/bin/a" ux,\n', b'  "/bin/a" Ux,\n',
               b'  "/bin/a" pix,\n', b'  "/bin/a" PUx,\n', b'  "/bin/a" cx,\n', b'  "/bin/a" Px -> unconfined,\n',
               b'  file,\n', b'  all,\n', b'  "/unterminated r,\n', b'  /unquoted/{a,b} r,\n', b'  "/a" r,\\\n', b'  "/a" r,\r\n',
               b'  network, "/bin/a" ux,\n', b'  unix (send), change_profile -> unconfined,\n',
               b'  capability sys_admin, "/bin/a" px,\n', b'  deny "/bin/a" ix,\n', b'  unix (send)),\n']
        for raw in bad:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    POLICY.host_body(raw)

    def test_host_labels_cannot_name_namespaces_or_subprofiles(self):
        for label in (":child://host", "host//child", "host/", ".host", "unconfined", "qwen-k2-source-v1"):
            with self.subTest(label=label):
                self.assertFalse(POLICY.host_label(label))

    def test_actual_changed_config_paths_change_only_owned_rules_and_unit(self):
        self.target["roleConfigPaths"]["source"] = "/etc/qwen-k2/renamed-source.json"
        self.source["key"] = "/etc/qwen-k2/renamed-source-key"
        self.render()
        self.assertIn('"/etc/qwen-k2/renamed-source-key" r,', self.role("source"))
        self.assertNotIn("renamed-source", self.role("gateway"))
        self.assertIn("source /etc/qwen-k2/renamed-source.json\n", (self.output / "qwen-k2-node-source.service").read_text())

    def test_entry_only_execution_and_bidirectional_birth_read(self):
        self.render()
        for role in ("worker", "sandbox"):
            self.assertIn("ptrace (readby) peer=qwen-k2-source-v1,", self.role(role))
            self.assertNotIn("change_profile", self.role(role))
            self.assertNotIn("attr/", self.role(role))
            self.assertNotIn("/etc/qwen-k2", self.role(role))
        worker = self.role("worker")
        self.assertIn('"/usr/local/bin/node" mrix,', worker)
        self.assertIn('"/other-elf" mr,', worker)
        self.assertNotIn('"/other-elf" mrix,', worker)
        self.assertIn("ptrace (readby) peer=qwen-k2-shim-v1,", self.role("source"))
        self.assertIn("ptrace (read) peer=qwen-k2-source-v1,", self.role("shim"))
        self.assertIn("ptrace (read,readby) peer=qwen-k2-shim-v1,", self.role("shim"))

    def test_policy_export_leaves_and_bundle_domains_are_complete(self):
        self.render()
        source, shim = self.role("source"), self.role("shim")
        for leaf in ("hash_policy", "export_binary", ".ns_level", ".ns_name", ".stacked", ".ns_stacked", "raw_data,abi,revision,sha256", "/uid_map", "/root/"):
            self.assertIn(leaf, source)
        for leaf in ("/s\" rw,", "/{config.json,address}\" r,", "log.json,.init.pid,init.pid", "type=seqpacket", "oom_score_adj"):
            self.assertIn(leaf, shim)
        for leaf in ("state-*", "memory.peak", "memory.swap.current", "rdma.current", "hugetlb.2MB.{max,current,events}", "/sys/fs/cgroup/cgroup.controllers"):
            self.assertIn(leaf, shim)
            self.assertNotIn(leaf, source)
        self.assertNotIn("shim.pid", shim)
        self.assertNotIn("/inputs/**", shim)
        self.assertNotIn("cgroup.subtree_control}\" rw", shim)

    def test_cross_role_private_key_alias_refuses(self):
        self.source["authority"] = self.gateway["key"]
        self.refuses("private keys cannot alias")

    def test_shared_private_key_refuses(self):
        self.gateway["key"] = self.source["key"]
        self.refuses("private keys cannot alias")

    def test_tls_file_cannot_alias_a_configuration(self):
        self.source["certificate"] = self.target["roleConfigPaths"]["source"]
        self.refuses("TLS inputs cannot alias")

    def test_malformed_ipv6_and_bracketed_ipv4_listeners_refuse(self):
        for listener in ("::1:9443", "[127.0.0.1]:9443", "[127.0.0.1:9443", "127.0.0.1:09443"):
            self.source["listen"] = listener
            self.refuses("canonical Go IP listener")

    def test_writable_and_pattern_config_paths_refuse(self):
        self.source["key"] = "/var/lib/qwen-k2/journal/secret"
        self.refuses("protected configuration directory")
        self.source["key"] = "/etc/qwen-k2/*"
        self.refuses("literal canonical")

    def test_unknown_config_and_permission_inputs_refuse(self):
        self.source["rules"] = ["/** rwix,"]
        self.refuses("complete closed source/gateway")
        del self.source["rules"]
        self.target["rules"] = ["mount,"]
        self.refuses("complete closed profile target")

    def test_peer_digest_or_unconfined_label_refuses(self):
        self.source["kubeletDigest"] = "a" * 64
        self.refuses("executable digests differ")
        self.source["kubeletDigest"] = self.target["hostExecutables"]["kubelet"]["sha256"]
        self.target["hostExecutables"]["runtime"]["label"] = "unconfined"
        self.refuses("confined root host labels")

    def test_host_executable_path_cannot_grant_another_roles_key(self):
        for peer, path in (("plugin", self.gateway["key"]), ("runtime", self.source["key"]),
                           ("runtime", "/var/lib/qwen-k2/journal/original.journal"), ("plugin", "/proc/1/mem")):
            with self.subTest(peer=peer):
                self.output = self.root / (peer + "-alias-output")
                original = self.target["hostExecutables"][peer]["path"]
                self.target["hostExecutables"][peer]["path"] = path
                self.refuses("host executable paths cannot alias role inputs")
                self.target["hostExecutables"][peer]["path"] = original

    def test_full_command_image_and_writable_image_overlap_refuse(self):
        self.runtime["command"] += ["extra"]
        self.refuses("creation commands differ")
        self.runtime["command"].pop()
        self.runtime["image"] = "registry.example/other@sha256:" + "0" * 64
        self.refuses("worker image differs")
        self.runtime["image"] = "registry.example/inert@sha256:" + self.worker_sha
        self.runtime["registration"]["mountRoot"] = "/usr/local"
        self.refuses("protected root")

    def test_catalogue_changes_cannot_be_repaired_by_new_manifest_hash(self):
        path = self.candidate / "worker-catalog.json"
        value = json.loads(path.read_bytes())
        value["entry"] = "/other-elf"
        path.chmod(0o600)
        path.write_bytes(POLICY.encoded(value))
        manifest_path = self.candidate / "artifact-manifest.json"
        manifest = json.loads(manifest_path.read_bytes())
        manifest["catalogues"][path.name] = {"sha256": digest(path), "bytes": len(path.read_bytes())}
        manifest_path.chmod(0o600)
        manifest_path.write_bytes(POLICY.encoded(manifest))
        self.refuses("original image catalogue differs")

    def test_changed_shim_lane_refuses(self):
        path = self.candidate / "shim.json"
        value = json.loads(path.read_bytes())
        value["containerdGrpc"] = "/run/other.sock"
        path.chmod(0o600)
        path.write_bytes(POLICY.encoded(value))
        self.refuses("shim configuration differs")

    def test_dns_gateway_and_unknown_namespace_templates_refuse(self):
        self.source["gatewayUrl"] = "https://gateway.example:9444"
        self.refuses("address")
        self.source["gatewayUrl"] = "https://127.0.0.1:9444"
        self.target["sandboxNetworkNamespaceSource"] = "/run/netns/*"
        self.refuses("identity network namespace")

    def test_cni_uuid_template_is_a_fixed_component_pattern(self):
        self.target["sandboxNetworkNamespaceSource"] = "/run/netns/cni-${NETWORK_NAMESPACE_ID}"
        self.render()
        self.assertIn('/run/netns/cni-' + POLICY.UUID, self.role("source"))

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        marker = self.output / "keep"
        marker.write_bytes(b"original")
        with self.assertRaises(FileExistsError):
            self.render()
        self.assertEqual([marker], list(self.output.iterdir()))
        self.assertEqual(b"original", marker.read_bytes())

    def test_full_mount_data_stays_pinned_and_rules_keep_supported_conditions(self):
        contract = json.loads(self.contract.read_bytes())
        contract["worker"]["mounts"] = [{"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["nosuid", "nodev", "noexec", "size=64m", "mode=1777"]}]
        self.contract.write_bytes(POLICY.encoded(contract))
        self.candidate = self.root / "mounted-candidate"
        self.prepare_candidate()
        self.render()
        self.assertEqual(self.contract.read_bytes(), (self.output / "creation-contract.json").read_bytes())
        self.assertIn('mount fstype=tmpfs options=(nosuid,nodev,noexec) "shm" -> ', self.role("shim"))
        self.assertNotIn("data=", self.role("shim"))
        self.assertTrue(any("LSM rules do not compare" in item for item in json.loads((self.output / "profile-candidate.json").read_bytes())["boundaries"]))

    def test_unknown_mount_data_refuses(self):
        contract = json.loads(self.contract.read_bytes())
        contract["worker"]["mounts"] = [{"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["nosuid", "unsupported=1"]}]
        self.contract.write_bytes(POLICY.encoded(contract))
        self.candidate = self.root / "bad-mount-candidate"
        self.prepare_candidate()
        self.refuses("unsupported mount flag or data")

    def test_mount_stages_split_readonly_and_propagation(self):
        contract = json.loads(self.contract.read_bytes())
        contract["worker"]["mounts"] = [{"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["ro", "nosuid", "nodev", "rprivate", "size=64m"]}]
        contract["worker"]["readonlyPaths"] = ["/proc/bus"]
        contract["worker"]["maskedPaths"] = ["/proc/scsi", "/proc/keys"]
        self.contract.write_bytes(POLICY.encoded(contract))
        self.candidate = self.root / "staged-mount-candidate"
        self.prepare_candidate()
        self.render()
        shim = self.role("shim")
        self.assertIn('mount fstype=tmpfs options=(nosuid,nodev) "shm" -> ', shim)
        self.assertIn('mount options=(rprivate) -> "' + POLICY.INPUT + '/rootfs/dev/shm{,/}",', shim)
        self.assertIn('mount options=(bind,nodev,nosuid,remount,ro) -> "/dev/shm{,/}",', shim)
        self.assertIn('mount options=(bind,nodev,noexec,nosuid,remount,ro) "/proc/bus" -> "/proc/bus{,/}",', shim)
        self.assertIn('mount options=(bind) "/proc/scsi" -> "/proc/keys{,/}",', shim)
        self.assertIn('mount options=(rslave) -> "/",', shim)
        self.assertIn('mount options=(rbind) "' + POLICY.INPUT + '/rootfs" -> "' + POLICY.INPUT + '/rootfs{,/}",', shim)
        self.assertNotIn("options=(ro,nosuid,nodev,rprivate)", shim)

    def test_outer_rootfs_is_required_and_independent_of_inner_mounts(self):
        self.target["rootfsMounts"]["worker"][0]["options"] = ["rw", "nodev", "lowerdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/2/fs"]
        self.render()
        self.assertIn('mount fstype=overlay options=(rw,nodev) "overlay" -> ', self.role("shim"))
        self.assertNotIn('mount fstype=overlay options=(ro,nosuid,nodev)', self.role("shim"))
        self.assertEqual(self.target["rootfsMounts"], json.loads((self.output / "target.json").read_bytes())["rootfsMounts"])

    def test_mount_and_boot_paths_follow_image_parent_symlinks(self):
        self.worker = self.root / "worker-with-var-run-alias"
        self.worker_sha = image(self.worker, [[("usr", {}), ("usr/local", {}), ("usr/local/bin", {}),
                                              ("usr/local/bin/node", inert_elf()), ("worker.mjs", b"inert data"),
                                              ("var", {}), ("run", {}), ("var/run", {"type": tarfile.SYMTYPE, "target": "/run"})]])
        self.runtime["image"] = "registry.example/inert@sha256:" + self.worker_sha
        contract = json.loads(self.contract.read_bytes())
        contract["worker"]["mounts"] = [{"destination": "/var/run/qwen-runtime/boot.json", "type": "bind", "source": "/var/lib/kubelet/pods/${POD_UID}/boot", "options": ["bind", "ro"]}]
        self.contract.write_bytes(POLICY.encoded(contract))
        self.candidate = self.root / "aliased-mount-candidate"
        self.prepare_candidate()
        self.render()
        self.assertIn('"/run/qwen-runtime/boot.json" r,', self.role("worker"))
        self.assertNotIn('"/var/run/qwen-runtime/boot.json" r,', self.role("worker"))
        self.assertIn('/rootfs/run/qwen-runtime/boot.json{,/}', self.role("shim"))
        self.assertNotIn('/rootfs/var/run/qwen-runtime/boot.json', self.role("shim"))
        self.assertEqual(self.contract.read_bytes(), (self.output / "creation-contract.json").read_bytes())

    def test_missing_outer_mounts_or_global_oldroot_refuses(self):
        self.target["rootfsMounts"]["worker"] = []
        self.refuses("single outer overlay")
        self.target["rootfsMounts"]["worker"] = self.target["rootfsMounts"]["sandbox"]
        self.target["oldRootPath"] = "/"
        self.refuses("canonical")

    def test_image_parent_alias_cannot_inject_a_mount_pattern(self):
        self.worker = self.root / "worker-with-pattern-name"
        self.worker_sha = image(self.worker, [[("usr", {}), ("usr/local", {}), ("usr/local/bin", {}),
                                              ("usr/local/bin/node", inert_elf()), ("worker.mjs", b"inert data"),
                                              ("var", {}), ("run[ab]", {}), ("var/run", {"type": tarfile.SYMTYPE, "target": "/run[ab]"})]])
        self.runtime["image"] = "registry.example/inert@sha256:" + self.worker_sha
        self.candidate = self.root / "pattern-alias-candidate"
        self.prepare_candidate()
        self.refuses("literal canonical")

    def test_unbounded_device_cgroup_grant_refuses(self):
        contract = json.loads(self.contract.read_bytes())
        contract["worker"]["deviceCgroupRules"] = [{"allow": True, "access": "rwm", "type": "a"}]
        self.contract.write_bytes(POLICY.encoded(contract))
        self.candidate = self.root / "bad-device-candidate"
        self.prepare_candidate()
        self.refuses("unbounded device grants")

    def test_relative_bind_source_refuses(self):
        contract = json.loads(self.contract.read_bytes())
        contract["worker"]["mounts"] = [{"destination": "/dev/shm", "type": "bind", "source": "../foreign", "options": ["bind"]}]
        self.contract.write_bytes(POLICY.encoded(contract))
        self.candidate = self.root / "bad-bind-candidate"
        self.prepare_candidate()
        self.refuses("bind sources must be absolute")

    def test_real_cli_consumes_all_required_inputs(self):
        self.write_inputs()
        argv = ["render-profiles.py", "--candidate", str(self.candidate), "--artifact-manifest-sha256", digest(self.candidate / "artifact-manifest.json")]
        for name, path in self.inputs.items():
            argv += ["--" + name, str(path), "--" + name + "-sha256", digest(path)]
        argv += ["--worker-layout", str(self.worker), "--sandbox-layout", str(self.sandbox), "--output", str(self.output)]
        argv += ["--host-policy", str(self.host_policy), "--host-policy-sha256", digest(self.host_policy / "host-policies.json")]
        with patch.object(sys, "argv", argv):
            runpy.run_path(str(Path(__file__).with_name("render-profiles.py")), run_name="__main__")
        self.assertTrue((self.output / "profile-candidate.json").is_file())


if __name__ == "__main__":
    unittest.main()
