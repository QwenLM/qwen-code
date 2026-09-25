---
name: batch-api
description: Prepare a many-file, single-turn transform (translate, rewrite, extract) as a plan and submit it to the asynchronous, half-price DashScope Batch API; results are delivered as new files hours later. Invoke explicitly with /batch-api.
argument-hint: '<task>'
disable-model-invocation: true
allowedTools:
  - glob
  - grep_search
  - read_file
---

# /batch-api — Agent-prepared Batch API workflow

**Hard rule for this whole skill:** if any `qwen batch …` command fails, or
the task turns out to be unsuitable, report what happened in a few lines and
stop (the one exception, a plan-field error from `run`, is in §4). Never fall back to doing the transform yourself in this session — the
user chose the half-price asynchronous path explicitly, and silently doing
the work at full realtime price is exactly what they opted out of. Offering
it as a choice ("I can do this realtime instead, at full price") is fine;
doing it without being asked is not.

The user explicitly chose **async batch mode** by typing `/batch-api`. This mode
trades latency for price: the provider bills Batch requests at 50% of the
realtime list price (with no context-cache benefit), and a job takes tens of
minutes to hours to finish (completion window 24h or more). Your job is to
turn the user's task into a small **plan file** that the deterministic
executor (`qwen batch run`) submits. You never write request JSONL by hand
and never call the Batch API yourself.

## 0. Check readiness before anything else

Run every `qwen batch …` command with the shell tool as
`"${QWEN_CODE_CLI:-qwen}" batch …` — `QWEN_CODE_CLI` names the CLI running
this session, so a plain `qwen` on PATH (possibly an older install without
these subcommands) is only the fallback. First make sure the CLI you reach
has them. Help output never calls a model:

```
"${QWEN_CODE_CLI:-qwen}" batch --help
```

If the output does not list `batch run <plan>`, the `qwen` it reached is an
older install without these subcommands — say so (the session's CLI is not on
PATH as `qwen`) and stop. Do not run any other `batch` command there: an older
CLI treats `batch check` as a prompt and answers it with a billed model call.
Then:

```
"${QWEN_CODE_CLI:-qwen}" batch check
```

It proves the credentials, endpoint and Batch route work and shows the model,
thinking mode and output limit a run would freeze from the user's current
settings — without a billed request. If it fails (for example Qwen OAuth, which has no Batch route),
relay its message and stop: do not read files or draft a plan the executor
cannot submit. Pass its `note:` lines on to the user.

## 1. Decide suitability honestly — this is your main job

Suitable: many independent, single-turn transforms whose input materials are
fully available right now. Examples: translate a set of documents under a
fixed style guide, rewrite files to a new format, summarize or extract
structured data from each file of a set.

Unsuitable:

- Work that needs iterative feedback — debugging, run-test-fix loops,
  exploratory refactors. The next step there depends on results that do not
  exist yet.
- Chained tasks where one item's output is another item's input.
- A handful of items, or a task the user needs answered soon. Batch's wait
  buys nothing there.

If the task is unsuitable, say so in one short paragraph and stop.

## 2. Prepare lightly

The whole point is saving money, so do not burn the savings in preparation:

- Discover the target files with glob.
- Read only a small sample (2–3 files) to understand structure and edge
  cases. Do NOT deeply read every file — the executor reads and embeds the
  full contents mechanically at submission time.
- Draft the shared rules once: terminology, style, format constraints, and
  the exact output contract. The model that runs the batch sees only your
  plan — spell out everything it needs, including "return ONLY the complete
  transformed document, no commentary".

## 3. Write the plan file

Write one JSON file to `.qwen/batch/plans/<slug>.json` (`<slug>` = short
kebab-case task name) with the write_file tool:

```json
{
  "version": 1,
  "name": "<slug>",
  "kind": "document-transform",
  "shared": {
    "system": "optional role/system prompt",
    "instructions": "the shared transform rules, terminology, output contract"
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

Rules:

- `id` must match `[A-Za-z0-9][A-Za-z0-9_-]{0,59}` (1–60 characters) and be
  unique per item; it
  becomes part of the provider-side `custom_id`.
- Paths are relative to the current working directory. Every `target` must
  be unique and must not overwrite an existing file — pick fresh output
  paths inside the project and outside any hidden path such as `.git/`,
  `.github/` or `.qwen/`, at any depth (refused). Results
  that arrive to a changed source or an occupied target are held, not
  written.
- Optional fields: `completionWindow` (default `24h`, max `14d`),
  `maxOutputTokens` (set it when outputs can be long — a truncated item can
  only be retried with a larger limit), `expectedOutputTokensPerItem`
  (improves the cost estimate), `maxCostUsd` (an estimate gate: `run` and
  `retry` refuse to submit when the estimate exceeds it — it is NOT a cap on
  the bill, and only works when `check` reports unit prices).
- Do NOT set `enableThinking` unless the user asked for a thinking mode:
  the executor freezes the thinking mode, sampling parameters and output
  limit from the user's current settings, so Batch runs the same way their
  realtime session does. Changing it silently changes both cost and quality.
- If you are unsure about model, prices, or provider limits, leave them to
  the executor — do not invent numbers.

## 4. Submit through the executor

First preview the batch — it assembles every request and prints the item
count, the frozen model/thinking/output-limit line, the cost estimate and a
snapshot digest, but uploads nothing and bills nothing:

```
"${QWEN_CODE_CLI:-qwen}" batch run .qwen/batch/plans/<slug>.json --dry-run
```

Show the user those lines verbatim, plus any `[batch]` note. Then submit
exactly that snapshot, with the digest the preview printed:

```
"${QWEN_CODE_CLI:-qwen}" batch run .qwen/batch/plans/<slug>.json --expect <digest>
```

Approving this command is the user's decision to spend, made with the preview
in front of them — never submit without a preview in the same turn, and never
drop `--expect`. If it reports that the batch changed since the preview, run
the preview again and show the new one. If either command fails, relay its
error and stop. The single exception: when the error names a field of the
plan file itself (an invalid id, a duplicate target, an unknown field), fix
that field once and preview again.

## 5. Wait in the background, then report

Right after a successful submission, start the waiter with the shell tool and
`is_background: true`:

```
"${QWEN_CODE_CLI:-qwen}" batch collect <task-id> --wait
```

It polls the provider over HTTP — no model call while the batch queues and
runs — and when the batch settles it collects, writes the target files and
exits; you are then notified once with its output. Tell the user the task is
submitted and that you will report when results arrive, then end your turn.
Do not poll or wait for the batch yourself in the foreground, and never loop
on status.

When the waiter's notification arrives, read the summary at the end of its
output and report it: which targets were delivered, which items are held or
failed and why. Then do the follow-up the user asked for in their original
request (for example, review the delivered files), and nothing else:

- Never retry automatically — every retry is a new billed request. Offer
  `qwen batch retry <task-id>` for failed items and for items held because
  their source changed; truncated items need
  `qwen batch retry <task-id> --max-output-tokens <n>`.
- Never redo a failed item yourself in this session.
- A target conflict (held: target exists) is resolved by the user; then
  `qwen batch collect <task-id>` delivers it without a new request.
- Estimates never include what this session spent preparing; do not
  describe the Batch estimate as the task's total cost or as a saving.

If the session closes before the batch settles, nothing is lost: an
interactive session collects the task automatically the next time `qwen`
starts in this project (`general.batchAutoCollect: false` turns this off).
