# Plan — rc-gateway policy time conditions (cycle 22, policy-engine Phase 2a)

Design: `docs/superpowers/specs/2026-06-09-rc-gateway-policy-time-conditions-design.md`.

**Branch:** `add-remote-control-spec` — stay on it; do NOT create a
branch. Run all git/npm from repo root `/home/evan/projects/qwen-code`
with absolute paths. Strict TDD: red → green, one commit per task, never
`--no-verify`. License header on every new `src/*.ts`. NodeNext ESM: `.js`
import extensions. No `any` (`no-explicit-any: error`) — read the
`unknown` policy fields defensively. Commits end with:
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Read first:** `packages/rc-gateway/src/policy/evaluator.ts` (current
pure evaluator + the `usedDeferred` downgrade), `src/policy/loader.ts`
(the deferred-field types + warning), `src/policy/enforcer.ts` (the
`evaluate(...)` call site). The semantics are in the design's
"Semantics" + "Evaluation algorithm" sections — follow them exactly;
do NOT invent timezone/format behavior.

## Task 1 — `conditions.ts` (pure time helpers)

New `packages/rc-gateway/src/policy/conditions.ts`:

- `interface ParsedTimeOfDay { fromMin: number; toMin: number; timezone: string }`.
- `parseTimeOfDay(raw: unknown): ParsedTimeOfDay | null` — `raw` must be a
  plain object with string `from`/`to` matching `^([01]\d|2[0-3]):[0-5]\d$`
  and a non-empty string `timezone`; convert `from`/`to` to minutes-of-day
  (0–1439). Anything off → `null`.
- `isWithinTimeOfDay(p: ParsedTimeOfDay, now: Date): boolean` — get the
  current minutes-of-day in `p.timezone`:
  ```ts
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: p.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  ```
  read `hour`/`minute` parts → `m = h*60 + min` (note `hour` can be `"24"`
  for midnight in some envs — normalize `24`→`0`). Window test:
  `p.fromMin <= p.toMin ? (m >= p.fromMin && m <= p.toMin) : (m >= p.fromMin || m <= p.toMin)`.
  **Wrap the `Intl` construction/format in try/catch**: an invalid IANA
  zone throws `RangeError` → treat as malformed. Recommended shape:
  `parseTimeOfDay` does NOT validate the timezone string against Intl (it
  can't cheaply); instead `isWithinTimeOfDay` throwing on a bad zone is
  caught by the evaluator and classified `unevaluable`. **Decide the
  cleaner split and document it in a comment** — either (a)
  `parseTimeOfDay` probes the zone with a throwaway `Intl.DateTimeFormat`
  in try/catch and returns null on a bad zone (malformed surfaces at
  parse), or (b) `isWithinTimeOfDay` returns a sentinel / the evaluator
  try/catches. Prefer (a): validate the zone in `parseTimeOfDay` so
  "malformed" is a single concept (parse → null).
- `parseExpiresAt(raw: unknown): number | null` — `typeof raw === 'string'`
  → `const t = Date.parse(raw); return Number.isNaN(t) ? null : t`. Non-
  string (number/object/null) → `null` (malformed; a bare `expiresAt:`
  YAML key → null in JS).
- `isExpired(expiresMs: number, now: Date): boolean` = `now.getTime() >= expiresMs`.

Tests `conditions.test.ts`: parseTimeOfDay valid (`"09:00"`/`"23:30"`),
invalid (`"24:00"`, `"9:00"`, `"09:9"`, `"09:60"`, missing field, non-
object, empty/garbage timezone → null); isWithinTimeOfDay inside, outside,
both boundaries inclusive, midnight-wrap (`23:00`–`07:00` at `02:00`
inside / `12:00` outside), **DST**: a `America/Los_Angeles` `09:00`–`17:00`
window evaluated at a fixed UTC `now` that is 10:00 PT in summer (inside)
and the same wall-UTC in winter (shifted) — assert tz projection, not raw
UTC; parseExpiresAt valid ISO / garbage / number→null; isExpired
before/at(=expired)/after.

Commits: `test(rc-gateway): policy time-condition helpers` /
`feat(rc-gateway): policy timeOfDay + expiresAt condition helpers`.

## Task 2 — evaluator: classify + evaluate conditions

Edit `src/policy/evaluator.ts`:

- `evaluate(policy, ctx, now: Date = new Date())`.
- Add `classifyConditions(rule, now): 'no-match' | 'match' | 'unevaluable'`
  per the design algorithm:
  1. `expiresAt` present (`rule.expiresAt !== undefined`): `parseExpiresAt`
     → null ⇒ mark `unevaluable`; else `isExpired` ⇒ **return `'no-match'`**.
  2. `timeOfDay` present (`rule.match.timeOfDay !== undefined`):
     `parseTimeOfDay` → null ⇒ mark `unevaluable`; else
     `!isWithinTimeOfDay` ⇒ **return `'no-match'`**.
  3. `maxPerWindow` present ⇒ mark `unevaluable`.
  4. return `unevaluable` if marked else `match`.
- In the main loop: a rule applies iff `ruleMatches(static fields)` AND
  `classifyConditions !== 'no-match'`. Replace the old
  `usedDeferred = presence(...)` block with:
  ```ts
  const status = classifyConditions(rule, now); // 'match' | 'unevaluable'  (no-match already continued)
  const unevaluable = status === 'unevaluable';
  if (unevaluable && rule.action !== 'prompt') {
    /* downgrade as today */
  }
  return {
    action: rule.action,
    ruleId,
    requireScope,
    reason,
    usedDeferredField: unevaluable,
  };
  ```
  Order matters: check `classifyConditions` and `continue` on `'no-match'`
  BEFORE deciding the action.

Tests (extend `evaluator.test.ts`): well-formed allow IN window → allow
(not prompt), `usedDeferredField:false`; OUT of window → that rule
skipped, falls through to a lower rule / default; expired allow →
skipped; not-yet-expired allow → allow; malformed timeOfDay (bad tz) on
an allow rule → prompt + `usedDeferredField:true`; malformed expiresAt →
prompt; `maxPerWindow` allow → still prompt; a rule that is BOTH expired
(well-formed) AND has a malformed timeOfDay → skipped (`no-match` wins);
a `prompt` rule with timeOfDay out-of-window → skipped (doesn't prompt
out of window). Pass a fixed `now` to all.

Commit: `feat(rc-gateway): evaluate policy timeOfDay/expiresAt (no longer downgraded)`.

## Task 3 — loader: narrow the deferred warning

Edit `src/policy/loader.ts`: the `warnedDeferred` block currently fires
for timeOfDay/maxPerWindow/expiresAt. Narrow it to fire only for
`maxPerWindow` (the still-deferred field), and update the message to say
maxPerWindow downgrades to prompt (timeOfDay/expiresAt are now evaluated).
Keep the field pass-through unchanged (still `unknown`).

Tests: extend `loader.test.ts` — a rule with ONLY timeOfDay or ONLY
expiresAt does not trigger the deferred warning (spy on `console.warn`);
a rule with maxPerWindow still does. (If the existing tests assert the old
warning behavior, update them to match.)

Commit: `feat(rc-gateway): narrow loader deferred-field warning to maxPerWindow`.

## Task 4 — enforcer + verification sweep

- Confirm `src/policy/enforcer.ts` still compiles (it calls
  `evaluate(policy, ctx)` — the new `now` param is optional/defaulted, so
  no change needed; if it threads anything, leave the real-clock default).
- Optionally add ONE enforcer test: an out-of-window allow rule → the
  enforcer does NOT auto-vote (falls through). Keep only if it's a small
  addition to the existing enforcer test harness.
- Run the full sweep (repo root):
  ```
  npm run typecheck --workspace @qwen-code/rc-gateway
  npm run lint --workspace @qwen-code/rc-gateway
  npm run build --workspace @qwen-code/rc-gateway
  npm run test --workspace @qwen-code/rc-gateway
  node scripts/rc-gateway-e2e.mjs
  ```
  The e2e must still pass unchanged (no new route surface). Commit any
  enforcer test separately:
  `test(rc-gateway): enforcer skips an out-of-window allow rule`.

## Final

Confirm diff scope: `git diff --name-only <cycle-start>..HEAD` shows only
`packages/rc-gateway/src/policy/` (+ the two docs). No files outside
`packages/rc-gateway/`.

## Report back

- Commit hashes + `git log --oneline` of your commits.
- All 5 verification outputs (test count, e2e count).
- The DST test: state the concrete `now`/timezone you used and that it
  asserts tz-projected minutes, not raw UTC.
- Any deviation (esp. the parseTimeOfDay-vs-isWithinTimeOfDay malformed-tz
  split you chose) and why; any bugs hit.
- Do NOT push or update memory — the orchestrator handles that after review.
