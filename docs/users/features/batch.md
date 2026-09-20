# Batch Mode (DashScope)

The DashScope Batch API runs requests asynchronously at half the realtime
price, on its own quota, with a completion window of at least 24 hours. Qwen
Code exposes it as `qwen batch`: a command for pushing many independent
requests through it.

It needs an OpenAI-compatible API key: set `OPENAI_API_KEY`,
`OPENAI_BASE_URL`, and `OPENAI_MODEL` (or `QWEN_MODEL`) — see
[Authentication](../configuration/auth.md). `qwen batch` accepts any
OpenAI-compatible endpoint, because a Batch-compatible gateway in front of
DashScope is a legitimate setup; a host with no Batch API then fails
server-side with a 404, surfaced verbatim.

## When batch is the right tool

Batch is priced at 50% of realtime, but DashScope also bills cached input at
20% of list — and **the prefix cache does not hit inside a batch**. Measured
against the live API, both batch arms returned `cached_tokens: 0` while the
realtime control on the same prompts hit a cache rate of 0.647. Setting the
two price models equal (realtime `1 − 0.8h` against batch `0.5`, for a
cache-hit rate `h`) breaks even at `h = 0.625`, and an agent loop routinely
sits above that, because every turn resends the same conversation prefix.

| shape                      | cache-hit rate             | batch / realtime   | source                             |
| -------------------------- | -------------------------- | ------------------ | ---------------------------------- |
| agent loop (shared prefix) | 0.647 realtime, 0 in batch | **1.03** — 3% more | measured against the live API      |
| fan-out, nothing shared    | 0                          | **0.50** — half    | derived: `h = 0` defines the shape |

Only the first row was measured. The second follows from the two facts above —
batch is half price, batch never caches — plus the definition of the shape, so
it needs no probe of its own. But read "nothing shared" literally, because most
real fan-out does not qualify.

### Fan-out is not automatically half price

A thousand requests that each carry the same 2 KB system prompt do share a
prefix, and the realtime side caches it. What decides the bill is the **share
of one request's input that is the common prefix**:

| common prefix as a share of one request's input | who wins                           |
| ----------------------------------------------- | ---------------------------------- |
| below 62.5%                                     | batch, and by more the lower it is |
| around 62.5%                                    | a wash                             |
| above 62.5%                                     | realtime + cache                   |

Two jobs with the same request count land on opposite sides:

- 500-token instruction, 2,000-token document per request → prefix is 20% of
  the input → **batch saves about 40%**
- 5,000-token instruction with few-shot examples, 500-token item per request →
  prefix is 90% → **batch costs more than realtime**

Few-shot classification and long-rulebook labelling are the second shape, and
they are common. To check your own job before committing to it, send one
request realtime and read `usage.prompt_tokens_details.cached_tokens` against
`usage.prompt_tokens` — that ratio is `h`, and anything under 0.625 means batch
is the cheaper route.

Output tokens are the part that always favours batch: they are half price there
and carry no cache discount realtime, so a job with long outputs tolerates a
higher prefix share before it flips.

So the shape batch is genuinely good for is fan-out **with little shared
context**: many independent single-turn requests, each dominated by its own
content. Summarizing a thousand different files, re-labelling a dataset where
the item text dwarfs the instruction. That is what `qwen batch` serves.

Latency is the other half of the story. Measured from `in_progress` to
`completed`: 596 s for a 3-line job, 1720 s for 24 lines, 3718 s for 1000 —
and `status` can read unchanged for 10–30 minutes at a time while the job
works (one 1000-line job sat at 889/1000 for 28 minutes, then finished
1000/1000). Plan in tens of minutes to hours.

Batch is therefore **not** a way to make an agent run cheaper. Routing an
agent's own turns through it was measured and rejected: the prefix cache the
loop depends on does not apply inside a batch, so the run came out slightly
more expensive _and_ hours slower. If a task needs more than one turn, run it
realtime.

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
line, 500 MB / 50 000 lines per file. Context is capped at 256K per batch
request.

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

## Verifying locally without an API key

A fake DashScope server and a regression script that drives the real CLI
against it live in
[`docs/verification/batch-api/`](https://github.com/QwenLM/qwen-code/pull/12297),
which is landing as its own change:

```bash
bash docs/verification/batch-api/regression.sh
```

No network and no key. Useful when changing this code path.
