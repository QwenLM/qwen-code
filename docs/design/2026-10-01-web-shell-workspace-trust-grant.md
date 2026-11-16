# Web Shell Workspace Trust Grant

[English](2026-10-01-web-shell-workspace-trust-grant.md) | [简体中文](2026-10-01-web-shell-workspace-trust-grant.zh-CN.md)

## Status

Implemented for QwenLM/qwen-code#13130.

## Problem

Folder trust fails closed. Once `security.folderTrust.enabled` is set, a
folder that no rule decides is untrusted: workspace settings, project
environment files, extensions, auto-acceptance, and automatic memory loading
stay switched off until the user records a decision.

Recording that decision is terminal-only. The Ink folder-trust prompt and
`/permissions` write `trustedFolders.json`; no daemon route accepts a trust
decision. `POST /workspace/trust/request` only publishes
`trust_change_requested` and still requires local operator action, so a Web
Shell client — including the Desktop app — has no way out when every
registered workspace resolves untrusted. A missing, unreadable, or
machine-local `trustedFolders.json` therefore locks the whole product out of
its own UI, with no in-app recovery path (#13130).

## Goals

- Give an operator-authority client a direct, authenticated way to record
  trust for one workspace.
- Keep `POST /workspace/trust/request` request-only; it remains the
  "someone should look at this" channel.
- Fail closed. The new route reuses the existing strict mutation gate and the
  existing trusted-folder writer; it widens neither the attack surface nor the
  set of reachable files.

## Non-goals

- Remote revoke. Untrusting a workspace remotely closes a live runtime
  generation and can destroy running sessions; the terminal and the trust file
  remain the paths for that, and the recovery problem in #13130 is one-sided.
- Repairing a malformed or unreadable `trustedFolders.json` from the daemon.
  The write fails and reports instead of guessing at the operator's file.
- Zero-downtime trust application. The runtime replacement stays destructive.
- Changing standalone CLI trust choices or precedence. `/permissions` and the
  trust prompt keep the same choices; the shared reader accepts the JSONC
  format already preserved by their writer.

## Design

### Endpoints

| Surface   | Route                                     | ACP method                    |
| --------- | ----------------------------------------- | ----------------------------- |
| Primary   | `POST /workspace/trust/grant`             | `_qwen/workspace/trust/grant` |
| Qualified | `POST /workspaces/:workspace/trust/grant` | `_qwen/workspace/trust/grant` |

No request body is read and no client id is used. The response is the trust
status the workspace reports after the write, so a caller sees the decision it
just recorded rather than a prediction.

The ACP column on the Qualified row carries a precondition the REST route does
not. A workspace-qualified ACP connection needs a secondary mount, and only
trusted non-primary runtimes get one: an untrusted non-primary workspace is
refused `403 untrusted_workspace` at the mount resolver, before any dispatcher
exists, on both the HTTP and WS paths. So for the state this design exists to
recover — a locked-out secondary workspace — the ACP method is undispatchable
and recovery is REST-only. The Primary row is not trust-gated for this method.

### Authority and boundary

The route is registered through the same strict mutation gate as the other
privileged REST mutations: credentials, or a primary-listener request in
trusted-loopback mode. A caller without operator authority is rejected before
the writer runs. Native app clients reach the daemon through that primary
loopback listener, so the Desktop and Web Shell paths work without a token;
a LAN or `--require-auth` deployment needs real credentials.

The written path is never supplied by the caller. It is the workspace the
request already resolved to, so the endpoint cannot be aimed at an arbitrary
directory. New rules trust only that folder; an existing `TRUST_FOLDER` or
`TRUST_PARENT` rule is preserved under the write lock. An SSH workspace
records trust on the daemon host's own trust record, which is the record the
daemon evaluates.

### Refusals

| Condition                                                       | Result                                   |
| --------------------------------------------------------------- | ---------------------------------------- |
| Selector names no registered workspace                          | 400 `workspace_mismatch`                 |
| Folder trust disabled for the workspace                         | 409 `folder_trust_disabled`              |
| Workspace is managed scratch                                    | 409 `managed_scratch_trust_fixed`        |
| Workspace owns a live conversation                              | 409 `live_conversation_trust_fixed`      |
| Runtime not active                                              | 503 `workspace_runtime_unavailable`      |
| Trust file malformed, unreadable, or not a regular file         | 500 `trusted_folders_invalid`            |
| Grant recorded but the policy or reported status is not trusted | 409 `trust_grant_ineffective`            |
| Generation closed mid-request                                   | generation-closed response, as elsewhere |
| Already trusted, runtime active                                 | 200, idempotent                          |

That trust-file row is narrower than it reads. A dangling symlink reads as no
file at all, so the grant replaces it with a regular file holding only the new
rule and answers 200. Corruption the write itself discovers mostly answers 500
`trusted_folders_invalid`: a symlinked or otherwise non-regular trust file, a
document whose root is not a JSON object, and a rule carrying an invalid trust
level all raise `FatalConfigError` from the writer. Only a document that is
syntactically invalid JSONC — and was still valid when the daemon first cached
it — reaches the write as a plain parse failure and answers 500
`internal_error`. And the malformed/unreadable verdict comes from a cached load
that nothing clears in production, so a file repaired afterwards keeps
answering 500 until the daemon restarts.

The already-trusted row likewise assumes an active runtime. A successful grant
starts a rebuild that moves the entry to `transitioning`, and while it is there
both grant routes answer 503 `workspace_runtime_unavailable` with
`Retry-After: 1`, even though the trust record is already written. That 503 is
retryable-until-applied rather than a failed decision, but the reference Web
Shell panel does not read it that way yet: `handleGrantTrust` reports every
rejection with the same "Could not trust the workspace" message and branches on
neither status nor `code`. Clients should treat the 503 as retryable inside
their own bounded wait, without re-arming the deadline indefinitely; aligning
the panel is tracked in #13186.

Writing the exact workspace path at the deepest matching depth also overrides
a shallower `DO_NOT_TRUST` parent rule. An existing trusted rule is retained;
an equal-depth `DO_NOT_TRUST` under that same spelling is replaced. A rule
recorded under a different spelling of the same directory — a symlink alias — survives the write
and wins the equal-depth tie, so such a grant is recorded but does not take
effect, and answers 409 `trust_grant_ineffective`. A policy load error or IDE
refusal can produce the same response; its error names the checked state and
source, without assuming a blocking file rule. Both trust readers accept the
comments and trailing commas that the JSONC writer preserves.

The write itself is the existing primitive the terminal uses: it takes
`proper-lockfile`, re-reads under the lock, preserves comments, and atomically
replaces a regular 0600 file without following symlinks.

### Advertising

The daemon advertises `workspace_trust_grant` only when the runtime can pick up
a trust change without a restart. Route registration is unconditional, so the
tag and the REST surface stay consistent — writing the file where hot reload is
unavailable is already safe, it just needs a restart, exactly as `/permissions`
does. The ACP counterpart is not covered by that consistency: it needs a
trusted secondary mount (see Endpoints). The tag tells clients where the grant
takes effect live. An older daemon omits the tag and clients must not offer the
affordance.

### Applying

The trust record changes immediately; the effective state changes when the
reconciler rebuilds the runtime, which is asynchronous. Clients refresh
capabilities until the workspace reports trusted, and give up after a bounded
wait so a failed rebuild leaves the row interactive again. No new event type
is introduced: the workspace inventory already carries the per-workspace
trusted flag, and GET status is the source of truth.

## Validation

- Service level: granting overrides an existing untrusted rule for the bound
  workspace and returns a trusted status.
- Route level: both routes grant, 409 when folder trust is disabled, and 500
  when the trust file is invalid.
- Protocol level: ACP dispatch, the disabled-folder refusal, and mutation-tier
  classification; SDK route mapping and client URL shape.
- Web Shell: the affordance appears only with the capability, grants for the
  row's workspace, refreshes capabilities, and returns the row to a usable
  state once the workspace reports trusted.

## Acceptance criteria

- A workspace the user cannot currently enter can be trusted from the Web
  Shell without a terminal, and the full workspace surface becomes available
  after the runtime rebuilds.
- An unauthenticated non-operator caller cannot record trust.
- `POST /workspace/trust/request` keeps its request-only behavior.
- A daemon without the capability advertises no affordance.
