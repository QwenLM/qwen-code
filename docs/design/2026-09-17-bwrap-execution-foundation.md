# bwrap execution foundation

[English](2026-09-17-bwrap-execution-foundation.md) | [简体中文](2026-09-17-bwrap-execution-foundation.zh-CN.md)

## Status and problem

This is the first independent implementation slice of the tool-execution sandbox work previously collected in PR #12064. It adds an internal execution foundation. Runtime policy, tool routing, public settings and retirement of the whole-CLI bwrap backend belong to subsequent changes. Existing CLI entrypoints retain their current behavior.

The shell service currently launches command strings through a shell. A sandbox adapter needs literal executable/argv, an exact environment, stdin transport for workers, and the same pipe/PTY lifecycle without reconstructing a shell command. It also needs completion evidence that a payload cannot forge through ordinary output.

## Execution contract

`ShellExecutionService.executeLaunch` accepts an absolute executable, literal argv, absolute cwd, an exact environment and optional string/Buffer stdin. It snapshots caller-owned values before asynchronous initialization. Stdin is pipe-only and closes after the supplied bytes. PTY callers must provide `TERM`; POSIX PTY callers must provide `PWD` matching cwd. The existing command-string `execute` API retains its environment preparation and shell parsing.

Both APIs share output, cancellation, background promotion and terminal management. Pipe streaming identifies stdout/stderr per chunk; after the child exits, trailing stdio keeps flowing and settlement happens on stream closure or a bounded post-exit drain (1s), whichever comes first, so a grandchild inheriting the pipe cannot wedge settlement. The per-chunk `stream` tag is plumbing for the next slice: the daemon UI protocol already models it and no core consumer reads it in this slice. Fallback from PTY to pipes is permitted only before a process has been created; a failure after spawn must not replay the payload. Input bytes are caller-owned and are not given a new arbitrary size cap by the launch API. A transport-level stdin failure is reported as the execution error only when the process left no exit information; otherwise the process's own exit status is authoritative.

## Linux adapter and trusted completion

`executeBwrap` takes trusted workspace, installation and runtime-state directories, a read-only/workspace-write filesystem policy and an open/closed network policy. It canonicalizes paths and rejects writable grants overlapping HOME ancestors, installation/state, worker/runtime binaries or protected system paths. Cwd must be inside the workspace. Each execution receives private scratch and a separate host control directory.

The adapter mounts the host root read-only, optionally makes the workspace writable, mounts private scratch, creates a private PID namespace with fresh procfs and minimal devices, and optionally creates a private network namespace. It removes internal Qwen secrets from the explicitly supplied payload environment and assigns canonical `PWD` and private temporary paths. A trusted installed Node relay starts with a minimal bootstrap environment that is separate from the payload environment.

The relay reads bwrap's dedicated status FD, which the payload does not inherit, and writes a bounded result to an exclusively created, no-follow, mode-0600 regular file in the protected control directory. A final valid bwrap exit record confirms payload execution and its exit code; the initial child PID is not proof of successful exec. Missing or malformed evidence remains `unconfirmed`. Signal/cancellation produces `interrupted`; a promoted process is `running` until its separate settlement promise completes. None of these states authorizes automatic retry or execution outside bwrap.

The relay checks parent identity before spawn and polls parent liveness every 100 ms. Relay exit lets bwrap's parent-death handling terminate the private namespace. Scratch/control resources live through background promotion and are removed at terminal settlement. Retention for inspection is scoped to genuine post-exec uncertainty: the receipt attests a payload exit record, or the receipt file exists but is unreadable (the relay died after creating it). Setup failures before payload exec — a missing bubblewrap or payload binary — are positively attested by the receipt and clean up normally, and their error reads "did not run" rather than the ambiguous unconfirmed message. Crashes can leave directories; recovery/garbage collection is not implemented here. One streaming nuance: an abort that arrives inside the post-exit drain window settles with `aborted: true` while a detached grandchild holding the pipe survives — `aborted` no longer implies the whole tree was torn down.

## Confined file worker

The installed worker consumes a newline-terminated JSON header of at most 16 KiB followed by binary content on stdin. The header contains an absolute destination, expected file version or absence, and the exact binary content length; a short or overlong body is rejected. The version records device, inode, size and nanosecond modification/change times. Binary content has no extra protocol size cap; the trusted caller and worker buffer it in memory.

The worker checks freshness, creates parents, and uses the existing atomic writer, including its pre-commit freshness check and mode handling, inside bwrap. The host client never opens the destination for writing. It treats the trusted exit status as the commit outcome and parses the worker reply on failure for structured diagnostics. Read-only policy rejects writes. Kernel mount restrictions constrain symlink traversal. Version checks detect observed changes but do not provide a filesystem compare-and-swap guarantee against every concurrent writer.

## Packaging and affected components

The change adds the launch API to the existing core shell service, low-level modules under `packages/core/src/sandbox/`, collocated unit tests and the standalone `scripts/sandbox-prototype/` verifier. The main bundle builds the relay and file worker separately and the package manifest includes both assets. Module builds resolve adjacent workers; bundled builds resolve the shipped assets. Missing assets fail before execution.

No runtime configuration consumer or CLI switch enables this adapter in this PR. Runtime/tool integration is the next dependent PR, followed by the complete CLI cutover and public Linux acceptance workflow. Keeping activation separate prevents an intermediate public setting from enabling incomplete tool coverage. Landlock remains deferred.

## Constraints and risks

The adapter is Linux-only and requires a working unprivileged bwrap installation. Restricted host user-namespace policies may require operator preparation. The library does not modify kernel/AppArmor settings. Shared shell lifecycle changes need regression coverage for existing callers, including platforms that do not use bwrap.

This is write and command-network confinement, not secret confidentiality or complete host isolation: broad host reads and pathname Unix sockets remain available. Payload environment values currently travel in bwrap's `--setenv` argv and are readable from `/proc/<pid>/cmdline` while the launch runs; credential-bearing environments must not use this adapter until the routing slice supplies a non-argv environment channel. Same-user trusted host processes, hostile changes to workspace ancestors from outside the sandbox, hard-link aliases and all-host crash cleanup are outside this boundary. General user path-policy admission, permissions, backend selection, model/CLI tool routing, Bun standalone support and macOS/Windows sandbox backends are out of scope.

## Verification and acceptance

Build, typecheck and bundle must succeed on the extracted branch. Unit tests cover literal argv, exact/snapshotted environments, stdin EOF and early closure, PTY requirements and no replay after spawn, status parsing, binary worker framing, version checks and client result handling. Existing shell-service tests remain part of this regression run.

The standalone verifier must pass all 36 cases on real Linux with native PTY. It checks namespace identities, filesystem/network isolation, literal argv and bootstrap environments, cancellation, timeout, promotion, inherited-stdio settlement, parent death, worker writes and receipt spoofing. Negative controls check the outside-write and network-denial predicates against successful host access. Missing prerequisites fail; mocks and numeric PIDs alone do not prove confinement. Artifact hashes before/after execution, source-input manifests and the recorded dirty-worktree flag identify the tested candidate. Package inspection must show both worker assets; a CLI version smoke confirms packaging only, not public sandbox enablement.

Run `node scripts/sandbox-prototype/build.mjs /absolute/empty/install`, then install the locked native PTY dependency without changing the hashed installation manifest: `npm install --prefix /absolute/empty/install --no-save --package-lock=false @lydell/node-pty@1.2.0-beta.10`. Execute that installation's `verify.mjs`. Use disposable, disjoint installation, state, workspace and temporary roots. Record current results in the PR's separate test report; results from the larger PR do not substitute for this extracted branch's validation.
