# add-policy-engine

## Why

`add-remote-control` makes the agent reachable from any device, but
every tool call still emits a `permission_request` that requires a
human in the loop. For long unattended tasks (overnight refactors, test
suites, batch refactors) this turns "remote control" into "remote
babysitting." Users today work around it by editing locally with
`/yolo`-style global flags, which is exactly the dangerous over-broad
approval we want to avoid.

This change adds a declarative policy engine that evaluates each
proposed tool call against a rule file. Rules can `allow`, `deny`, or
`prompt` (the current default). Decisions are logged and visible to
every client. The default is unchanged — without a policy file, every
tool call still prompts — so this is opt-in and additive.

Policy is the prerequisite for `add-notification-routing`: routing
needs to know which events are "auto-handled" (no ping) vs "user
must decide" (ping the appropriate device).

## What Changes

- **Policy evaluator in the daemon.** Runs synchronously between the
  agent's `requestPermission` call and the SSE `permission_request`
  emit. If a rule matches with `allow` or `deny`, the daemon resolves
  the request immediately and emits a `policy_decision` event in place
  of the prompt; clients render the decision without an approval card.
- **Policy file: `~/.qwen/rc/policy.yaml`** (workspace-overridable to
  `<workspace>/.qwen/policy.yaml` with strict precedence). Hot-reload
  via debounced fsnotify; explicit `qwen rc policy reload` for
  scripts.
- **Rule language** is declarative: match by tool name (glob), args
  (JSON-path + glob), workspace path (glob), originating client scope,
  time-of-day. No code execution; no embedded expressions.
- **Per-rule decision plus rate-limit and TTL.** A rule may allow up
  to N invocations per window, or be valid only for the next M
  minutes. After expiry, the rule no longer matches — useful for
  "approve npm install once this hour."
- **Override path.** `prompt` rules can carry a `requireScope:
approve|owner` field. `deny` rules are not overridable from a
  client; the rule file itself must change.
- **Audit-first.** Every evaluation produces an audit entry, whether
  the rule matched or fell through to default-prompt.
- **`policy_decision` SSE event** type added so all clients see what
  the engine decided and which rule matched.

## Capabilities

### New Capabilities

- `policy-engine` — rule file format, evaluator semantics, decision
  events, threat model, and operator controls.

## User Stories

**P1. Pre-authorize a test suite run.** Before a long task I add
`rules: [{ match: { tool: "bash", argsGlob: "npm test*" }, action:
"allow", maxPerWindow: { count: 50, windowSec: 3600 } }]`. The agent
runs `npm test` 47 times overnight without paging me; the 48th time
beyond the rate limit prompts.

**P2. Block destructive defaults.** I add `{ match: { tool: "bash",
argsGlob: ["rm -rf*", "git push --force*"] }, action: "deny" }`. The
agent never reaches my approve buttons for those commands; if the
model proposes one, the daemon refuses immediately and the agent
sees a structured `policy_denied` tool result.

**P3. Phone-approves-only for risky edits.** I add `{ match: { tool:
"edit_file", pathGlob: "src/auth/**" }, action: "prompt", requireScope:
"owner" }`. Edits in the auth tree still prompt, but only my
workstation (owner scope) can approve, not the partner's read+approve
laptop.

**P4. Audit who-decided-what.** Each tool call shows in the audit
feed: who/what decided (`rule: id-or-default`, `actor: tokenId or
policy-engine`). At 3am the agent ran `npm test` 47 times — I see
all 47 entries pre-labeled "decided by rule `safe-tests`."

## Impact

- **qwen-code repo**: new module `packages/cli/src/serve/policy/`
  containing `loader.ts` (YAML parser + schema), `evaluator.ts`
  (rule matching), `hotReload.ts` (fsnotify wrapper), `quotas.ts`
  (per-rule rate limiting). Integration point in
  `packages/cli/src/serve/server.ts` permission handler.
- **Wire protocol**: new SSE event type `policy_decision`; new
  request body field on `permission_request` events
  (`policyEvaluated: true|false`).
- **Audit log**: `rule_id`, `decision_source` columns added to the
  JSON schema.
- **Scope additions**: no new scopes; `requireScope` reuses existing
  `owner|write|approve|read` from `add-remote-control`.
- **No breaking changes**: in the absence of a policy file the
  daemon behaves identically to `add-remote-control`.
- **Out of scope** (deliberately):
  - Policy-as-code (e.g., Cedar, OPA/Rego). Considered and rejected —
    declarative rules cover the use cases without adding a runtime.
  - Federated / centrally-distributed policies. Per-workspace files
    only; sync via git is the user's choice.
  - Model-level safety policy. The engine is at the tool boundary; it
    does not constrain what the model proposes, only what executes.
  - Approval delegation to a third-party system (PagerDuty,
    OpsGenie). Push notifications via `add-webpush-notifications`
    are the supported "remote approval ping" path.
