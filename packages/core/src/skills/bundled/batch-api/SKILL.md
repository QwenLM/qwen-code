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
these subcommands) is only the fallback. First:

```
"${QWEN_CODE_CLI:-qwen}" batch check
```

It proves the credentials, endpoint and Batch route work and shows the model,
thinking mode and output limit a run would freeze from the user's current
settings — without a billed request. If it fails (for example Qwen OAuth,
which has no Batch route), relay its message and stop: do not read files or
draft a plan the executor cannot submit. Pass its `note:` lines on to the
user.

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

If the task is unsuitable, say so in one short paragraph and stop. Do NOT
silently do the work in the normal realtime loop instead — the user chose
this mode explicitly and deserves the honest answer.

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

- `id` must match `[A-Za-z0-9][A-Za-z0-9_-]*` and be unique per item; it
  becomes part of the provider-side `custom_id`.
- Paths are relative to the current working directory. Every `target` must
  be unique and must not overwrite an existing file — pick fresh output
  paths. Results that arrive to a changed source or an occupied target are
  held, not written.
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

Run exactly this with the shell tool:

```
"${QWEN_CODE_CLI:-qwen}" batch run .qwen/batch/plans/<slug>.json
```

Then report to the user, verbatim from the command output: the task id, item
count, the frozen model/thinking/output-limit line, the cost estimate, and
the collect command. If the command fails, relay
its error and fix the plan (or stop) — never work around the executor by
hand-crafting requests or calling the API directly.

## 5. Collecting later

Tell the user:

- Everything below is a plain command that needs no model: typed with the
  `!` prefix in this session (for example `!qwen batch collect <task-id>`)
  it runs without spending a model turn, and it works from any directory.
- Check progress or collect results any time with
  `qwen batch collect <task-id>` (add `--wait` to poll until it settles).
  If they ask you to do it instead, run it for them — but mention the `!`
  form costs nothing.
- Failed items can be resubmitted after the underlying problem is fixed:
  `qwen batch retry <task-id>`. Items truncated at the output limit are
  skipped unless a larger limit is given:
  `qwen batch retry <task-id> --max-output-tokens <n>`. Every retry is a new
  billed request.
- Held results (source changed / target conflict) are delivered by re-running
  `qwen batch collect <task-id>` after the conflict is resolved.
- `qwen batch list` shows all recorded tasks with their project;
  `qwen batch cancel --task <task-id>` cancels the active job
  (already-finished requests are still billed).
- A task is tied to the endpoint and API key it was submitted with; after
  switching accounts or regions, switch back to collect it.
