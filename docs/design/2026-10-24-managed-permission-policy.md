# Managed Session permission policy

[English](2026-10-24-managed-permission-policy.md) | [简体中文](2026-10-24-managed-permission-policy.zh-CN.md)

## Status and problem

Implemented locally and integrated with the current main's Workspace files/3
profile. Initial validation used `cdd5f1e02744`; subsequent integration checks
are recorded in the E2E report. Before this change, Managed Sessions supported
`default`, `auto-edit`, `yolo`, independent Plan state and durable permission
Actions. Users could not configure Session allow/ask/deny rules or select the
existing Core classifier through Managed approval settings.

## Scope and decisions

Extend the existing Session approval query/change operation. Add `auto` and an
optional `permissionRules` object containing `allow`, `ask` and `deny` string
arrays. Mode, Plan and rules share the existing `approvalRevision`, actor-scoped
idempotency receipt, Session authorization and transaction lock. No new policy
service, route, table or database version is needed.

Omitting rules preserves the current rules. Supplying three empty arrays clears
them. Empty policies retain the existing wire representation. Rules changes
require an idle Session; existing live mode changes retain their behavior. A
Turn snapshots the policy alongside its existing mode/revision snapshot. New
rules are not inherited by another Session or a delegated child. Auto is selected
after Session creation. A newly delegated child maps a parent's Auto to default;
the child protocol retains its existing three modes.

Idle means there is no active Turn, pending approval or unsettled operation.
A healthy retained MCP connection alone does not prevent rule editing. Ordinary
Turns keep their original admission snapshot. Internal monitor, automation and
Session-message wakes seed policy through the current writer-scoped SQL read;
without an original human prompt, Auto falls back to manual approval. These rules
govern model tool calls, not internal wake delivery or Hook side effects.

Each list permits 32 entries, the combined count is at most 64, each rule is at
most 512 UTF-8 bytes, and the encoded object is at most 8192 UTF-8 bytes. Rules
must be trimmed, nonempty, control-character-free and unique within each list.
The first version accepts tool names and aliases, MCP server/tool name patterns,
Shell command patterns and WebFetch `domain:` patterns. File-path specifiers and
other parameter predicates are explicitly rejected: the Harness cannot resolve
the remote filesystem's canonical paths. These are execution-input policies,
not an operating-system confinement boundary.

## Evaluation and classifier

Keep input validation, authorization, profile admission and Plan restrictions.
After Hooks produce the final tool input, evaluate rules using the existing
Core permission matcher with `deny > ask > allow`, before mode defaults. A
deny is effective even in `yolo`; explicit asks, Hook asks and Plan exit require
a human and cannot be waived by an allow rule, Hook allow or classifier. MCP
matching uses producer-carried server/tool identity, never the opaque advertised
name or description. Compound Shell commands retain conservative matching.

For an otherwise undecided native call, `auto` uses Core `classifyAction` with
the Harness's existing guarded model configuration. The model runner injects a
classifier callback; it does not enable local tools or create a second execution
environment. Only genuine user input and trusted Session history provide user
intent. Original text is read from committed human input resources; attachment
text and synthetic messages do not become user intent. Hook-expanded prompts,
Workspace instructions and compression summaries
must not be promoted to human authority. A classifier allow permits the call;
a policy block refuses it; unavailable classification falls back to a durable
human Action. Cancellation never permits dispatch. MCP and a cold continuation
without a safe classifier runner conservatively require human approval unless
an explicit rule already decides them.

Existing native batch plans retain decisions and completed ordinals across
recovery. Persist the human-only floor in Action options and preserve it through
live polling and cold recovery. Recovering an admitted operation must not
reclassify a completed call, rewrite a pending Action or replay an unknown tool.

## Components and compatibility

| Layer                    | Change                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Java Session store       | Session/Turn rule JSON in the shared V1 baseline; snapshots, receipts, writer-scoped reads and CSI inventories remain consistent        |
| Public/WebShell API      | Extend existing approval request/options/result; advance OpenAPI and regenerate browser types                                           |
| SDK and Harness protocol | Negotiate `permission-rules/1` and `auto-approval/1`; preserve the old shape without rules                                              |
| Hosted execution         | Reuse Core matching and classifier, final-input checks, native batch recovery and durable Actions                                       |
| WebShell                 | Add Auto to eligible mode choices and a Session rules dialog using shared primitives; retain pending intent and original retry identity |

An old or incompatible Harness must refuse a saved Auto/rules policy, including
after replacement or pool routing. Capability discovery controls new choices;
it cannot silently erase an existing policy. Existing tenant, owner/OPERATOR,
Workspace and writer generation checks remain authoritative. The editor exposes
the portable grammar and the idle requirement. It neither edits daemon settings
nor changes the pinned AgentDefinition or enables unsupported tools.

The shared V1 baseline changes in place under the repository's first-release
schema policy. Initialize a fresh development database for this build; existing
catalogs have no upgrade migration.

## Validation and acceptance

The E2E plan is `.qwen/e2e-tests/managed-permission-policy.md`. First inspect the
global CLI baseline in isolated state. Cover rule precedence, compound commands,
MCP identity, malformed/oversized policies, classifier allow/block/unavailable,
Plan and Hook asks, pending Action recovery, idempotency, authorization, stale
revisions, cold policy snapshots and unsupported Harnesses.

Run root build/typecheck/bundle and affected Core/CLI/WebShell tests. Java checks
share the module's ten-minute local budget and prioritize approval, API/surface,
schema/CSI and SDK consumers, plus the minimum real MySQL/Hosted path when
available. Record unavailable checks and leave complete profiles to CI. Two
clean full-diff self-audits and independent review precede completion. Component,
controlled-model and browser-fixture evidence do not establish production or
Linux fault acceptance. No running preview service is modified.

Local evidence: the affected packages build, root typecheck and bundle pass.
Selected Core, CLI and WebShell fixtures pass; an independent source review
found no actionable defects. Java SDK and selected API, connector and Action
tests pass. The full CSI class exposed a physical-column ordering mismatch,
which is corrected; a complete green rerun remains pending. Real MySQL has no
passing acceptance evidence. Complete Java/CSI, provider, Runtime and required
CI qualification remain pending; this is not production acceptance.

## Open questions and subsequent work

No product decision blocks this scope. Remote canonical path rules, automatic
MCP classification, deployment-level policy administration, classifier billing
and broader pool qualification remain separate work.
