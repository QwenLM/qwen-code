# E2E: /doctor memory tool-result retention diagnostics

Date: 2026-08-10 (re-verified after review round 1) · Branch:
`feat/doctor-tool-result-retention` · Runtime: `npm run dev` in tmux
(220x52), IdeaLab API key auth, no sandbox, macOS.

Sizes are measured with the compression pipeline's `estimatePartChars` model
(raw chars for string outputs; nested media billed at the image estimate),
and oversized counts compare each result against its own tool's declared
budget (30k fallback).

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
  ~/.qwen/tmp/<session-hash>/run_shell_command_928ba0eecdb5.output`, UI shows
  `... first 6573 lines hidden ...` plus the tail.
- Report reflects only the retained preview stub:

```
    Tool result retention
      Tool results in history: 1
      Total retained: 4543 chars
      Largest result: 4543 chars
      Oversized results (above tool budget): 0
      Oversized also rendered in UI history: 1 item(s)
      Oversized also in compression input: no
```

Conclusion: mitigation (shell 30k budget + spill) keeps history retention
bounded; diagnostics track the live history correctly. The UI-history scan
detects that the tool output's rendered copy (`tool_group` `resultDisplay`,
still above the tool budget) survives in UI history even though the API
history only holds the stub — the duplication signal works.

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
      Oversized also rendered in UI history: 1 item(s)
      Oversized also in compression input: no
```

Counts accumulate with the session. The shell tool's own 30k budget still
caps each retained result (`Largest result: 29070 chars` — the 40k printf
output, bounded by the tool and kept under its 30k budget), so
`Oversized results` stays 0 — confirming the oversized counter is a
regression alarm rather than an everyday signal.

## Scenario 4 — `--json`

Steps: `/doctor memory --json` in the scenario-2 session.

Observed payload includes:

```json
"toolResultRetention": {
  "toolResultCount": 1,
  "totalChars": 4543,
  "largestResultChars": 4543,
  "oversizedResultCount": 0,
  "oversizedThresholdChars": 30000,
  "largeOutputsInUIHistory": 1,
  "presentInCompressionInput": false
}
```

When no chat history is available, `--json` omits the `toolResultRetention`
key entirely (no `null`), matching the readable output.

## Oversized "yes" branch

Unreachable in normal operation (per-tool/global layers bound every result at
or below its declared budget). Covered deterministically by unit tests:

- `packages/core/src/utils/tool-result-retention.test.ts` (13 tests): counts,
  max, raw-char measurement of newline-dense outputs, strict `>` boundary,
  per-tool budget resolver (high/low/unknown/`Infinity` budgets), nested
  media billing, missing payload/parts, unserializable payloads.
- `packages/cli/src/ui/commands/doctorCommand.test.ts` (7 retention tests):
  readable report with `Oversized results (above tool budget): 1` +
  compression input `yes (shared by reference, no extra copy)` + `/compress`
  hint; UI-history detection scoped to `tool_group` result displays (model
  text excluded); `--json` fields; `--json` omits the key without history;
  section omitted when history reads throw; interactive report.

## Cleanup

The temporary `.qwen/settings.json` was gitignored and used for simulation
only; it is removed before the PR is merged. All tmux sessions killed; no
source changes from testing.
