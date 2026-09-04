# TUI parity harness

Deterministic, dependency-light harness that compares a base CLI capture
(current Ink behavior) against a fixed CLI capture (OpenTUI behavior) with
machine-checkable metrics and reviewable artifacts. Node built-ins plus the
repository's existing `@lydell/node-pty` capability for PTY allocation.

## Runner contract

```bash
node scripts/tui-parity/runner.mjs \
  --scenario <file|dir> ... \
  --out <dir> \
  [--base '<command>'] [--fixed '<command>']
```

- `--scenario` is a `*.scenario.json` file or a directory of them. `--out` is
  the artifact directory. Exit codes: 0 pass, 1 threshold/capture failure,
  2 usage or validation error.
- `--base` / `--fixed` override the scenario commands (single scenario only).
  This is the real-CLI contract: point base at the Ink build and fixed at the
  OpenTUI build with the same scenario parameters. Overrides always capture
  through a native PTY. Relative `.js/.mjs/.cjs` script paths after `node`
  resolve against the repository root. The final resolved argv (after any
  override) is re-validated before anything is captured: declared
  `compareParams` must be present and equal on both sides, and terminal-size
  flags must match the capture geometry. A divergent override aborts the run
  with a parameter-binding error instead of executing under a stale
  "validated" claim.
- Base and fixed always share the scenario's terminal size, timeout, stdin
  input, environment, and thresholds. Scenarios that attach per-side
  parameters are rejected. `compareParams` names argv flags whose values are
  extracted, normalised (`--flag value` and `--flag=value` are equivalent),
  and required to be present and equal on both sides; terminal-size flags
  (`--rows`/`--lines`/`--columns`/`--cols`) must additionally match
  `terminal.rows`/`terminal.columns`. Any mismatch fails validation before
  anything runs.

### Native TTY capture is enforced

Plain argv commands are captured through a **native PTY** allocated by the
harness (`@lydell/node-pty`, rows/columns and `TERM` from the scenario). The
child therefore runs with a real TTY, and each side's `summary.json` records
the evidence (`capture.tty`: mode, backend, allocated, rows, columns,
handshake). If no PTY backend is available, direct capture is **refused**
with `native TTY capture refused: ...`; the harness never silently falls back
to non-TTY pipes for a real CLI. Two explicit waivers exist, both recorded in
artifacts and reports:

- `"pty": "fixture"` — the command is a deterministic fixture that needs no
  TTY (the harness's own emitters). Captured over pipes and clearly marked
  as waived; real-CLI captures may not use this mode.
- `"pty": "wrapped"` — the command already runs inside a caller-supplied PTY
  wrapper (expect, tmux, `script`, or `lib/tty-handshake.mjs`). The harness
  generates a per-run nonce in `TUI_PARITY_PTY_NONCE` and verifies that the
  captured stream contains the matching
  `ESC ] 697 ; tty-handshake ; <nonce> BEL` marker. `lib/tty-handshake.mjs`
  emits that marker only when its stdout really is a TTY, and refuses
  otherwise. A missing handshake fails the side.

`TUI_PARITY_NO_PTY=1` forces the no-backend path in tests.

## Scenario schema

```json
{
  "id": "kebab-case-id",
  "description": "what is being compared",
  "terminal": { "rows": 12, "columns": 40 },
  "timeoutMs": 10000,
  "input": [{ "data": "\r", "delayMs": 0 }],
  "env": { "KEY": "value" },
  "compareParams": ["--frames", "--rows"],
  "commands": {
    "base": ["argv", "captured through a native PTY"],
    "fixed": { "argv": ["argv..."], "pty": "fixture" }
  },
  "thresholds": { "maxFullScreenClears": 0 },
  "expectBaseFailure": false,
  "proves": "what a passing run proves",
  "doesNotProve": "what it cannot prove"
}
```

`commands.<side>` is either a plain argv array (native PTY capture) or an
object with `argv` and optional `pty` (`"fixture"` or `"wrapped"`). Any other
per-side key is rejected.

`expectBaseFailure` (optional boolean, default `false`) declares that the base
side is a defect fixture rather than a clean reference. Such a scenario passes
only when the base side fails: a `both-pass` there means the fixture emitted no
defect, so the comparison would report success while proving nothing.

Thresholds (all optional, evaluated per side): `maxFullScreenClears`,
`maxPartialScreenErases`, `maxLineErases`, `maxDuplicateEvents`,
`maxDec2026Unbalanced` (integers >= 0), and `requireSync`,
`requireEventMarkers`, `requireExitCodeZero` (booleans; the exit-code
requirement defaults to true; spawn failures, timeouts, PTY refusals, and
unverified handshakes always fail a side).

## Metrics

Counted from each side's raw stdout:

- Full-screen clear opcodes: `ESC[2J`, `ESC[3J`, RIS (`ESC c`).
- Line erases: `ESC[K` in modes 0/1/2; partial screen erases `ESC[J` modes
  0/1 tracked separately.
- DEC 2026 synchronised-output begin/end (`ESC[?2026h` / `ESC[?2026l`) plus
  an unbalanced count for stray ends and unclosed begins. `requireSync`
  accepts a stream only if at least one begin exists, pairs balance, and —
  when live-output event markers are measured — every marker occurrence was
  emitted inside an active DEC 2026 interval. Coverage is measured per event,
  not inferred from counts: empty begin/end pairs that wrap no events and
  markers emitted outside every interval fail `requireSync` even when the
  begin count equals the unique event count.
- Live-output event markers using OSC `697;<id>;<seq>` (BEL or ST
  terminated). A marker whose `(id, seq)` was already seen is a duplicate.
  Each marker occurrence is additionally classified as covered (inside an
  active DEC 2026 interval) or unwrapped (outside every interval), and both
  counts are reported. Without markers the duplicate count is reported as not
  measurable.
- Process exit code, signal, timeout, and duration.

Timeout handling tracks and clears every pending input timer, and kills the
capture process tree where supported (SIGTERM to the process group, SIGKILL
after a 1s grace). The kill escalation survives the main child closing: the
SIGKILL step is not cancelled when the captured command exits, and after it
fires the harness re-probes the process group until it is confirmed gone
(bounded). A descendant that ignores SIGTERM and detaches stdio therefore
cannot outlive the capture, and a capture cannot linger on delayed input or
orphaned descendants.

`proves` and `doesNotProve` are mandatory scenario fields and are copied
verbatim into every report, so each scenario states what its result does and
does not demonstrate.

## Artifacts

Per run under `--out`:

```
run-summary.json
<scenario-id>/
  base|fixed/
    raw.ansi        exact captured stdout
    stderr.txt      captured stderr (empty for PTY captures: a real
                    terminal merges stderr into the PTY stream)
    screen.txt      final screen from the built-in terminal model
    summary.json    capture metadata (incl. tty evidence), metrics,
                    verdict, reasons
  comparison.json   side-by-side metrics, deltas, outcome
  report.md         reviewer-facing report
```

Outcomes: `base-fails-fixed-passes` (evidence that the fix removes the
defect), `both-pass` (no base-side defect exhibited), `fixed-fails`
(threshold violation), `capture-error` (spawn failure, refusal, or timeout).
The run passes only on the first two — and for a scenario with
`expectBaseFailure`, only on `base-fails-fixed-passes`.

## Fixtures and tests

- `fixtures/emitters/tui-emitter.mjs` is a deterministic emitter: identical
  flags produce identical bytes, and its flags inject the exact defects the
  metrics count (`--clears-per-frame`, `--scrollback-clears`, `--dups`,
  `--sync`, `--hang-ms`, `--exit-code`). `--tree-hang` spawns an idle
  grandchild and hangs, to exercise process-tree kill on timeout.
  `--stubborn-hang` spawns a grandchild that ignores SIGTERM and detaches its
  stdio, then hangs; it exercises kill escalation that must survive the main
  child closing.
- `fixtures/wrappers/pty-launcher.mjs` wraps a command in a PTY, standing in
  for external wrappers in handshake tests.
- `fixtures/scenarios/stream-redraw.scenario.json` reproduces a failing base
  and passing fixed side without launching the real CLI.

```bash
node --test scripts/tui-parity/test   # unit + end-to-end tests
node scripts/tui-parity/self-test.mjs # full pipeline self-check
```

Tests cover the PTY refusal and the native/wrapped happy paths, divergent
`compareParams` (including `--rows`/`--columns`), per-side parameter
rejection, and a bounded regression test where `input.delayMs` exceeds
`timeoutMs`. They also lock in the three adversarial counterexamples as
regressions: empty DEC 2026 pairs plus unwrapped event markers can never
satisfy `requireSync`; a descendant that ignores SIGTERM and detaches stdio
is still reaped after the main child closes (fixture and native PTY); and a
`--base`/`--fixed` override that diverges from `compareParams` or the capture
geometry aborts before anything runs. Fixture results are evidence about the
harness and its metrics, not about the products. Real-CLI parity claims
require running the same harness with real base/fixed commands through the
native PTY contract.

## Normalization limits

The built-in terminal model supports printable text, CR/LF/BS/TAB, cursor
movement, ED/EL/IL/DL/ICH/DCH/ECH, SGR (ignored), alternate screen
(47/1047/1049), and RIS. Scroll regions, double-width characters, and
wide-grapheme measurement are not modeled; `screen.txt` is a review aid, and
the machine-checkable part of the harness is the metric counts. PTY captures
apply the terminal line discipline (e.g. LF echoed as CRLF); metrics count
opcodes, not whitespace, so this does not change threshold semantics.
