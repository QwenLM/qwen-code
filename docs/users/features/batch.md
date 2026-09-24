# Batch Mode (DashScope)

The DashScope Batch API runs requests asynchronously at half the realtime
price, with a completion window of at least 24 hours. Qwen Code uses it
through `/batch-api`: you describe a bulk task, the agent prepares a plan,
and `qwen batch` submits it, tracks it and writes the results as files.

It needs an OpenAI-compatible API key: set `OPENAI_API_KEY`,
`OPENAI_BASE_URL`, and `OPENAI_MODEL` (or `QWEN_MODEL`) — see
[Authentication](../configuration/auth.md). Qwen OAuth has no Batch route.

## When batch is the right tool

- **Half price, no cache.** Batch bills successful requests at 50% of the
  realtime list price, but the prefix cache never hits inside a batch
  (measured `cached_tokens: 0`). Realtime bills cached input at 20% of list,
  so batch only wins when little of each request is shared: with a
  cache-hit rate `h`, realtime costs about `1 − 0.8h` of list on input, and
  batch loses once `h` exceeds 0.625.
- **Good fit:** many independent single-turn requests, each dominated by its
  own content — translating or summarizing a set of documents, extracting
  data per file. Long outputs favour batch further.
- **Poor fit:** a long shared rulebook or few-shot prefix with short items,
  a handful of items, anything that needs more than one turn. Routing an
  agent's own turns through Batch was measured at 1.03× realtime and hours
  slower.
- **Latency:** anywhere from seconds to hours, mostly queueing, and it varies
  by model. Count on it being cheap, not fast.

To check a job before committing to it, send one request realtime and compare
`usage.prompt_tokens_details.cached_tokens` with `usage.prompt_tokens`.

## `/batch-api`

```text
/batch-api translate the Markdown docs in docs/zh into English,
writing them to docs/en with the same file names
```

The agent runs `qwen batch check`, confirms the task fits, reads a small
sample, writes a plan to `.qwen/batch/plans/`, and submits it:

```bash
qwen batch run .qwen/batch/plans/<slug>.json
# task translate-docs-20260923103000: 42 item(s), window 24h
# model qwen-plus, thinking off, max output 8192 tokens (frozen from your current settings; retries reuse them)
# ~180,000 in / ~190,000 out tokens (rough estimate); ...
# batch job: batch_abc123
# collect later with: qwen batch collect translate-docs-20260923103000
```

`run` returns immediately and **you do not need to collect by hand**. The
agent starts `qwen batch collect <task-id> --wait` as a background task
(visible in `/tasks`) and ends its turn, so you can keep working. That
process polls the provider over HTTP — no model call while you wait — and when
the batch finishes it writes the results and exits. The agent is then woken
once: it tells you what was delivered, held or failed, and does any follow-up
you asked for in the original request. Failed items are never retried
automatically, since a retry bills again.

If the session closes first, nothing is lost: an interactive session collects
the project's finished tasks at startup and while it is open, and posts one
notice. Set `general.batchAutoCollect` to `false` to turn that off. Headless
runs (`qwen -p`), `qwen serve` and IDE/ACP clients do not auto-collect.

The commands work from any directory, and inside a session with the `!`
prefix (e.g. `!qwen batch collect <task-id>`) so no model turn is spent:

```bash
qwen batch check                         # verify setup; nothing is billed
qwen batch collect <task-id> [--wait [--timeout <s>]]   # validate + write target files
qwen batch retry <task-id>               # resubmit only the failed items
qwen batch retry <task-id> --max-output-tokens 8192  # include truncated ones
qwen batch list                          # every recorded task, with its project
qwen batch cancel <task-id>              # partial results are still billed
qwen batch clean <task-id>               # delete the local record (cancels nothing)
```

`collect` reports each item as:

- **delivered** — written to its target;
- **held** — the source changed after submission (`retry` resubmits it
  against the new source), or the target already exists with different
  content (resolve it and re-run `collect`; no new request is made);
- **failed** — truncated, empty, a tool call, or a provider error; `retry`
  resubmits these, truncated items only with a larger `--max-output-tokens`.

Re-running `collect` is always safe: delivered items are never redone and
usage is never double-counted. Once results are on disk, the remote input and
output files are deleted.

## Records, safety and cost

- Task records live in `~/.qwen/batch/tasks/<task-id>/` (`QWEN_BATCH_HOME`
  overrides) with owner-only permissions, since they hold full copies of your
  sources and outputs. Plan files under the project's `.qwen/batch/` get a
  `.gitignore`.
- A task is tied to the endpoint and API key it was submitted with (only a
  short hash of the key is stored); after switching accounts or regions,
  commands refuse until you switch back.
- If the create call's answer is lost, `run` fails, the task is marked
  `submit-unknown`, and `collect` reconciles against the provider's batch
  list instead of resubmitting — a duplicate would bill twice.
- Only one `qwen batch` command works on a task at a time.
- A run freezes your current sampling parameters, output limit and thinking
  mode; retries reuse them.
- Estimates are token-based unless you set
  `QWEN_BATCH_INPUT_PRICE_PER_1M_USD` and
  `QWEN_BATCH_OUTPUT_PRICE_PER_1M_USD`. A plan's `maxCostUsd` is an estimate
  gate, not a cap on the bill, and needs those prices. Neither figure
  includes what your session spent preparing the plan.
- `clean` refuses while a batch may still be running or holds uncollected
  results, unless you pass `--force`.
- Targets may not be inside `.git/`, `.github/`, `.husky/` or `.qwen/`:
  results are written hours after you approved the plan.

Design: [`docs/design/2026-09-23-batch-api-design.md`](../../design/2026-09-23-batch-api-design.md).
An offline end-to-end check (fake Batch API, real built CLI) lives in
[`docs/verification/batch-api/`](../../verification/batch-api/README.md).
