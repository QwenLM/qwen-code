# verify-pr: harden the remaining actionable #17371 residuals

Language: English | [中文](verify-pr-deferred-residual-hardening.zh-CN.md)

Tracking issue: #17371. The high-priority residuals are already closed —
R17-1 (core trust boundary) by #17375; R16-1/R16-2/R16-4 and D17-1/2/3 by
#17440; R17-2 (register-ahead liveness) by #17550. This increment addresses the
remaining **actionable below-Critical** residuals (clusters E/F, the R5-2 doc
sweep, and the round-7/8/12/14 deferred refinements). It deliberately does
**not** touch the accepted fail-closed budgets (RS-1/RS-2) or the three
silent-drop liveness windows, which stay tracked in #17371.

## Re-enumeration against current main

Per the tracking discipline, every residual was re-checked at the current head
before being acted on; several are already covered or not reproducible:

- **D17-11 (`--context-root` accepted without `--context`) — already closed by
  #17375.** `verify-pr-check.mjs` validates `--context-root` whenever supplied
  ("not only with `--context`") and rejects a filesystem root even without
  `--context` (R2-2). No change needed.
- **D17-10 (a followed `evidence/` symlink) — covered by the #17440 scan
  rewrite.** The nonce walk uses `readdirSync(..., { withFileTypes: true })`
  and only recurses `entry.isDirectory()` / reads `entry.isFile()`; a symlink
  is neither, so it is skipped, never followed. A witness pins this.
- **Round-8 #3 (legacy `--release` writes empty lists without `seqCounter`) —
  not reproducible as stated.** A successful `--release` always appends the
  released head to `releasedHeads`, which is a state-bearing entry, so the
  released body is admitted on the next read (probed: legacy no-`seqCounter`
  state → `--release` → next `--start` exits 0). The "empty lists" premise is
  unreachable. We still make the documented invariant true for every writer
  (below) as a cheap hardening, with a witness.
- **D17-14 (liveness-gated dead-round recovery) — this is the accepted
  dead-round `--release`→restart silent-drop window**; it stays tracked, not
  changed here.

## Proposed changes

### A. watch-state helper (`scripts/verify-pr-watch-state.mjs`)

- **A1 — every writer emits `seqCounter`.** `releaseRound` builds its state
  with `deriveView({ ...existing, ... })` and adds no `seqCounter`, so it is
  the one writer that can emit a list-bearing body without one (a legacy
  pre-list state has none to inherit). The read guard's documented invariant
  "a `*Heads` list implies `seqCounter`" therefore does not hold for every
  writer. `releaseRound` now sets
  `seqCounter: Math.max(existing?.seqCounter ?? 0, entry.seq ?? 0)`, matching
  `startRound`/`completeRound`. Behavior-neutral for every reachable shape (the
  released body was already admitted via `releasedHeads`, and every
  writer-produced shape already has `entry.seq ≤ seqCounter`); it makes the
  invariant robust and keeps the counter from regressing below a seq it carries
  into `releasedHeads` (`nextSeq` never reads that list). A witness releases
  a legacy no-`seqCounter` state and asserts the written body carries an integer
  `seqCounter`; a second witness seeds a counter below the marker's `seq` and
  pins the fold, so the `?? 0` fallback alone reds it.
- **A2 — drop the dead `sandboxRuntime` field (D17-8).** `detectIsolation` in
  `verify-pr-prepare.mjs` returns `sandboxRuntime`, but no production consumer
  reads it (callers use `isolated` / `signals` / `seatbelt`). Remove the field
  and the prepare-test assertions that pin it.

### B. checker (`scripts/verify-pr-check.mjs`) + tests

- **B1 — bound-refusal wording (round-7 #6).** The resource-bound refusal
  advises "echo the nonce into an early log", but the walk is unsorted, so
  "early" does not control read order; the bound is on total bytes. Reword to
  drop the ordering implication and name both remedies — reduce the
  non-evidence log volume AND consolidate it into fewer files or directories,
  since directories and empty files charge the entry cap, not the byte budget
  (R1-7) — keeping the `mode:"waived"` escape.
- **B2 — pin the bound constants (round-7 #8).** The refusal hardcoded its
  numbers independently of the function-local `TOTAL_BUDGET` / `MAX_ENTRIES`,
  so a silent constant change red nothing (R1-5). Hoist both bounds to module
  scope and build the refusal from them; the message pin now asserts the
  rendered `64 MiB total / 20000 entries`, so a constant change reds it. The
  skill-side pin covers the full bound phrase, `20000 entries in total`
  included.
- **B3 — per-file / per-directory budget witness (round-7 #9).** The two bounds
  are asserted only on flat single-directory fixtures; add a nested-directory
  forest proving the entry cap is aggregate and a two-file (2 × 33 MiB)
  fixture proving the byte budget is aggregate — a per-directory or per-file
  reset reds its fixture (R1-6).

### C. skill contract (`.qwen/skills/verify-pr/SKILL.md`)

- **C1 — nonce scan bound prose (round-7 #2).** The nonce contract omits the
  scan's 64 MiB / 20000-entry bound, so a compliant round can still be refused
  without the operator knowing why. Add a sentence naming the bound and both
  remedies (reduce non-evidence log volume / consolidate into fewer files or
  directories / `mode:"waived"` with approval).
- **C2 — scope the nonce claim to "cannot produce" (round-7 #3).** The step-5
  echo puts the nonce plaintext in the PR-writable log, so "a host battery
  cannot read the nonce" is stronger than established. The binding is that a
  host battery cannot _produce_ the matching `container-nonce:` line without
  the container-local plaintext. Reword accordingly, and scope the claim to
  what the echo proves — the harness read a container-local value at echo
  time, not that the battery ran in the container, since the echoed copy rides
  the shared mount and any later writer with the round dir can reuse it
  (R1-1). The step-7 comment is aligned in the same edit.
- **C3 — R12-D4 moved-head terminal group.** The moved-head recipe says to
  start the head the release's deferred list names, but that list also carries
  a terminal "not covered after repeated inconclusive rounds" group that must
  not be started without a new head move. Re-exclude the terminal group in the
  moved-head wording AND in the exit-3 dead-marker bullet that reads the same
  release output — its "start the last deferred head" is scoped to the
  awaiting group, since the terminal group prints last (R1-2).
- **C4 — round-14 prose-structure items, assessed not churned.** The `:786`
  item (moved-head release `--round <r>` "after a restart renumbers") is a
  confirmed bot misreading: the moved-head branch releases _this_ round's
  marker and does **not** restart it, so `--round <r>` is correct (the `<r+1>`
  renumber belongs to the separate dead-round recovery branch). The
  `:261`/`:278`/`:767` items are below-Critical prose-structure nuances whose
  substance is already carried by the adjacent clarifications (registration is
  a watch/re-verification procedure, not a fresh `/verify-pr <n>`; the transient
  case retries prepare without release). They stay tracked in #17371 as polish
  rather than re-churned here, to avoid a non-converging prose loop.

### D. prepare test (`scripts/tests/verify-pr-prepare.test.js`)

- **D1 — `homedir()` throw witness (round-7 #4).** The R5-1 home-refusal guard
  is exercised only via the post-catch `home:null` seam; add a witness that
  injects a `homedir` that actually throws, proving the lazy try/catch reaches
  the exit-3 refusal (not an escaped exit 1).

### E. text-pin suite (`scripts/tests/qwen-triage-workflow.test.js`)

- **E1 — VM negative pin (round-7 #7).** The R16-4/R3-4 VM-prose fix is pinned
  only positively; add a `not.toContain` asserting the retracted preflight
  sentence (routing the VM through `--require-isolation`) is gone.
- **E2 — R12-D5 exact registration pins.** The no-`--artifact-dir` registration
  pins prefix-match the `--start` command, so the flag could be re-appended at
  the end with the pins still green. Tighten to the full command form.
- **E3 — round-14 pin guards.** Add the missing presence guard on the
  manual-section ordering pin's left operand (and the watch heading pin's right
  operand), and scope the `<dir>` provenance pin to the watch prompt's own
  slice so the manual copy is not its alibi.

### F. documentation sweeps (bilingual)

- **F1 — R5-2 Java recipe waived-model coherence.** Sweep
  `docs/design/2026-11-14-verify-pr-java-container-recipe.md` (+ `.zh-CN.md`)
  to a single coherent `mode:"waived"` model: step-1 digest-pinned-Node
  rationale, the step-1 nonce paragraph (a waived round's check reads no gate
  record; the battery container runs no gate and carries no Node), step-4
  lead-in, the Validation plan, the Acceptance criteria, and what the report's
  mandatory `**Boundary.**` line reads (waiver + approval; containers named in
  the declaration `detail`/report body, not the Boundary line).
- **F2 — `verify-pr-watch.md` null directory.** The canonical watch design
  still says every state entry carries an artifact directory; register-ahead
  (#17550) permits a `null` dir on the in-flight marker. Correct it (+ `.zh-CN.md`).
- **F3 — `verify-pr-residual-hardening.md` Files-affected completeness.** The
  list names 8 of the PR's 14 files; enumerate the documentation pairs too
  (+ `.zh-CN.md`).
- **F4 — round-14 register-ahead doc.** Note the post-prepare-success head
  comparison in the scope boundary, and make residual (3)'s recovery recipe
  pass `--round` (not optional), consistent with the doc's own rule
  (+ `.zh-CN.md`).

## Key design decisions

- **Re-enumerate before fixing.** Items already closed by a follow-up PR
  (D17-11), covered by a rewrite (D17-10), or not reproducible (round-8 #3)
  are recorded as such rather than "fixed" again; the one invariant hardening
  (A1) is kept because it is cheap and makes a documented claim true.
- **Accepted risks stay accepted.** RS-1/RS-2 (fail-closed budgets) and the
  three silent-drop windows are liveness/availability trade-offs the maintainer
  accepted; they are out of scope and remain tracked in #17371.
- **Prose/test-only where possible.** The production changes are small — three
  files: A1 (one field), A2 (a dead field removed), B1/B2 (the refusal-message
  wording, now built from the hoisted bound constants), and D1 (a test seam on
  `requireBoundary`); everything else is prose, docs, or test hardening, so the
  blast radius is small and each change is witnessed.

## Files affected

- `scripts/verify-pr-watch-state.mjs` (A1), `scripts/verify-pr-prepare.mjs`
  (A2, D1).
- `scripts/verify-pr-check.mjs` (B1, B2).
- `.qwen/skills/verify-pr/SKILL.md` (C1–C4).
- `scripts/tests/verify-pr-watch-state.test.js` (A1 witnesses),
  `scripts/tests/verify-pr-prepare.test.js` (A2, D1),
  `scripts/tests/verify-pr-check.test.js` (B2, B3, D17-10 witness),
  `scripts/tests/qwen-triage-workflow.test.js` (C/E pins).
- `docs/design/2026-11-14-verify-pr-java-container-recipe.md` + `.zh-CN.md` (F1),
  `docs/design/verify-pr-watch.md` + `.zh-CN.md` (F2),
  `docs/design/verify-pr-residual-hardening.md` + `.zh-CN.md` (F3),
  `docs/design/verify-pr-register-ahead-of-prepare.md` + `.zh-CN.md` (F4),
  and this design pair.

## Scope boundaries

- Only the actionable below-Critical residuals listed above. The watch-gate
  ownership/cursor, dedup/defer/release semantics, and the trust-boundary
  checks (R17-1, closed) are unchanged. RS-1/RS-2 and the three silent-drop
  windows remain accepted and tracked in #17371.

## Open questions

- The vague cluster-F test-quality items (D17-4/5/6/9: ambient-gated pass-path
  tests, quote-blind pins, a replay that never reaches its write,
  rendered-Markdown disclosure matching) are recorded in the #17185 findings
  artifact; those needing the artifact's exact fixture detail stay tracked
  rather than guess-fixed here.
