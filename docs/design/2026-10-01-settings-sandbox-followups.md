# Settings and sandbox follow-ups (#12417)

[English](2026-10-01-settings-sandbox-followups.md) | [简体中文](2026-10-01-settings-sandbox-followups.zh-CN.md)

## Problem and current state

PR #13119 made settings replacement atomic. Remaining startup paths report malformed operator settings inconsistently, boolean argument parsing loses named sandbox selections, and recovery metadata still refers to User settings although only Workspace recovery remains possible. The sandbox command waits for backpressure but can exit before a final buffered write completes. Both backend relays read ahead on shared regular-file stdin and can remain blocked on an idle named FIFO after the payload exits.

## Goals and scope

Preserve operator policy, make refusals actionable, report the effective boundary, and preserve ordinary command input/output semantics. Keep the existing sandbox policy and atomic publication algorithm. Add regression coverage for BOM reload, private save-directory events and failures, and native Windows replacement. This is a bugfix, not a new sandbox configuration surface.

## Design

Operator read and parse failures use the existing fatal configuration error contract (exit 52). The entrypoint reports the error once without a stack or argument help. Repair instructions name the original file; User preservation copies never authorize resetting operator settings. Workspace recovery remains separate, with exact-path Workspace metadata propagated through relaunch and the existing dialog. Snapshot and preserve-invalid callers retain their refusal semantics.

Normalize explicit sandbox selection before yargs boolean coercion, stopping at `--`. Preserve bare boolean selection and positional prompts. The sandbox inspector reports inherited whole-CLI markers separately from tool confinement. Migration checks normalize both environment markers. Report npm as not probed and include the admitted command network policy in the model prompt.

Wait for stdout and stderr write completion, including a final write below the backpressure threshold. Keep downstream error handlers until completion and preserve EPIPE cancellation.

For regular files and named FIFOs, relay bytes through a private pipe rather than exposing host-backed descriptors. A native helper supervises the backend: positional regular-file reads leave the shared offset unchanged while running; after child exit, advance it by bytes written minus bytes still queued in the private pipe. Poll nonblocking FIFO input and child completion together, so an idle writer cannot prolong exit. Directly inherited anonymous pipes, sockets and character devices remain explicit caller capabilities. Closed networking prevents new ordinary IP connections; it does not revoke existing standard-stream capabilities.

## Constraints and risks

Both backend relays consume the input helper; other Linux architectures retain directly inherited pipe/TTY execution but reject host-backed stdin without a supported helper; their status transport, payload attestation and cancellation behavior must remain intact. Bundled Linux x64 and arm64 helpers must rebuild reproducibly with the pinned compiler. Regular-file offset accounting concerns bytes consumed from the OS descriptor, not application-level parser consumption. Concurrent readers sharing stdin are outside this accounting contract. Do not grant a linked worktree's external Git metadata implicitly. A successful backend probe establishes admission, not full-session viability under every TMPDIR or environment setting.

## Validation and acceptance

Use isolated global-CLI baseline cases and repeat against the built CLI for interactive, headless, MCP, serve and ACP startup. Require one actionable refusal, a nonzero exit and unchanged malformed operator files. Cover named flags, aliases, boolean flags and tokens after `--`; BOM reload and Workspace recovery; final stdout/stderr bytes through slow real pipes; downstream close; zero-read and partial-read regular files; FIFO exit with a live idle writer; inherited connected descriptors; and preservation of original files on native Windows sharing violations. Run Linux kernel boundary checks separately from fake-backend transport tests. Build, typecheck, focused unit tests, independent verification and review are required. Platform cases are not considered verified until exercised on that platform.

Native CI also runs the public CLI verification matrix and ordinary shell tool calls under the runner's own UID. A local fake model endpoint drives the real agent/tool loop; it does not establish authenticated provider or full-session viability. Run native Windows publication tests independently so unrelated full-suite failures cannot hide their result.

Create the host verification fixture before probing the backend, so an unusable TMPDIR reports the original host path and repair action without implying that the sandbox boundary was tested. Clean up that fixture after admission or verification failures. Inspection and explicit command execution do not create a verification fixture.

## Release communication

Document that malformed SystemDefaults, User and System settings block startup rather than silently resetting. The generated changelog is not edited by hand; include this behavior in the fix's release description and user documentation. Keep #12417 open until the tracking acceptance matrix, including native platform evidence, is complete.
