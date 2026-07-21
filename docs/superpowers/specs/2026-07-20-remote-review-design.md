# Remote review — design (2026-07-20)

A thin rc-gateway surface for triggering and observing the fork's
existing bundled `/review` skill from a remote client. Approved
approach: **A — review-as-tagged-session** (chosen over B: reimplement
review as a workflow, and C: hybrid orchestration; see Alternatives).

Spec-first: ships as the next OpenSpec change, `add-remote-review`, in
qwen-code-remote, registering all new SSE events and audit actions in
the authoritative registries before implementation.

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
  **vote mode** (each privileged tool call surfaces a permission
  request the owner approves remotely); an `owner`-scope trigger may run
  the review **auto-approved** against a bounded allowlist.

## Feasibility (verified)

A headless daemon/ACP session runs the `review` skill when sent the
literal prompt text `/review 42`. The daemon processes slash commands
through the same skill loaders the interactive CLI uses; there is no UI
dependency:

- `BundledSkillLoader` maps each bundled skill (including `review`) to a
  `SlashCommand` of `kind: SKILL` whose action expands the SKILL.md body
  inline as the model prompt, appending args
  (`packages/cli/src/services/BundledSkillLoader.ts`).
- The daemon's ACP `prompt` RPC routes text starting with `/` through
  `isSlashCommand` → `handleSlashCommand`, which instantiates
  `BundledSkillLoader` and dispatches the skill
  (`packages/cli/src/acp-integration/session/Session.ts`,
  `packages/cli/src/nonInteractiveCliCommands.ts`).
- `SKILL`-kind commands are valid in `acp`/`non_interactive` modes
  (`getEffectiveSupportedModes`), and the bare-mode gate that would
  disable them is off by default and unset by the daemon supervisor.
- `task` is the legacy alias for the `agent` tool; the fanout works in
  the daemon and subagents are observable via `SubAgentTracker`.

Two caveats drive the design:

1. **Silent load fallback**: if the skill fails to load (bare mode,
   `skills.disabled`, etc.), `handleSlashCommand` returns `no_command`
   and the literal `/review 42` is forwarded to the model as plain text
   with no error. The trigger route MUST verify the skill actually
   dispatched and fail loudly otherwise (see Error handling).
2. **Permissions gate completion, not invocation**: the skill body runs
   shell (`git`, build, test), `read_file`/`write_file`/`edit`, and the
   `task`/`agent` fanout — all normally per-call approval-gated. A
   headless session has no local human to approve; the approval policy
   below is how the review runs to completion. Note a review inherently
   reads the diff under review, so a malicious diff could attempt to
   prompt-inject the reviewer — which is why auto-approving workstation
   shell from a remote trigger is owner-class trust, not write-class.

## Architecture

Every review **is a daemon session**, tagged in a gateway-local
registry, reusing the agents-as-sessions plane delivered by
`add-agent-observability`. Because a review is a session, the existing
subsystems apply with no new per-subsystem code: WAL replay, presence,
**permission voting** (the vote-mode approval path is remote approval of
a blocked agent's tool call — already built), cost tracking, FTS5
search, scope enforcement, audit, reconciliation. The Stage-1 daemon
remains unmodified (preserves the transparent-proxy boundary): the only
new daemon-visible behavior is a prompt whose text is `/review …`.

### Control plane

| Endpoint                                                          | Scope                                                                 | Behavior                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /rc/reviews` `{ target, comment?, autofix?, autoApprove? }` | `write`; → `owner` if any of `comment`/`autofix`/`autoApprove` is set | Saga: create daemon session (SDK) → configure the approval leg → send `/review <target> [--comment]` prompt → register `ReviewRecord` + `AgentRecord` → verify the skill dispatched → `202 { reviewId, sessionId }`. |
| `GET /rc/reviews?status=`                                         | `read`                                                                | Registry listing: status, target, summary, timestamps.                                                                                                                                                               |
| `GET /rc/reviews/:id`                                             | `read`                                                                | Detail: status, target, `reportPath`, PR `findingsCount`/`verdict` when available, `sessionId`, cost rollup.                                                                                                         |
| `POST /rc/reviews/:id/cancel`                                     | `write`                                                               | Proxy to `POST /session/:id/end`; mark record `cancelled`; `409 review_not_running` if terminal.                                                                                                                     |

`target` is one of `{ pr: number }` → `/review <n>`, `{ path: string }`
→ `/review <path>`, `{ local: true }` (default) → `/review`. `comment:
true` appends `--comment` (owner-gated). `autofix` is enforced at the
approval layer (below); additionally, when `autofix` is false the
trigger appends a "report only — do not apply autofixes" instruction to
the prompt so the skill does not even propose edits, with the
approval-layer denial as the defense-in-depth backstop against a
prompt-injected attempt to autofix anyway. Observation of live progress
is `GET /session/:sessionId/events` on the review's own session,
unchanged.

### The approval policy (security-critical — Opus-owned)

This component carries the threat model, so it is authored and reviewed
by Opus. It has two legs, selected by scope + the `autoApprove` flag:

- **Vote mode** (`write`, `autoApprove` absent — the default). The
  review session uses the normal `ask` approval mode. Every privileged
  tool call surfaces an ordinary `permission_request` frame on the
  review session's stream; the owner approves or denies it via the
  existing remote-voting path. Nothing is auto-approved. Secure but
  interactive — practical for small diffs or while watching.
- **Auto-approve mode** (`owner`, `autoApprove: true`). The gateway
  registers a **bounded auto-voter** on the review session that answers
  its permission requests against a fixed allowlist:
  - **Auto-approve**: `read_file`, `grep_search`, `glob`, the
    `agent`/`task` fanout, and `run_shell_command` whose command matches
    a read/build/test allowlist — read-only `git`
    (`status`/`diff`/`log`/`show`/`rev-parse`), the project's
    build/test invocations
    (`npm`/`pnpm`/`yarn`/`cargo`/`go`/`mvn`/`gradle`/`make` build+test,
    `tsc --noEmit`), the `qwen review …` subcommands, and
    `mkdir -p …/.qwen/…`.
  - **Deny by default (mutations)**: `write_file` and `edit` are
    approved only when `autofix: true`; the PR-comment post is approved
    only when `comment: true`; any `run_shell_command` **not** matching
    the allowlist (including `git commit`/`push`, `rm`, `curl`, package
    installs) escalates to a vote rather than auto-approving.

  This is what makes `autofix: false` meaningful under auto-approve: a
  prompt-injected diff can burn compute or read code, but cannot
  silently write, commit, push, or post. The allowlist is a
  literal-prefix/argv classifier, never a substring match, to avoid
  `git diff; rm -rf` smuggling.

The auto-voter reuses the agent-observability voting plumbing (the
gateway already answers permission votes); it does not introduce a new
approval primitive on the daemon.

### Registry

`reviewRegistry.ts` — persisted JSON store (same pattern as
`agentRegistry.ts`/`tokenStore.ts`).

```ts
interface ReviewRecord {
  reviewId: string; // uuid
  sessionId: string; // the daemon session running /review
  agentId: string; // the AgentRecord this review is also registered as
  target: // discriminated union, mirrors the trigger body
  | { kind: 'pr'; number: number }
    | { kind: 'path'; path: string }
    | { kind: 'local' };
  comment: boolean;
  autofix: boolean;
  approvalLeg: 'vote' | 'auto';
  status:
    | 'running'
    | 'blocked' // an auto-escalated or vote-mode call is awaiting approval
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

Cost is **not** stored — it is computed at read time from the existing
cost tables keyed by `sessionId`, the single source of truth (same rule
as `AgentRecord`).

### Lifecycle & events

`reviewLifecycle.ts` subscribes to the review session's events through
the gateway's own event plumbing and transitions the record:

- outstanding `permission_request` → `blocked`; resolved → `running`
- terminal prompt completion → `completed`. The Step-10 report path
  follows a deterministic _pattern_ (`.qwen/reviews/<date>-<time>-<target>.md`)
  but the filename carries a model-chosen `<time>`, so `reportPath` is
  located by globbing that pattern for the target and choosing the
  newest match, or left `null` if none is found. `summary` is filled
  from `.qwen/review-cache/pr-<n>.json` when the target is a PR
- `session_died` → `failed`

SSE frames (owner stream, plus the parent session's stream when a
parent exists), to be registered in the wire-protocol SSE registry:
`review_started`, `review_completed`, `review_failed`,
`review_cancelled`. Payload: `{ reviewId, sessionId, target, status,
reportPath?, summary? }`.

The `review_completed` and `review_failed` frames become routable
notification kinds `review.completed` / `review.failed` through the
existing routing rules and bridges; neither bypasses quiet hours.

### Audit actions

Registered in the pairing-auth extension registry: `review_started`,
`review_cancelled`. Records the target, the `comment`/`autofix`/
`autoApprove` flags, the approval leg, and `tokenId`/scope — **never**
the diff content or the report body.

### Reconciliation

Reuses the agent-observability startup pass: a review whose backing
session is no longer live becomes `orphaned` (surfaced in
`GET /rc/reviews`, never silently dropped).

## Data flow (trigger → notification, happy path)

1. Remote client `POST /rc/reviews { target: { pr: 42 }, autoApprove:
true }` with an `owner` token.
2. Gateway creates a daemon session (SDK), registers the auto-voter for
   this session, registers `ReviewRecord` + `AgentRecord`, sends the
   `/review 42` prompt.
3. Gateway verifies the skill dispatched (see Error handling); emits
   `review_started` on the owner stream; writes the `review_started`
   audit row.
4. The review runs: `qwen review fetch-pr`, deterministic pre-pass, the
   9-agent fanout, verification, reverse audit — each privileged call
   auto-approved or escalated per the bounded allowlist.
5. Terminal completion: `reviewLifecycle` fills `reportPath` + PR
   `summary`, marks the record `completed`, emits `review_completed`,
   hands the routable `review.completed` kind to the notification
   router.
6. Routing rules decide push/bridge delivery per existing config.

## Error handling

| Failure                                                        | Behavior                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session create fails at trigger                                | `502 daemon_unavailable`, nothing registered.                                                                                                                                                                                           |
| Prompt send fails after create                                 | Session ended, record `failed`, `502` — no zombie review sessions.                                                                                                                                                                      |
| **Skill did not dispatch** (silent plain-text fallback)        | The trigger saga inspects the session's first response / `stopReason`; if the skill did not run, end the session, mark the record `failed`, emit `review_failed`, return `502 review_skill_unavailable`. Never report a fake `running`. |
| `comment`/`autofix`/`autoApprove` set without `owner` scope    | `403 owner_scope_required`, nothing registered.                                                                                                                                                                                         |
| Vote-mode call denied by owner                                 | The skill sees a denied tool call and proceeds per its own logic; the review may complete with reduced coverage or fail — surfaced as the session's normal outcome.                                                                     |
| Auto-escalated shell (outside allowlist) with no voter present | Treated as a vote that no one answers → the call blocks; the record shows `blocked`. Owner can approve or cancel.                                                                                                                       |
| Daemon dies mid-review                                         | `session_died` → record `failed`, `review_failed` emitted + routed.                                                                                                                                                                     |
| Gateway restarts                                               | Reconciliation pass; unreachable running reviews → `orphaned`.                                                                                                                                                                          |
| Cancel on terminal review                                      | `409 review_not_running`.                                                                                                                                                                                                               |

## Threat model

| Attacker                               | Capability                                                      | Mitigation                                                                                                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised `write` token              | Trigger reviews to burn compute                                 | `write` reaches only vote mode; every dangerous call needs an explicit owner vote; each trigger is audited with tokenId + target. Per-token review quota deferred (follow-up).                                                                                    |
| Compromised `owner` token              | Remote autofix / PR-comment / auto-approve                      | `owner` scope required and audited; even under auto-approve the bounded allowlist denies out-of-band mutations unless the matching flag is set; owner revocation ends the session.                                                                                |
| Prompt-injection via the reviewed diff | Steer the reviewer into shell or mutation under auto-approve    | Bounded allowlist: reads/build/test auto-approved; `write_file`/`edit`/commit/push/post/arbitrary-shell deny-by-default and escalate to a vote unless the owner set the flag. Residual read/compute exposure is documented and accepted for the auto-approve leg. |
| Malicious LAN process                  | Forge review triggers                                           | Same auth surface as every gateway route: scope-gated bearer token; no new unauthenticated path.                                                                                                                                                                  |
| Silent skill-load failure              | `/review` forwarded as plain text, no review runs, owner misled | Post-dispatch guard fails loudly to `review_failed` / `502 review_skill_unavailable`; never a fake success.                                                                                                                                                       |
| Report/cost tampering                  | Forge a review outcome                                          | Report path is derived read-only by globbing the deterministic `.qwen/reviews/` pattern; cost is computed from the authoritative cost tables, not stored on the record.                                                                                           |

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
- **Parse findings into a structured API / modify the skill to emit
  structured events** — rejected for this change: the first couples the
  gateway to the SKILL.md markdown format (brittle), the second forks
  the upstream skill (merge maintenance). Kept as a follow-up if a rich
  remote finding UX is wanted.

## Testing

Vitest, existing stub-daemon pattern:

- **Registry**: persistence round-trip; reconciliation against a stub
  session list; orphan marking.
- **Trigger route**: saga success + both failure legs (create fails,
  prompt-send fails); scope enforcement (`read` cannot trigger; `write`
  cannot set `comment`/`autofix`/`autoApprove`); the skill-did-not-
  dispatch guard → `502 review_skill_unavailable`; target → prompt
  mapping (pr/path/local).
- **Approval policy (Opus)**: the bounded allowlist — reads/build/test
  auto-approved; `write_file`/`edit` denied unless `autofix`; PR-comment
  post denied unless `comment`; out-of-allowlist shell escalates, never
  auto-approves; prefix/argv classifier rejects `git diff; rm -rf`
  smuggling. Vote-mode leg: privileged calls surface as
  `permission_request`, nothing auto-approved.
- **Lifecycle**: stub SSE feed → status transitions (running ↔ blocked,
  → completed/failed); correct frames; `reportPath`/`summary` fill on
  completion (PR summary from the cache JSON).
- **Cancel**: proxy to session end; `409` on terminal.
- **Integration**: trigger → observe frames → cancel against the stub
  daemon; and a real end-to-end `/review local` against the stub with
  the auto-voter approving a scripted tool-call sequence.

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

- Structured finding API / `review_finding` streaming (would parse the
  report or modify the skill).
- Lifting the orchestration into a deterministic workflow (Alternative
  C) for journaled resume.
- Per-token review quota (noted in the threat model).
- Incremental remote re-review using the existing
  `.qwen/review-cache/pr-<n>.json` (re-review only new commits).
