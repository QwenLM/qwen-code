# Batch Mode (DashScope)

The DashScope Batch API runs requests asynchronously at half the realtime
price, on its own quota, with a completion window of at least 24 hours. Qwen
Code exposes it in two ways: a `qwen batch` command for pushing many
independent requests through it, and an experimental `--batch` flag that sends
a headless run's own turns through it.

Both need an OpenAI-compatible API key on a DashScope endpoint: set
`OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` (or `QWEN_MODEL`) —
see [Authentication](../configuration/auth.md). Both paths refuse to run
unless all three resolve the `openai` auth type. Qwen OAuth has no `/batches`
route, and no other provider (Gemini, Vertex, Anthropic, the Responses API)
has a Batch API at all — both paths refuse those rather than quietly running
at full price.

## When batch is the right tool

Batch is priced at 50% of realtime, but DashScope also bills cached input at
20% of list. Realtime plus prefix caching therefore beats batch whenever the
input cache-hit rate is above roughly 64% — which an agent loop routinely
reaches, because every turn resends the same conversation prefix.

So the shape batch is genuinely good for is **fan-out**: many independent
single-turn requests that share no prefix, where the 50% is real and the
realtime quota is left alone. Classifying a thousand files, generating a
thousand summaries, re-labelling a dataset. That is what `qwen batch` serves.

`--batch` is the other shape — one agent run deferred — and it is
experimental for a reason. See [Limits](#limits) before using it.

## `qwen batch`

Four subcommands: `submit`, `status`, `fetch`, `cancel`.

### submit

```bash
qwen batch submit requests.jsonl
# batch_abc123
```

The input file holds one request per line. Each line may be a full batch
request line:

```json
{
  "custom_id": "doc-1",
  "method": "POST",
  "url": "/v1/chat/completions",
  "body": {
    "model": "qwen-plus",
    "messages": [{ "role": "user", "content": "Summarize: ..." }]
  }
}
```

or a bare chat-completions body, which gets wrapped with the line index as
`custom_id`, the endpoint URL, and your configured default model:

```json
{
  "messages": [{ "role": "user", "content": "Summarize: ..." }],
  "enable_thinking": false
}
```

Set `enable_thinking: false` explicitly unless you want thinking tokens —
newer models default it on, and thinking tokens can eat the 50% discount.

Provider limits: a file must be homogeneous — one model and one thinking
configuration for every line (a per-line `model` overrides the default, so a
mixed file is rejected server-side only after upload) — and at most 6 MB per
line, 500 MB / 50 000 lines per file.

`--window` sets the completion window (default `24h`, maximum `14d`). A longer
window does not make the job slower; it is the deadline, not the schedule.

### status

```bash
qwen batch status batch_abc123
# batch_abc123  in_progress  120/1000 done, 0 failed  running 340s  expires 2026-09-19T12:00:00.000Z
```

The phase (`queued` / `running` / `ran`) is derived from the job's timestamps.
`--json` prints the raw batch object instead.

### fetch

```bash
qwen batch fetch batch_abc123 --out ./results --delete
# batch_abc123  completed  1000/1000 done, 0 failed  ran 1847s  expires ...
# ./results/batch_abc123.output.jsonl
```

Refuses until the job has settled. Writes `<id>.output.jsonl` and, when the
provider produced a separate error file, `<id>.error.jsonl`. A request can
also fail _inside_ the output file, as a line whose `response.status_code` is
not 200 — the reason is in that line's `.error` or `.response.body.error`.
`--delete` removes the remote input, output and error files afterwards — do
it once you have the results, or they accumulate in your account.

Output lines carry the `custom_id` you supplied, so map results back to inputs
yourself — and filter out the failed lines first, or they enter the dataset
as empty answers (`// ""` also covers a successful turn that ended on
`tool_calls`, whose `message.content` is `null`):

```bash
jq -r 'select(.response.status_code == 200) | .custom_id + "\t" + (.response.body.choices[0].message.content // "")' \
  results/batch_abc123.output.jsonl
jq -r 'select(.response.status_code != 200) | .custom_id' \
  results/batch_abc123.output.jsonl
```

### cancel

```bash
qwen batch cancel batch_abc123
```

Requests that already completed are still billed.

## `--batch` (experimental)

```bash
qwen -p "list the files here and summarize" --batch
# [batch] submitted batch_xyz789; results due by 2026-09-19T12:00:00.000Z
# ...
```

Non-interactive runs only — `-p`, a positional prompt, or piped stdin. It is
rejected with `-i` and in the TUI, because there is nothing to show while the
job sits in a queue for hours.

With it set, **only the main loop's own turns** go through the Batch API. Side
calls (compression, session titles, permission classifiers, goal judges) and
subagents stay realtime — they are short, they are not what you are trying to
defer, and each deferred call would otherwise pay its own queue wait.

The batch id is written to stderr before the wait begins. If the process dies
mid-wait, recover the result with `qwen batch fetch <id>` — the job keeps
running on DashScope's side either way.

Interrupting the run (Ctrl-C) cancels the job server-side and deletes the
files it uploaded.

### Multi-turn

The client side is built for tool calls and multi-turn runs: a turn that
comes back with `tool_calls` runs the tools locally and submits the next turn
as a **new** batch job carrying the full `assistant` + `tool` history. What
is **not yet verified against the live API** is whether the provider accepts
`tools`/`tool_calls` in a batch body at all — see the probe in
[Limits](#limits); treat multi-turn `--batch` as blocked on that result.

What the Batch API does not have is server-side conversation state. Every job
is one stateless request with the complete `messages` array, so an N-turn run
means N jobs, N queue waits (serially — each turn needs the previous result),
and N re-uploads of the whole context. Budget accordingly: with a p50 queue
wait of Q, a five-turn task takes at least 5Q.

### Limits

- **Not measured yet.** Whether tool calls pass through a real batch body, and
  whether context caching hits inside a batch, have not been verified against
  the live API — see `docs/verification/batch-api/` for the probes that answer
  both. If the cache does not hit, `--batch` on an agent loop costs _more_ than
  realtime, and is worth using only to spare the realtime quota.
- No cost accounting. The session footer's token numbers do not know about the
  50% discount, so a `--batch` run's reported cost overstates the bill.
- No batch-id persistence across processes beyond the stderr line.
- `enable_thinking` is left to provider defaults on this path.
- Context is capped at 256K per batch request; compression still uses the
  model's own limit, so a very long session can fail server-side.

## Recovering a run

```bash
# the id was printed to stderr when the job was submitted
qwen batch status batch_xyz789
qwen batch fetch batch_xyz789 --out ./recovered
```

If polling fails repeatedly (a flaky network, a throttled endpoint), the run
gives up but deliberately leaves the job alone: it is still running and still
billing, its input file is kept, and the error names the id to fetch. It is
never retried automatically — a retry would create a second paid job while the
first one is still going.

## Verifying locally without an API key

`docs/verification/batch-api/` carries a fake DashScope server and a
regression script that drives the real CLI against it:

```bash
bash docs/verification/batch-api/regression.sh
```

No network and no key. Useful when changing this code path.
