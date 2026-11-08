# Caller-supplied daemon session IDs

## Context

Daemon clients sometimes need to choose a session ID before creation so they can persist the identity atomically with their own workflow state. The existing REST implementation forwarded an optional ID, but uniqueness and recovery coordination remained local to one route and one workspace runtime. ACP, SDK, runtime replacement, and direct stdio-agent entry points could therefore observe different behavior.

This design makes caller-supplied IDs one daemon-wide contract without changing the core session format or adding a persistent global index.

## Contract

A caller-supplied ID is optional. `undefined` and `null` mean that no ID was supplied. A supplied value must be a string containing an RFC-variant UUID v1-v5. The daemon normalizes it to lowercase and rejects nil UUIDs, unsupported versions, non-RFC variants, path characters, Arena `-agent-*` suffixes, and all non-string values.

The internal session-ID validator continues to accept the existing Arena suffix. Caller validation is intentionally narrower because the public ID must remain addressable by the persisted-session and CLI resume paths.

Supplying an ID means “create a new independent thread session with this ID.” It is not an idempotent attach operation. After an ambiguous create response, a caller should use the known ID with load or resume.

## Ownership boundaries

| Layer                         | Responsibility                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Shared parser                 | Public UUID validation and lowercase normalization; internal Arena compatibility remains separate.                        |
| `RequestedSessionIdAdmission` | Daemon-wide live, pending, and persisted conflict detection for create and restore.                                       |
| REST and ACP dispatchers      | Parse protocol fields, acquire admission before side effects, map errors, and verify the returned ID.                     |
| ACP bridge                    | Force direct caller-supplied creates to thread scope, forward the ID, and include it in fresh-session capacity admission. |
| stdio ACP agent               | Validate before settings or filesystem access, serialize same-ID startup, and preserve the shared child on errors.        |
| SDK and MCP clients           | Negotiate `session_id_override`, serialize the field, and verify the success response.                                    |

The existing total-session admission controller remains responsible only for capacity and drain state. ID uniqueness is deliberately separate so the two policies cannot accidentally release or count each other's reservations.

## Daemon-wide admission

The admission component owns an in-memory map keyed by normalized session ID. A claim is either:

- `create`, owned by one bridge generation; or
- `restore`, owned by one bridge generation with a reference count so concurrent load/resume calls on that generation can share recovery.

Create performs these steps:

1. Enumerate every live bridge supplied by the daemon, including draining and replaced generations that have not completed shutdown.
2. Reject any live owner or pending claim.
3. Install the pending create claim synchronously, before the first asynchronous persistence, branch, or worktree operation.
4. Under the session archive coordinator's shared lock, scan every currently registered workspace with a `SessionService` pinned to that runtime's captured `sessionRuntimeBaseDir`.
5. Reject active, archived, or worktree-backed persisted history; otherwise return an identity-bound reservation.

Restore performs no disk scan because its purpose is to open existing history. It rejects a live or pending owner on another bridge generation, shares an existing restore claim only when it belongs to the same bridge object (the workspace spelling may differ between calls on that bridge), and otherwise installs a new restore claim.

Reservations are idempotent and remove state only when the map still contains the exact state object they captured. This identity check prevents a delayed release from deleting a newer claim for the same ID. Restore references decrement individually and remove the state at zero.

Bridge enumeration and persistence inspection errors fail closed with retryable `session_id_admission_unavailable`. A normal `SessionNotFoundError` means only that the bridge does not own the ID. Persistence read failures do not inherit `SessionService`'s treat-error-as-exists behavior: the scan surfaces them as retryable `503 session_id_admission_unavailable` instead of a `409` conflict. Clients should bound their 503 retries — a permanently unreadable transcript directory keeps returning 503 and never resolves on its own.

## Runtime replacement and workspace scope

Production passes a dynamic bridge provider backed by the runtime lifecycle array. A replaced bridge stays in that array until shutdown is confirmed, so a new generation cannot create the same ID while the old generation is draining. Enabling runtime replacement or removal without this provider is a startup error.

Persistence scans use the current workspace registry and each runtime's fixed base directory. They do not depend on ambient storage context. This guarantees uniqueness across all workspaces currently registered with the daemon while avoiding a new global on-disk index.

Existing duplicate history is not migrated or renamed. If a workspace containing a historical duplicate is registered later, workspace-qualified routing continues to disambiguate it; the admission guarantee applies to creates relative to the runtimes registered at admission time.

## Transport behavior

REST accepts `POST /session { sessionId }`. ACP accepts `session/new._meta["qwen-code/sessionId"]`. Both use the same admission instance, including primary and workspace-qualified ACP mounts. REST and ACP load/resume also share restore claims, closing cross-transport races.

Both create paths force `sessionScope: "thread"`. After the bridge returns, the dispatcher compares the actual and requested IDs. A mismatch returns `session_id_not_honored` and removes the newly created live and persisted orphan before releasing admission.

The stdio agent repeats validation before loading settings. It guards specified creates and non-live load/resume startup with a per-child pending set. Duplicate startup returns a structured ACP `INVALID_PARAMS` error; it never exits the process or damages sibling sessions. Core `Config` remains unchanged and still receives `throwOnSessionIdConflict` for its final disk-conflict defense.

## Public compatibility

The daemon advertises `session_id_override`. TypeScript, Java, and daemon MCP clients require that capability before sending a create mutation with a chosen ID. This prevents an older daemon from silently ignoring an additive field.

TypeScript maps the field to REST JSON or ACP `_meta` depending on the active transport. Java exposes `CreateSessionRequest.Builder.sessionId(String)`. MCP exposes `session_create.session_id`. A successful response is checked again by each SDK; Java reports mismatches as `SessionCreationOutcomeUnknownException` because the unexpected session may have been created.

Web UI consumers inherit the optional TypeScript field but do not set it. The Python SDK has no daemon client and is unchanged.

## Error contract

| Condition                                               | REST                                                          | ACP                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| Invalid requested ID                                    | `400 invalid_session_id`                                      | `INVALID_PARAMS`, `data.httpStatus=400`                         |
| Create conflicts with live, pending, or persisted state | `409 session_id_conflict`                                     | `INVALID_PARAMS`, `data.httpStatus=409`                         |
| Restore belongs to another runtime generation           | `409 session_workspace_conflict`                              | `INVALID_PARAMS`, `data.httpStatus=409`                         |
| Live or persisted ownership cannot be checked           | `503 session_id_admission_unavailable` with `retryable: true` | internal error with `data.httpStatus=503` and `retryable: true` |
| Downstream returns a different ID                       | `500 session_id_not_honored`                                  | internal error with `data.httpStatus=500`                       |

## Alternatives rejected

A persistent daemon-global ID index would make future workspace registration easier to reason about, but it introduces transactional recovery, migration, and stale-entry cleanup for a feature that can be enforced from current live bridges and existing session storage. Per-route maps are smaller locally but cannot close REST/ACP or cross-workspace races. Treating create as idempotent attach would also hide ambiguous mutation outcomes and conflict with ACP `session/new` semantics.

## Verification

Unit coverage exercises UUID versions and variants, normalization, Arena compatibility, synchronous claims, all live bridge generations, pinned persistence targets, restore reference counting, failure release, stale releases, structured stdio errors, scope forcing, orphan cleanup, capability gates, transport mapping, and SDK response verification.

The manual daemon scenario creates mixed-case fixed IDs through raw REST, TypeScript REST/ACP, Java, and MCP; prompts and persists the winning session; restarts and restores it; verifies cross-workspace and cross-transport conflicts; and confirms invalid direct ACP metadata neither creates files nor terminates the shared child.
