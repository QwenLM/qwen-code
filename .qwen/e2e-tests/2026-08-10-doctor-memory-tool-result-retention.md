# E2E: /doctor memory tool-result retention diagnostics

Date: 2026-08-11 (re-verified after review round 4) · Branch:
`feat/doctor-tool-result-retention` · Runtime: `npm run dev` in tmux
(220x52), IdeaLab API key auth, no sandbox, macOS.

Sizes are measured with the compression pipeline's `estimatePartChars` model
(raw chars for string outputs; nested media billed at the image estimate).
Oversized counts compare each result against its own tool's declared budget
(resolved from the registry by canonicalized name; tools declaring none fall
back to the configured global truncation threshold), skip results already
carrying a truncation marker (prefix, in-body marker, or `<persisted-output>`
stub), and apply the scheduler's combined-pass 2x tolerance plus a small
envelope slack for the token-aware fallback. The UI-history scan compares each
`tool_group` display against the same per-tool budget at the same 2x
tolerance.

## Scenario 1 — fresh session (baseline)

Steps: start CLI, run `/doctor memory`.

Expected/observed: report ends with an all-zero retention section:

```
    Tool result retention
      Tool results in history: 0
      Total retained: 0 chars
      Largest result: 0 chars
      Oversized results (above tool budget): 0
      Oversized also rendered in UI history: 0 item(s)
      Oversized also in compression input: no
```

## Scenario 2 — large shell output (mitigation active)

Steps: ask the agent to run `seq 1 9000` (~47k chars), approve the
confirmation, then `/doctor memory`.

Observed:

- Tool output spilled to disk: `Output too long and was saved to:
  ~/.qwen/tmp/<project-hash>/run_shell_command_928ba0eecdb5.output`, UI shows
  `... first 6573 lines hidden ...` plus the tail.
- Report reflects only the retained preview stub:

```
    Tool result retention
      Tool results in history: 1
      Total retained: 4543 chars
      Largest result: 4543 chars
      Oversized results (above tool budget): 0
      Oversized also rendered in UI history: 0 item(s)
      Oversized also in compression input: no
```

Conclusion: mitigation (shell 30k budget + spill) keeps history retention
bounded; diagnostics track the live history correctly. The spilled result's
retained UI display stays well within 2x the shell budget, so the UI
duplication signal correctly stays at 0 — it only fires when a rendered
display actually exceeds 2x its tool's budget.

## Scenario 3 — multiple tool calls, raised global threshold

Steps: set `tools.truncateToolOutputThreshold: 100000` in project
`.qwen/settings.json` (simulation only; removed after testing), run five
shell calls (`date`, `echo hello`, `ls packages`, `seq 1 6000`,
`printf 'x%.0s' {1..40000}`), then `/doctor memory`.

Observed:

```
    Tool result retention
      Tool results in history: 5
      Total retained: 34572 chars
      Largest result: 29070 chars
      Oversized results (above tool budget): 0
      Oversized also rendered in UI history: 0 item(s)
      Oversized also in compression input: no
```

Counts accumulate with the session. The largest result is the `seq 1 6000`
multi-line output (raw ~28.9k chars, kept under shell's 30k budget); the 40k
`printf` output is a single line, which the shell tool spills to disk with a
small ~1.3k preview (hardcoded `previewChars: 4000`), so it contributes only
the stub. `Oversized results` stays 0 — confirming the oversized counter is
a regression alarm rather than an everyday signal.

## Scenario 4 — `--json`

Steps: `/doctor memory --json` in the scenario-2 session.

Observed payload includes:

```json
"toolResultRetention": {
  "toolResultCount": 1,
  "totalChars": 4543,
  "largestResultChars": 4543,
  "oversizedResultCount": 0,
  "oversizedThresholdChars": 25000,
  "largeOutputsInUIHistory": 0,
  "presentInCompressionInput": false
}
```

`oversizedThresholdChars` reports the configured global threshold
(25000 under defaults) — the fallback budget for tools declaring none.

When no chat history is available, `--json` omits the `toolResultRetention`
key entirely (no `null`), matching the readable output.

## Oversized "yes" branch

Unreachable in normal operation (per-tool/global layers bound every result at
or below its declared budget). Covered deterministically by unit tests:

- `packages/core/src/tools/tool-result-retention.test.ts` (19 tests): counts,
  max, raw-char measurement of newline-dense outputs, strict `>` boundary
  at 2x budget + slack, sentinel skip (truncation prefix and
  `<persisted-output>` stubs on both `output` and `error` keys), per-tool
  budget resolver (high/low/unknown/`Infinity` budgets), nested media
  billing, missing payload/parts, unserializable payloads, multiple
  functionResponse parts in one Content.
- `packages/cli/src/ui/commands/doctorCommand.test.ts` (12 retention tests):
  readable report with `Oversized results (above tool budget): 1` +
  compression input `yes (shared by reference, no extra copy)` + `/compress`
  hint; UI-history detection scoped to `tool_group` result displays with
  per-tool budgets at 2x tolerance (model text and compliant high-budget
  renders excluded); legacy-alias canonicalization; compliant-session shape
  (zero oversized, no compression advice); `--json` fields; `--json` omits the
  key without history; section omitted (rest of report intact) when history
  reads throw; disabled-truncation guard (no false positives at `Infinity`
  threshold); unresolvable-name fallback; interactive report.

## Cleanup

The temporary `.qwen/settings.json` was gitignored and used for simulation
only; it is removed before the PR is merged. All tmux sessions killed; no
source changes from testing.
