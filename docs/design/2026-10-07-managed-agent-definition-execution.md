# Managed AgentDefinition Execution (Stages D8b and D8c)

[English](2026-10-07-managed-agent-definition-execution.md) | [简体中文](2026-10-07-managed-agent-definition-execution.zh-CN.md)

Status: proposal; the decisions in section 7 await review
Date: 2026-10-07
Issue: [#12867](https://github.com/QwenLM/qwen-code/issues/12867), part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
Builds on: [AgentDefinition revisions (D8a)](2026-10-01-managed-agent-definitions.md)
Baseline: `main` at `ac497aeed9`, OpenAPI 1.33.0

## 1. Problem

D8a stores immutable definition revisions under `/v1/agents`, but no Session
uses them:

- **Admission ignores definitions.** Session creation stores the deployment
  setting `QWEN_MANAGED_AGENT_REVISION` (default `1`) as `agent_revision`, and
  any other requested revision answers `400 unsupported_feature`
  (`ManagedAgentStore.java:370-375`).
- **`qwen-code` is hard-coded in three places:** Session admission
  (`ManagedAgentStore.java:266`), the Workspace execution authority
  (`WorkspaceExecutionStore.java:67,98`) and admission of later Turns on a
  bound Session (`ManagedAgentService.java:871`).
- **The Harness has no notion of a revision.** Java's `POST /session` to the
  Hosted Harness carries only `approvalMode`, `approvalTimeoutMs`,
  `toolProfile` and the Session Store descriptor
  (`QwenHostedHarnessConnector.java:322-345`). Model, system prompt, cwd,
  sampling and the round budget come from the Harness process: every Turn
  loads them with `loadSettings(cwd, {skipWorkspaceSettings,
workspaceTrusted: false})` and `loadCliConfig`
  (`hosted-harness-model.ts:82-104`).
- **Two per-Session pins already exist.**
  - **Approval mode:** `managed_agent_session.approval_mode` (V24). It is
    taken from the deployment setting `QWEN_MANAGED_AGENT_APPROVAL_MODE`
    (default `yolo`) and written only for bound Sessions.
  - **Tool profile:** `managed_agent_session.tool_profile` (V35). Bound
    Sessions get the literal `hosted-workspace-files/1`
    (`ManagedAgentStore.java:409`).
  - The Harness records both in the immutable `managed-definition` resource
    (`hosted-harness-session.ts:1704-1727`), compares them on every load, and
    answers `409 hosted_tool_profile_conflict` on a mismatch.

## 2. Constraints from the upstream design

The [code_agent design][upstream] (v1.13, pinned at `6891216`) fixes these
rules, and this design keeps them:

1. **A Session pins its revision and never drifts.** Creation fixes
   `agentRevision`; a newer revision never changes an existing Session.
   Upgrading a definition means a new Session; there is no hot switch.
2. **"Latest" is resolved once, before the Session is created.**
3. **Configuration is never dropped silently.** If a definition asks for a
   capability that cannot run, admission refuses it. It must not run without
   that configuration and claim compatibility.
4. **Credentials stay out of definitions.** Model credentials resolve only
   in the Harness, through its existing credential references.
5. **Digests are verified.** The Harness checks the revision and digest it
   loads and refuses to run on a mismatch.

Upstream describes a trusted publish step that writes an `AgentBundle` to a
shared directory. This design adds no separate publish service: a D8a
revision is already immutable and digest-addressed, so storing a revision is
publishing it (decision 1 in section 7).

## 3. Goals

- **D8b:** a new Session can select a stored definition and pins
  `(agent_id, revision, digest)`. An omitted revision resolves to the latest
  at admission, and a replay never resolves it again.
- **D8c-1:** `permission_policy` and `tools` take effect through the two
  existing per-Session pins. Java only.
- **D8c-2:** `model` and `instructions` take effect. The Harness gains a
  per-Session model override and instruction section, and verifies the
  digest on load.
- **No silent drops:** admission refuses a definition whose content cannot
  take effect and names the field.

## 4. Non-goals

- A separate publish step, a default-revision pointer, and listing or
  deleting definitions (unchanged from D8a).
- Applying `skills` and `mcp_servers`, which belong to Stage H. Until then a
  non-empty value refuses admission.
- Applying `environment_template_id`, which belongs to Environment and
  Runtime templates. A non-null value refuses admission.
- Switching the definition of an existing Session.
- The reader, operator and owner role matrix from section 10 of the
  contract.
- Any change to the behavior of the built-in `qwen-code` agent.

## 5. Design

### 5.1 Two kinds of agent

|                                | `qwen-code` (built-in)                    | Stored definition (`agent_<32 hex>`)                       |
| ------------------------------ | ----------------------------------------- | ---------------------------------------------------------- |
| Source                         | Deployment settings; no stored row        | D8a's `managed_agent_definition`                           |
| Revision                       | `QWEN_MANAGED_AGENT_REVISION`, as today   | Resolved at admission: explicit, or the latest             |
| Digest                         | None (`NULL`)                             | The pinned revision's `digest`                             |
| Approval mode and tool profile | Unchanged (deployment default, `files/1`) | Compiled from the definition (5.3)                         |
| Model and instructions         | Harness process settings                  | Deployment defaults until D8c-2 (5.3), then the definition |

`qwen-code` does not become a seeded definition. Seeding would need a row per
tenant, and its behavior is defined by deployment settings, so a stored copy
could disagree with what actually runs. The three `"qwen-code".equals(...)`
checks become "the Session is `qwen-code` or pins an executable definition".

### 5.2 Session admission (D8b)

The existing creation transaction gains these steps:

1. **Resolve the revision.** `qwen-code` keeps its current path. Otherwise:
   - an explicit `agent_revision` reads that row;
   - an omitted one reads the latest row for the agent with
     `SELECT … FOR SHARE`, in the same transaction as the Session insert, so
     a concurrent update cannot interleave;
   - a missing agent or revision answers `404 agent_not_found`. The create
     route already declares `404`; its description is filled in.
2. **Compile the execution settings** by the rules in 5.3. Content that
   cannot take effect answers `409 agent_definition_unsupported`, with the
   field in `details.field`.
3. **Store** `agent_id`, `agent_revision` (decimal string) and a new column
   `agent_definition_digest CHAR(64) NULL`, and take `approval_mode` and
   `tool_profile` from the compiled settings.
4. **Request digest and replay.**
   - The request digest keeps its current rule: `agentRevision` counts only
     when the caller sent it.
   - A replay goes through the creation receipt and returns the original
     Session; it never resolves the latest revision again. The receipt
     already guarantees this; a test pins it by publishing revision 2
     between two retries and expecting revision 1 on the replay.
5. **Public fields.** `PublicSession.agent_revision` exists already; an
   optional `agent_digest` is added so a caller can check the pin. The
   contract takes a minor version.

Revisions are immutable and have no delete route, so a pinned revision is
always readable for recovery and load. A future delete must first handle
revisions that Sessions still pin.

### 5.3 Field rules (v1)

D8a stores `model`, `permission_policy` and the items of `tools` as open
objects without checking them. This design leaves D8a's storage alone and
compiles at admission, so stored definitions stay valid, and unsupported
content fails with a precise error when a Session is created from it.

| Field                     | Accepted v1 shape                                                                                                      | Effect                                                                                                                                                                 | Stage   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `permission_policy`       | `{}` (deployment default), or `{"approval_mode": "default" \| "auto-edit" \| "yolo", "approval_timeout_ms"?: integer}` | Written to `approval_mode`. The timeout may not exceed the deployment's `QWEN_MANAGED_AGENT_APPROVAL_TIMEOUT` and defaults to it. `plan` and any other key are refused | D8c-1   |
| `tools`                   | `[]`, or exactly one `{"type": "hosted_profile", "profile": "<id>"}`                                                   | Written to `tool_profile`. A bound Session needs one entry; an unbound Session needs `[]` (model only)                                                                 | D8c-1   |
| `model`                   | D8c-1: only `{}` (deployment default). D8c-2: `{}` or `{"id": "<model id>"}`                                           | D8c-2 overrides it per Session in the Harness                                                                                                                          | D8c-2   |
| `instructions`            | D8c-1: only `""`. D8c-2: UTF-8 up to 64 KiB                                                                            | D8c-2 appends it as an agent instruction section (5.5)                                                                                                                 | D8c-2   |
| `skills`, `mcp_servers`   | Omitted, `null` or `[]`                                                                                                | None; non-empty is refused                                                                                                                                             | Stage H |
| `environment_template_id` | Omitted or `null`                                                                                                      | None; non-null is refused                                                                                                                                              | Later   |
| `metadata`                | Anything                                                                                                               | Does not affect execution                                                                                                                                              | —       |

**Selectable profiles come from a deployment allowlist**,
`QWEN_MANAGED_AGENT_DEFINITION_TOOL_PROFILES`, which defaults to
`hosted-workspace-files/1,hosted-workspace-files/2`.

- **`shell/1` and `shell/2`** wait for public foreground Shell admission
  (#13271) and must pair with the `default` approval mode; see below.
- **`mcp/1`** waits for Stage H.

**Combination rules**, each answering `409 agent_definition_unsupported`:

- A Shell profile may not pair with `yolo`. This is #13271's mandatory-asking
  gate, written into the rules before the allowlist opens Shell.
- `files/2` (glob) requires the deployment to have enabled its workers,
  following #13166's coordinated rollout; Java checks the same switch.
- An unbound Session may not select a profile.

### 5.4 D8c-1: Java only

The approval mode and tool profile already travel to the Harness on create
and load, where they are pinned and verified. D8c-1 therefore only:

- writes the compiled values at admission, replacing the literal `files/1`
  and the deployment-default approval mode;
- changes the `qwen-code` checks in later-Turn admission and the Workspace
  execution authority to "`qwen-code` or a pinned, compiled definition";
- makes `maySubmitShape` and similar checks read the Session's columns
  instead of assuming a profile.

The Harness, the Runtime Broker and WebShell are unchanged. WebShell already
shows approval cards (#13107), so a Session created from a definition with
`default` approval asks through it.

### 5.5 D8c-2: model and instructions (Java and Harness)

- **Delivery.** Java adds an optional `agentDefinition` object to
  `POST /session` on create: `{agentId, revision, digest, model?: {id},
instructionsRef?}`.
  - Instructions do not travel in the request body. Java publishes them to a
    digest-addressed Session Store resource (`managed-agent-instructions`)
    and sends the reference.
  - Load sends only `{agentId, revision, digest}`.
- **Harness pin.** On create the Harness records `agentDefinition` in the
  `managed-definition` resource next to `toolProfile` and `approvalMode`. On
  load it compares the digest and answers `409
hosted_agent_definition_conflict` on a mismatch, as it does for
  `hosted_tool_profile_conflict`.
- **Application.**
  - **Model:** after each Turn's `loadCliConfig`, the pinned `model.id`
    overrides model selection. It must name a model the deployment has
    configured (present in `modelProviders`, with resolvable credentials);
    otherwise the Turn fails with `model_unavailable` and nothing runs. So
    that admission can refuse early, Java keeps an allowlist,
    `QWEN_MANAGED_AGENT_DEFINITION_MODELS`, which the deployment keeps
    consistent with the Harness.
  - **Instructions:** a separate section after the core system instruction
    and before project context (QWEN.md and AGENTS.md from #13168). It never
    replaces the core instruction, which carries tool-use and safety rules.
- **Not delivered:** credentials, sampling parameters and the round budget.
  They stay deployment settings until a field is added for them.

### 5.6 Contract changes

- Create: describe `404 agent_not_found` and `409
agent_definition_unsupported`, and describe `agent_revision` as "omitted
  resolves the latest revision at admission and pins it".
- `PublicSession` gains the optional `agent_digest`.
- `AgentDefinitionRequest` is not tightened, so revisions stored under D8a
  stay valid. The v1 shapes are documented in route descriptions and here.
- WebShell creation uses the same admission path (it already has `agentId`)
  and needs no separate change.

## 6. Delivery

Two PRs:

1. **PR A, D8b and D8c-1 (Java only):** pinning, compilation of the approval
   mode and tool profile, the refusal rules, the new column (the next free
   Flyway version on `main` at merge time) and contract 1.34. Definitions then
   have their first real effect: selecting `files/2` and `default` approval.
2. **PR B, D8c-2 (Java and Hosted Harness):** delivery, pinning,
   verification and application of the model and instructions.

D8b does not ship alone. Pinning a definition whose fields do nothing would
drop configuration silently (rule 3 in section 2). The alternatives are to
keep refusing agents other than `qwen-code`, as today, or to apply at least
some fields.

## 7. Decisions for review

Each item is a recommendation, followed by who should confirm it.

1. **No publish step; an omitted revision means the latest.** A stored
   revision is usable at once. A default-revision pointer can be added later
   for staged rollout without affecting pinned Sessions. → wenshao
2. **D8b ships with D8c-1 in one PR**, not alone (section 6). → wenshao
3. **`qwen-code` stays built in**, not a seeded definition. → wenshao
4. **Field order:** `permission_policy` and `tools` first (Java only), then
   `model` and `instructions`; `skills` and `mcp_servers` with Stage H.
   → wenshao
5. **`tools` selects one frozen profile** rather than listing individual
   tools; profiles are limited by a deployment allowlist, and Shell requires
   an asking mode. → doudouOUC (tool profiles), aligned with DragonnZhang's
   #13271
6. **Instruction placement:** after the core system instruction and before
   project context, never replacing it, up to 64 KiB. → wenshao
7. **Ownership of D8c-2's Harness part:** yiliang114 implements it;
   doudouOUC reviews the profile and definition-resource changes.
   → doudouOUC

## 8. Verification

- **Java unit and contract tests:**
  - an omitted and an explicit revision;
  - a revision published between two retries, with the replay returning the
    original;
  - no partially updated read under a concurrent update;
  - the refusal matrix: every unsupported shape of every field, and the
    combination rules;
  - `404` across tenants;
  - the `qwen-code` path unchanged.
- **Harness unit tests (PR B):**
  - create pins `agentDefinition`;
  - a digest mismatch on load answers `409`;
  - the model override applies, and an unconfigured model fails closed;
  - instructions land in the right place in the system instruction.
- **Real-stack acceptance**, following the method used on #13101 and #13107:
  - run MySQL, Java, the Hosted Harness and Chromium;
  - store a definition with `files/2` and `default`, and create a bound
    Session from it;
  - confirm glob is available and a file write shows an approval card;
  - store revision 2 with `yolo`: the old Session still asks, and a new one
    does not;
  - for PR B, add a model switch and instructions taking effect.

## 9. Risks

- **The Java model allowlist and the Harness settings disagree:** admission
  succeeds and the Turn fails. Failing closed with an explicit code covers
  this, and the deployment documentation states that both lists must match.
- **The default approval mode is `yolo`:** a definition with `{}` inherits
  it. That is what "deployment default" means, but the documentation must say
  so, and production deployments should change the default to `default`.
- **Revisions stored under D8a may use shapes v1 does not support:**
  creating a Session from them is refused. This is intended (no silent
  drops), and the error names the field.

[upstream]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-java-hosted-runtime.md
