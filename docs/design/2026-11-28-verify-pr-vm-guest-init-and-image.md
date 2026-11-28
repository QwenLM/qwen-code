# Standard Guest Entrypoint and Offline Golden Image Derivation for `/verify-pr` MicroVMs

[中文版本](2026-11-28-verify-pr-vm-guest-init-and-image.zh-CN.md)

**Status: implemented and verified on macOS arm64 and Linux aarch64 KVM; PR review and remote CI remain separate gates. Date: 2026-11-28.**

## 1. Context and Goal

With PR #18552 merged, the host-side `/verify-pr` microVM pipeline (`probe` → `select --probe` → `stageLocalVmRound` → `runHardwareRound` → `reapOwnership` → `verify-pr-check`) lives completely in-repo. However, two remaining Phase 2 pieces still lived in ad-hoc out-of-tree PoC scripts:

1. A standard PID-1 guest init entrypoint and zero-dependency guest lifecycle runner that orchestrates the 3-port guest vsock channel (`fetch-inputs`, `model-bridge`, `upload-artifacts`), entropy mixing, isolation checks, bundle materialization, credential-stripped workload execution, and clean poweroff.
2. An offline, read-only golden ext4 rootfs derivation tool that injects those audited guest scripts into a derived image without loop mounts or mutating the golden source.

This change brings both pieces formally into `scripts/`, completing Phase 2 with zero out-of-tree PoC glue, and also folds in the two non-blocking follow-ups recorded during PR #18552 review (`ensureApprovedDirHierarchy` accepting directory equality with a normalized `approvedRoot`, and recording `createdDirs.push(nextDir)` immediately after `mkdirSync` before `chmodSync`).

## 2. Scope and Hard Constraints

- **Allowed scope:** `scripts/verify-pr-vm-guest-init.sh`, `scripts/verify-pr-vm-guest-runner.py`, `scripts/verify-pr-vm-image.mjs`, `scripts/verify-pr-vm-host.mjs`, collocated unit tests (`scripts/tests/verify-pr-vm-{guest-runner,image,host}.test.js`), and this bilingual design document.
- **Out of scope (untouched):** `packages/`, `.github/`, `.qwen/skills/`, `/review`, cloud resource allocation, external model calls, and real credentials.
- **Backward compatibility:** existing default launch `bootArgs` (`init=/opt/poc/init`), manual `stageAssets: false` flows, and legacy `container`, manual `vm`, and `waived` `/verify-pr` flows remain unchanged.

## 3. Design Decisions

### 3.1 Minimal PID-1 Guest Init (`scripts/verify-pr-vm-guest-init.sh`)

- Pure POSIX `#!/bin/sh` (zero `shellcheck -s sh` warnings), compatible with BusyBox and Debian rootfs layouts.
- Mounts `/dev` (`devtmpfs`), `/proc`, `/sys`, `/run` (`tmpfs`), optionally loads `virtio_vsock`, brings up loopback `lo` only (zero external NICs), exports a clean credential-free environment, invokes `guest-runner.py --from-cmdline`, syncs, and powers off cleanly when running as PID 1 so the guest exits without a kernel panic.

### 3.2 Zero-Dependency Guest Lifecycle Runner (`scripts/verify-pr-vm-guest-runner.py`)

- Pure Python 3 standard library; loads sibling `verify-pr-vm-guest-vsock.py` (or `/opt/qwen/guest-vsock.py` inside the derived image).
- Executes a 7-step fail-closed lifecycle:
  1. Fetches and SHA-verifies `manifest.json`, `round.bundle`, and `entropy.hex` via port 53 (`--unix-input` supported for host-side testing).
  2. Decodes 64-hex `entropyHex` and mixes the 32 bytes into `/dev/urandom` (configurable `--urandom-path` for testing).
  3. Inspects `/sys/class/net` and `/proc/mounts` to verify loopback-only interfaces (`noNic`) and absence of shared host mounts (`virtiofs`/`9p`/`vboxsf`/`vmhgfs`/`fuse.sshfs`).
  4. Materializes a clean Git workspace from `round.bundle` and verifies exact `baseRefOid` and `headRefOid` commits, or — only when explicitly opted in via `--skip-materialize` / `qwen.skip_materialize=1` for git-less minimal BusyBox images — verifies the Git v2/v3 bundle header and advertised OIDs in pure Python (`verify_bundle_header`).
  5. When `manifest.modelProxy` is non-null, launches `model-bridge` on `127.0.0.1:0` over port 54 (`--unix-model` for tests) and verifies exact `GET /__health` raw nonce equality (`res.end(nonce)`) before starting any workload; mismatches fail closed and stop the bridge immediately.
  6. Executes either `--workload` (or `/opt/qwen/workload.sh`) in a stripped environment (excluding host secrets, exposing only workspace/artifact paths and the ephemeral loopback bridge URL/token/nonce under a bounded timeout) or the built-in self-test that produces `verify-pr-check`-compliant `report.md`, `verdict.txt`, `assertions.json`, `comment.md`, and `logs/guest-runtime.json`.
  7. Always stops `model-bridge` in `finally` and uploads artifacts over port 52 (`--unix-collector` for tests).
- Parses `qwen.*` tokens from `/proc/cmdline`, rejecting non-positive integer values for `cid`, ports, and `workload_timeout`.

### 3.3 Offline Read-Only Golden ext4 Image Derivation (`scripts/verify-pr-vm-image.mjs`)

- Extracts read-only golden ext4 images via `debugfs -R "rdump / <tree>"` and rebuilds independent ext4 outputs via `mkfs.ext4 -F -b 4096 -U random -d <tree>` (zero loop mounts, never opens the golden image for writing).
- Reuses `normalizeApprovedRoots`, `canonicalizeVaultDir`, and `canonicalizePreservingLeaf` from `scripts/verify-pr-vm-host.mjs` to enforce `approvedRoots`, `vaultDir` exclusion, single-link non-symlink sources, optional `expectedBaseSha256` pinning, no output overwrites, and in-image target path normalization (`normalizeImageTargetPath`).
- Verifies `realpathSync(dirname(dest))` stays within the extraction tree before writing each injected file so a hostile base image containing a symlinked `/opt/qwen` cannot write outside the extract tree.
- Re-hashes `baseImagePath` after promotion to prove the read-only golden source remained byte-identical, and cleans temporary extraction trees and unpromoted temp images in `finally`.
- Provides optional `--bundle-host-python` to package host Python 3 and its `ldd`-resolved shared libraries into `/opt/python` for minimal BusyBox golden images.

### 3.4 PR #18552 Non-Blocking Follow-Ups (`scripts/verify-pr-vm-host.mjs`)

- `ensureApprovedDirHierarchy` accepts directories equal to a normalized `approvedRoot` (e.g. `copyIsolatedAsset(src, join(root, 'kernel'), { approvedRoots: [root] })`), while keeping strict child containment for file destinations.
- Moves `createdDirs.push(nextDir)` immediately after `mkdirSync(nextDir, { mode })` and before `chmodSync(nextDir, mode)` so a concurrent `chmodSync` failure still rolls back the newly created directory.

## 4. Acceptance Criteria

1. `verify-pr-vm-guest-init.sh` passes `sh -n` and `shellcheck -s sh` with zero warnings.
2. `verify-pr-vm-guest-runner.py` completes the full 7-step lifecycle through `runHardwareRound` over real 3-port Unix sockets (input 53 + model proxy 54 + collector 52 + `verify-pr-check` exit 0), writes 32 decoded entropy bytes, strips host secrets from workload environments, flags non-loopback NICs / `virtiofs` mounts as `needs-changes`, rejects wrong `/__health` nonces before workload execution, rejects invalid `qwen.*` cmdline integers, and verifies Git v2/v3 bundle headers when `--skip-materialize` is requested.
3. `deriveExt4GuestImage` and its `derive` CLI enforce `expectedBaseSha256`, `approvedRoots`, `vaultDir` (including symlinked vaults), single-link non-symlink inputs, no overwrites, in-image path traversal refusal, hostile extract-tree symlink escape refusal, temp cleanup on `mkfs` failure, and post-build golden SHA parity.
4. On real Linux aarch64 KVM, a 100% repo-only round (`verify-pr-vm-image.mjs derive` → `runHardwareRound({ stageAssets: true, runChecker: true })` → PID-1 `verify-pr-vm-guest-init.sh` → `verify-pr-vm-guest-runner.py`) completes with `ok: true`, `checkExitCode: 0`, `boundary.json (mode: "microvm")`, `guestEntropyWritten: true`, `noNic: true`, `hasDirectoryShare: false`, `modelProbeStatus: 200`, zero residual `jailRoot`, and unchanged golden kernel/rootfs hashes.
5. `copyIsolatedAsset(src, join(root, 'kernel'), { approvedRoots: [root] })` succeeds while `copyIsolatedAsset(src, root, { approvedRoots: [root] })` remains refused.

## 5. Verification Evidence and Boundaries

Measured on the exact final bytes (`verify-pr-vm-host.mjs` `672f642e…`, `verify-pr-vm-image.mjs` `097f1340…`, `verify-pr-vm-guest-init.sh` `0a97cd63…`, `verify-pr-vm-guest-runner.py` `212f9f86…`):

| Environment                                         | Verified Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64, Node 24.18.1                           | 6 focused suites (`verify-pr-vm-{guest-runner,image,host,runner,channel}` + `verify-pr-credential-scan`): **81 passed, 1 root-gated skip, 0 failed**. `python3 -m py_compile`, `sh -n`, `shellcheck -s sh` (0 warnings), Prettier, ESLint, and full repository `npm run lint` all passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Linux aarch64, Node 22.23.5 (`qa-guest-init-image`) | All 14 `scripts/tests/verify-pr*.test.js` files: **555 passed, 9 environment skips**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 100% Repo-Only Zero-PoC Real Firecracker/KVM E2E    | Derived image `c1ef5982…` via `verify-pr-vm-image.mjs derive --bundle-host-python` (real `debugfs` + `mkfs.ext4`), booted via `runHardwareRound({ stageAssets: true, runChecker: true })` with PID-1 `verify-pr-vm-guest-init.sh` + `verify-pr-vm-guest-runner.py` (`qwen.skip_materialize=1` for git-less minimal BusyBox golden rootfs): `ok: true`, `checkExitCode: 0`, `outputStatus: "complete"`, `teardownStatus: "destroyed"`, `boundaryMode: "microvm"`, `guestEntropyWritten: true`, `interfaces: ["lo"]`, `noNic: true`, `hasDirectoryShare: false`, `headerVerified: true`, `guestModelProbeStatus: 200`, `upstreamAuthOk: true`, `jailRootCleaned: true`, `execDirCleaned: true`. Golden kernel (`aee80c3a…`) and rootfs (`1ba7902e…`) verified unchanged. |

**Explicit boundaries (not verified here):** live Firecracker/KVM boot with a `git`-bearing guest rootfs (full `git bundle unbundle` + `git checkout` materialization and credential-stripped custom workload execution were verified over real 3-port Unix sockets in `verify-pr-vm-guest-runner.test.js`, while the minimal BusyBox golden rootfs on the KVM host lacks `git` and used `qwen.skip_materialize=1`), live macOS `vfkit` VM boot, cloud `provider-vm` / Agent Sandbox allocations, external model endpoints, Windows IPC, and remote GitHub CI / maintainer approval.
