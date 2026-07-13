# Daemon Multi-Workspace Session Rewind and Shell

## Status

Final implementation design. This document supersedes the Phase 2a
primary-only statement for live-session rewind snapshots, rewind, and shell.

## Problem

The daemon exposes singular session APIs, while a multi-workspace daemon owns
one bridge per workspace runtime. Most live session routes already resolve the
session owner, but rewind snapshots, rewind, and shell were still bound to the
primary bridge or rejected a secondary owner. That made a valid live secondary
session indistinguishable from an unsupported route to clients.

## Decision

Keep the singular REST API and resolve the owning live runtime on every request:

- `GET /session/:id/rewind/snapshots` uses owner-aware read routing.
- `POST /session/:id/rewind` and `POST /session/:id/shell` use owner-aware
  mutable routing and the shared session archive coordinator.
- SDK rewind calls always select direct REST, even when the client is configured
  with ACP transport. This preserves the strict REST mutation gate.
- SDK shell keeps its configured transport. The default REST transport gains
  owner routing; a workspace-qualified ACP client keeps `_qwen/session/shell`.
- No workspace-qualified session REST API, ACP rewind method, core change, ACP
  child change, or FileHistory migration is introduced.

## Ownership and authorization

The workspace registry searches all live bridge summaries for the session id.
Exactly one trusted owner dispatches to that runtime. No owner returns
`404 session_not_found`; an untrusted owner returns `403 untrusted_workspace`;
multiple owners return `500 ambiguous_session_owner`. All three outcomes occur
before the target bridge operation runs. Persisted sessions must first be loaded
or resumed into a runtime.

Rewind and shell retain `mutate({ strict: true })`. Shell additionally requires
effective shell enablement, a valid session-bound client id, and a non-empty
command. Rewind forwards an optional client id and accepts `rewindFiles` only
when omitted or boolean. Omitted means `true`; any other JSON type returns
`400 invalid_rewind_files_flag`.

## Behavior boundaries

Shell starts in the owning session workspace cwd and is not a filesystem path
sandbox. Rewind restores only snapshots recorded for `edit` and `write_file`.
It does not undo shell, Git, script, or manual changes. File restore is
best-effort: the conversation may already be rewound when the response reports
`rewound: false` with `filesFailed[]`. Active prompts retain `409 session_busy`
and `Retry-After: 5`; invalid targets retain `400 invalid_rewind_target`.
Web Shell continues to request `rewindFiles: false`.

The existing `~/.qwen/file-history/<sessionId>` layout is unchanged. A live UUID
collision therefore fails closed through owner ambiguity rather than selecting
the primary runtime.

## Capabilities

`multi_workspace_session_rewind` is advertised only while more than one runtime
exists. `multi_workspace_session_shell` additionally requires effective session
shell enablement, which means both the enable flag and a configured token.

Client preflight is additive:

- Primary rewind: `session_rewind`.
- Secondary rewind: `session_rewind` and
  `multi_workspace_session_rewind`.
- Primary shell: `session_shell_command`.
- Secondary shell: `session_shell_command` and
  `multi_workspace_session_shell`.

ACP-native clients use initialize `_qwen.methods`; the daemon does not advertise
an ACP rewind vendor method.

## Verification

Unit coverage pins owner dispatch, zero calls to non-owning bridges, trust and
ambiguity failures, strict validation order, `rewindFiles` semantics, SDK REST
fallback, unchanged shell transport, conditional capability advertising, and
the absence of ACP rewind mappings. ACP workspace tests retain the invariant
that an A connection cannot operate a B session while a workspace-qualified B
shell succeeds.

The E2E scenario creates a session and tracked edits in workspace B, verifies
snapshots and shell cwd are B-scoped, checks both rewind file modes, proves a
shell-created file survives rewind, and records busy, partial restore, and
untrusted-secondary outcomes.
