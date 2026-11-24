# Persist the Hosted Session tool profile

[English](2026-10-03-hosted-session-tool-profile.md) | [简体中文](2026-10-03-hosted-session-tool-profile.zh-CN.md)

## Scope and current behavior

This is the first implementation slice of #13271. Public REST and WebShell
Workspace creation share `ManagedAgentStore.insertSession`. The Hosted connector
currently derives `hosted-workspace-files/1` from the presence of a Workspace on
every create and load, including recovery. There is no durable profile decision.

Persist that existing decision without enabling Shell or `/2` profiles. Public
responses, capabilities, request validation and approval behavior stay unchanged.
Background Shell, Monitor and Shell takeover remain out of scope.

## Storage and attachment

Add nullable `managed_agent_session.tool_profile` with a SQL default of
`hosted-workspace-files/1`. Existing bound rows receive that value. Clear the
value on existing unbound rows; new creation explicitly writes the file profile
for bound Sessions and null for unbound Sessions in the same INSERT as the binding.

Keep the SQL default so an older binary can still create bound Sessions after
the migration. An older binary may also store the default on a new unbound row;
the connector ignores the column for unbound Sessions and sends no profile.
This migration does not change any existing approval mode or journal snapshot.

Expose the column on `StoreModels.SessionRecord`. Both connector create and load
read it through their existing shared helper. Recovery, create-conflict and
lost-create-response fallback use the same load path. A bound Session with a
missing or blank profile fails before the Harness request; omitting the field
would let the Harness infer a profile from its journal. Never infer a bound
Session's profile from current deployment settings at load time.

Creation retries return the original Session without rewriting the profile.
There is no profile mutation API or new deployment setting in this slice.
Future admission work changes the server-side selection at creation only.
An old connector still assumes files/1, so admitting other profiles must wait
until all participating control planes support the persisted field.

## Implementation contract

- Caller input cannot choose a profile; existing `unsupported_feature` refusals
  remain. The database and server-side admission are trusted authorities.
- Public and WebShell creation converge on the same transactional INSERT.
  Connector create, cold load and recovery consume the same stored value.
- Unbound Sessions remain without Workspace tools. Missing bound profile data
  fails closed; there is no fallback to a stronger profile.
- Reuse JDBC, Flyway and the existing connector helper. No profile registry,
  parser, configuration framework or public schema field is needed.
- Regression: migrate a pre-column bound Session, then create/load/recover with
  its persisted profile; removing the persistence or restoring the connector
  constant must make the relevant assertions fail.

Affected production files are `StoreModels`, `ManagedAgentStore`,
`QwenHostedHarnessConnector` and one Flyway migration. The migration is initially
V35; its number is provisional until merge and must be rechecked against main.

## Validation and acceptance

Use the existing Java tests for public/WebShell admission and connector request
capture. Verify persisted file-only creation, idempotent replay, legacy migration,
old-binary INSERT defaults, missing-profile refusal, and identical profile values
on create, load and recovery. Keep the unbound no-tool control and requested-profile
refusal. Run Java compilation, focused tests and Checkstyle; record unavailable
database or full-stack checks explicitly. There is no new UI state to capture.

## Remaining Shell admission

Before enabling Shell, #13271 still needs its independent off-by-default opt-in,
mandatory asking approval mode and per-Session capability/contract updates.
Shell creation and attachment must reject `yolo`, null and blank stored approval
modes, including Java's current fallback. Old file Sessions, including `yolo`
Sessions, retain their profile when deployment settings change.

#13160 must expose the command to the approver. G3 step 1 (#13174) gives in-flight
Shell and pending approvals a typed blocked outcome after a Harness crash; it
does not resume approval or re-execute Shell. Operator recovery (#12977) releases
an uncertain Workspace only after verified quiescence. Automatic cancellation
and release for `await_action` belong to G3 step 3 and are not promised here.
Enabling the opt-in additionally requires #12904 and #13010 to be resolved,
public-path FG6f to pass and `HostedPublicWorkspaceIT` to cover Shell approval.
The persisted field is shared with future `/2` admission from #13166.
