# K2 installation and cold-bootstrap software

[English](2026-10-20-k2-installation-cold-bootstrap.md) | [简体中文](2026-10-20-k2-installation-cold-bootstrap.zh-CN.md)

## Status and problem

This is the fourth software slice of [#13526](https://github.com/QwenLM/qwen-code/pull/13526), extracted from `af312254483a350d5655a40c84591c9e5512aaa9`. The preceding node-evidence slice supplies strict installed-byte readers, the shared cold-lane contract, and controlled creation. Those readers deliberately grant no installation authority. This slice supplies the offline producers and the Linux PID1 implementation that consume that same contract. It is stacked on the node-evidence slice until that dependency reaches `main`.

Software validation is distinct from native acceptance. This change does not report a real installation, policy load or lock, reboot, accepted node, worker execution, physical release, or reuse. The endpoint is an empty systemd target, not a usable ACK node. Compiler provenance and the actual host policy set still require independent review and native qualification.

## Scope and components

| Component                            | Responsibility                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline inputs and policy generation | Bind reviewed executable/image/configuration bytes; generate the five Qwen and six distinct host profiles without ambient includes or hidden inputs.                                          |
| No-load compilation                  | Run the explicitly pinned parser with fixed features, empty configuration, no cache and no kernel load; retain failed attempts.                                                               |
| Artifact assembly                    | Validate the closed pre-exec, profile and compile graphs; publish a new read-only installation directory.                                                                                     |
| Cold candidate and packaging         | Harden the exact reviewed initramfs entry, bind the real loader ELF and systemd dependencies, and produce deterministic initrd/rootfs outputs and an external inventory.                      |
| Linux cold-init                      | Validate actual original PID1/thread/namespace and retained objects, close helper interfaces, reduce privilege, load/check/lock the policy, then execute real systemd on the original thread. |

The implementation areas are `deploy/k2-evidence`, `packages/k2-node-evidence/cmd/{k2-assemble-artifacts,k2-cold-init}`, and the cold loader helpers in `internal/{birth,coldboot}`. Shared artifact readers and the independent Java lane remain the preceding slice's protocols; extraction must not copy a second definition or weaken them. There is no new durable SQL, retirement coordinator, Pod deletion, history or reuse implementation.

## Closed graph and ordering

The shared protocol stays `pre-exec-artifacts/2`, `profile-target/3`, `profile-candidate/3`, `profile-compile/2`, `installed-artifacts/3` and `cold-bootstrap/1`. The profile candidate has exactly 16 pinned children. The installation has exactly 26 files, including its manifest and the mandatory cold-bootstrap leaf, with at most 64 MiB in aggregate. Existing limits remain: cold contract 64 KiB, packed policy 8 MiB, profiles/catalogues 16 MiB each, host bases 1 MiB each, and the existing smaller configuration limits.

The acyclic order is loader/templates → cold contract → target and profile candidate → no-load compilation → installation → final image and external inventory. Only the original source configuration's worker-policy digest token is replaced during assembly; all other original bytes remain bound. The final image digest does not appear in its own input graph. Python producers and Go/Java readers must accept the same supported graph and reject missing, extra, null, stale-version, changed-pin and unsupported-lane inputs.

Outputs are candidates. `nativeAcceptance: NOT_RUN` is evidence of that boundary, not a flag that can authorize installation. Fresh output directories and exclusive file creation prevent silent output reuse; the compiler, cold tools and assembler additionally require absolute output paths. The production PID1 entry has no alternative root, PID, kernel, relaxed mode or test environment switch.

## Fixed first lane and PID1 handoff

The only supported first boot lane is Ubuntu 24.04.5 amd64 with kernel `6.8.0-139-generic`. The checked chain is hardened `/init` → original `run-init` root switch → `/opt/qwen-k2/bin/k2-cold-init` as original PID1 → real `/usr/lib/systemd/systemd` → `qwen-k2-cold.target`. An arm64 cross-build is compilation evidence only.

Harden the exact reviewed script bytes and anchors, preserving required root mounting and filesystem moves. Remove rescue shells, alternative init, breakpoint/panic hooks, caller-selected arguments, environment and command-line selectors. Every reachable helper and ORDER invocation propagates failure. The trusted udev child is explicitly owned, requested to exit, joined and reaped. Unknown processes are refused; they are never killed to make the scan pass. Earlier helpers and Go runtime threads remain part of the boot TCB. A process snapshot cannot prove that queued usermode-helper work is empty.

Before policy loading, write and independently read back exactly `\n` for `/proc/sys/kernel/modprobe`, `/proc/sys/kernel/hotplug` and `/sys/kernel/uevent_helper`, `core\n` for `/proc/sys/kernel/core_pattern`, and `0\n` for `/proc/sys/fs/suid_dumpable`. A zero-byte or short write never counts as disablement. Close all those descriptors before the inheritance check. Set soft and hard RLIMIT_CORE to zero and permanently remove CAP_SYS_MODULE from permitted, effective, inheritable, ambient and bounding sets on the locked original thread. Independently verify all five sets immediately before exec.

The systemd profile unconditionally denies writes to those five interfaces and denies `sys_resource`, including when a host base broadly permits them. This prevents early systemd initialization from raising the inherited hard core limit or restoring helper settings. This slice does not additionally change module/kexec disable knobs or global usermode-helper capability masks.

Retain and revalidate actual immutable files, ancestors and identity, including the running loader, systemd, its 24 pinned dependencies, kernel and configuration. Check the initial namespaces, real proc/sysfs, expected ext4/mount state, loader ownership, and bounded process/task sets. Only the three exact console descriptors may survive exec; every other classified descriptor must be CLOEXEC. Unknown or writable inherited descriptors stop the boot. Pathname exec still depends on the validated boot TCB and absence of concurrent mutators.

Load the single complete packed bundle only into the reviewed unlocked empty AppArmor root namespace. Independently verify modes, exported raw bytes, hash, size, ABI/context/revision; lock and read back again. Set the original thread's next-exec label only after all checks, then exec on that thread. Every failure stops PID1; there is no alternative exec, retry or fallback. Destructive software tests use package-private fakes, never a production bypass.

## Empty systemd endpoint

The immutable cold-systemd tree contains only `units`. Both generator directories must be absent; an existing empty directory still permits systemd to create a generator child. The unit directory contains the fixed 85-byte target, `default.target` pointing to it, and `apparmor.service` pointing to `/dev/null`. No normal runtime, kubelet, CSI, source, gateway, bus or business service starts.

Cold-init enters with exactly `LANG=C`. Systemd receives the fixed argv and six fixed environment entries with replacement unit/generator paths and no trailing colon. Pin the 51-byte manager configuration, reject ambient manager drop-ins, initrd-release and IMA policy, require visible efivarfs and both SystemdOptions paths absent, and check the exact command line including credential import disablement. These guards do not replace native testing of actual Ubuntu systemd, dynamic lookup, hostname/machine-id, other LSMs, firmware inputs, pending helpers or the earlier boot TCB.

## Validation and acceptance

First attempt the baseline with the global `qwen` CLI. These private offline tools and the PID1 path are not reachable through an ordinary CLI invocation; record that limitation and use a software test-script fallback. Run the Python producer/packager tests, Go artifact assembly and sequence/failure tests, Linux package-private fake tests, and static Linux amd64/arm64 builds. Exercise deterministic output and cross-language graph consumption; retain failed attempts and label synthetic bytes as synthetic.

Run the required root build, typecheck and bundle, focused affected consumer tests, formatting/reference checks, two clean self-audit passes and independent review. Run Maven checks if extraction changes Java or its packaged resources. Validation must name the exact frozen base and final candidate. A green software test does not establish installation or native acceptance.

Software extraction is accepted when the fourth-slice delta has complete producers/consumers, passes those checks, preserves the preceding slice's strict contracts and refusal paths, and is independently reviewable. Native policy loading, lock/readback, immutable installation, bootloader selection, actual PID1 handoff and cleanup remain explicit follow-up gates. Do not run those operations on the development host as part of this extraction.

## Open questions and follow-up

The node-evidence PR must freeze before this PR is published against its branch; after it merges, rebase and retarget to `main`. Native host-policy provenance and supported kernel/systemd behavior require separate evidence. Physical retirement coordination and durable progress are the fifth slice. No open question is resolved by weakening a check or treating a generated receipt as authority.
