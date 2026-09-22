# /batch --api — Agent-prepared Batch API workflow

The user explicitly chose **async batch mode** by typing `--api`. This mode
trades latency for price: the provider bills Batch requests at 50% of the
realtime list price (with no context-cache benefit), and a job takes tens of
minutes to hours to finish (completion window 24h or more). Your job is to
turn the user's task into a small **plan file** that the deterministic
executor (`qwen batch run`) submits. You never write request JSONL by hand
and never call the Batch API yourself.

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
  `maxOutputTokens`, `expectedOutputTokensPerItem` (improves the cost
  estimate), `maxCostUsd` (hard budget — only enforceable when unit prices
  are configured, see executor output), `enableThinking` (default off in the
  executor only if you set it false explicitly; leave unset to use the
  provider default).
- If you are unsure about model, prices, or provider limits, leave them to
  the executor — do not invent numbers.

## 4. Submit through the executor

Run exactly this with the shell tool:

```
qwen batch run .qwen/batch/plans/<slug>.json
```

Then report to the user, verbatim from the command output: the task id, item
count, cost estimate, and the collect command. If the command fails, relay
its error and fix the plan (or stop) — never work around the executor by
hand-crafting requests or calling the API directly.

## 5. Collecting later

Tell the user:

- Check progress or collect results any time with
  `qwen batch collect <task-id>` (add `--wait` to poll until it settles).
  You can run this for them whenever they ask — it needs no model judgment.
- Failed items can be resubmitted after the underlying problem is fixed:
  `qwen batch retry <task-id>`.
- Held results (source changed / target conflict) are delivered by re-running
  `qwen batch collect <task-id>` after the conflict is resolved.
- `qwen batch list` shows all recorded tasks; `qwen batch cancel --task <task-id>`
  cancels the active job (already-finished requests are still billed).
