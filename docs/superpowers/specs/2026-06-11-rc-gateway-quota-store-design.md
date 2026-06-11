# rc-gateway — policy quota store + WAL (cycle 42, Phase 2b part 1)

## Context

`add-policy-engine` spec (`specs/policy-engine/spec.md:119-139`):

> Requirement: Per-rule rate limiting via `maxPerWindow`. A rule with
> `maxPerWindow: { count, windowSec }` SHALL allow at most `count` matches within
> any rolling `windowSec`-second window. Beyond the cap, the rule SHALL NOT match
> (evaluation continues to lower-specificity rules; audit records
> `rule_id: null, decision_source: default`).
> Scenario "Quota state survives daemon restart": counters mid-window with 3 of 5
> used → after restart, first match resumes at 4 of 5.

design.md:68: "Quotas are consumed only on `allow` matches and only AFTER the
tool is actually invoked (not on bare match)."

Today (cycle 13/22/39/40): `maxPerWindow` is stored as raw `unknown`, flagged a
"deferred field", and the evaluator downgrades any matched `maxPerWindow` rule to
**prompt** (the safe placeholder). This cycle builds the load-bearing core — a
persisted rolling-window counter — but **wires NOTHING** (the evaluator keeps
downgrading to prompt). The wiring (loader validation + evaluator quota-oracle +
enforcer consume-on-invoke = the behavior flip) is the NEXT cycle, kept separate
because it changes a hot-path security decision and deserves its own review.

## Deviation from the daemon-centric spec

- **Gateway-side, not the daemon.** Store lives in `packages/rc-gateway/`; persists
  to `~/.qwen/rc/quotas.wal` (the gateway's config dir, beside `policy.yaml` /
  `routing.yaml`), NOT the daemon.
- **Rolling vs bucket.** The SPEC says "rolling `windowSec` window"; `tasks.md`
  sketches `(ruleId, windowStartTs)` fixed buckets. We implement the SPEC's TRUE
  sliding window (per-rule consumption timestamps; count those within
  `(now-windowSec, now]`) — strictly more correct than tumbling buckets, and the
  WAL already stores timestamps so it costs nothing extra. Deviation noted.
- **Consume point.** In the gateway, "the tool is actually invoked" = the enforcer
  cast a SUCCESSFUL `allow` vote (`respondToSessionPermission` returned ok) — that
  is the gateway's commit-to-invoke. So next cycle consumes there, not on bare
  match. (This cycle only builds the store; the consume API is exercised by tests.)

## Decisions (this cycle = INERT store + WAL only)

- **D1 — `QuotaStore` is policy-AWARE via an injected limits lookup.**
  `new QuotaStore(wal, limitsFor)` where
  `limitsFor: (ruleId: string) => { count: number; windowSec: number } | undefined`.
  Knowing each rule's `windowSec` lets the store PRUNE stale timestamps at load
  and COMPACT the WAL (bounding growth) — impossible with policy-agnostic
  primitives. An unknown ruleId (id-less or no quota) → `undefined` → the store
  reports `untracked`. (The wiring cycle passes `(id) => rule.maxPerWindow` from
  the active policy; hot-reload swaps it.)
- **D2 — True sliding window (REQUIRED, not a preference).** The spec's "at most
  `count` within ANY rolling window of length W" IS the formal definition of a
  sliding window; tumbling `(ruleId, windowStartTs)` buckets (tasks.md's sketch)
  VIOLATE it — `2×count` calls can straddle a bucket boundary. So per-rule sorted
  `number[]` of consume-instants (ms): `used(ruleId, now)` prunes
  `≤ now - windowSec*1000` then returns the length; `remaining = max(0, count -
used)`; `state(ruleId, now) → 'room' | 'exhausted' | 'untracked'` (untracked =
  `limitsFor` unknown). `consume(ruleId, now)` appends `now` to memory AND the WAL.
  Pure given an injected `now` (no `Date.now()` inside — banned anyway). **Memory
  is O(count)/rule:** once a rule is exhausted no more consumes land until old
  instants age out, so the live array never exceeds ~`count`.
- **D3 — WAL = append-only JSONL**, one record per consume:
  `{"r":"<ruleId>","t":<ms>}\n` (JSON escaping handles any ruleId bytes).
  `mkdir -p` the config dir, then append via a single `appendFile`. On
  construction the store REPLAYS: read the file, parse line-by-line, **skip any
  malformed/torn line** — and SHAPE-validate each parsed record (`typeof r.r ===
'string' && Number.isFinite(r.t)`), not merely `JSON.parse` success, so a
  well-formed-JSON-but-wrong-shape line can't poison a counter. A `kill -9`
  mid-append leaves at most one partial trailing line → skipped. Construction
  rebuilds memory from the survivors but does NOT prune/compact at load (no `now`
  is injected at construct — pruning is LAZY on first access, which is correct and
  avoids startup I/O). **Compaction is RUNTIME + amortized:** `consume` tracks
  appends; when WAL lines exceed `max(floor, 2× live entries)` it prunes every
  rule to its window via `limitsFor`+`now`, DROPS records for an unknown ruleId
  (rule deleted/renamed), and rewrites the file with only the survivors — bounding
  growth for a long-lived daemon. (`floor` is monotonic via `Math.max`, so the
  threshold tracks the historical-max live set, not the instantaneous one — still
  bounded.)
- **D4 — Fail-direction (SECURITY FORK — advisor-reviewed, rationale CORRECTED).**
  - **`ENOENT` at load is NORMAL, not a failure:** no WAL yet → empty counters,
    no warn (empty IS the correct state).
  - **Individual torn/garbage/wrong-shape lines:** skip + replay the rest (above).
  - **Whole-file read failure (EACCES/EIO):** start EMPTY + a LOUD warn. This
    **FAILS OPEN** — and, correcting the earlier draft, the evaluator does **NOT**
    mitigate it: a reset store cannot tell "legitimately fresh" from "lost my
    state", so `limitsFor` still returns the limit, `used=0` → `state='room'` →
    the wiring cycle would AUTO-ALLOW. So fail-open here directly permits up to one
    extra window of allowances; it is a deliberate **bounded cap-reset**, not an
    evaluator-caught condition. Justification stands on the spec, not a safety net:
    `maxPerWindow` is a SOFT throttle whose beyond-cap fallback is **prompt the
    human** (spec:131-132), NOT deny — so resetting to a fresh window is
    spec-consistent, whereas bricking every quota'd rule into perpetual prompts on
    one bad byte is worse operationally. **Known amplification:** an attacker who
    can induce repeated restarts (or corrupt the WAL) gets repeated fresh windows;
    acceptable ONLY because the fallback is prompt, not silent allow-forever. If a
    future cycle wants `maxPerWindow` as a HARD limit, it must add a
    prompt-on-corruption mode — out of scope here.
  - **WAL _append_ failure (during `consume`, POST-decision):** swallow + log; the
    in-memory counter still increments. The allow already happened; a lost line
    only means that one consume won't survive a restart. Never throws.
- **D5 — INERT.** Exported from the barrel; imported by NOTHING in
  evaluator/enforcer/cli this cycle. Zero behavior change; `maxPerWindow` stays
  deferred→prompt. The cycle-40 `lint` "deferred" note stays accurate (still
  deferred until the wiring cycle).

## Safety / fail-safe

- No loader/evaluator/enforcer/route/cli edit → cannot change any live decision.
  Pure module + WAL file under the gateway config dir. `consume`/`append` never
  throw; the store never throws out of any public method.
- Fail-safe commit order: docs → in-memory `QuotaStore` (sliding window, no WAL) +
  tests → file WAL + replay/prune/compact + tests → barrel export. (cli/evaluator
  wiring is a SEPARATE future cycle.)

## Tests

- Window math: under cap → `room`; at cap → `exhausted`; a consume that ages out
  of the window frees a slot (inject `now` forward); unknown ruleId → `untracked`;
  `count: 0` rule → always `exhausted`.
- Restart survival: consume 3, build a NEW store over the SAME WAL → `used` resumes
  at 3 (→ remaining 2 of 5) — the spec scenario.
- Crash tolerance: a WAL with a truncated trailing line + a garbage line + a
  well-formed-JSON-but-wrong-shape line (`{"r":5}`) → all skipped, valid records
  replayed.
- Compaction: after replay+prune the WAL is rewritten — assert it **KEEPS the live
  records** (the dangerous bug is dropping still-valid timestamps) AND drops
  records for an unknown ruleId.
- Fail-open load: an unreadable/garbage whole-file → empty counters + no throw +
  warn; `ENOENT` → empty + NO warn (normal).
- Append failure: a WAL whose append rejects → `consume` still increments memory +
  no throw.

## Deferred (Phase 2b/3/4, NEXT cycles)

- **Wiring (THE IMMEDIATE next cycle — do not let quotas sprawl to 3+ cycles):**
  loader validates `maxPerWindow` → typed `{count,windowSec}` (fail-closed on
  malformed); evaluator gains an optional quota-oracle param (`room`→match,
  `exhausted`→no-match/fall-through, `untracked`/no-oracle→prompt); enforcer builds
  the store, passes the oracle, and `consume`s after a SUCCESSFUL allow vote;
  cycle-40 `lint` stops calling `maxPerWindow` "deferred". **MUST confirm in that
  cycle:** the check(evaluator)/consume(enforcer-after-vote) split is spec-FORCED
  (consume only after invoke, so no atomic `tryConsume`) and is therefore
  inherently TOCTOU — two concurrent permission events could both see `room` and
  over-grant. Acceptable ONLY if permission handling is serialized; verify the
  notifier/pump awaits each `handlePermission` before the next (it does today, but
  re-confirm) — this does not affect THIS cycle's API.
- `expiresAt` TTL is already honored (cycle 22) — not part of this.
- Phase 3 hot-reload + `qwen rc policy reload`; Phase 4 `policy_decision` SSE
  (`quotaRemaining`) + web UI.
