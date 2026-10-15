# Managed Agent extension configuration and static Skills

[English](2026-10-15-managed-agent-extension-config.md) | [简体中文](2026-10-15-managed-agent-extension-config.zh-CN.md)

Status: implemented and locally verified. Initial implementation baseline: `e612bbf23c`; review recovery fix rebased onto `55fbf99003`.

## Problem and baseline behavior

Managed MCP and Hooks already have durable private Hosted implementations. Public AgentDefinitions store `skills` and `mcp_servers`, but Session admission rejects nonempty values. Hook catalogs have no AgentDefinition field. Hosted deliberately skips the local SkillManager, preventing skills installed on the Harness host from leaking into a remote Session.

This change connects explicitly published extensions to the existing Session definition. It retains one model driver in the Harness and keeps MCP credentials, Hook recipes, command execution, and Workspace files in the Tool Runtime.

## Scope and configuration

The first supported Skill is a static, model-invocable instruction resource. An AgentDefinition publishes its name, description, and Markdown body. The immutable AgentDefinition revision fixes these bytes; editing a definition affects new Sessions only. A Skill may identify a base directory relative to the Session's saved working directory inside its Workspace, matching the existing file tools' path contract. The Harness never interprets that directory as a path on its own host. Scripts and attachments remain Workspace resources accessed through the selected Runtime's existing tools and approval policy.

MCP definitions contain only `server_id`, `server_revision`, and `definition_digest` pins selecting an administrator-provisioned Runtime manifest. They require the existing MCP tool profile and deployment allowlist. A Hook catalog similarly contains `catalog_id`, `catalog_revision`, and `definition_digest`. It requires a Workspace-bound tool profile. Neither supported pin shape accepts endpoints, credentials, commands, module paths, or execution recipes.

Skills require a Workspace-bound tool profile. They do not initialize local SkillManager discovery. Empty or omitted extension fields preserve existing behavior for non-MCP profiles. Invalid, duplicate, oversized, incompatible, or unsupported definitions fail admission with a field-specific error. Nonempty MCP pins without the MCP profile, and an MCP profile without pins, are rejected.

Each Skill accepts exactly `name`, `description`, `body`, and optional `base_directory` (default `.`). Names follow the native Skill character vocabulary and are limited to 128 UTF-8 bytes. A catalog holds at most 16 unique names and 48 KiB of JSON; descriptions are limited to 4 KiB and bodies to 32 KiB. Directories are limited to 4 KiB and use canonical relative POSIX segments, without traversal, backslashes, colons, or control characters. Invalid Unicode and blank required values are rejected without changing the published body bytes.

```json
{
  "skills": [
    {
      "name": "repository-review",
      "description": "Review changes using the project's review guide.",
      "body": "Read review-guide.md and apply its checklist to the current diff.",
      "base_directory": "docs"
    }
  ],
  "mcp_servers": [
    {
      "server_id": "repository-tools",
      "server_revision": 1,
      "definition_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ],
  "hook_catalog": {
    "catalog_id": "repository-policy",
    "catalog_revision": 1,
    "definition_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
```

These fields are part of an otherwise valid AgentDefinition. This combined example requires its `tools` field to select the allowlisted MCP profile.

## Ownership and execution

| Component                       | Responsibility                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Java control plane              | Validate the supported configuration, pin the AgentDefinition revision/digest at Session creation, and publish immutable Skill content resources when creating the Hosted attachment.                     |
| Hosted Session                  | Save Skill references, MCP server pins, and Hook catalog pins in `managed-definition`; recover from those saved values and reject conflicting requests.                                                   |
| Harness                         | Advertise the explicit Skill catalog and a `skill` tool. Load the selected immutable body into the tool response without touching the local filesystem. Continue the existing MCP and Hook orchestration. |
| Runtime Broker and Tool Runtime | Preserve existing authenticated Session routing, Workspace ownership, MCP connection and credential handling, Hook execution, and receipt/drain semantics.                                                |

The Skill tool uses the existing assistant/tool-result journal. Loading immutable instructions has no external side effect and grants no permissions. A successful response is committed before the next model request. Recovery can reuse a committed response or recompute it from the same immutable resource; it cannot execute a script, install a Hook, change the model, or grant tool access. A new `skill_activation` state machine is unnecessary for this restricted instruction-only operation.

When an independent Hook catalog applies to a Skill call, recovery reads the original committed PreToolUse aggregate, preserving its refusal or effective input. An unfinished or missing Hook result blocks recovery. Instruction-only Skill loading does not create approval waits; a PreToolUse `ask` returns an explicit unsupported-approval refusal instead of granting access. Existing post-tool Hook recovery still runs before model continuation.

Skill discovery and validation use the same saved catalog. Unlisted skills and unsupported arguments are refused. Bodies and result envelopes must fit the existing Session Store limits. Skill descriptions remain bounded and tool names cannot shadow built-in tools. Relative asset paths resolve from the Session's saved working directory within the selected Workspace; absolute paths, traversal, and ambiguous roots are rejected at configuration admission.

Skills load in their own tool batch before Workspace tools run. A mixed batch is refused before PermissionRequest Hooks, approval Actions, or Workspace tool dispatch, so a static instruction read cannot enter the existing file-only approval continuation format. Recovery derives the same refusal from the original assistant batch. Existing Session initialization and PostToolBatch Hooks retain their normal behavior. A pure batch may load several Skills.

## Recovery, lifecycle, and rollout

The existing AgentDefinition revision and digest remain the public source of identity. Load requests carry that original identity and use the saved resource references rather than resolving the latest definition. Skills survive a Harness replacement through their durable content references. Missing or corrupt resources block loading instead of silently dropping skills.

MCP and Hook side effects retain their original stable operation IDs and Runtime owners. Unknown outcomes are observed, never resent as new work. Existing MCP/Hook close and drain checks remain mandatory. Enabling the MCP profile still requires the deployment's explicit profile allowlist and compatible Hosted lifecycle capability; this change does not enable it globally or bypass an upgrade gate.

Deploy compatible Harness and Runtime components before admitting new configured Sessions. Existing Sessions without extension fields remain readable for non-MCP profiles. The MCP profile now requires nonempty server pins during create and attach/load validation. Earlier storage admission could retain an MCP profile with empty pins, although Hosted attachment already rejected it. Do not assume such rows are absent: audit stored definitions and Sessions before rollout, retain historical access separately, and settle or close affected Sessions with the previous deployment before replacing it. Publishing a corrected definition revision enables new Sessions; it does not rewrite existing Session pins. Old Harness processes may reject the newly published configuration, so admission failures remain visible and must not be reported as successful installation.

## Boundaries

This is the first static published Skill path. It does not implement project/user/extension filesystem discovery, live catalog updates, slash commands, path-triggered activation, Skill `allowedTools`, Skill-registered Hooks, model overrides, or argument-file expansion. Those require the broader C07 activation contract and remain rejected rather than silently ignored. Explicit AgentDefinition Hook catalogs are independent of Skill activation. This change adds no Environment template, package installer, credentials API, Runtime sharing, or idle reclamation policy.

## Affected areas and validation

Changes cover AgentDefinition validation and its OpenAPI schema, the Java Hosted connector, immutable Hosted definition parsing and loading, and the Hosted Skill tool. The existing MCP/Hook implementations are reused.

Run a global-CLI baseline before implementation and record the public admission gap separately from the ordinary CLI's existing Skill support. Test valid and invalid definitions, resource publication, first Skill invocation, unknown Skill refusal, resource corruption, conflicting load, Harness detach/load, MCP/Hook pin forwarding, and MCP close capability gates. Use deterministic model/MCP fixtures to prove the model sees and invokes the configured capability without host-settings discovery. Run focused TypeScript and Java tests, build/typecheck/bundle, the applicable Java verification profiles, and two clean full-diff audits. Record unavailable physical environments and never equate fixture results with production acceptance.

Initial implementation build, typecheck, bundle, lint and formatting passed, alongside 515 Hosted Session tests, 337 Skill/Hook/tool/recovery tests, 50 model/definition tests, 77 Java SDK tests and the Java server verification suite (2897 tests, seven skipped). Both tests in the selected Hosted Harness/MySQL 8.4 profile passed against the final bundle. The full MySQL profile first passed 548 of 549 tests; its existing asynchronous verification timing case passed an isolated rerun. This does not make the original full run green.

The final packaged-process fixture made 18 deterministic model requests, verifying actual call names and arguments against durable history. It covered on-demand loading, invalid invocations, immutable cold loads, corrupt/missing resources, normal mixed-batch refusals and a pure-Skill SIGKILL followed by HTTP recovery. Mixed-batch SIGKILL loads remained explicitly blocked with HTTP 409; a separate built recovery-helper check on the same real journal verified the immutable refusal and idempotency, without claiming HTTP continuation. No Runtime execution occurred in this fixture. Physical Linux execution, real MCP/Hook effects and production acceptance are not established by these results.

After rebasing the review recovery fix onto `55fbf99003`, build/typecheck/bundle and changed-file lint/formatting passed, together with 392 targeted TypeScript tests, 31 focused Java recovery tests, ten Workspace recovery/MySQL tests, two Hosted Harness/MySQL tests and SpotBugs. The full Java test phase passed 2923 tests with seven skipped, but `mvn verify` failed on eleven pre-existing Checkstyle violations in the unchanged CSI SQL worker test from that base; the failing file, ruleset and plugin configuration exactly match the base. Independent reader probes verified both fixes, and the rebuilt 18-request process fixture retained the same recovery boundaries described above.

## Acceptance criteria

1. A published static Skill is visible and callable in a new Managed Session, and its body is part of durable model history.
2. Reloading that Session preserves the original Skill bytes and extension pins even after a newer AgentDefinition revision exists.
3. An explicitly admitted MCP configuration and Hook catalog reach the existing Runtime implementations without exposing recipes or credentials.
4. Unsupported options, missing resources, profile incompatibility, and conflicting pins produce explicit failures before affected work runs.
5. Existing Sessions and their approval, recovery, close, and drain behavior remain covered by regression checks.

## Open questions

None for this bounded slice. Dynamic Skill activation and discovery remain separate work under the existing configuration design.
