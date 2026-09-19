# Runtime file tools in the execution sandbox

[English](2026-09-16-runtime-file-sandbox.md) | [简体中文](2026-09-16-runtime-file-sandbox.zh-CN.md)

## Status and problem

Implemented internal integration stage, 2026-09-16, following [runtime Shell integration](2026-09-16-runtime-shell-sandbox.md). Before this stage the registry exposed only Shell and task_stop. The prototype file worker accepted small UTF-8 JSON writes, replaced symlinks, and did not preserve existing modes. Production Write/Edit additionally created directories on the host. Simply registering those tools would both bypass confinement and leave existing files uneditable without Read's prior-read cache.

## Scope and policy

Keep the existing trusted-host-only bare noninteractive admission and fixed workspace ceiling. Register the existing Read, Write, Edit, Shell and task_stop tools. No settings, environment switch, public CLI flag, Landlock implementation, or legacy whole-CLI removal is included. Other tools, hooks, MCP, LSP, extensions and worktree effects retain their previous restrictions. Custom filesystem delegation is rejected in this mode; ordinary runtime delegation is unchanged.

The completed runtime-integration branch also prepares the next public CLI stage by admitting Monitor, Glob, LS and same-workspace in-process agents under the same immutable policy. Monitor uses the runtime shell executor; nested agents inherit the policy and cannot request worktrees, alternate working directories, teammates, custom executors, hooks or MCP servers. These additions do not create a public enablement path in this stage, and the unsupported variants fail before setup. The tracked verifier's registry assertions include this final internal runtime set.

The current filesystem policy allows host reads and does not promise read confidentiality. Read keeps its existing content processing and inode-based prior-read cache. Reject PDF processing before any metadata probe, extraction or rasterization can start a host subprocess; users may invoke suitable utilities through confined Shell. Ordinary image processing is in memory and host model requests retain their trusted-runtime status.

## Write execution

Add one internal runtime write helper at the final Write/Edit write sites. Without policy it delegates to the existing FileSystemService, including tool-write provenance. With policy it uses the existing text encoder to preserve charset, BOM and line endings, then sends bytes to the installed worker through the existing confined pipe launch. Directory creation moves into the worker; the tool's host mkdir is skipped. Read-only policy rejects file mutations, even with YOLO. No failure retries on the host.

Capture an expected regular-file version before reading/preparing the original content: device, inode, size, mtime and ctime, using bigint stat fields serialized as decimal strings; a missing file is null. Never refresh that version after reading. The worker checks the version before creating directories or temporary files and again through atomicWriteFile's assertCanCommit callback immediately before commit. A changed/replaced/disappeared/appeared target fails with a structured stale-file error that asks the caller to re-read. This narrows the added worker-launch race window; it is not atomic compare-and-swap and does not provide locking against arbitrary simultaneous writers.

Replace the prototype JSON-content transport with a bounded JSON header followed by newline and raw encoded bytes. The header is at most 16 KiB and validates operation, absolute destination and version shape. Content is not subject to the prototype's 1 MiB JSON limit; the tool's existing in-memory text preparation remains. The worker reuses atomicWriteFile for mode preservation, fsync, symlink-following behavior and its established ownership/cross-device fallbacks. Existing in-workspace and dangling symlinks retain their meaning; paths resolving outside writable grants are denied by the kernel. Special files are rejected even when the prior-read cache is disabled.

The worker returns structured success or filesystem error codes. The client accepts success only with a confirmed sandbox receipt, exit zero and a valid reply; uncertain completion is never replayed. Preserve ordinary tool errors, confirmation, replacement matching, diff display, artifact metadata and post-write cache updates. Existing attribution records only update host memory. File-history backups, when explicitly enabled, remain trusted runtime writes to protected session storage; they do not authorize workspace writes or rewind tools.

## Affected code and compatibility

Core Config changes only the restricted tool registry/allowlist and rejects custom filesystem services. Write/Edit capture versions and route the final mutation. The shared file-content pipeline rejects PDF host processing under policy. The worker/client transport and Linux prototype verifier change together; this API is internal and has no public compatibility promise. Encoding and atomic-write implementations are reused rather than duplicated.

Historical runtime Shell and API-stage evidence remains labeled by its frozen artifact. This stage rebuilds both worker assets and reruns the corresponding Linux acceptance after the protocol change. Remaining file-producing tools, full frontend/effect inventory, read confidentiality, inode-wide hard-link immutability and atomic CAS remain outside this stage.

## Validation and acceptance

Use the repository feat-dev and e2e-testing workflows. Before implementation, drive the global CLI with a deterministic local model and disposable workspace/HOME/state to establish native Read/Edit semantics and unconstrained outside writes. Keep the ordinary installed CLI baseline distinct from the internal policy launcher.

Unit coverage must check default delegation, policy routing without host mkdir/write, version drift and absent/appeared targets, regular-file enforcement, structured worker failures and custom-adapter rejection. Preserve the existing Write/Edit/Read suites. On real Linux drive production Read/Write/Edit turns, verify the restricted registry, Unicode and non-UTF-8 bytes, BOM/CRLF, existing modes, nested creation, allowed and denied symlink traversal, read-only denial, two runtime ceilings and cancellation without replay. Add deterministic worker-level stale-version tests and content larger than the old 1 MiB cap. PDF rejection must be proven before a helper process launches. Rerun existing Shell lifecycle and adapter tests.

Acceptance requires build, typecheck, bundle, focused tests, matching final source/artifact hashes, two clean self-audits and independent review. Record exact results and limitations in .qwen/e2e-tests/runtime-file-sandbox.md. No unresolved design choices remain for this internal stage.

## Verification results

On 2026-09-16 the global qwen 0.23.4 baseline completed seven actual Read/Edit calls before implementation. The candidate passed 31 production headless runtime groups and 34 adapter/worker groups on Lima qwen-sbx, ARM64 Linux 7.0.0-31-generic, Node 22.22.1 and bubblewrap 0.11.1. These include the existing Shell lifecycle, private PID namespace cleanup, file semantics, outside-write denial and failed setup without host replay. Raw binary payloads larger than 1 MiB, empty content, mode/symlink preservation, stale/replaced/removed/appeared targets and FIFO rejection passed in the worker harness.

Build, typecheck and bundle passed. Focused core and CLI tests passed 3,328 cases with one pre-existing skip. The runtime artifact has 4,791 matching source inputs; launcher SHA-256 is `18a7a557bf41e8ecc3baa3de1a6826fccc21a7fb93cbac3f49584d83a362b8e1`. The adapter artifact has 278 matching inputs; its worker SHA-256 `439e880137e0ef7ab383fb54f8d4f42804a406e363c6513468a102c7f90e3a18` matches the production bundle worker. Exact evidence and cleanup records are in `.qwen/e2e-tests/runtime-file-sandbox.md`.

The Linux evidence covers this ARM64 environment. Linux x64, other kernels, public frontend enablement and Landlock remain unvalidated or unimplemented. Cancellation and uncertain receipt handling use the existing real-Linux adapter lifecycle checks plus file-client unit rejection tests; the runtime file groups do not interrupt an in-progress file commit. No atomic compare-and-swap or general rollback guarantee is claimed.

Two clean self-audit passes and independent review found no remaining actionable issues. Package dry-run included both installed workers; final source and worker hashes were rechecked afterward.
