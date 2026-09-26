# Managed Context Worker (W0c-1)

[English](2026-09-26-managed-context-worker.md) | [简体中文](2026-09-26-managed-context-worker.zh-CN.md)

Status: implemented in the worker. The Broker (W0c-2) and the control plane (W0c-3) do not use it yet. Updated: 2026-09-26. This is the first slice of W0c, the execution directory of the Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380), tracked in [#12724](https://github.com/QwenLM/qwen-code/issues/12724). It implements the worker side of the [Managed Context Envelope](2026-09-25-managed-context-envelope.md) (W0a-2) on top of the [Workspace binding contract](2026-09-25-managed-workspace-binding-contract.md) (W0a). Below, "the envelope" means that design, and "the reference design" means the proposal's [Workspace and Session cwd design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-workspace-context.en.md).

## Problem

The envelope defines boot v2, ready v2, attestation v3 and context installation, but no worker serves them. The worker still runs every tool call of every Session in the one directory that boot v1 names. The Broker therefore has nothing to offer `managed-context/1` to, and a Session cannot run its tools in the directory that its Workspace binding names.

## Current state

The facts below are from `main` at `16496a71ec`.

- **Boot.** The worker reads one boot document from standard input: at most 32 KiB, closed within 30 seconds. It accepts exactly the 14 keys of boot v1. An invalid document makes it exit with status 1 before it writes the ready line.
- **Routes.** It serves attestation v2 and the Tool v2 `execute`, `status` and `cancel` routes. A raw gate admits exactly those four routes and answers every other request it receives with an empty 404.
- **Tools.** One tool executor runs `read_file`, `write_file`, `edit` and foreground `run_shell_command` for every Session. Their configuration is rooted at `workspaceCwd`, so it is the starting directory of every call. An in-memory journal, keyed by the call's `callId`, keeps each invocation for the life of the process.
- **Envelope.** `managed-context-envelope.ts` validates boot v2, ready v2, attestation v3 and installation requests, and keeps installations idempotent. Only its tests import it. Its installation checks stop before step 6, the directory verification.
- **Fake worker.** `fake-attestation-worker.mjs`, which the Java provisioner tests start, parses its boot document without checking it and serves only v1.

## Goals

- Accept boot v2 and answer with ready v2, and refuse every other document before the ready line.
- Under boot v2, serve attestation v3 and context installation, and answer 404 to attestation v2.
- Implement step 6 of the installation: verify the effective directory, or answer 409 `managed_context_unavailable` and record nothing.
- Under boot v2, run a new tool call only for a Session with an installed context, in that context's effective directory, verified again for each call.
- Teach the fake worker both closed boot key sets and the v2 answers, for the Broker work in W0c-2.
- Settle the envelope's open questions that the worker has to answer.
- Leave the behavior of boot v1 unchanged.

## Non-goals

- **The Broker.** The provisioner still writes boot v1. The v3 clients, the retry bound and the tighter identifier checks are W0c-2.
- **The control plane.** Session and storage resolution in `managed-agent-server`, and the Workspace turn lease, are W0c-3.
- **Configuration installation.** The worker checks and digests `contextConfigRef` but installs no configuration from it.
- **Changing an installed context**, which needs the W2 directory-change protocol.
- **A sandbox.** The effective directory is where tools start. Confining tool paths stays with the Harness, as the Tool v2 contract requires.

## Design

### Boot and readiness

The worker reads the boot document as before. It accepts either exactly boot v1, which is unchanged, or a document that the envelope's boot v2 rules accept. A boot v2 document must also be valid UTF-8: bytes that are not are refused, where boot v1 still replaces them. Anything else makes it exit with status 1 before it writes to standard output. Its standard error carries a fixed message and a stack trace, never the document. The worker writes no refusal line (see [Open questions of the envelope](#open-questions-of-the-envelope)).

Under boot v2 the ready line is ready v2, built from the boot document and the listening port. Like v1, it carries no token.

### Routes

| Route                                                 | Boot v1     | Boot v2                                   |
| ----------------------------------------------------- | ----------- | ----------------------------------------- |
| `POST /internal/managed-runtime/v2/attest`            | attestation | 404                                       |
| `POST /internal/managed-runtime/v3/attest`            | 404         | attestation v3                            |
| `POST /internal/managed-runtime/v3/context`           | 404         | context installation                      |
| `POST /internal/managed-runtime/v2/execute`           | Tool v2     | Tool v2, behind the activation gate below |
| `POST /internal/managed-runtime/v2/status`, `/cancel` | Tool v2     | Tool v2                                   |

The raw gate admits exactly the routes of the boot version, so a Runtime never presents two identities, and a peer that sees 404 on a v3 route knows the worker is incompatible. The v3 routes keep the discipline of the owned routes: the bearer token, `Cache-Control: no-store`, the lease headers, and an uncompressed JSON body of at most 16 KiB. They use the same error codes.

Attestation v3 is the envelope's check. It compares the request with the boot document and never touches the filesystem.

### Context installation

The handler runs the envelope's steps in order. Steps 1 to 5 never touch the filesystem. A request that passes them and does not repeat a recorded installation reaches step 6, which verifies the effective directory:

1. **Mount root.** `mountRoot` must be absolute on this host: a drive or UNC path on Windows, a path starting with `/` elsewhere. The boot rule also admits the other platform's forms, which would otherwise resolve against the worker's working directory. The worker resolves the root to its real path. The root may itself be reached through a symbolic link, because the Broker configured it.
2. **Mount identity.** The first successful verification pins the root's device and inode, as `stat` reports them, for the Runtime's lifetime. Every later verification requires the same two values. This refuses a root unmounted to the directory beneath it, a volume remounted on another device node, and a root directory replaced by another whose inode differs. It does not detect everything. On APFS and ext4 every volume root has the same inode and a freed device node is reused, so a different volume mounted where the first one was can keep both values. Some file systems also reuse a freed inode at once, so a root deleted and recreated in place can keep them too. The worker cannot tell which storage backs a path: whoever changes the mount must replace the Runtime. The directories below the root are still verified on every call.
3. **Effective directory.** The effective directory is the real root joined with the segments of `cwdRelative`, which W0a's normal form writes as `.` for the root and otherwise without `.` or `..` segments. Its real path must equal that path exactly. So no segment below the root may be a symbolic link, whether it points inside the Workspace or out of it. Where the real path reports a name as it is stored, as on macOS and Windows, a segment whose letter case differs from the disk is refused too, and so, on macOS, is a name in another Unicode normalization form. On a file system whose real path repeats the requested name, such as a case-folding volume on Linux, such a segment names the same directory and is accepted.
4. **Access.** The effective directory must be a directory that the worker can read and search. On Windows this check cannot see access-control lists, so there it only confirms that the directory exists.

If any check fails, the answer is 409 `managed_context_unavailable` and nothing is recorded, so the same request succeeds after a repair. A repeated installation returns its original receipt without a new verification.

Refusing every link keeps the starting directory equal to the path the binding names. A link inside the Workspace would be followed on some calls and not others, because the Workspace's own tools can retarget it at any time.

Verification is asynchronous, so two installations can be verified at the same time. After the verification, whether it passed or failed, the worker checks steps 4 and 5 again before it answers. Concurrent requests therefore get the answers they would get one after the other: the first to record wins, a repeat returns its receipt even if its own verification failed meanwhile, and a conflicting installation is refused. The root is the one exception: if it changes while the first verifications are in flight, the first to pass pins the root it saw. A verification that saw a different root is refused, even if it saw its root earlier. A root that changes needs a new Runtime anyway (step 2).

### Activation gate

Under boot v2, a new `execute` call passes a gate before the journal records it:

- Its `sessionId` must have an installed context. Otherwise the answer is 409 `managed_context_unavailable`.
- The Session's effective directory is verified again, with the checks of step 6 and the pinned root. If it fails, the answer is 409 `managed_context_unavailable`.
- The call then runs in that directory. Its tools use a configuration built for the call right after the gate, whose working directory and workspace are the effective directory, so what the tools see of the directory is never older than the call's own verification.

The request's shape and the tool name are checked before the gate, as today. A refused call is not journaled, so `status` answers `unknown` for it, and a retry after a repair runs it. A call that is already journaled is joined, or answered from the journal, without the gate, so a settled result stays readable after its directory is gone. Identical calls at the gate together are journaled once: if one of them is journaled first, the others join it, whatever their own gate answered. `status` and `cancel` never pass the gate, because they only read or cancel journaled calls.

A `status` or `cancel` that arrives while a new call is still at the gate answers `unknown`, as it would for a call that has not arrived yet, and the call then runs unless the gate refuses it. Closing the worker likewise aborts the calls that are running, but not one still at the gate.

Each call runs as its Session. Its shells see `QWEN_CODE_SESSION_ID` set to a key derived from the Runtime instance ID and a hash of the Runtime Session ID, which may hold characters that are not safe in a file name, and `QWEN_CODE_PROJECT_DIR` set to the project directory of the Session's effective directory. Core derives that directory from the path, so two directories whose names differ only in punctuation share one. Under boot v1 both keep their values: the Runtime instance ID, and the project directory of `workspaceCwd`.

The directory is fixed when the call is journaled. The Shell tool checks a `directory` parameter against its workspace, which is now the effective directory, so a call whose `directory` lies outside it settles as an error without running. That check is the tool's own, made when the call starts, and like any path in tool input it is not a boundary (see [Security](#security)): a command can still change directory.

The gate and the tool's start are not atomic. A directory replaced between them is detected only by the next call. This is acceptable because the effective directory is a starting point, not a sandbox (see [Security](#security)).

Under boot v1 there is no gate, and every call runs in `workspaceCwd`, as before.

### Retention

A Runtime keeps its installations for its lifetime, as it keeps its tool journal. Nothing is evicted, so step 5 keeps protecting a live Session, and an `operationId` reused with other values is always refused. The Broker bounds that lifetime when it reclaims the Runtime. Each entry holds only bounded fields, a few kilobytes at most. Tool configurations are not kept: each call builds its own, in its Session's context so that core does not keep it for its debug log, and core compiles each parameter schema that JSON text describes exactly only once, so rebuilding adds no compiled validators. Each Session also keeps three small entries under its key for the Runtime's lifetime, as its installation is kept: its project directory, and core's record of its model and model identity. Releasing a Session's entries earlier needs a signal that the Session has ended. The Broker's `release` session verb is that signal, and it has no worker route yet.

### Errors

The envelope's error table gains no code or status; its `managed_context_unavailable` row now also names `execute`. Under boot v2, `execute` can answer 409 `managed_context_unavailable`, with the usual `code` and `error` body. The shape of Tool v2 is unchanged, and a worker booted with v1 never answers this code. The W0c-2 client classifies it as the envelope requires: the Session's tool gate stays closed, its context becomes `recovery_blocked`, and nothing falls back to another directory.

### Fake worker

The fake worker accepts a boot document only if its keys are exactly those of boot v1 or of boot v2, with the matching version and, for v2, the protocol token. It checks only `type`, the version and, for v2, the protocol token, not the other values. Otherwise it exits before the ready line, without echoing the document. So the provisioner tests, which write boot v1, now fail if the provisioner adds or drops a key. Under boot v2 the fake answers:

- ready v2;
- attestation v3, built from its boot document;
- installations, echoed as receipts without any check, and 400 for a body it cannot read;
- 404 for attestation v2.

A Java test pins these answers to the shared fixtures, and checks that the fake refuses documents outside both key sets.

## Open questions of the envelope

The envelope left four questions to W0c. The worker answers them as follows:

1. **Refusal line.** The worker writes none. A worker that implements only v1 cannot write one, so the Broker could never rely on it. Instead, W0c-2 bounds boot v2 retries and never retries as v1.
2. **Configuration installation.** Still open. This slice installs no configuration, and the route keeps its v3 shape. Whether the installation request carries it, or a later version of the route does, is undecided.
3. **Control characters in `cwdRelative`.** The worker applies the W0a rule unchanged, which refuses every Cc character. If W0a narrows the rule, the worker follows it.
4. **Retention.** A Runtime's lifetime, as above. Releasing entries earlier waits for the session verbs.

## Security

- The bearer token stays on standard input and in the header. It appears in no response, error or log line.
- An error never carries `mountRoot` or the effective directory. Only attestation v3 repeats `mountRoot`, as the contract requires.
- Verification follows no symbolic link below the root, so a link in the Workspace cannot move a Session's effective directory, inside the Workspace or out of it.
- The effective directory is where tools start, not a sandbox. Absolute paths in tool input still reach whatever the worker's user can reach. The Harness decides the Workspace boundary when it admits a call, as the Tool v2 contract requires.

## Files affected

- `packages/cli/src/serve/managed-context-worker.ts` (new): the boot v2 routes, the mount verification and the activation gate. Its test (new) replays the shared fixtures over real HTTP and exercises a real filesystem.
- `packages/cli/src/serve/managed-context-envelope.ts`: installation takes the step 6 verification and exposes a Session's installed binding.
- `packages/cli/src/serve/managed-runtime-attestation-worker.ts`: boot dispatch, the routes of each version, and ready v2.
- `packages/cli/src/serve/managed-runtime-tool-executor.ts`: the tools come from a resolver asked before each new call is journaled. Boot v1 builds them once at startup; boot v2 builds them for each call. Each call runs as its session, whose project directory is registered for its shells.
- `packages/cli/src/serve/managed-runtime-tool-routes.ts` and `managed-runtime-attestation-contract.ts`: the 409 for an unavailable directory, a route gate parameterized by boot version, and one JSON body parser for every owned route.
- `packages/core/src/utils/schemaValidator.ts`: a parameter schema that JSON text describes exactly and that compiles is compiled once per validator, keyed by that text; any other schema is compiled as Ajv always compiled it.
- The fake worker, its Java test, a helper it shares with `LocalProcessRuntimeProvisionerTest`, and the tests of the attestation worker, the tool worker, the envelope and the schema validator.
- `packages/cli/src/serve/managed-workspace-binding.ts`: its header comment only.
- This document in both languages; the status, errors, open questions and follow-up work of the envelope document; the status and the wiring line of the W0a document; and pointers here from the worker section and the error classes of the Tool v2 contract document.

## Validation

- **Shared fixtures over real HTTP:**
  - Every boot case passes through the worker's standard-input reader.
  - Every attestation case is sent to a worker booted with the fixtures' boot document.
  - Every installation sequence is sent to a fresh worker whose mount root is a temporary directory holding the directories that the fixtures install.
- **Directory checks on a real filesystem:**
  - missing directories, files, and links inside and outside the Workspace;
  - a mount root that is missing, a file, reached through a link, or in the other platform's form, which is never resolved;
  - a root replaced by another directory, and names that differ only in letter case, as this file system reports them;
  - an access check that fails, faked so that the test runs whatever the user, and an unreadable directory when not running as root.
- **Concurrency:** identical and conflicting installations verified at the same time, including a repeat whose verification fails after the original was recorded.
- **Activation gate:**
  - a call without a context, and Sessions in three different directories;
  - Read, Write and Edit in a Session's directory, and the cancellation of a running call;
  - the session and project directory that each Session's shells see;
  - a Shell `directory` that becomes a link out of the Workspace after an earlier call used it;
  - a directory removed or turned into a link after installation;
  - identical calls at the gate together, including one whose gate refuses it after the other was journaled.
- **Boot v1:** the workspace is still taken at startup, the shells still see the Runtime's session and project directory, a document is still read when its bytes are not UTF-8, and the existing tool-worker tests pass unchanged.
- **Boot v2 encoding:** a document whose bytes are not UTF-8 is refused.
- **Core:**
  - equal parameter schemas compile once, and a schema object is not serialized a second time;
  - a schema that JSON text does not describe exactly, or that fails to compile, behaves as it did before;
  - a caller that mutates its own schema object changes no other schema's validator;
  - a rebuilt schema with an `$id` is validated.
- **Process level:** the hidden CLI command starts with boot v2 and answers attestation v3. It exits before the ready line on refused documents.
- **Java:** the fake worker's v2 answers, and its refusals of documents that change one thing in an accepted one, including joined keys, `type`, and input that is not JSON, without the token on standard error; the provisioner tests, which share a helper with it.

## Acceptance criteria

- The worker gives every boot, attestation and installation case of the shared fixtures its expected answer over real HTTP. Boot cases are read through standard input.
- A missing, non-directory, unreadable, linked or escaping effective directory, and a mount root whose device or inode, as `stat` reports them, differs from the first successful verification, are refused with 409 `managed_context_unavailable`, and the refusal records nothing.
- A tool call whose Session has no installed context, or whose directory no longer verifies, never runs, and no other directory is used.
- Sessions with different effective directories run their tools in their own directories. Each Session's shells see its own session key, and the project directory that core derives from its own effective directory.
- A boot v2 document whose bytes are not UTF-8 is refused.
- Boot v1 and its routes behave as before.

## Follow-up work

| Slice         | Scope                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W0c-2         | The provisioner writes boot v2 and checks ready v2; the v3 attestation and installation clients; no downgrade, and a retry bound for boot v2; identifier and Session ID checks tightened to the envelope's rules; a test that the Broker's JSON writer leaves non-ASCII characters unescaped; `managed_context_unavailable` from installation and `execute`. |
| W0c-3         | Session and storage resolvers in `managed-agent-server` instead of one startup directory, and the Workspace turn lease for shared Workspaces.                                                                                                                                                                                                                |
| Session verbs | A worker route for `release`, which drops the released Session's installation.                                                                                                                                                                                                                                                                               |
| Configuration | Installing configuration from `contextConfigRef`, in the installation request or in a later version of the route (open question 2).                                                                                                                                                                                                                          |
