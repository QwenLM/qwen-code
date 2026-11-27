# Host Capability Probing and Per-Round VMM Staging for `/verify-pr` MicroVMs

[中文版本](2026-11-27-verify-pr-vm-host-staging.zh-CN.md)

**Status: implemented and verified on macOS arm64 and Linux aarch64 KVM; PR review and remote CI remain separate gates. Date: 2026-11-27.**

## 1. Context and Goal

The prior `/verify-pr` microVM milestones landed trust classification (`scripts/verify-pr-prepare.mjs`), host-record checking (`scripts/verify-pr-check.mjs`), ownership reaping and finalization (`scripts/verify-pr-vm-lifecycle.mjs`), bounded artifact collection (`scripts/verify-pr-vm-collector.mjs`), 3-port guest vsock transport (`scripts/verify-pr-vm-channel.mjs`, `scripts/verify-pr-vm-guest-vsock.py`), and launch-plan orchestration (`scripts/verify-pr-vm-runner.mjs`).

Two operational gaps prevented `verify-pr-vm-runner.mjs` from driving a real local microVM without hand-written PoC glue:

1. `select` accepted only manual capability flags (`--kvm`, `--vfkit --seatbelt-enforcing`) with no live host capability or macOS Seatbelt enforcement probe.
2. `runHardwareRound` required callers to manually create Firecracker's `jailRoot`, copy golden kernel/rootfs images to independent per-round files, write and chown `<jailRoot>/config.json`, or author a deny-default macOS Seatbelt `.sb` profile and stage `vfkit` assets, and did not verify an on-disk `<jailRoot>/config.json` against `plan.vmConfig`.

This change closes those Phase 2 host-side gaps in a single focused module (`scripts/verify-pr-vm-host.mjs`) plus minimal, backward-compatible wiring in `scripts/verify-pr-vm-runner.mjs`.

## 2. Scope and Hard Constraints

- **Allowed scope:** `scripts/verify-pr-vm-host.mjs`, `scripts/verify-pr-vm-runner.mjs`, `scripts/tests/verify-pr-vm-host.test.js`, this bilingual design document, and the five `#18400` R5 deferred test/doc follow-ups in `scripts/tests/verify-pr-vm-channel.test.js` and `docs/design/2026-11-25-verify-pr-round-input-hardening.{md,zh-CN.md}`.
- **Out of scope (untouched):** `packages/`, `.github/`, `.qwen/skills/`, `/review`, cloud resource provisioning, real model credentials, and guest workload packaging.
- **Backward compatibility:** existing manual `select` flags, `runHardwareRound({ stageAssets: false })`, `run --config`, and legacy `container`, manual `vm`, and `waived` `/verify-pr` flows remain unchanged.

## 3. Design Decisions

### 3.1 Fail-Closed Live Host Capability Probing (`probeHostCapabilities`)

- **Linux KVM + Firecracker/jailer:** verifies `/dev/kvm` via `lstatSync` (non-symlink character device) and real `openSync(O_RDWR | O_NOFOLLOW)`, confirms readable cgroup v2 controllers (`/sys/fs/cgroup/cgroup.controllers`), requires positive non-root `vmmUid`/`vmmGid`, and validates `firecracker` and `jailer` as non-symlink regular executables whose `--version` exits 0 with non-empty output.
- **macOS ARM64 `vfkit` + Seatbelt (D7):** requires `darwin`/`arm64`, verifies `/usr/bin/sandbox-exec`, checks `vfkit` as a non-symlink regular executable whose `--version` succeeds AND whose `/usr/bin/codesign -d --entitlements :-` output contains `com.apple.security.virtualization` (refusing hollow/unsigned binaries), and executes `probeSeatbeltEnforcement`.
- **Live Seatbelt enforcement probe (`probeSeatbeltEnforcement`):** runs a clean-environment `/usr/bin/env -i ... /usr/bin/sandbox-exec` subprocess with canonicalized (`realpathSync`) `POC_DIR` and `POC_SOCKET_DIR` parameters. It passes only when **both** positive controls succeed (read and write inside `POC_DIR`) **and** both negative controls are denied (reading a host canary outside `POC_DIR` and creating a file outside `POC_DIR` fail with no leak). Symlinked or multi-hardlinked external profiles are rejected before execution.

### 3.2 Minimal Deny-Default macOS Seatbelt Profile (`renderVfkitSeatbeltProfile`)

- Starts with `(version 1)`, `(deny default)`, `(import "system.sb")` (Apple's minimal dyld/system-library base, with no `/Users`, `$HOME`, `/tmp`, or IP network allowances), followed by explicit `(deny network-inbound)` and `(deny network-outbound (remote ip))`.
- Grants only `POC_DIR` and `POC_SOCKET_DIR` read/write, Unix-socket bind/outbound strictly under `POC_SOCKET_DIR`, Virtualization.framework / Hypervisor Mach and IOKit services, and safe absolute literal execution paths (rejecting quotes, backslashes, newlines, or NUL bytes in `vfkitBin`).

### 3.3 Per-Round Independent Asset Staging and Disk Config Verification

- **`copyIsolatedAsset`:** opens the source with `O_RDONLY | O_NOFOLLOW`, asserts single-link regular file outside `vaultDir`, refuses to overwrite any existing destination, copies via streaming into an `O_CREAT | O_EXCL | O_NOFOLLOW` temp file inside the canonicalized `realParent` (verified within `approvedRoots`), computes SHA-256 while streaming, asserts `(dev, ino)` differs from the source and `nlink === 1`, applies mode and optional `fchown`, and atomically renames into `realParent`.
- **`stageLocalVmRound`:**
  - **Firecracker:** creates `plan.jailRoot`, copies `sourceKernelPath` and `sourceRootfsPath`, atomically writes `<jailRoot>/config.json` matching `plan.vmConfig` and `<jailRoot>/console.log`, and applies `vmmUid:vmmGid` ownership when running as root (or when `applyChown: true`).
  - **`vfkit`:** creates private `0o700` `pocDir`/`socketDir`/`homeDir`/`tmpDir` inside `approvedRoots`, derives independent copies of `kernel`, `initramfs`, and `rootfs`, and atomically renders `seatbeltProfile` if absent (or validates an existing profile via `lstatSync` + single-link read, rejecting broken symlinks).
  - Any failure rolls back every file and newly created per-round directory; shared parent directories are pruned only via non-recursive `rmdirSync` when empty.
- **`verifyFirecrackerDiskConfig`:** validates `<jailRoot>/config.json` as a single-link regular file whose parsed JSON matches `plan.vmConfig` via `util.isDeepStrictEqual` (independent of key ordering, while rejecting injected `network-interfaces` or extra drives). Enforced unconditionally when `stageAssets: true` and whenever `<jailRoot>/config.json` is present on default Firecracker launches.

### 3.4 Runner CLI and Orchestrator Integration

- `node scripts/verify-pr-vm-runner.mjs probe [...]` emits JSON capability reports and exits 0 iff at least one hardware backend is genuinely ready.
- `node scripts/verify-pr-vm-runner.mjs select --context <snapshot> --probe [...]` feeds real probe results into `selectBackend`; mixing `--probe` with manual `--kvm`/`--vfkit`/`--seatbelt-enforcing` or omitting option values exits 2.
- `runHardwareRound` and `run --config` accept optional `stageAssets: true`, `sourceInitramfsPath`, and `applyChown`, cleaning up pre-launch staged assets on early failure and cleaning remaining staged files in `finally` only after `reapOwnership` proves worker absence.

## 4. Acceptance Criteria

1. `renderVfkitSeatbeltProfile` rejects unsafe `vfkitBin` literals and produces a deny-default profile that passes live macOS `sandbox-exec` positive/negative filesystem controls and blocks real outbound TCP to a local canary listener (while an unsandboxed positive control reaches that listener).
2. `probeSeatbeltEnforcement` returns `enforcing: false` for permissive `(allow default)`, symlinked, and hardlinked profiles, and on non-darwin platforms.
3. `probeHostCapabilities` refuses hollow `vfkit` binaries missing `com.apple.security.virtualization` via real `codesign`, refuses non-char/symlink `/dev/kvm`, symlinked or failing `firecracker`/`jailer` binaries, missing cgroup v2, and root `vmmUid`, and reports `kvmAvailable: true` on real Linux KVM with Firecracker/jailer.
4. `copyIsolatedAsset` and `stageLocalVmRound` enforce `approvedRoots`, `vaultDir` exclusion, single-link sources, independent destination inodes, no overwrites, broken-symlink rejection, and complete rollback on failure.
5. `verifyFirecrackerDiskConfig` accepts key-reordered matching configs and blocks tampered on-disk `config.json` (e.g. injected NIC) before spawning Firecracker.
6. `runHardwareRound({ stageAssets: true })` completes a zero-manual-staging real Linux Firecracker/KVM round with `outputStatus=complete`, `teardownStatus=destroyed`, `boundary.json (mode:"microvm")`, zero residual `jailRoot`/working disk, and unchanged golden kernel/rootfs SHA-256 digests.

## 5. Verification Evidence and Boundaries

Measured on the exact final bytes (`verify-pr-vm-host.mjs` `f6ee7de2…`, `verify-pr-vm-runner.mjs` `159cc194…`, `verify-pr-vm-host.test.js` `8d9948fb…`):

| Environment                                        | Verified Result                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64, Node 24.18.1                          | 4 focused suites (`verify-pr-vm-{host,runner,channel}` + `verify-pr-credential-scan`): **76 passed, 0 failed**. Live `/usr/bin/sandbox-exec` positive/negative controls, permissive profile rejection, local TCP canary deny (with unsandboxed positive control), and hollow-`vfkit` real `codesign` refusal all passed. Full `npm run lint` and Prettier passed.                                                                                                           |
| Linux aarch64, Node 22.23.5 (`qa-host-staging`)    | All 12 `scripts/tests/verify-pr*.test.js` files: **549 passed, 9 environment skips**.                                                                                                                                                                                                                                                                                                                                                                                       |
| Live Linux KVM CLI `probe` & `select --probe`      | Verified `/dev/kvm` char-device open, cgroup v2, `Firecracker v1.18.0`, `Jailer v1.18.0`; `select --probe` selected `backend: "firecracker"`.                                                                                                                                                                                                                                                                                                                               |
| Zero-manual-staging real Firecracker/KVM E2E       | `runHardwareRound({ stageAssets: true })` with guest `9cc5977f…` and derived image `a719de5e…`: `ok: true`, `outputStatus: "complete"`, `teardownStatus: "destroyed"`, `guestChecks: 15`, `guestNoNic: true`, `guestHasDirShare: false`, `upstreamAuthOk: true`, `upstreamHits: 1`, `jailRootCleaned: true`, `workDiskCleaned: true`, `boundaryMode: "microvm"`, `boundaryBackend: "firecracker"`. Golden kernel (`aee80c3a…`) and rootfs (`1ba7902e…`) verified unchanged. |
| Real Linux tampered `config.json` negative control | Injecting `network-interfaces` into on-disk `<jailRoot>/config.json` blocked before `jailer` launch (`firecracker disk config.json does not match validated plan.vmConfig`).                                                                                                                                                                                                                                                                                                |

**Explicit boundaries (not verified here):** live macOS `vfkit` microVM boot (this macOS host has no `vfkit` binary installed; macOS verification covers real Seatbelt enforcement, TCP denial, and real `codesign` hollow-binary rejection), cloud `provider-vm` / Agent Sandbox allocations, external model endpoints, Windows IPC, and remote GitHub CI / maintainer approval.
