# E2E: /doctor memory tool-result retention diagnostics

Date: 2026-08-10 · Branch: `feat/doctor-tool-result-retention` · Runtime:
`npm run dev` in tmux (220x52), IdeaLab API key auth, no sandbox, macOS.

## Scenario 1 — fresh session (baseline)

Steps: start CLI, run `/doctor memory`.

Expected/observed: report ends with an all-zero retention section:

```
    Tool result retention
      Tool results in history: 0
      Total retained: 0 chars
      Largest result: 0 chars
      Oversized results (> 30000 chars): 0
      Oversized also in UI history (> 30000 chars): 0 item(s)
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
      Total retained: 5341 chars
      Largest result: 5341 chars
      Oversized results (> 30000 chars): 0
      Oversized also in UI history (> 30000 chars): 0 item(s)
      Oversized also in compression input: no
```

Conclusion: mitigation (shell 30k budget + spill) keeps retention bounded;
diagnostics track the live history correctly.

## Scenario 3 — multiple tool calls, raised global threshold

Steps: set `tools.truncateToolOutputThreshold: 100000` in project
`.qwen/settings.json` (simulation only; removed after testing), run several
shell calls (`date`, `echo`, `ls packages`, `seq 1 6000`, `seq 1 9000`,
`printf 'x%.0s' {1..40000}`), then `/doctor memory`.

Observed: counts accumulate with the session
(`Tool results in history: 5`, `Total retained: 44364 chars`). The shell
tool's own 30k budget still caps each retained result
(`Largest result: 24658 chars`), so `Oversized results` stays 0 — confirming
the oversized counter is a regression alarm rather than an everyday signal.

## Scenario 4 — `--json`

Steps: `/doctor memory --json` in a fresh session.

Observed payload includes:

```json
"toolResultRetention": {
  "toolResultCount": 0,
  "totalChars": 0,
  "largestResultChars": 0,
  "oversizedResultCount": 0,
  "oversizedThresholdChars": 30000,
  "largeOutputsInUIHistory": 0,
  "presentInCompressionInput": false
}
```

## Oversized "yes" branch

Unreachable in normal operation (per-tool/global layers bound every result at
or below the 30k diagnostic threshold). Covered deterministically by unit
tests:

- `packages/core/src/utils/tool-result-retention.test.ts` (9 tests): counts,
  max, oversized threshold (default + custom), missing payload/parts, Part[]
  responses, circular references.
- `packages/cli/src/ui/commands/doctorCommand.test.ts` (5 retention tests):
  readable report with `Oversized results (> 30000 chars): 1` + compression
  input `yes (shared by reference, no extra copy)` + `/compress` hint;
  UI-history duplication detection; `--json` fields
  (`largeOutputsInUIHistory`, `presentInCompressionInput`); section omitted
  without chat history.

## Cleanup

The temporary `.qwen/settings.json` is gitignored and used for simulation
only; it is removed before the PR is merged. All tmux sessions killed; no
source changes from testing.
