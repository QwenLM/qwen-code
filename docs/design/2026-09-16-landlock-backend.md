# Landlock backend: explicit filesystem confinement

[English](2026-09-16-landlock-backend.md) | [简体中文](2026-09-16-landlock-backend.zh-CN.md)

## Status and scope

Design revision, 2026-09-16. The whole-CLI Landlock proposal below is **withdrawn as the recommended implementation plan**. No Landlock production code has been implemented or validated. Source baseline: `c755723286a6224ebbb65147f69b41e826936d5b`. Keep the previous proposal as a record of the compatibility costs, not instructions to begin implementing it.

The merged bwrap implementation still uses whole-CLI confinement in current production code. The replacement design retires that path instead of preserving a second supported mode. Prior behavior and the real Linux coverage in PR #11981 remain baseline evidence; migrate useful safety cases and explicitly report incompatible old configuration rather than silently changing its meaning.

## Revised architectural direction

The current proposal is the [unified tool-execution sandbox design](2026-09-16-tool-execution-sandbox.md), covering both bwrap migration and Landlock integration. Its decisions, capability profile, configuration, call-site inventory, and acceptance criteria take precedence over this historical document; no implementation is claimed.

- Keep model transport, authentication refresh, session persistence, and approval handling in the trusted host process. Give that process only the authority it needs; being outside the command sandbox is not permission to execute arbitrary model-directed writes.
- Resolve an immutable effective policy for each invocation from trusted configuration, workspace state, and any applicable approval. Apply kernel confinement when spawning untrusted command code and its descendants.
- Inventory every model-directed file mutation and execution surface, including built-in file tools, subagents, MCP, hooks, and background processes. Built-in mutations need the same policy enforced at their trusted implementation boundary or through a confined worker. Shell wrapping alone does not provide complete coverage. Remote services require their own control boundary.
- Distinguish ordinary tool failure, policy denial, and sandbox-launch failure. Where escalation is supported, bind approval to the exact operation and permitted scope before a new invocation; denial or approval unavailability must not trigger automatic unconfined replay.
- Avoid passing host credentials, arbitrary writable descriptors, or broad Qwen state grants into tool subprocesses. Authenticate the CLI on the host while explicitly defining credentials intentionally needed by individual tools.
- Implement and verify the policy/executor interface with bwrap first, replacing the old CLI hop in the same delivery, then add Landlock according to the same required capabilities. Do not retain a whole-CLI bwrap option or use it as an execution fallback.

The previous minimum ABI 5, `partial` label, global-state subdirectory list, private-temp lifetime, and whole-CLI marker protocol are **provisional choices to revisit**, not accepted requirements for the revised boundary. Some constraints remain relevant: explicit requests must not run unconfined on setup failure; broad parent grants cannot be undone by child read-only rules; network promises must match actual enforcement. Do not imply that moving the boundary alone solves these problems.

The bilingual unified design now covers call-site inventory, trusted versus model-controlled inputs, permission propagation, built-in file operations, approvals, networking, process lifetime, and backward compatibility. Continue from that document for implementation planning. The choice is justified by separating trusted runtime duties from untrusted execution, not merely by matching another product.

## Historical whole-CLI proposal — not the implementation plan

The remaining sections record the withdrawn proposal. Statements such as “first release,” “recommended,” and “release gate” below refer only to that historical proposal. They do not override the revised direction above.

### Findings that change the earlier proposal

| Finding                                                                                                        | Design consequence                                                                                        |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A usable Landlock kernel is not implied by bwrap failure; an outer container may also block Landlock syscalls. | Probe the actual helper and require successful enforcement.                                               |
| Current bwrap protects operator-controlled `QWEN_HOME/.env` with a read-only mount over a writable parent.     | Do not translate `--rw QWEN_HOME` plus `--ro .env`; redesign state grants.                                |
| The current network `closed` mode creates a network namespace.                                                 | Reject `closed` in the initial pure-Landlock backend.                                                     |
| Existing prompts describe read-only mounts, synthetic `/dev`, and `EROFS`.                                     | Give Landlock its own accurate report and prompt.                                                         |
| The launcher is a security-sensitive binary, while current backend discovery assumes executables on PATH.      | Resolve a packaged helper by absolute path; never search for a user-supplied executable named `landlock`. |
| Existing runtime state and writer leases depend on host process identity.                                      | Preserve PID namespace, `/proc`, runtime location, and ownership records.                                 |

Landlock's handled rights define what a ruleset denies by default; omitted rights are not automatically restricted. The ABI query reports availability, while actual ruleset installation can still fail. These are distinct checks. [Ruleset API](https://man7.org/linux/man-pages/man2/landlock_create_ruleset.2.html)

### Initial product contract

Use `QWEN_SANDBOX=landlock qwen …`, or the existing string-valued `tools.sandbox` setting. Do not invent `--sandbox=landlock` unless the boolean CLI option is separately changed. Bare mode and environment/settings precedence retain their existing semantics. Explicit `bwrap` remains bwrap; `QWEN_SANDBOX=true` retains its present candidate order. A failure never retries the task outside confinement or silently selects another backend.

The supported platform is Linux x64 and arm64, with **Landlock ABI 5 or newer** and successful functional enforcement. ABI 3 adds truncation controls, and ABI 5 adds device ioctl controls; the proposed minimum avoids an ABI-dependent device-policy downgrade. Upstream Linux 6.10 introduced ABI 5, but use runtime ABI detection, not the release string, because kernels may be backported or disable the LSM. ABI 1–4 is rejected, not accepted with a warning. [ABI reference](https://man7.org/linux/man-pages/man7/landlock.7.html)

This minimum deliberately excludes some 6.1/6.6 systems. If target-user measurements later show that these dominate deployment, reconsider a separately named, weaker profile; do not quietly lower this profile's requirements. A newer ABI does not automatically enable new permissions or restrictions: the first helper installs the fixed, reviewed ABI-5 filesystem policy.

The user-facing promise is **filesystem operation restrictions**, not a read-only host filesystem or comprehensive host isolation. Reads remain broad for CLI/tool compatibility. Secret-file confidentiality, metadata operations outside handled rights, network isolation, resource limits, and authority delegated through host services are not provided by this profile.

### Filesystem policy

#### Fixed rights and grants

Handle the ABI 1 filesystem rights plus `REFER`, `TRUNCATE`, and `IOCTL_DEV`. Set the network and scope fields to zero. The helper defines named masks rather than accepting arbitrary masks from configuration.

| Grant                                                             | Allowed operations                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global `/`                                                        | `READ_FILE`, `READ_DIR`, `EXECUTE` only. No global write, truncate, directory mutation, or device ioctl grant.                                                                                                                                                                                                                                                                                  |
| Approved writable directory                                       | Read/execute; regular-file write/truncate; create/remove regular files and directories; symlink, FIFO and socket creation; `REFER`. Never `MAKE_CHAR`, `MAKE_BLOCK`, or `IOCTL_DEV`.                                                                                                                                                                                                            |
| Explicit ordinary writable file, if required by an audited caller | File read/write/truncate only; no directory rights and no inferred parent grant. Initial CLI policy uses directory grants instead.                                                                                                                                                                                                                                                              |
| Terminal/device compatibility exceptions                          | Exact `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom` write access, and the PTY paths required by real shell execution (`/dev/ptmx`, `/dev/pts`, `/dev/tty`). Device ioctl permission is limited to terminal paths. No blanket `/dev` write/ioctl grant. Missing required devices fail startup; optional terminal devices are omitted only in a headless profile verified without them. |

The device list is an implementation acceptance target, not a tested compatibility claim. PTYs, redirected stdio, and ordinary shell tools must pass real Linux tests before release. Global reads mean device nodes are not hidden as they are under bwrap; no GPU/device isolation claim is made.

Use canonical paths and `O_PATH | O_CLOEXEC` rule descriptors, and validate the descriptor's object type before installing its allowed mask. Missing required paths and every failed rule insertion are fatal. The helper supports only regular-file/directory grants and the explicitly enumerated device exceptions. It closes its rule descriptors before executing the child. [Rule API](https://man7.org/linux/man-pages/man2/landlock_add_rule.2.html)

#### Workspace, temporary files, and Git

Preserve the current home/ancestor prohibition, the stricter treatment of settings-supplied extra directories, and validated linked-worktree/common-Git-directory discovery. Reuse their narrowly extracted validation logic; do not reuse the final bwrap grant array.

Grant the workspace, admitted additional directories, validated Git metadata, and admitted cache locations. Instead of granting the host's whole temporary directory, create one private launch directory on the host and set child `TMPDIR` to it. Programs hard-coding other temporary paths may receive a denial; report this instead of broadening the grant. The private directory is cleaned after the supervised launch. Cache roots must pass the same overlap checks as workspace roots.

Canonicalize and verify all grants before launch. Once descriptors have been opened, the rules refer to those objects; if an independently modified path no longer resolves as expected, startup may fail or the later operation may be denied. Do not promise atomic protection against a malicious same-user host process. Test symlinks, pre-existing hard links, renames between directories, and common-directory layouts. Granted Git configuration/hooks can still influence later host Git commands.

#### Protecting operator configuration

Landlock rules within a layer add permissions; a child rule cannot subtract a parent's grant. Additional layers intersect permissions, but do not offer a simple “everything writable except this filename” rule. [Policy composition](https://docs.kernel.org/6.12/userspace-api/landlock.html#layers-of-file-path-access-rights)

The first release therefore **never grants writes to the global Qwen directory itself**. Its `.env`, root-level settings, credentials, and installation metadata remain readable but outside write grants. Protect the directory even if `.env` is absent; the child must not create a replacement `.env`.

Before confinement, create and validate only required data directories through trusted initialization: runtime `tmp` and `debug`, plus global `ide`, `plans`, and `audits` when the enabled feature needs them. Grant those subdirectories, not the parent. This is a closed initial list derived from `Storage`; any additional state consumer requires an explicit review. Do not grant all existing children or enumerate configuration files into a permissive policy. Require state subdirectories to be genuine directories and reject symlink redirection. Keep existing session/runtime paths so a host process can inspect and reclaim the same writer lease.

If an independently configured runtime directory is canonically disjoint from the global Qwen directory, it may receive a directory grant after the same validation. If it equals the global Qwen directory, split it into the approved runtime data subdirectories. Reject layouts where workspace, temporary, cache, Git, or runtime grants would include the global Qwen directory or any ancestor. Examples include launching from `QWEN_HOME` itself or placing `QWEN_HOME` beneath a broadly writable workspace. Check overlap in both directions: a grant below the global Qwen directory is permitted only when entirely inside an approved data subtree; `workspace=~/.qwen/extensions`, `runtime=~/.qwen/commands`, and `cache=~/.qwen/skills` are refused. Also reject aliases that defeat protected-file checks; preserve the current `.env` regular-file/single-link requirement when it exists.

Consequently, global configuration saves, login/token refresh requiring root-level file replacement, extension installation, and self-update are not supported inside this initial profile. Prepare authentication/configuration outside it. Do not move these operations into an automatic privileged host callback. A working preconfigured API-key CLI turn is a release gate; startup identity initialization must be audited and performed before the hop if required, without running workspace-controlled hooks. OAuth refresh and broad managed-state compatibility remain explicit follow-up work.

For `.env`, the single-link/type validation plus directory policy protects content and name replacement through the handled filesystem operations. For other configuration, this proposal protects the named paths and directory entries, not every possible pre-existing hard-link alias; do not claim that all global configuration content is immutable. An existing writable alias is a residual risk that must be recorded in the feasibility tests. It does not make every metadata operation read-only, nor prevent a reachable host service from acting on the process's behalf. Those limits must accompany the `.env` protection claim.

### Network contract

| Requested mode                  | Initial behavior                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`                          | Supported; share the host network, subject to outer restrictions.                                                                                       |
| `proxied`                       | Supported with the existing host proxy lifecycle and normalized proxy variables. Clearly identify routing as advisory; direct traffic remains possible. |
| `closed`                        | Refuse before starting a proxy or payload: `Landlock profile does not support closed network mode; select a backend that supports it.`                  |
| Invalid value or unusable proxy | Refuse; preserve closed-over-proxy precedence.                                                                                                          |

ABI-4 TCP rules grant operations by port, not a destination hostname/IP. They cannot implement the existing whole-network `closed` promise or proxy-only egress. The initial backend does not add a misleading “TCP-only closed” mode. Future stricter networking requires a separate policy design and tests for UDP, DNS, IPv6, Unix sockets, and inherited descriptors. [Network rule API](https://man7.org/linux/man-pages/man2/landlock_add_rule.2.html)

### Helper and launch protocol

Ship `packages/core/vendor/landlock-run/{x64,arm64}-linux/qwen-landlock-run`, with small auditable C11 source in the adjacent `src/` directory. Avoid a speculative line-count target. The TypeScript host builds argv; the helper does not invoke a shell or read workspace configuration.

Proposed interface: `qwen-landlock-run --probe` and `qwen-landlock-run --profile fs-v1 [--rw-dir <absolute-path>]... -- <argv>...`. Read, device, and required-right masks belong to the fixed profile. Expose no arbitrary capability, syscall, or writable-root escape option. Host policy assembly validates root provenance; the helper validates syntax/types and applies the exact grants, not their trust origin.

`--probe` runs in its own short-lived process: query ABI, require ABI >= 5, set `no_new_privs`, create the fixed handled-rights ruleset, install it, then emit a single bounded JSON record: `{"protocol":1,"abi":5,"profile":"fs-v1"}` with the actual ABI value. No success record precedes enforcement. This tests host capability, not every workspace grant or protection property. Real launches always repeat enforcement with their actual grants.

On launch, reject malformed argv/unknown profiles before payload execution; open and validate grants; set `no_new_privs`; install the ruleset; close all helper/grant descriptors; then `execvp` the requested executable. No payload runs when any prerequisite or syscall fails. Failures use exit 125 and a sanitized `qwen-landlock-run:` diagnostic identifying the stage and errno. Successful exec preserves the payload's status, including 125; never infer a setup failure from that exit code alone. [Enforcement API](https://man7.org/linux/man-pages/man2/landlock_restrict_self.2.html)

Only stdin/stdout/stderr are intentionally inherited by the launch; close inherited descriptors >= 3 before acquiring helper descriptors. Tests must cover a writable FD deliberately passed by a caller. Stdio itself is an explicit exception: host redirection to a file opened before confinement remains a capability. Inherited environment secrets and reachable host services are likewise outside the filesystem read/write policy. Landlock does not retroactively revoke already-open file authority. [Descriptor semantics](https://docs.kernel.org/userspace-api/landlock.html#rights-associated-with-file-descriptors)

The host caches a successful, strictly parsed probe result or failure for one process, keyed by helper path/profile. Reject unknown protocol, malformed/oversized output, nonzero exit, timeout, or signal. Apply the existing five-second timeout. Do not persist host capability across launches or infer it from an environment marker.

### Lifecycle and reporting

Keep the host PID namespace and `/proc` view. Run the helper in a supervised process group with inherited stdio, as the current non-container launch does. The helper exec preserves its process identity. Reuse only the small shared process-supervision portion needed by bwrap and Landlock; keep their argv, capabilities, and policy builders separate.

Preserve SIGINT/SIGTERM/SIGWINCH forwarding, exit status 130/143, terminal restoration, readiness cancellation, and proxy cleanup. Configure parent-death signaling in the helper and check for a parent-exit race before exec. This protects the immediate payload; it is not a guarantee that all detached descendants die with the outer launcher. Normal termination must stop the ordinary child process group, while descendants that deliberately detach remain confined but may outlive it. Whole-tree termination under abrupt host SIGKILL requires a separately designed supervisor/cgroup mechanism. [Parent-death semantics](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html)

Set `SANDBOX=landlock` and `SANDBOX_ENFORCEMENT=partial` only in the child environment, preserving the existing marker vocabulary. Here `partial` describes the limited profile, never missing required ABI rights. Add `SANDBOX_LANDLOCK_ABI` and `SANDBOX_LANDLOCK_PROFILE=fs-v1`; helper launch overwrites these from actual enforcement. These are display/re-entry metadata, not authentication or a security boundary. Register/sanitize their reload behavior wherever current sandbox markers are preserved.

`qwen sandbox` reports the backend, ABI, profile, actual write grants, protected configuration directory, and network semantics. The status text is `landlock (filesystem restrictions, ABI N)`; no green “fully isolated” label. A separate Landlock prompt explains `EACCES`, broad reads, advisory proxying, and configuration-write restrictions. It must not assert mounts or hidden device nodes. `EACCES` alone is not proof of a policy denial.

`qwen sandbox --verify` uses disposable host-writable targets with positive controls, rather than the current bwrap-specific fixed host path/network-namespace checks. Its heading is `Declared Landlock profile checks passed`, accompanied by the limits. In-session directory additions cannot widen the installed ruleset: reject an uncovered directory with a restart instruction; `/cd` within covered roots remains permitted. Do not replay a denied command outside confinement.

### Integration and packaging

| Area / current consumer                                                                                   | Planned change                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/config/config.ts`, CLI `config/sandboxConfig.ts`                                       | Add named backend; preserve image-less behavior; special-case absolute helper resolution and structured probe results.                                                             |
| New core utility `landlock-launcher.ts`                                                                   | Resolve assets for source, transpiled workspace, npm installation, and shared-chunk bundle layouts using core's asset anchor; never copy CLI-relative traversal assumptions.       |
| CLI `serve/sandbox.ts` and new small Landlock policy/runner module                                        | Build distinct grants, initialize private temp/state, preserve child environment and Node/Electron launch details; reuse validated Git/root logic without copying bwrap overrides. |
| CLI `commands/sandbox.ts`                                                                                 | Backend-specific inspection, execution and behavior verification.                                                                                                                  |
| Core prompts; CLI `ui/systemInfo.ts`, Footer and shared environment keys                                  | Accurate profile text and actual ABI/marker handling.                                                                                                                              |
| CLI `llm.tsx`                                                                                             | Verify existing docker/podman-only container split; no new container handoff.                                                                                                      |
| Directory/config guards; docs/extension UI commands                                                       | Verify immutable grants and explicit unsupported configuration/install behavior.                                                                                                   |
| `Storage`, `SessionWriterLease`, authentication/settings writers                                          | Audit pre-hop initialization and state paths; preserve ownership namespace/location and test refused root-level writes. No broad state relocation.                                 |
| Core package files, `scripts/copy_bundle_assets.js`, `prepare-package.js`, `create-standalone-package.js` | Verify actual helper inclusion and executable mode in every shipped form.                                                                                                          |

Use pinned musl toolchains and pinned build-image digests for reproducible x64/arm64 binaries. Record toolchain/source hashes, compiler/linker flags, license notices, and output hashes. CI rebuilds and compares bytes; floating `apt install musl-tools` alone is not a reproducibility contract. Users neither compile nor download an executable dynamically at startup. Do not copy external helper source without reviewing its license.

Unsupported architecture, missing asset, non-executable/noexec installation, unsupported ABI, disabled LSM, or an outer syscall denial all produce explicit unavailability. A correctly packaged binary is not evidence that the host can enforce it.

### Verification and implementation stages

| Stage                                         | Deliverable and gate                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Feasibility, before production integration | Native helper prototype in a disposable Linux environment; prove fixed rights, device/PTY operation, configuration protection, and ABI failure paths. Audit normal API-key startup and state writers. No automatic fallback or binary distribution yet. |
| 2. Helper and distribution                    | Reviewed source, pinned reproducible binaries, probe protocol tests, and actual npm/standalone asset checks on x64 and arm64.                                                                                                                           |
| 3. Explicit CLI integration                   | `open`/`proxied` normal turns, independent inspection/verify, accurate prompt/UI and failure behavior; unchanged bwrap tests.                                                                                                                           |
| 4. Real Linux CI                              | Dedicated no-credential suite plus compatibility matrix; release only after the matrix passes and reported limitations match observed behavior.                                                                                                         |

Required behavioral evidence:

- Allowed write/create/delete/rename/truncate operations succeed inside granted roots. A sibling file proven host-writable cannot be modified through open/write, `O_TRUNC`, truncate, rename replacement, or hard-link relocation; verify original bytes and directory entries.
- Global `.env` content and path survive direct writes, truncate, unlink, symlink/rename replacement, and hard-link attempts. Test present and absent `.env`, overlapping roots, and redirected state paths; forbidden layouts fail before any payload marker is written.
- Git ordinary/linked worktrees commit successfully; cross-boundary writer conflict/reclaim preserves transcript and host namespace identity. This is service-level ownership evidence, not full daemon handoff certification.
- Real fake-model CLI turns execute real shell tools in `open` and `proxied` modes; the proxy sees traffic and terminates. `closed` and invalid modes never start proxy/payload. A direct connection remains possible in `proxied` and is reported as such.
- Device/PTY behavior, terminal resize, SIGINT/SIGTERM, proxy failure/readiness cancellation, extra inherited FDs, and immediate parent death are exercised. Report detached-descendant observations separately from ordinary process-group cleanup.
- Probe/launch rejection covers ABI 1–4, no Landlock, disabled LSM, seccomp denial, missing/wrong-arch/noexec helper, malformed probe, and ruleset failures. Simulated syscall failures test control flow; actual kernel matrix runs establish enforcement.
- Include an isolated environment where namespace creation is denied but Landlock calls are allowed, proving the intended deployment value. Do not change shared-host sysctls or disable its security policy.
- Test ABI 5 and a newer ABI on real kernels, on both supported architectures for packaging/execution. A newer kernel with mocked ABI results does not substitute for the minimum-kernel behavioral run. Unsupported CI prerequisites fail visibly instead of skipping green.
- A no-confinement negative control runs only disposable file cases and must fail their assertions. Secrets, host configuration and fixed system paths are never used as destructive test targets.

### Tradeoffs and release decisions

The recommended first version is deliberately explicit and narrower than bwrap: ABI >= 5, filesystem policy only, no `closed`, and protected global configuration with selected writable state subdirectories. This makes limitations inspectable and avoids a silent fallback changing the user's policy.

Before implementation is accepted, maintainers must validate the two practical assumptions through Stage 1: enough target environments provide ABI >= 5, and preconfigured CLI use works with global configuration writes disabled. If either fails, revisit the product profile or state layout in a separate design update. Do not unblock delivery with partial required rights, a writable global Qwen parent, host callbacks for arbitrary denied writes, or automatic unconfined retries.

Strict secret-read isolation, OAuth refresh/global settings compatibility, complete network denial, scope controls for signals/Unix sockets, seccomp, detached-process containment, automatic backend selection, and per-tool approval remain separate work. This document is ready for feasibility work; it is not evidence that a deployable Landlock backend already exists.
