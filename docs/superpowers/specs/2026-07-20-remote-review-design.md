# Remote review — design (2026-07-20)

A thin rc-gateway surface for triggering and observing the fork's
existing bundled `/review` skill from a remote client. Approved
approach: **A — review-as-tagged-session** (chosen over B: reimplement
review as a workflow, and C: hybrid orchestration; see Alternatives).

Spec-first: ships as the next OpenSpec change, `add-remote-review`, in
qwen-code-remote, registering all new SSE events and audit actions in
the authoritative registries before implementation.

> **Revision note (post-feasibility):** the approval mechanism in this
> doc was rewritten after four verification probes. The corrected
> mechanism is a **dedicated per-review permission subscription** with a
> **kind-based, escalate-by-default classifier** — not the pump/enforcer
> seam, and not a tool-name allowlist (the wire frame carries neither a
> reliable feed for headless sessions nor the tool-name string). See
> Feasibility and The permission bridge.

## Premise correction

The Claude Code gap analysis listed "multi-agent code review" as a
missing feature on the claim that qwen-code has nothing built-in. That
claim is **false**. The fork already ships a capable upstream `/review`
skill (`packages/core/src/skills/bundled/review/SKILL.md`, dated Jun 6
— it came with the fork, not this session):

- 9 parallel dimension agents — correctness, security, code quality,
  performance, test coverage, three undirected personas
  (attacker / 3AM-oncall / future-maintainer), build+test.
- Batch verification agent (confirm/reject each finding at high/low
  confidence) + pattern aggregation.
- Iterative reverse audit (up to 3 rounds, until dry).
- Deterministic pre-pass (linters, typecheck, build/test as
  pre-confirmed facts).
- Inline PR comments via the GitHub Create-Review API, plus optional
  autofix, worktree-isolated PR fetch.

What it lacks is not the review itself but a **remote surface**: it is a
local-CLI-only skill, LLM-driven (the model reads the SKILL.md and
dispatches via `task`), with no journaling and no way to trigger or
watch it through the gateway. This change closes exactly that gap and
nothing more — it does not rebuild, fork, or modify the skill.

## Scope decisions (user-confirmed)

- **Thin remote surface**: a review is a tagged daemon session running
  the existing `/review <target>` skill verbatim. All existing
  machinery (fetch-pr worktree, deterministic pre-pass, 9 agents,
  verify, reverse-audit, autofix, PR-comment API) runs untouched on the
  workstation. No changes to the skill or to session output.
- **Lifecycle + report-link findings**: the surface exposes review
  lifecycle and a link to the saved report; it does not parse or
  restructure findings. Findings are observed live via the session's
  own `GET /session/:id/events` and durably via the saved report file.
- **Full parity, owner-gated mutations**: plain review requires `write`
  scope; `comment` (post PR comments) and `autofix` (mutate the working
  tree) each require `owner` scope.
- **Scope-tiered approval**: a `write`-scope trigger runs the review in
  **vote mode** (every privileged tool call is escalated to the owner
  to approve remotely); an `owner`-scope trigger with `autoApprove:true`
  runs the review in **assisted auto-approve** — a strict
  escalate-by-default classifier auto-approves only a known-safe set and
  escalates the rest.
- **No daemon change (assisted, not hands-off)**: the classifier keys on
  the ACP `kind` present on the permission frame (the frame carries no
  tool-name). Because the agent fanout (`kind: 'other'`) cannot be
  distinguished from other `other`-kind tools without a daemon frame
  change, the fanout **escalates**: even under auto-approve the owner
  votes ~9 times to let the sub-agents spawn, after which each
  sub-agent's read/search/allowlisted-shell work auto-approves. The
  daemon stays fully unmodified. (Hands-off auto-approve via an additive
  `name` field on the frame is a follow-up.)

## Feasibility (verified by four probes)

**1. A headless daemon/ACP session runs the `review` skill** when sent
the literal prompt text `/review 42`. The daemon processes slash
commands through the same skill loaders the interactive CLI uses; there
is no UI dependency:

- `BundledSkillLoader` maps each bundled skill (including `review`) to a
  `SlashCommand` of `kind: SKILL` whose action expands the SKILL.md body
  inline as the model prompt, appending args
  (`packages/cli/src/services/BundledSkillLoader.ts`).
- The daemon's ACP `prompt` RPC routes text starting with `/` through
  `isSlashCommand` → `handleSlashCommand`, which instantiates
  `BundledSkillLoader` and dispatches the skill
  (`packages/cli/src/acp-integration/session/Session.ts`,
  `packages/cli/src/nonInteractiveCliCommands.ts`).
- `task` is the legacy alias for the `agent` tool; the fanout works in
  the daemon and subagents are observable via `SubAgentTracker`.

**2. `allowedTools` is advisory, so the tool surface is open.** The
review SKILL.md lists `allowedTools` (no `web_fetch`), but that field is
never enforced (`packages/core/src/skills/types.ts`: "For v1, this is
informational only (no gating)"). Sub-agents inherit the **full tool
registry** minus `EXCLUDED_TOOLS_FOR_SUBAGENTS` — which does **not**
exclude `web_fetch` (the sole `Kind.Fetch` tool, directly callable by
every review sub-agent). So a prompt-injected diff could steer a review
agent to `web_fetch` a URL with data in the query string —
exfiltration. The classifier therefore **cannot** treat the surface as
closed; it must be strict escalate-by-default and escalate `fetch`.

**3. The pump cannot reliably feed a headless review session.** The
`SessionEventPump` discovers sessions by 5s polling and its first
subscribe does **not** replay the daemon's event ring, so
`permission_request` frames fired in the first ~5s (e.g. the opening
`qwen review fetch-pr` shell) are missed → the daemon's 5-minute
permission timeout fires → auto-`cancelled` (deny) → the review stalls
and fails early. The enforcer the pump runs is also push-gated
(`undefined` when push is off). The fix: the review opens its **own**
`daemon.subscribeEvents(sessionId, { lastEventId: 0 })` at session
creation; event ids are 1-based, so seeding `0` forces a full ring
replay and closes the poll-latency gap. This dedicated subscription is
needed in **both** approval legs — even vote mode needs it to reliably
notify the owner, or a review triggered and walked-away-from just
stalls.

**4. The `permission_request` frame carries no tool-name.** It carries
the ACP `ToolCall` shape — `{ toolCallId, status, title (humanized),
content, locations, kind, rawInput }` plus an `options` list — emitted
verbatim at `packages/cli/src/serve/httpAcpBridge.ts`. The only stable
per-tool discriminator is `toolCall.kind` (`read`/`search`/`edit`/
`execute`/`fetch`/`other`); the real arguments are under
`toolCall.rawInput` (e.g. `rawInput.command` for shell). Several tools
collapse to one `kind` (`write_file`+`edit`→`edit`; `grep`/`glob`/`ls`→
`search`; `agent`+`lsp`+MCP→`other`). The classifier keys on `kind` +
`rawInput`, and escalate-by-default makes the collisions harmless (a
collision can only cost an extra human vote, never open a hole).

**One caveat drives the trigger saga: silent load fallback.** If the
skill fails to load (bare mode, `skills.disabled`, etc.),
`handleSlashCommand` returns `no_command` and `/review 42` is forwarded
to the model as plain text with no error. The saga guards against this
with a **pre-flight check**: before sending the prompt it calls
`daemon.sessionSupportedCommands(sessionId)` and confirms
`'review' ∈ availableSkills`; if absent it ends the session and returns
`502 review_skill_unavailable` — never a fake `running`.

## Architecture

Every review **is a daemon session**, tagged in a gateway-local
`ReviewRegistry`. It reuses the _patterns_ of the agents-as-sessions
plane (`add-agent-observability`) — the persisted JSON store, the
lifecycle three-surface emit, reconciliation — but it does **not**
register a redundant `AgentRecord`: cost is keyed by `sessionId`, so a
standalone `ReviewRecord` + a `costFor(sessionId)` rollup gets
cost/observability without double-emitting `agent_spawned` +
`review_started`. Observability comes from `GET /rc/reviews`,
`GET /session/:id/events`, and the cost rollup.

The Stage-1 daemon remains **fully unmodified** (preserves the
transparent-proxy boundary): the only new daemon-visible behavior is a
prompt whose text is `/review …` and reads of two existing daemon
endpoints (`sessionSupportedCommands`, `subscribeEvents`).

### Control plane

| Endpoint                                                          | Scope                                                                 | Behavior                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /rc/reviews` `{ target, comment?, autofix?, autoApprove? }` | `write`; → `owner` if any of `comment`/`autofix`/`autoApprove` is set | Saga: create daemon session (SDK) → **pre-flight** `sessionSupportedCommands` skill check → open the dedicated permission subscription → register `ReviewRecord` → send `/review <target> [--comment]` prompt → `202 { reviewId, sessionId }`. |
| `GET /rc/reviews?status=`                                         | `read`                                                                | Registry listing: status, target, summary, timestamps.                                                                                                                                                                                         |
| `GET /rc/reviews/:id`                                             | `read`                                                                | Detail: status, target, `reportPath`, PR `findingsCount`/`verdict` when available, `sessionId`, cost rollup.                                                                                                                                   |
| `POST /rc/reviews/:id/cancel`                                     | `write`                                                               | Proxy to `POST /session/:id/end`; mark record `cancelled`; `409 review_not_running` if terminal.                                                                                                                                               |

`target` is one of `{ pr: number }` → `/review <n>`, `{ path: string }`
→ `/review <path>`, `{ local: true }` (default) → `/review`. `comment:
true` appends `--comment` (owner-gated). When `autofix` is false the
trigger appends a "report only — do not apply autofixes" instruction to
the prompt so the skill does not even propose edits, with the
classifier's `edit`-escalation as the defense-in-depth backstop.
Observation of live progress is `GET /session/:sessionId/events` on the
review's own session, unchanged.

### The permission bridge (security-critical — Opus-owned)

This component carries the threat model, so it is authored **and
reviewed** by Opus. One mechanism serves both legs: on trigger the
gateway opens a dedicated `daemon.subscribeEvents(sessionId,
{ lastEventId: 0 })` for the review session and, on each
`permission_request`, applies a per-review policy, then either votes or
escalates:

- **Vote** (approve): `daemon.respondToSessionPermission(sessionId,
requestId, { outcome: { outcome: 'selected', optionId } })` where
  `optionId` is the `allow_once` option (via `selectAllowOnceOptionId`).
  If no `allow_once` option is offered, the bridge refuses to vote and
  escalates instead — it can never silently escalate a one-time
  approval into a standing grant.
- **Escalate**: leave the permission pending and reliably notify the
  owner (reusing the existing `permission_request` → `permission.required`
  push path, which carries the `requestId` + approve option). The owner
  approves or denies via the existing `POST
/session/:id/permission/:requestId` route. The record moves to
  `blocked` while pending, back to `running` when the tool proceeds.

The two legs differ only in the policy:

- **Vote mode** (`write`, `autoApprove` absent — default): the policy
  escalates **every** privileged call. Nothing is auto-approved; the
  owner votes on each. The dedicated subscription is what makes this
  reliable (the owner is notified even when not attached).
- **Assisted auto-approve** (`owner`, `autoApprove: true`): a strict
  **escalate-by-default classifier** keyed on `toolCall.kind`:

  | ACP `kind`              | Tools it covers                         | Decision                                                                                                                                               |
  | ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `read`                  | `read_file`                             | **approve**                                                                                                                                            |
  | `search`                | `grep_search`, `glob`, `list_directory` | **approve**                                                                                                                                            |
  | `edit`                  | `write_file`, `edit`                    | approve **iff `autofix`** AND every target path field confines to the worktree (classifier string-resolves; bridge `realpath`-verifies), else escalate |
  | `execute`               | `run_shell_command`                     | approve **iff** `rawInput.command` passes the shell allowlist (below), else escalate                                                                   |
  | `fetch`                 | `web_fetch`                             | **escalate** (exfiltration vector)                                                                                                                     |
  | `other`                 | `agent`/`task` fanout, `lsp`, MCP, …    | **escalate** (fanout indistinguishable from other `other` tools without a daemon frame change)                                                         |
  | anything else / unknown | —                                       | **escalate**                                                                                                                                           |

  **The shell allowlist** (`execute`): parse `rawInput.command`; approve
  only if (a) it contains **no** shell metacharacter
  (`; & | $ \` > < newline`) — any present → escalate, which defeats
`git diff; rm -rf`smuggling — and (b) its argv[0..1] matches a
literal prefix in a fixed allowlist: read-only`git`
(`status`/`diff`/`log`/`show`/`rev-parse`), the project build/test
invocations (`npm`/`pnpm`/`yarn`/`cargo`/`go`/`mvn`/`gradle`/`make`build+test,`tsc --noEmit`), the `qwen review …`subcommands, and`mkdir -p …/.qwen/…`. The PR-comment post is a `gh`command: allowed
**iff`comment: true`**, otherwise escalate. Everything else
(`git commit`/`push`, `rm`, `curl`, package installs, arbitrary
binaries) escalates. The classifier is a pure function tested with the
**real** `{ title, kind, rawInput }`frame shape (never the synthetic`{ name, input }`— that synthetic shape is exactly what hid a latent
wire-mismatch bug in the existing`PolicyEnforcer`; see Follow-ups).

The bridge uses per-request voting, **not** `setSessionApprovalMode`:
the latter is session-wide and coarse (cannot inspect tool or
arguments), the wrong lever for a bounded policy.

### Registry

`reviewRegistry.ts` — persisted JSON store (same pattern as
`agentRegistry.ts`/`tokenStore.ts`: private constructor + `static async
open(filePath, nowFn)`, `PersistShape { reviews: [] }`, every mutation
`await persist()` = `mkdir(dirname,{recursive})` + `writeFile(...,{mode:
0o600})`, path `~/.qwen/rc/reviews.json`; getters return defensive
copies; terminal-status `setStatus` returns a boolean used as the
emission/CAS gate).

```ts
interface ReviewRecord {
  reviewId: string; // uuid
  sessionId: string; // the daemon session running /review
  target:
    | { kind: 'pr'; number: number }
    | { kind: 'path'; path: string }
    | { kind: 'local' };
  comment: boolean;
  autofix: boolean;
  approvalLeg: 'vote' | 'auto';
  status:
    | 'running'
    | 'blocked' // a call is escalated and awaiting the owner's vote
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'orphaned';
  reportPath: string | null; // located by glob on completion (see below)
  summary: { findingsCount?: number; verdict?: string } | null; // PR only
  triggeredByTokenId: string;
  triggeredAt: string;
  finishedAt: string | null;
}
```

Cost is **not** stored — computed at read time from the existing cost
tables keyed by `sessionId`, the single source of truth.

### Lifecycle & events

`reviewLifecycle.ts` mirrors `agentLifecycle.ts`. It transitions the
record and emits to the **owner stream only** (a review has no parent
session):

- `blocked` ↔ `running` driven by the permission bridge (escalate →
  `blocked`; tool proceeds → `running`) — no SSE frame, an internal
  status surfaced in `GET /rc/reviews/:id`.
- terminal prompt completion → `completed`. The Step-10 report path
  follows a deterministic _pattern_
  (`.qwen/reviews/<date>-<time>-<target>.md`) but the filename carries a
  model-chosen `<time>`, so `reportPath` is located by globbing that
  pattern for the target and choosing the newest match, or left `null`.
  `summary` is filled from `.qwen/review-cache/pr-<n>.json` for PR
  targets.
- `session_died` → `failed`.

SSE frames (owner stream), registered in the wire-protocol SSE
registry: `review_started`, `review_completed`, `review_failed`,
`review_cancelled`. Payload: `{ reviewId, sessionId, target, status,
reportPath?, summary? }`. The `review_completed` / `review_failed`
frames become routable notification kinds `review.completed` /
`review.failed` (neither bypasses quiet hours).

### Audit actions

Registered in the pairing-auth extension registry: `review_started`,
`review_cancelled`. Records the target, the `comment`/`autofix`/
`autoApprove` flags, the approval leg, and `tokenId`/scope — **never**
the diff content or the report body.

### Reconciliation

Mirrors the agent-observability startup pass: a review whose backing
session is no longer live becomes `orphaned` (surfaced in
`GET /rc/reviews`, never silently dropped).

## Data flow (trigger → notification, auto-approve happy path)

1. Remote client `POST /rc/reviews { target: { pr: 42 }, autoApprove:
true }` with an `owner` token.
2. Gateway creates a daemon session (`sessionScope: 'thread'`),
   pre-flight-checks `'review' ∈ sessionSupportedCommands`, opens the
   dedicated `subscribeEvents(sessionId, { lastEventId: 0 })` bridge,
   registers the `ReviewRecord`, sends the `/review 42` prompt.
3. Emit `review_started` on the owner stream; write the `review_started`
   audit row.
4. The review runs. The fanout (`kind: 'other'`) escalates → owner votes
   ~9 times to spawn the agents; each agent's read/search/allowlisted-
   shell then auto-approves; `edit`/`web_fetch`/out-of-allowlist shell
   escalate.
5. Terminal completion: `reviewLifecycle` fills `reportPath` + PR
   `summary`, marks the record `completed`, emits `review_completed`,
   hands `review.completed` to the notification router.
6. Routing rules decide push/bridge delivery per existing config.

## Error handling

| Failure                                                                        | Behavior                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session create fails at trigger                                                | `502 daemon_unavailable`, nothing registered.                                                                                                                                        |
| **Skill not available** (pre-flight `sessionSupportedCommands` lacks `review`) | End the session, register nothing, `502 review_skill_unavailable`. Guards the silent plain-text fallback.                                                                            |
| Prompt send fails after create                                                 | Close the bridge, end the session, mark `failed`, `502 prompt_send_failed` — no zombie review sessions.                                                                              |
| `comment`/`autofix`/`autoApprove` set without `owner` scope                    | `403 owner_scope_required`, nothing registered.                                                                                                                                      |
| Escalated call the owner never answers                                         | The daemon's 5-min permission timeout resolves it `cancelled` (deny); the review proceeds with that tool denied (reduced coverage) or fails — the record shows `blocked` until then. |
| Owner denies an escalated call                                                 | The skill sees a denied tool call and proceeds per its own logic; outcome surfaced as the session's normal completion/failure.                                                       |
| Daemon dies mid-review                                                         | `session_died` → record `failed`, `review_failed` emitted + routed; bridge subscription closed.                                                                                      |
| Gateway restarts                                                               | Reconciliation pass; unreachable running reviews → `orphaned`. In-flight bridges are lost; their escalations fall to the daemon permission timeout.                                  |
| Cancel on terminal review                                                      | `409 review_not_running`.                                                                                                                                                            |

## Threat model

| Attacker                               | Capability                                                                       | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised `write` token              | Trigger reviews to burn compute                                                  | `write` reaches only vote mode; every privileged call is escalated to an explicit owner vote; each trigger is audited with tokenId + target. Per-token review quota deferred (follow-up).                                                                                                                                                                                                                                                                                                       |
| Compromised `owner` token              | Remote autofix / PR-comment / auto-approve                                       | `owner` scope required and audited; even under auto-approve the escalate-by-default classifier admits only read/search/allowlisted-shell/agent-work, and `edit`/comment are additionally flag-gated; owner revocation ends the session.                                                                                                                                                                                                                                                         |
| Prompt-injection via the reviewed diff | Steer the reviewer into mutation, network, or arbitrary shell under auto-approve | Escalate-by-default: only `read`/`search`, a metacharacter-free shell whose command passes a **per-command flag allowlist** (unrecognized/out-of-tree-redirect flags — `--ext-diff`, `-c`, `--output`, `--config`, `--manifest-path`, `--prefix`, `-exec`, `--init-script`, `mvn` plugin coords, … — escalate), and `edit` under `autofix` **confined to the worktree** auto-approve; `web_fetch` (exfiltration) and every `other`/unknown kind escalate; the metacharacter check defeats `; && | $()`smuggling;`gh` `@`-file field values (read-exfil) escalate. Edit path-confinement is enforced in two layers: the classifier string-resolves **all** target path fields against the worktree root (defeats absolute/`..`/dual-field-decoy), and the permission bridge `fs.realpath`-verifies the target before honoring an edit approval (defeats an in-tree symlink pointing outside). Residual: **build/test auto-approval runs the PR author's own in-tree code** (`npm test` executes whatever is in the tree) — inherent to reviewing a PR, not a new hole; out-of-tree code loads are blocked. The "cannot write/commit/push/post" guarantee is scoped to the **reviewer's own** privileged actions, not to code the tree already executes. |
| Malicious LAN process                  | Forge review triggers                                                            | Same auth surface as every gateway route: scope-gated bearer token; no new unauthenticated path.                                                                                                                                                                                                                                                                                                                                                                                                |
| Silent skill-load failure              | `/review` forwarded as plain text, no review runs, owner misled                  | Pre-flight `sessionSupportedCommands` guard fails loudly to `502 review_skill_unavailable`; never a fake success.                                                                                                                                                                                                                                                                                                                                                                               |
| Missed early permission frame          | Review stalls / a dangerous call resolves without review                         | Dedicated `subscribeEvents(lastEventId: 0)` forces full ring replay, so the bridge sees every frame; only a gateway crash mid-review loses a bridge, and then the daemon's 5-min timeout denies pending calls (fail-safe, not fail-open).                                                                                                                                                                                                                                                       |
| Report/cost tampering                  | Forge a review outcome                                                           | Report path is derived read-only by globbing the deterministic `.qwen/reviews/` pattern; cost is computed from the authoritative cost tables, not stored on the record.                                                                                                                                                                                                                                                                                                                         |

## Alternatives considered

- **B: Reimplement review as a deterministic workflow** on the
  `add-workflow-orchestration` engine. Gains determinism + journaled
  resume, but must re-earn the substantial working machinery the skill
  already owns — fetch-pr worktree isolation, the deterministic
  linter/build/test pre-pass, the Create-Review PR-comment API, and
  autofix. High duplication risk for a modest determinism gain (the
  _content_ of each review agent is LLM-nondeterministic regardless).
  Rejected in favor of the thin surface.
- **C: Hybrid** — script only the orchestration loop as a workflow while
  calling into the existing `commands/review/` infrastructure. Best of
  both, but a larger integration surface than the remote gap warrants.
  Rejected for now; a future change can lift the orchestration into a
  workflow without touching this surface.
- **Pump/enforcer seam for the auto-voter** — reuse the existing
  `SessionEventPump` + `PolicyEnforcer` rather than a dedicated
  subscription. Rejected: the pump is poll-driven (up to 5s late),
  doesn't replay the ring on first subscribe (misses early frames), is
  push-gated, and its enforcer is global — all of which make it
  unreliable for a headless review. A dedicated
  `subscribeEvents(lastEventId: 0)` is race-free.
- **Tool-name allowlist / additive `name` frame field for hands-off
  auto-approve** — the frame carries no tool-name, so an exact
  allowlist needs a daemon frame change. Chosen to key on `kind` +
  escalate-by-default with no daemon change (the fanout escalates,
  making auto-approve "assisted" not hands-off). The additive `name`
  field is a follow-up.
- **Parse findings into a structured API / modify the skill to emit
  structured events** — rejected: the first couples the gateway to the
  SKILL.md markdown format (brittle), the second forks the upstream
  skill. A follow-up if a rich remote finding UX is wanted.

## Testing

Vitest, existing stub-daemon pattern:

- **Registry**: persistence round-trip; reconciliation against a stub
  session list; orphan marking.
- **Classifier (Opus, pure function, real frame shapes)**: `read`/
  `search` approve; `edit` escalates unless `autofix`; `execute` approves
  only metacharacter-free argv-allowlisted commands and escalates
  `git commit`/`push`/`rm`/`curl`/installs and `git diff; rm -rf`
  smuggling; `gh` comment-post approves only when `comment`; `fetch` and
  `other`/unknown always escalate. Tests use `{ toolCallId, title, kind,
rawInput }`, never `{ name, input }`.
- **Permission bridge**: on a scripted permission-frame feed — approve
  path calls `respondToSessionPermission` with the `allow_once`
  optionId; missing `allow_once` → escalate; escalate path leaves
  pending + notifies + sets `blocked`; vote mode escalates everything.
- **Trigger route**: saga success + failure legs (create fails,
  pre-flight skill-missing → `502 review_skill_unavailable`, prompt-send
  fails); scope enforcement (`read` cannot trigger; `write` cannot set
  `comment`/`autofix`/`autoApprove` → `403`); target → prompt mapping
  (pr/path/local); report-only suffix when `autofix` false.
- **Lifecycle**: stub feed → status transitions (running ↔ blocked, →
  completed/failed); correct frames; `reportPath`/`summary` fill on
  completion (PR summary from the cache JSON).
- **Cancel**: proxy to session end; `409` on terminal.
- **Integration**: trigger → observe frames → cancel against the stub
  daemon; a real auto-approve `/review local` against the stub with a
  scripted permission sequence (fanout escalates, agent work approves);
  a vote-mode run where a scripted permission escalates and is answered
  via the existing permission route.

## Spec artifacts (qwen-code-remote)

`openspec/changes/add-remote-review/` with:

- `proposal.md` — why, what changes (leads with the premise correction).
- `design.md` — this design, with Alternatives and the threat-model
  table (config.yaml rules).
- `specs/remote-review/spec.md` — requirements with scenarios; endpoints
  cited method+path; SSE requirements cite event names.
- `tasks.md` — phased tasks with Status/Prompt fields per config.yaml.

Registry edits are made **directly** in `add-remote-control`'s
wire-protocol spec (4 SSE rows: `review_started`, `review_completed`,
`review_failed`, `review_cancelled`) and pairing-auth spec (2 audit
rows: `review_started`, `review_cancelled`), per repo precedent — no
`## MODIFIED Requirements` partial-content delta files.

## Follow-ups (out of scope)

- **Hands-off auto-approve**: add an additive `name: fc.name` field to
  the daemon `permission_request` frame (`httpAcpBridge.ts`) so the
  classifier can key on the exact tool name and auto-approve the agent
  fanout without owner votes. Purely additive; precedent is the
  remote-rewind bridge extension.
- **`PolicyEnforcer` wire-mismatch bug** (separate, not this change): the
  existing enforcer reads `toolCall.name`/`toolCall.input`, which do not
  exist on real frames, so path-glob policy rules silently never match;
  its tests use a synthetic `{ name, input }` shape that hid it. Worth a
  dedicated fix.
- **Reliable pump notification** for all headless sessions (the same
  ring-replay gap affects any gateway-created session's permission
  notifications, not just reviews).
- Structured finding API / `review_finding` streaming (would parse the
  report or modify the skill).
- Lifting the orchestration into a deterministic workflow (Alternative
  C) for journaled resume.
- Per-token review quota (noted in the threat model).
- Incremental remote re-review using the existing
  `.qwen/review-cache/pr-<n>.json` (re-review only new commits).
