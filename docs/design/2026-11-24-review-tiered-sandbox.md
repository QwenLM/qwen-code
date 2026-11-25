# Tiered Sandbox Execution for `/review`

[English](2026-11-24-review-tiered-sandbox.md) | [简体中文](2026-11-24-review-tiered-sandbox.zh-CN.md)

**Status:** Phase 1 & Phase 2-B implemented (trust classification, hardened containers, tiered fail-closed backend selection & launch planners, `guest-exec-v1` UDS/vsock live microVM execution bridge with content-only workspace packing and identity-checked VMM worker teardown, bypass phase gates, structured boundary disclosure); CI workflow cutover (Phase 2-A) and cloud `provider-vm` HTTP/SDK data plane remain follow-up work.
**Date:** 2026-11-24
**Related:** [Tiered MicroVM Isolation for `/verify-pr`](2026-11-23-verify-pr-tiered-microvm.md), [Review CPU for Tokens](review-cpu-for-tokens.md)

## 1. Problem Statement

`/review` runs reviewed repository code across multiple mechanical verification subcommands (`build-test`, `test-efficacy`, `test-delta`, `base-tree`, plus interactive/scripted runtime probes `drive`, `ab-drive`, and `capture-tui`). While `packages/cli/src/commands/review/lib/sandboxed-exec.ts` introduced single-tier container execution (`off | auto | required`) for `build-test`, `test-efficacy`, and `test-delta`, four structural gaps remain when compared against the tiered microVM isolation architecture introduced for `/verify-pr` (#18181):

1. **No trust classification or mandatory high-risk escalation.** All PRs are treated uniformly regardless of author trust (`local-owner`, `collaborator`, `external`, `unknown`), fork origin (`isCrossRepository`), or high-risk file modifications (`package.json`, lockfiles, `patches/`, `.github/workflows/`, `.qwen/`, executable files, symlinks, submodules).
2. **Single shared-kernel container backend without hardening or verified teardown.** `containerCommand()` does not drop Linux capabilities (`--cap-drop=ALL`), does not set `no-new-privileges`, and sets no PID cap (`--pids-limit`). `killContainer()` runs best-effort `rm -f` without verifying that the container actually exited. There is no fail-closed adapter layer for hardware-isolated backends (`firecracker`, `vfkit`, `provider-vm` / Aliyun `fcsandbox`).
3. **Uncontained host execution bypasses.** `drive`, `ab-drive`, and `capture-tui` launch `tmux` and `bash -lc` directly on the host without consulting `refuseUnsandboxedPhase()` or `review.sandbox`, leaving a host execution bypass even when `review.sandbox` is `required` or `tiered`.
4. **No structured execution boundary disclosure.** `BuildTestReport`, `TestEfficacyReport`, `TestDeltaReport`, `DriveReport`, and `AbDriveReport` do not carry a structured `executionBoundary` object recording `policy`, `prTrust`, `executionClass`, `backend`, `escalationReasons`, and `teardownStatus`.

## 2. Goals and Non-Goals

### Goals

- Align `/review` with the core invariant established in `/verify-pr` (#18181): **microVM-first for untrusted / high-risk changes, hardened shared-kernel containers for trusted low-risk changes, fail-closed everywhere, never silent downgrade to host execution**.
- Preserve 100% backward compatibility for existing `review.sandbox` values (`off`, `auto`, `required`) while adding a new `tiered` policy mode and operator-only controls (`QWEN_REVIEW_SANDBOX_BACKEND`, `QWEN_REVIEW_FORCE_HARDWARE`).
- Harden the lightweight container tier with least-privilege flags and verifiable teardown status.
- Provide a unified fail-closed backend selection and launch-planner boundary supporting `container`, `firecracker` (Linux KVM), `vfkit` (macOS Apple Silicon + Seatbelt), and `provider-vm` (Aliyun `fcsandbox` custom VPC-isolated template or ephemeral ECS).
- Gate `drive`, `ab-drive`, and `capture-tui` behind the same fail-closed sandbox policy so they never silently execute untrusted scripts on the host under `required`, `tiered`, or `QWEN_REVIEW_FORCE_HARDWARE=1`.
- Attach structured `executionBoundary` metadata to execution reports and capture PR trust inputs (`isCrossRepository`, `authorAssociation`) in `fetch-pr` plans with zero extra GitHub API calls.

### Non-Goals (Phase 1 / 2-B)

- Putting the entire `/review` orchestrator LLM agent inside a microVM (per `/verify-pr` §3.5, `/review` keeps its orchestrator, `working_dir`, fan-out, coverage ledger, and `--fix` host target unchanged, isolating only code-execution adapters).
- Modifying `.github/workflows/qwen-code-pr-review.yml` or provisioning production cloud VM credentials in this change (Phase 2-A).
- Shipping a cloud HTTP/SDK data plane for `provider-vm` (`fcsandbox` / `aliyun-ecs`) inside `packages/cli` (remains follow-up; local microVM backends `firecracker` and `vfkit` now execute live over the `guest-exec-v1` UDS/vsock bridge when prerequisites and `QWEN_REVIEW_VM_BRIDGE_SOCKET` are ready, and refuse fail-closed otherwise).

## 3. Architecture and Design Decisions

### 3.1 Policy Modes and Operator-Only Precedence

`review.sandbox` / `QWEN_REVIEW_SANDBOX` supports four ordered policies:

| Policy     | Precedence Rank | Semantics                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`      | 0               | Run reviewed commands directly on the host (default, backward-compatible). Still overridden if `QWEN_REVIEW_FORCE_HARDWARE=1` is set in the operator environment.                                                                                                                                                                                                                |
| `auto`     | 1               | Use a hardened container when Docker or Podman answers; fall back to direct execution with disclosure when unavailable.                                                                                                                                                                                                                                                          |
| `required` | 2               | Never execute reviewed code unsandboxed; requires a mountable container (or stronger backend). Refuses fail-closed if unavailable.                                                                                                                                                                                                                                               |
| `tiered`   | 3               | Classify PR trust and changed files into `trusted-shared-kernel` or `hardware-isolated`. Trusted low-risk runs may use a hardened container (no host fallback); `hardware-isolated` runs require a hardware-isolated backend (`firecracker`, `vfkit`, or `provider-vm`) and refuse fail-closed if unavailable — never silently downgrading to a shared-kernel container or host. |

**Anti-tampering rules:**

- `review.sandbox` is read exclusively via `operatorReviewSettings()` (User / System / SystemDefaults scopes); workspace `.qwen/settings.json` is ignored.
- `QWEN_REVIEW_SANDBOX`, `QWEN_REVIEW_SANDBOX_BACKEND`, `QWEN_REVIEW_FORCE_HARDWARE`, and `QWEN_REVIEW_SANDBOX_IMAGE` are all members of `PROJECT_ENV_HARDCODED_EXCLUSIONS` in `packages/cli/src/config/shared-env-keys.ts` and additionally checked against `isFileSourcedEnvKey()`. A repository `.env` or `.qwen/.env` can never set or relax them.
- Between operator environment and operator settings, `sandboxPolicy()` always selects the stricter policy (`off < auto < required < tiered`).

### 3.2 Trust Classification and Mandatory Escalation (`lib/sandbox-trust.ts`)

Mirrors `scripts/verify-pr-prepare.mjs` with `/review`-native inputs derived from `PlanReport` (written by `fetch-pr` or `capture-local`):

- **`prTrust`**:
  - `local-owner`: local diff / file-path review (`isLocal: true`, no PR target).
  - `collaborator`: same-repository PR (`isCrossRepository: false`) whose `authorAssociation` is `OWNER`, `MEMBER`, or `COLLABORATOR`.
  - `external`: fork PR (`isCrossRepository: true`) or non-collaborator association (`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`).
  - `unknown`: PR review where `isCrossRepository` or `authorAssociation` is missing or unrecognized.
- **`executionClass`**:
  - `trusted-shared-kernel`: only when `prTrust` is `local-owner` or `collaborator`, `forceHardware` is false, changed file list is complete (for PRs: non-incremental or demoted full-range, `files.length === diffStat.files`, and diff capture did not collapse/fail), and zero mandatory escalation rules fire.
  - `hardware-isolated`: in all other cases (`external`, `unknown`, `forceHardware`, missing or incomplete/incremental file list on a PR, malformed plan JSON, or any mandatory escalation hit).
- **Mandatory escalation triggers (`detectReviewMandatoryEscalations`)**:
  - Supply-chain / dependency manifests: `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock*`, `.npmrc`, `.yarnrc*`, `.pnpmfile.mjs`, `patches/**`, `pom.xml`, `.mvn/**`, `mvnw*`, `Cargo.toml`, `Cargo.lock`, `go.mod`, `go.sum`, `pyproject.toml`, `requirements*.txt`, `setup.py`, `Gemfile*`, `build.gradle*`, `settings.gradle*`, `gradlew*`.
  - CI / hooks / agent / git / review config: `.github/workflows/**`, `.github/actions/**`, `.husky/**`, `.qwen/**`, `.claude/**`, `.gitmodules`, `.gitattributes`.
  - Build / sandbox / verification / JS-executed tooling config: `**/scripts/**`, `build.{js,mjs,cjs,ts}`, `Dockerfile*`, `docker-compose*`, `(GNU)Makefile`, `*.mk`, `justfile`, `Taskfile.ya?ml`, `turbo.json`, `esbuild/vite/vitest/babel/webpack/rollup/jest/playwright/postcss/tailwind/next/prettier/eslint.config.*`, `tsconfig*.json`, `.eslintrc*`, `.prettierrc.{js,cjs,mjs}`.
  - Executable, symlink, submodule, binary, or traversal artifacts: git mode `100755`, `120000`, `160000` (parsed from `new/deleted file mode`, `new/old mode`, and `index <old>..<new> <mode>` diff headers into `FileMetric.mode` and copied by `trustInputFromPlan`), `binary: true`, `..` path-traversal segments, or executable script/binary extensions (`.sh`, `.bash`, `.zsh`, `.py`, `.rb`, `.pl`, `.ps1`, `.bat`, `.cmd`, `.exe`, `.dll`, `.so`, `.dylib`).
  - Both `file.path` and `file.renameFrom` are normalized and inspected so renames or redundant slashes cannot bypass escalation.

### 3.3 Hardened Lightweight Container Tier (`lib/sandboxed-exec.ts`)

Every `containerCommand()` invocation now enforces:

- `--cap-drop=ALL`: drops all default Linux capabilities.
- `--security-opt=no-new-privileges:true`: blocks setuid/setgid privilege escalation inside the container.
- `--pids-limit=512`: bounds process/thread creation against fork bombs while accommodating concurrent Vitest/esbuild workers.
- Network split preserved: `install` keeps network access; `build` and `test` pass `--network none`.
- Verifiable teardown (`reapContainer()` / `killContainer()`): executes `<runtime> rm -f <name>` and verifies via `<runtime> inspect --format '{{.State.Running}}' <name>` (capturing stderr) that the container is explicitly gone (`No such container/object`) or stopped (`false`), returning `'clean'` or `'failed'` (`ReviewTeardownStatus`) so daemon outages or still-running containers never register as clean teardown.

### 3.4 Tiered Backend Adapter and Fail-Closed Selection (`lib/sandbox-backends.ts`)

Defines a clean adapter boundary aligned with `scripts/verify-pr-vm-runner.mjs`:

- Supported hardware backends:
  - `firecracker` (Linux KVM `/dev/kvm` + `firecracker` + `jailer` + operator-supplied readable regular-file kernel/rootfs assets).
  - `vfkit` (macOS Apple Silicon `arm64` + `vfkit` + enforcing Seatbelt `sandbox-exec` + operator-supplied readable regular-file kernel/rootfs assets).
  - `provider-vm` (Aliyun `fcsandbox` with an explicit non-default isolated VPC template — rejecting `default`, `base`, `python`, `code-interpreter`, and whitespace — or ephemeral `aliyun-ecs`, with a valid `https://` endpoint URL).
- Selection order for `hardware-isolated`:
  1. If `QWEN_REVIEW_SANDBOX_BACKEND` explicitly names a hardware backend (`firecracker`, `vfkit`, or `provider-vm`), validate only that backend (fail-closed if unavailable or if `container` was requested for a `hardware-isolated` run).
  2. Otherwise probe in host-native priority order: `firecracker` (Linux) -> `vfkit` (macOS arm64) -> `provider-vm` (cloud fallback).
- Each hardware backend has a pure launch-plan builder (`buildReviewBackendPlan`) validating prerequisites without spawning untrusted code.
- **Live microVM `guest-exec-v1` bridge (`lib/guest-exec-bridge.ts`, Phase 2-B):**
  - When a local microVM backend (`firecracker` or `vfkit`) satisfies all host prerequisites AND the operator provides a valid non-symlinked Unix domain socket via `QWEN_REVIEW_VM_BRIDGE_SOCKET` (checked against OS `sun_path` byte limits and `lstatSync().isSocket()`, excluded from repository `.env` via `PROJECT_ENV_HARDCODED_EXCLUSIONS`), `selectReviewSandboxBackend()` returns `kind: 'hardware-bridge'` and `sandboxVerdict()` returns `kind: 'microvm'`.
  - **No RW host mount (D5) & session continuity:** `packWorkspaceFiles()` uploads regular files by content (`F`/`D`/`V` frames) under strict count, per-file, and aggregate byte caps, verifying canonical directory containment via `realpathSync` and opening files with `O_NOFOLLOW`, refusing symlinks, FIFOs, sockets, device nodes, and traversal paths. Multi-command phases (`build-test` `install` -> `build` -> `test`, `test-delta` lockfile install -> baseline test reruns, and `test-efficacy` mutation probes) thread a validated `workspaceSessionId` with `workspaceMode` (`replace` / `sync` / `overlay` / `reuse`) so guest-installed `node_modules` and compiled outputs persist inside the guest session without ever touching the host worktree, verified by a guest-side lockfile completeness marker probe (`test -f node_modules/<marker>`) instead of checking the host filesystem, and reclaimed on exit via an explicit `C` frame. `closeGuestSessionSync()` accepts only a complete session-bound ACK whose `runId`, `workspaceSessionId`, `sessionSha256`, and process status match — a bare exit 0, missing/truncated ACK, or wrong sender is reported as `'partial'`, never as clean teardown. Because that ACK shape is stricter than the original bare-session-id contract, the cleanup handshake carries its own token `guest-exec-close-v2` (command execution stays on `guest-exec-v1`): a peer still speaking the old contract fails at the handshake and the returned `reason` names the protocol skew, which `executionBoundary.note` surfaces instead of an unexplained `partial`. If the peer **explicitly refuses** the versioned token (`R`), the client retries once on `guest-exec-v1` with the same JSON `C` payload, so a collector already updated to the JSON contract but still validating `H` against the base token is closed cleanly rather than stranded. Only an explicit refusal triggers the retry — an echoed-but-unbound ACK is never retried, so a weak peer cannot be upgraded into a false `clean`. An install that fails records `installError`; later probe calls report `not-run` instead of skipping installation or retrying it. All three phases — including `test-efficacy` — probe the guest-side completeness marker after a zero-exit install, so an install that exits 0 without materialising `node_modules` is `not-run`, not N probes reported as `no-output`.
  - **Framed transport & anti-truncation:** Uses `1B ASCII kind + 4B uint32 BE length + payload` (`H`/`A` handshake, `X` exec with allowlisted `guestCommandEnv()`, `C` session close, `O`/`E` bounded stdout/stderr chunks, `Z` end frame with independent SHA-256 verification of stdout/stderr, `R` refusal). Missing `Z` frames, trailing partial bytes, frame/output overruns, impossible exitCode+signal pairs, or SHA-256 mismatches fail closed with `EPROTO` rather than reporting exit 0.
  - **Synchronous adapter & identity-checked teardown:** `executeViaGuestBridgeSync()` drives a minimal raw UDS byte pump child under `spawnSync` timeout so `build-test`, `test-efficacy`, and `test-delta` execute inside the microVM while keeping all protocol verification in the parent. On timeout or protocol fault, `reapVmWorker()` validates the PID file (refusing symlinks and the host's own PID) and matches executable identity strictly against executable basenames (`comm`, `argv[0]`, Linux `/proc/<pid>/exe` — never arbitrary `argv[1..]` substrings), ignoring the Linux `(deleted)` suffix after binary replacement before sending `SIGTERM` -> `SIGKILL` -> confirmed absence, reporting verifiable `teardownStatus` (`'clean' | 'partial' | 'failed'`).
  - **Fail-closed fallback:** If prerequisites are missing, `QWEN_REVIEW_VM_BRIDGE_SOCKET` is unset/invalid, or `provider-vm` is selected without an attached data plane, `sandboxVerdict()` / `refuseUnsandboxedPhase()` refuse fail-closed without downgrading to a shared-kernel container or the host.

### 3.5 Execution Surface Coverage and Bypass Closure

| Subcommand      | Executes Reviewed Code                   | Policy Gate Behavior                                                                                                                                                                                                                                          |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-test`    | `npm ci`, build, test                    | `refuseUnsandboxedPhase(root, ..., trustContext)`; records `executionBoundary` and `teardownStatus` in `BuildTestReport`.                                                                                                                                     |
| `test-efficacy` | mutation & revert Vitest probes          | `refuseUnsandboxedPhase(probeWorktree, ..., trustContext)`; records `executionBoundary` and `teardownStatus` in `TestEfficacyReport`.                                                                                                                         |
| `test-delta`    | base-side failed test reruns             | `refuseUnsandboxedPhase(baseline, ..., trustContext)`; records `executionBoundary` in `TestDeltaReport`. Under `tiered` the command MUST receive `--plan`; without it the trust context is unknown and the rerun refuses fail-closed with an actionable note. |
| `base-tree`     | delegates build to `build-test`          | Inherits `build-test`'s gate and refusal semantics.                                                                                                                                                                                                           |
| `drive`         | host `tmux` + `bash -lc`                 | Calls `refuseHostExecutionPhase()`; refuses (`outcome: 'unavailable', observed: false`) under `required`, `tiered`, or `QWEN_REVIEW_FORCE_HARDWARE=1` before touching `tmux`. Records `executionBoundary`.                                                    |
| `ab-drive`      | host `tmux` + `bash -lc` across two arms | Calls `refuseHostExecutionPhase()`; refuses (`observed: false`) under `required`, `tiered`, or `QWEN_REVIEW_FORCE_HARDWARE=1` before touching `tmux`. Records `executionBoundary`.                                                                            |
| `capture-tui`   | host `tmux` + command capture            | Calls `refuseHostExecutionPhase()`; invokes `refuse(...)` (exit 3) under `required`, `tiered`, or `QWEN_REVIEW_FORCE_HARDWARE=1` before starting `tmux` or modifying `--out`.                                                                                 |

### 3.6 Zero-Extra-API Trust Propagation (`fetch-pr.ts` & `lib/platform/github.ts`)

`githubReader.getFetchMeta()` already queries `gh pr view --json ...`. Adding `authorAssociation` to that field list populates `FetchMeta.authorAssociation` and writes it into the `fetch-pr` plan JSON alongside `isCrossRepository` and `files`. Downstream `build-test`, `test-efficacy`, and `test-delta` derive `ReviewTrustInput` directly from the `--plan` file when present (falling back safely to `unknown` / fail-closed under `tiered` when PR metadata is absent).

**Read trust before executing.** The plan lives under the review temp dir the container mounts read-write, so reviewed code can rewrite it during a trusted run. Every phase therefore reads `ReviewTrustInput` once, before its first command, and reports that captured value; `build-test` in particular no longer re-reads the plan for its `executionBoundary` after the build. The gate invariant is not affected: a `hardware-isolated` plan is refused before any reviewed code runs, so no code it contains ever gets the chance to rewrite it; later phases of a trusted run may see a mutated plan, but only a PR that was already allowed to execute, and never to make a `hardware-isolated` run execute. An execution with no trust context at all is disclosed as `executionClass: 'unclassified'` rather than mislabelled `hardware-isolated`.

## 4. Risks and Mitigations

| Risk                                                                                                           | Mitigation                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing local or CI `off`/`auto`/`required` workflows break unexpectedly                                      | `off`, `auto`, and `required` keep identical default behavior; `tiered` and `QWEN_REVIEW_FORCE_HARDWARE` are explicit opt-ins.                                                                                |
| `--pids-limit` breaks legitimate parallel builds/tests                                                         | Default set to `512`, well above normal Node/Vitest/esbuild concurrency while still stopping fork bombs.                                                                                                      |
| A malicious PR sets `QWEN_REVIEW_SANDBOX_BACKEND=container` or `QWEN_REVIEW_FORCE_HARDWARE=0` via `.qwen/.env` | All review sandbox env vars are in `PROJECT_ENV_HARDCODED_EXCLUSIONS` and filtered by `isFileSourcedEnvKey()`.                                                                                                |
| `drive`/`ab-drive`/`capture-tui` unit tests fail if operator machine sets `review.sandbox`                     | Existing tests run with isolated operator settings or default `off`; new unit tests explicitly pin both `off`/`auto` pass-through and `required`/`tiered`/`QWEN_REVIEW_FORCE_HARDWARE=1` fail-closed refusal. |

## 5. Validation Plan and Acceptance Criteria

1. **Unit tests**:
   - `sandbox-trust.test.ts`: covers `local-owner` / `collaborator` / `external` / `unknown`, every mandatory escalation pattern (dependencies, lockfiles, patches, workflows, `.qwen`, scripts, executable modes, symlinks, submodules, renames), missing file list fail-closed, and `QWEN_REVIEW_FORCE_HARDWARE=1`.
   - `sandbox-backends.test.ts`: covers backend selection priority per platform, explicit `QWEN_REVIEW_SANDBOX_BACKEND` override, rejection of `container` for `hardware-isolated`, fail-closed when prerequisites are missing, and launch-plan validation for `firecracker`, `vfkit`, and `provider-vm` (`fcsandbox` / `aliyun-ecs`).
   - `sandboxed-exec.test.ts`: covers `tiered` policy precedence, repo `.env` rejection for new env keys, hardened container flags (`--cap-drop=ALL`, `--security-opt=no-new-privileges:true`, `--pids-limit=512`), `reapContainer()` clean vs. failed verification, and `refuseHostExecutionPhase()`.
   - `build-test` / `test-efficacy` / `test-delta` / `drive` / `ab-drive` / `capture-tui` tests: verify `executionBoundary` attachment, plan-derived trust enforcement, and fail-closed refusal on bypass subcommands.
   - `guest-exec-bridge.test.ts`: covers `guest-exec-v1` frame encoding/decoding, UDS path length and symlink socket rejection, content-only workspace packing (refusing symlinks, non-regular files, and budget overruns), truncated/forged-digest rejection, identity-checked `reapVmWorker()` (refusing mismatched PIDs, killing live TERM-ignoring targets, preserving innocent canaries), and end-to-end real Unix domain socket child guest-agent execution through `runBuildTest` and `runTestDelta` under `tiered` + external fork PRs.
2. **Build & static checks**: `npm run build && npm run typecheck` and targeted Vitest suites in `packages/cli`.

## 6. Follow-up Work

- Update `.github/workflows/qwen-code-pr-review.yml` (and workflow meta-tests) to remove the fallback to `policy=off` on external PRs when container/VM runtime is unavailable, switching CI to `QWEN_REVIEW_SANDBOX=tiered` (Phase 2-A).
- Connect a cloud HTTP/SDK data plane for `provider-vm` (`fcsandbox` / `aliyun-ecs`) and optional microVM-wrapped `drive` execution.
