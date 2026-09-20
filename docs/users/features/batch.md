# Batch Mode (DashScope)

The DashScope Batch API runs requests asynchronously at half the realtime
price, on its own quota, with a completion window of at least 24 hours. Qwen
Code exposes it in two ways: a `qwen batch` command for pushing many
independent requests through it, and an experimental `--batch` flag that sends
a headless run's own turns through it.

Both need an OpenAI-compatible API key: set `OPENAI_API_KEY`,
`OPENAI_BASE_URL`, and `OPENAI_MODEL` (or `QWEN_MODEL`) — see
[Authentication](../configuration/auth.md). Both paths refuse to run unless
the **resolved** auth type is `openai` on the chat-completions wire, so a
model pinned to `wireApi: "responses"` is refused too — the Responses API has
no Batch route, and neither does Gemini, Vertex, Anthropic or Qwen OAuth.
Refusing is the point: a generator that ignores batch would otherwise run the
turn realtime, immediately, at full price.

The two paths differ on the host. `--batch` requires a DashScope endpoint
(loopback is allowed, for a local proxy or the test harness). `qwen batch`
accepts any OpenAI-compatible endpoint, because a Batch-compatible gateway in
front of DashScope is a legitimate setup; a host with no Batch API then fails
server-side with a 404, surfaced verbatim.

## When batch is the right tool

Batch is priced at 50% of realtime, but DashScope also bills cached input at
20% of list — and **the prefix cache does not hit inside a batch**. Measured
against the live API, both batch arms returned `cached_tokens: 0` while the
realtime control on the same prompts hit a cache rate of 0.647. Setting the
two price models equal (realtime `1 − 0.8h` against batch `0.5`, for a
cache-hit rate `h`) breaks even at `h = 0.625`, and an agent loop routinely
sits above that, because every turn resends the same conversation prefix.

The measurements, not just the model:

| shape                      | cache-hit rate             | batch / realtime   |
| -------------------------- | -------------------------- | ------------------ |
| agent loop (shared prefix) | 0.647 realtime, 0 in batch | **1.03** — 3% more |
| fan-out (no shared prefix) | 0                          | **0.50** — half    |

So the shape batch is genuinely good for is **fan-out**: many independent
single-turn requests that share no prefix, where the 50% is real and the
realtime quota is left alone. Classifying a thousand files, generating a
thousand summaries, re-labelling a dataset. That is what `qwen batch` serves.

Latency is the other half of the story. Measured from `in_progress` to
`completed`: 596 s for a 3-line job, 1720 s for 24 lines, 3718 s for 1000 —
and `status` can read unchanged for 10–30 minutes at a time while the job
works (one 1000-line job sat at 889/1000 for 28 minutes, then finished
1000/1000). Plan in tens of minutes to hours.

`--batch` is therefore **not** a way to make an agent run cheaper. It is a
switch for a run you are happy to leave going: it spares the realtime quota
and defers the turn, at roughly realtime cost. See [Limits](#limits) before
using it.

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

A switch for a headless run you are happy to leave going for hours: it moves
that run's own turns off the realtime quota. It is not a discount — on an
agent-loop shape it measured 1.03× realtime, because the prefix cache does not
apply inside a batch.

```bash
qwen -p "list the files here and summarize" --batch
# [batch] submitted batch_xyz789; results due by 2026-09-19T12:00:00.000Z
# ...
```

Non-interactive runs only — `-p`, a positional prompt, or piped stdin. It is
rejected with `-i`, with an empty positional, and in the TUI, because there is
nothing to show while the job sits in a queue for hours.

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
as a **new** batch job carrying the full `assistant` + `tool` history. The
provider accepts that shape — measured against the live API, `tools`,
`tool_calls` and an `assistant` + `tool` history all pass through a batch body
unchanged, with `finish_reason: "tool_calls"` preserved.

What the Batch API does not have is server-side conversation state. Every job
is one stateless request with the complete `messages` array, so an N-turn run
means N jobs, N queue waits (serially — each turn needs the previous result),
and N re-uploads of the whole context. Budget with the measured per-job wait,
not a guess: a trivial 3-line job took 596 s from `in_progress` to
`completed`, so a five-turn task is an afternoon, not a minute.

### Limits

- **It costs slightly more on an agent loop.** Measured against the live API:
  no cache hits inside a batch (`cached_tokens: 0` on both arms, against 0.647
  for the realtime control), so an agent-loop run came out at **1.03×**
  realtime. Use `--batch` to spare the realtime quota on a run you can leave
  for hours — not to save money on it.
- **Nothing arrives until the whole turn is done.** There is no streaming, and
  `status` can read unchanged for 10–30 minutes while the job works.
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
