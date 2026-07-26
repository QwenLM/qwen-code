# Daemon Skill Toggle

## Goal

Expose the CLI `/skills` panel's workspace enable/disable behavior through daemon REST and the TypeScript SDK, including immediate refresh of active ACP sessions.

## Public contract

- `POST /workspace/skills/:name/enable`
- `POST /workspaces/:workspace/skills/:name/enable`
- Request body: `{ "enabled": boolean }`
- SDK: `DaemonClient.setWorkspaceSkillEnabled` and `WorkspaceDaemonClient.setWorkspaceSkillEnabled`
- Capability: `workspace_skill_toggle`

The response contains the canonical skill name, requested state, whether persistence changed, activation state, and session refresh counts. `applied` means every active session refreshed, `deferred` means no ACP child was running, and `partial` means at least one session failed to refresh after persistence committed.

## Semantics

The API changes workspace `skills.disabled` and `skills.enabled` as needed. Skill lookup is case-insensitive, but the canonical discovered name is persisted. Enabling a default-disabled skill writes an explicit opt-in; disabling it removes the opt-in and writes a hard workspace disable. Updating one target removes target duplicates and case variants without deleting orphan entries for unavailable skills. A second identical request is a no-op.

The route rejects states the CLI panel cannot toggle:

- unknown skill: `404 skill_not_found`;
- `userInvocable === false`: `409 skill_not_toggleable`;
- skill from an inactive extension: `409 skill_not_toggleable`;
- disabled in system defaults, user, or system scope: `409 skill_not_toggleable` with the locking scope;
- untrusted workspace: `403 untrusted_workspace`.

The scope lock check and workspace read-modify-write happen inside the daemon's per-workspace settings lock. A failed write stops before refresh and event publication.

## Skill availability versus `disable-model-invocation`

`skills.disabled` is an operator hard denylist merged as a case-insensitive union across scopes. `skills.defaultDisabled` supplies overridable defaults and `skills.enabled` supplies explicit opt-ins, with `disabled > enabled > defaultDisabled` precedence. Effective disables remove matching skill slash commands and model-visible skill entries, and execution-time validation rejects the skill. The daemon endpoint writes the workspace members of `disabled` and `enabled`.

`disable-model-invocation` is SKILL.md metadata. It hides a skill from model invocation while preserving direct user invocation. The existing managed-skill ACP operation edits that metadata and is intentionally not reused by this API.

## Activation flow

1. Resolve the canonical, toggleable skill from the workspace status snapshot.
2. Under the workspace settings lock, re-read every scope, reject higher-scope locks, and commit the canonical workspace list.
3. Invalidate the daemon's cached skill status.
4. If an ACP child is live, invoke `qwen/control/workspace/skills/refresh`.
5. The child reloads workspace-scope settings and refreshes every active session, including busy sessions.
6. Each session reloads its own workspace settings, rebuilds and pushes `available_commands_update`, and notifies SkillManager consumers.
7. Publish the existing workspace `settings_changed` event for each changed skill-settings key.

An in-flight model request cannot be rewritten. Subsequent skill execution checks, command snapshots, and model contexts read the new state.

## Downstream consumers

- Settings merge: system defaults, user, workspace, and system lists form the effective disabled-name set with `disabled > enabled > defaultDisabled` precedence.
- Workspace status: ACP and daemon-local skill mapping expose disabled state, disablement reason, lock scope, and false-only `userInvocable`.
- Slash commands: available-command construction removes disabled skills and sends updated command metadata to daemon clients.
- Model context: SkillManager change listeners refresh the Skill tool description and available-skill context.
- Execution validation: the Skill tool re-reads the disabled-name provider before invocation, so later calls are rejected immediately.
- Extension state: inactive extension skills remain non-toggleable even when they are not disabled by settings.
- Daemon cache: the cached live-child skill snapshot is invalidated after persistence so later GET requests cannot replay stale state.
- SDK consumers: both primary-workspace and workspace-qualified clients share the response and error contract.
- Events: existing `settings_changed` consumers observe each committed `skills.disabled` or `skills.enabled` value; there is no new event type.

## Failure behavior

- Persistence failure: the HTTP request fails; no ACP refresh and no event.
- No child: persistence succeeds with `deferred`; the next child loads the setting at startup.
- Per-session refresh failure: persistence remains committed; successful sessions stay refreshed and the response is `partial`.
- Child transport race: if the child disappears after the liveness check, the response is `deferred`; other refresh failures are reported as `partial`.
