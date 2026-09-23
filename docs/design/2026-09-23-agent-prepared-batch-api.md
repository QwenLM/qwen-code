# Agent-Prepared Batch API Workflow

[中文版](./2026-09-23-agent-prepared-batch-api.zh-CN.md)

Status: implemented alongside this document (2026-09-23), on top of the
low-level `qwen batch submit|status|fetch|cancel` transport from #11874.
This document is the design contract for the workflow layer; the user-facing
guide lives in `docs/users/features/batch.md`.

## 1. Problem and goal

PR #11874 adds the DashScope Batch API to the CLI as four transport verbs.
Used directly they are powerful but barely usable for the people the feature
is for: the user must understand their task, gather every item's materials,
hand-assemble a request JSONL, submit, wait, parse results, map them back to
files, and verify — the two steps an agent is best at (preparing inputs,
delivering outputs) are left to the user. Meanwhile the one thing the
measured data supports — fan-out of independent single-turn requests is the
shape Batch is actually cheaper for — is exactly the shape an agent can
prepare well.

Goal: the user states a bulk task in natural language, explicitly chooses
async batch mode, and later receives delivered files. The agent prepares
lightly, the Batch API executes the bulk generation, and deterministic code
owns submission, recovery, validation, delivery, and accounting.

Two product promises, kept separate:

- **Convenience** — no JSONL, no request ids, no provider concepts. This is
  always on.
- **Cheaper total cost** — the whole task (light realtime preparation +
  Batch generation + delivery + any rework) must cost less than doing the
  same work realtime to the same quality bar. This is a property of the
  task shape, never a blanket claim: Batch bills at 50% of realtime list but
  does not benefit from the context cache (measured in #11874's probes and
  documented in `docs/users/features/batch.md`).

## 2. Entry points

### `/batch-api <task>` (interactive)

A separate bundled skill, `packages/core/src/skills/bundled/batch-api/`,
next to — not inside — the existing `/batch` (realtime parallel workers,
unchanged). The two are not substitutes: `/batch` workers use tools and edit
files in place within minutes; `/batch-api` requests are single-turn,
tool-less, write only fresh targets, and take hours. The skill sets
`disable-model-invocation: true`, so choosing Batch is always the user's
explicit act — the model can neither enter nor leave this mode on its own.
Its `allowedTools` grants read-only tools only; writing the plan and
`qwen batch run` (which spends money) stay behind the approval prompt.

The skill makes the model do the semantic work only:

0. Run `qwen batch check` first: it proves credentials, endpoint and the
   Batch route (no billed request) and shows the settings a run would
   freeze. On failure — e.g. Qwen OAuth, which has no Batch route — stop
   before spending anything on preparation.
1. Judge suitability honestly (independent single-turn transforms with all
   materials available now). Unsuitable → explain and stop; never silently
   do the work realtime instead.
2. Prepare lightly — glob the files, read a 2–3 file sample, draft the
   shared rules once. Deep per-file analysis belongs to nobody: the executor
   embeds full contents mechanically.
3. Write one plan JSON to `.qwen/batch/plans/<slug>.json`.
4. Submit by running `qwen batch run <plan>` in the shell, then report the
   task id, estimate, and collect command verbatim.

### `qwen batch` workflow subcommands (deterministic executor)

| Command                   | Behavior                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `run <plan>`              | Validate plan → assemble → estimate → budget gate → submit → record                          |
| `collect <task-id>`       | Reconcile → poll (optional `--wait`) → download → validate → deliver → report                |
| `retry <task-id>`         | Resubmit only `failed` items as a new attempt (`--max-output-tokens` for truncated ones)     |
| `check`                   | Verify credentials/endpoint/Batch route and show what `run` would freeze; nothing billed     |
| `clean <task-id>`         | Delete the local record; cancels nothing, refuses while a batch may be open unless `--force` |
| `list`                    | List recorded tasks with progress                                                            |
| `cancel --task <task-id>` | Cancel the task's active batch (partials are still billed)                                   |

`run` prints the task id and exits — waiting never burns agent turns.
`collect` is safe to run any number of times: everything already local is
reused, delivered items are never redone, and held items are re-attempted
(after the user resolves a conflict) without any new paid request.

## 3. Architecture

```text
user: /batch-api "translate docs/zh into docs/en"
        │
        ▼
prepare skill (batch-api/SKILL.md) — semantic work only: suitability, sample read,
shared rules, plan file. Runs realtime, keeps its own cache benefits.
        │
        ▼  plan JSON (schema in §4)
workflow executor (packages/cli/src/commands/batch-workflow.ts)
  ├─ batch-task.ts   ledger: task/item/attempt records, atomic writes
  ├─ batch-docs.ts   assemble requests, validate results, deliver files
  └─ batch-client.ts HTTP primitives with status-carrying errors
        │
        ▼
transport from #11874 (batch.ts): endpoint/auth resolution, upload, create,
status, download, cancel — reused, not duplicated.
```

Design invariants:

- **The ledger answers "which remote objects might exist?" without
  guessing.** Submit intent is persisted before upload, the uploaded file id
  before create. A lost create response — or a process that died with the
  create in flight, leaving the attempt `uploaded` — becomes
  `submit-unknown`, reconciled against the provider's batch list by
  `input_file_id` — never blindly resubmitted, because the wrong answer
  bills twice.
- **Records live with the user, not the repository.** Tasks are kept under
  `~/.qwen/batch` (`QWEN_HOME`/`QWEN_BATCH_HOME` honoured) with owner-only
  permissions, record their project root, and are reachable from any
  directory. Only the agent's plan files stay in the project, git-ignored.
- **A task is pinned to its endpoint.** The base URL and a short hash of the
  API key (never the key) are frozen at `run`; `collect`, `retry` and
  `cancel` refuse under different settings, since the batch is invisible
  from another account or region.
- **One command per task at a time.** `collect`, `retry` and `cancel` (and
  `run` while submitting) hold a per-task lock file; a lock whose pid is
  dead is taken over. Two concurrent retries would otherwise both bill the
  same items.
- **custom_id = `<itemId>#<attempt>`**, so results map back unambiguously
  across retries; unknown/duplicate result lines are ignored with a warning.
  Each item records the attempt that owns it, and only that attempt's
  result lines may change it: replaying an older attempt's failure while a
  retry runs must not re-open the item for another paid retry.
- **Delivery is no-overwrite.** A target that exists with different content
  is a conflict to report; an identical existing target counts as delivered,
  which is what makes re-collection idempotent. Sources are re-hashed before
  writing — a source that changed after submission holds its result.
- **Usage stays out of the interactive session's realtime cache statistics.**
  The workflow runs in its own process and records usage in the task ledger;
  Batch's `cached_tokens: 0` can never dilute the realtime cache-hit rate
  displayed for interactive use.
- **No monetary estimate without prices.** Token estimates are always shown
  (rough, chars/3). Dollar estimates exist only when
  `QWEN_BATCH_INPUT_PRICE_PER_1M_USD` and
  `QWEN_BATCH_OUTPUT_PRICE_PER_1M_USD` are set — a hardcoded price table
  would go stale against the provider's pricing page. A plan may set
  `maxCostUsd`, which is an **estimate gate, not a cap on the bill**: `run`
  and every `retry` refuse to submit when the estimate exceeds it, and
  refuse outright when no prices are configured. Estimates are rough and
  the provider bill is authoritative.
- **Batch runs the user's realtime settings.** At `run` the executor freezes
  the configured sampling parameters, output limit and thinking mode into
  the task (only fields verified as chat-completions body parameters), and
  every retry reuses them. A Batch-only default would make the cost/quality
  comparison against realtime meaningless. A configured reasoning effort
  that has no verified Batch equivalent is reported as a note, not guessed.

- **Accounting states its gaps.** Usage is summed across all attempts from
  the result files; a line without usage makes the total explicitly
  _incomplete_, never a silent zero. With prices set, `run` records their
  source (`QWEN_BATCH_PRICE_SOURCE`) and states the break-even realtime
  cache-hit rate — where `0.5·(I+O) − 0.8·h·I` reaches zero, the §6 model
  with the implicit-cache price at 20% of list — instead of claiming a
  saving. Preparation in the interactive
  session is not measured by the executor; every estimate and report says
  so rather than implying a full-workflow figure.
- **Lock takeover only when release is certain.** The lock records pid and
  host; it is taken over only when written on this host by a pid that no
  longer exists. A reused pid can only cause a (safe) refusal, and a lock
  from another host is never taken over; the message names the file to
  delete by hand.

## 4. Plan schema (v1)

```json
{
  "version": 1,
  "name": "translate-docs",
  "kind": "document-transform",
  "completionWindow": "24h",
  "maxCostUsd": 2.0,
  "maxOutputTokens": 4096,
  "expectedOutputTokensPerItem": 1500,
  "shared": {
    "system": "optional system prompt",
    "instructions": "shared rules: terminology, style, output contract"
  },
  "items": [
    {
      "id": "intro",
      "source": "docs/zh/intro.md",
      "target": "docs/en/intro.md"
    }
  ]
}
```

Enforced by `batch-task.ts`: item ids match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`
(they ride inside provider custom_ids), ids and targets are unique, unknown
fields are rejected (an agent's typo must fail loudly, not silently change
behavior). Only the optional fields above are optional; `kind` is literal —
new kinds get their own schema version. `enableThinking` exists only for a
user who explicitly asks for a different thinking mode; left unset, the
frozen setting applies, and `false` is refused for thinking-mandatory models.

The first product contract is **one source document → one complete target
document**. The model returns content only; paths or commands inside its
output are data and are never executed. Delivery validates structure (non-
empty, no truncation, no tool calls, balanced markdown fences) — structure
is not semantic quality, which remains the user's acceptance call.

## 5. Boundary behaviors

| Boundary                                             | Behavior                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsuitable task (needs iterative feedback)           | Skill explains and stops; no silent realtime fallback                                                                                                               |
| Source path escapes project root (incl. via symlink) | Assembly refuses before anything is uploaded                                                                                                                        |
| Assembled line > 1 MB                                | Refused with a pointer to raw `qwen batch submit` (workflow cap, below the provider's 6 MB)                                                                         |
| Create returns definite 4xx                          | Orphan upload deleted, items `failed`, `retry` is safe                                                                                                              |
| Create answer lost (5xx / dropped socket)            | `submit-unknown`; `collect` reconciles via the provider list; no resubmit                                                                                           |
| Reconcile finds 0 or 2+ candidates                   | Report and stop; the provider list is the source of truth                                                                                                           |
| Batch not settled at collect                         | Report status; `--wait` polls with 10s→60s backoff up to `--timeout`                                                                                                |
| Result line truncated / tool calls / empty           | Item `failed` with the reason; billed-failure costs stay visible. A truncated item is skipped by `retry` unless `--max-output-tokens` raises the limit it failed at |
| Result custom_id unknown or duplicated               | Ignored with a warning, never mapped onto another item                                                                                                              |
| Error-file line                                      | Item `failed` with the provider's error                                                                                                                             |
| Item missing from all result files                   | Item `failed` ("no result line")                                                                                                                                    |
| Source changed after submission                      | Delivery `held` with the reason; re-collect after reverting                                                                                                         |
| Target exists with different content                 | Delivery `held`; user resolves, re-collect delivers from the local record                                                                                           |
| Target path symlinks out of the project              | Delivery `held`                                                                                                                                                     |
| `--task` cancel on a settled batch                   | Points at `collect` instead of pretending to cancel                                                                                                                 |
| Remote cleanup after collect                         | Input/output/error files deleted (after local persistence); `--keep-remote` opts out                                                                                |

Retry semantics: only `failed` items (plus items whose only submission is
confirmed never to have become a batch), as a new attempt with fresh
`#<attempt>` custom ids, under the plan's `maxCostUsd` like `run`; refused
while an ambiguous submission exists or an earlier batch is still running or
settled-but-uncollected. Held items are never retried — they need a
user decision, not a new request.

## 6. Cost model

The executor compares nothing automatically — the user explicitly chose
Batch by invoking `/batch-api` — but it must not lie about money:

- Batch pricing: 50% of realtime list for successful requests, no context
  cache. Whether that beats realtime for a given job depends on the shared
  prefix fraction and output share (`docs/users/features/batch.md` derives
  the break-even math). The prepare skill keeps suitable tasks in the shape
  where Batch wins (item content dwarfs shared instructions, or outputs are
  long).
- Realtime preparation is deliberately cheap: the skill reads a sample, not
  every file; the executor embeds full contents mechanically. If the agent
  must deeply analyze each item to prepare it, the task is not in this
  workflow's sweet spot and the skill should say so.
- Rework is accounted: failed items retry visibly (new attempt, new usage);
  held items deliver from local records for free; nothing auto-retries in a
  loop.
- Estimates are labeled estimates. The provider bill is authoritative.

## 7. Verification

- Unit tests (`packages/cli/src/commands/batch-task.test.ts`,
  `batch-docs.test.ts`, `batch-workflow.test.ts`): plan validation, ledger
  atomicity and schema guard, assembly refusal on escaping paths, result
  classification, delivery conflict/change/idempotency, the full submit →
  settle → collect → retry lifecycle against a fake `WorkflowApi`, ambiguous
  create reconciliation, `--wait` backoff, budget gates.
- Manual end-to-end (fake HTTP server, isolated HOME, real built CLI):
  `run → collect (running) → collect --wait → delivered files → idempotent
re-collect → list → failure → retry → held → resolve → delivered →
cancel`. All checks pass; no real API is touched.
- The existing `qwen batch submit|status|fetch|cancel` behavior is unchanged
  (its test suite passes unmodified).

## 8. Non-goals (deliberate)

- No automatic realtime/batch router, no paid probing runs, no auto-repair
  loops. The user picks the mode; the program keeps it honest.
- No multi-stage dependency graphs; one settled batch per attempt.
- No per-turn agent loop over Batch (measured and rejected in #11874).
- No generic result protocol: only the document-transform contract is
  implemented. Code-patch delivery (apply + build + test) is a future kind
  with its own acceptance checks, not an assumption to bake in now.
