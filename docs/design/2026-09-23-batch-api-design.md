# `/batch-api` design

Status: implemented in PR #12492. User guide: `docs/users/features/batch.md`.
Measured data: `docs/verification/batch-api/results-2026-09-23.md`.

## 1. Goal

The user states a bulk task in one sentence, explicitly picks the
asynchronous Batch mode, and later receives delivered files.

- The agent does only the semantic work: judge suitability, sample 2–3 files,
  write the shared rules, write a plan file.
- The Batch API does the bulk generation.
- Deterministic code owns submission, recovery, validation, delivery and
  accounting.

In scope: many **independent, single-turn** transforms whose materials exist
now (translate a set of documents under one style guide, rewrite or extract
per file). Out of scope: tasks that need feedback, chained items, a handful
of items.

## 2. Entry points

### 2.1 `/batch-api <task>` (interactive skill)

- `packages/core/src/skills/bundled/batch-api/SKILL.md`, next to — not a
  replacement for — the realtime parallel `/batch`.
- `disable-model-invocation: true`: only the user can enter the Batch path.
  `/batch`'s description lets the model _suggest_ typing `/batch-api`.
- `allowedTools` pre-approves read-only tools (`glob`, `grep_search`,
  `read_file`); writing the plan and `qwen batch run` (which spends money)
  stay behind the approval prompt.
- Flow:
  1. `qwen batch check`: verifies credentials, endpoint and the Batch route
     and shows the settings a run would freeze. Nothing is billed; on
     failure, stop before spending anything on preparation.
  2. Judge suitability. Unsuitable → explain and stop; **never silently do
     the work realtime**.
  3. Prepare lightly: glob the files, read a 2–3 file sample, write the
     shared rules once.
  4. Write the plan to `.qwen/batch/plans/<slug>.json`.
  5. Run `qwen batch run <plan>` and relay its output. Collection is
     automatic.
- Every command runs as `"${QWEN_CODE_CLI:-qwen}" batch …`, so it reaches the
  CLI running the session.

### 2.2 `qwen batch` subcommands (deterministic executor)

| Command                   | Behavior                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `check`                   | Verify credentials, endpoint and Batch route; show what `run` would freeze; nothing billed |
| `run <plan>`              | Validate plan → assemble → estimate → budget gate → submit → record                        |
| `collect <task-id>`       | Reconcile → poll (optional `--wait`) → download → validate → deliver → report              |
| `retry <task-id>`         | Resubmit only `failed` items as a new attempt; truncated ones need `--max-output-tokens`   |
| `list`                    | List recorded tasks (local only, no credentials)                                           |
| `cancel --task <task-id>` | Cancel the task's active batch (finished requests are still billed)                        |
| `clean <task-id>`         | Delete the local record; cancels nothing; refuses while a batch may be open unless forced  |

`run` prints the task id and exits, so waiting never costs agent turns.
`collect` can run any number of times.

The raw transport verbs `submit` / `status` / `fetch` / `cancel <id>` (from
#11874) stay as the lower-level path for anything outside the
document-transform contract (lines over 1 MB, hand-built request files).

## 3. Architecture

```text
user: /batch-api "translate docs/zh into docs/en"
        │
        ▼
prepare skill (batch-api/SKILL.md): semantic work only, runs realtime
        │  plan JSON (§4)
        ▼
executor batch-workflow.ts: run / collect / retry / cancel / clean / check / list
  ├─ batch-task.ts    ledger: task / item / attempt records, atomic writes, per-task lock
  ├─ batch-docs.ts    assemble requests, validate results, deliver files
  └─ batch-client.ts  HTTP primitives; errors carry the HTTP status
        │
        ▼
batch.ts: endpoint / auth resolution, CLI registration, raw transport verbs

interactive session: batch-auto-collect.ts (started by startPostRenderPrefetches)
  → runs the same collectTask for this project's open tasks
```

### Invariants

- **The ledger answers "which remote objects might exist?" without
  guessing.** Intent is persisted before upload, the uploaded file id before
  create. A lost create answer — or a process that died mid-create — marks
  the attempt `submit-unknown`; `collect` reconciles it against the
  provider's batch list by `input_file_id` and **never resubmits blindly**,
  because a wrong answer bills twice.
- **Records live with the user, not the repository.** Tasks are kept under
  `~/.qwen/batch` (`QWEN_BATCH_HOME` overrides) with 0700/0600 permissions,
  record their project root, and work from any directory. Only the agent's
  plan files stay in the project, git-ignored.
- **A task is pinned to its endpoint.** `run` freezes the base URL and a
  short hash of the API key (never the key); `collect` / `retry` / `cancel`
  refuse under different settings, since the batch is invisible from another
  account or region.
- **One command per task at a time.** A per-task lock file records pid and
  host. It is taken over only when its release is certain: written on this
  host by a pid that no longer exists. A lock from another host is never
  taken over.
- **custom_id = `<itemId>#<attempt>`**, so results map back across retries.
  Each item records the attempt that owns it, and only that attempt's result
  lines may change it: an older attempt's failure never re-opens the item for
  another paid retry.
- **Delivery never overwrites.** A target that exists with different content
  is held as a conflict; an identical one counts as delivered, which makes
  re-collection idempotent. The source is re-hashed before writing; a source
  changed since submission holds its result.
- **Batch runs the user's realtime settings.** `run` freezes the configured
  sampling parameters, output limit and thinking mode into the task, and
  every retry reuses them. Settings with no verified Batch equivalent (e.g.
  reasoning effort) are reported as notes, not guessed.
- **No money figure without prices.** Token estimates are always shown
  (rough, chars / 3). A dollar estimate needs
  `QWEN_BATCH_INPUT_PRICE_PER_1M_USD` / `QWEN_BATCH_OUTPUT_PRICE_PER_1M_USD`.
  A plan's `maxCostUsd` is an **estimate gate, not a cap on the bill**; set
  without prices, it refuses to submit.
- **Accounting states its gaps.** Usage is summed over all attempts' result
  files; a line without usage marks the total incomplete, never a silent
  zero. Preparation in the session is invisible to the executor and every
  report says so. Batch usage stays out of the session's cache statistics.

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

- Validated by `batch-task.ts` with zod `.strict()`:
  - item ids match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, since they ride inside
    the custom_id;
  - ids and targets are unique;
  - unknown fields fail loudly, so an agent's typo cannot silently change
    behavior.
- `kind` is a literal; a new kind gets a new schema version.
- `enableThinking` is set only when the user asks for it; `false` is refused
  for thinking-mandatory models.
- Product contract: **one source document → one complete target document**.
  The model returns content only; paths or commands in its output are data
  and are never executed.
- Delivery checks structure only: non-empty, not truncated, no tool calls,
  balanced markdown fences. Semantic quality is the user's acceptance call.

## 5. Boundary behaviors

| Case                                                                        | Behavior                                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Source path escapes the project root (incl. via symlink)                    | Refused at assembly; nothing is uploaded                                          |
| Assembled line over 1 MB                                                    | Refused, pointing at `qwen batch submit`                                          |
| Create returns a definite 4xx                                               | Orphan upload deleted, items `failed`, `retry` is safe                            |
| Create answer lost (5xx / dropped socket)                                   | `submit-unknown`; `collect` reconciles via the provider list; no resubmit         |
| Reconcile finds 0 or 2+ candidates                                          | Report and stop; the provider list is the source of truth                         |
| Batch not settled at collect                                                | Report status; `--wait` polls with 10s → 60s backoff up to `--timeout`            |
| Result truncated / tool calls / empty                                       | Item `failed` with the reason; a truncated item needs a larger limit to retry     |
| Result custom_id unknown or duplicated                                      | Ignored with a warning                                                            |
| Item missing from all result files                                          | `failed` ("no result line", or the provider's reason when the whole batch failed) |
| Source changed / target exists with other content / target symlinks outside | `held`; re-collect after resolving delivers from the local record, no new cost    |
| After collect                                                               | Remote input/output/error files deleted; `--keep-remote` keeps them               |

Retry semantics:

- Only `failed` items, as a new attempt with fresh custom ids, under the same
  `maxCostUsd` gate.
- Refused while a submission is `submit-unknown`, or an earlier batch is
  still running or settled but uncollected.
- Held items are never retried: they need a user decision, not another
  request.

## 6. Automatic collection (interactive sessions)

- Starts after first render. Scans the local records for this project's open
  tasks, polls each over HTTP with a 1 → 5 minute backoff, and runs the same
  `collectTask` when a batch settles.
- The first pass at startup collects tasks that finished while no session was
  open.
- Results arrive as one info notice through the update-notice channel,
  queued while a response streams.
- Guarantees:
  - No model call and no automatic retry; failed items only get the retry
    command.
  - Same safety as a manual collect: the same lock, idempotency and
    no-overwrite delivery.
  - What it cannot collect is said once: no usable Batch credentials, or a
    submission with no matching provider batch. A task pinned to another
    endpoint backs off until the session switches back.
- `general.batchAutoCollect`: `deliver` (default) / `notify` / `off`.
- Not covered: headless, `qwen serve`, ACP, web-shell — no model-free notice
  channel there; use `qwen batch collect`.

## 7. Non-goals

- No automatic realtime/Batch routing, no paid probing, no auto-repair loops.
  The user picks the mode; the program keeps it honest.
- No multi-stage dependency graphs; one batch per attempt.
- No per-turn agent loop over Batch (measured and rejected in #11874).
- Only the document-transform contract. Code-patch delivery (apply, build,
  test) would be a new kind with its own acceptance checks.
