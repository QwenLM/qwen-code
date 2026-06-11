# rc-gateway — `qwen rc policy explain` (dry-run evaluator trace)

**Cycle 44.** Proposal: `add-policy-engine`, Phase 3 tooling
(`tasks.md` 3.2; `spec.md` "Operator commands for policy management" →
_Scenario: Explain shows match path_).

## Deviation from the OpenSpec design

The proposal's `design.md` puts `policy explain` in the daemon and has the
CLI hit a daemon "explain endpoint". We have no daemon-side surface to edit
(the HARD invariant: zero edits outside `packages/rc-gateway/`), and the
gateway already owns the policy evaluator. So `explain` is delivered
**gateway-side and DAEMON-FREE**, exactly like the cycle-40 `policy lint`
and cycle-41 `routing rules` inspectors: it loads the same layered policy
the boot path uses and runs the same pure evaluator. No running gateway is
required.

## Spec target (verbatim)

> `qwen rc policy explain <toolName> [--args=…] [--path=…]` — dry-run
> evaluator showing which rule (if any) would match and why.
>
> Scenario: Explain shows match path —
> WHEN the user runs `qwen rc policy explain bash --args="npm test"`
> THEN the output lists each rule considered in evaluation order with
> MATCHED/SKIPPED annotation, AND the final decision and source rule (or
> default).

## What ships this cycle

1. A pure `explainPolicy(policy, ctx, now?, quota?)` in `policy/evaluator.ts`
   returning `{ decision, trace[] }`:
   - `decision` is produced by the REAL `evaluate(policy, ctx, now, quota)`
     — the authoritative answer, so the printed decision can NEVER drift
     from what the enforcer would actually do.
   - `trace[]` walks rules in the **same** evaluation order
     (`priority desc, specificity desc, index asc`) and annotates each:
     `matched` / `skipped` / `not-reached`, with a short reason token.
2. `policy/explain.ts`: pure `parseExplainArgs(argv)` and
   `formatExplanation(exp)` (CLI input parsing + human rendering).
3. The `qwen-rc policy explain …` CLI branch in `cli.ts` (thin glue).

## Decisions

1. **Single source of truth — no drift.** `explainPolicy` reuses the SAME
   internals `evaluate()` uses, refactored so each yields a reason WITHOUT
   changing `evaluate()`'s behavior:
   - `ruleMatches(rule,…)` → thin wrapper over a new
     `matchReason(rule,…): string | null` (null = matches; otherwise the
     first failing token: `tool-mismatch`, `args-mismatch`,
     `no-path-candidates`, `path-mismatch`, `origin-scope-mismatch`,
     `session-tag-mismatch`). The matching path allocates no string.
   - `classifyConditions(rule,…)` → thin wrapper over a new
     `classifyConditionsDetailed(rule,…): { kind, reason }`
     (`expired` / `outside-time-window` / `quota-exhausted` /
     `condition-unevaluable` / `malformed-expiresAt` /
     `malformed-timeOfDay` / `quota-not-evaluated`).
     `evaluate()` keeps calling `ruleMatches(...)===true` /
     `classifyConditions(...)==='no-match'|'unevaluable'` — **byte-stable**;
     every existing evaluator test passes untouched.
2. **Shared ordering.** Extract the sort in `evaluate()` into
   `orderedRuleIndices(policy)`; `explainPolicy` calls the same function so
   the trace order is provably the evaluation order (behavior-preserving
   refactor of `evaluate`).
3. **Winner + not-reached.** The first rule that is neither `skipped` nor a
   condition `no-match` is the winner (`matched`); every later rule is
   `not-reached` (reason `earlier-rule-won`) — mirrors `evaluate()`
   returning on first match. A winner whose action was downgraded to prompt
   (unevaluable condition on a non-prompt action) is `matched` with
   `action:'prompt'`, `downgraded:true`.
4. **Dry-run has NO quota oracle.** The CLI is daemon-free with no live
   quota store, so `explain` passes `quota=undefined`. A `maxPerWindow` rule
   is therefore `condition-unevaluable` → prompt, reason `quota-not-evaluated`.
   This is HONEST: it is exactly the gateway's behavior when no store is
   wired, and a dry run cannot know live consumption. `formatExplanation`
   appends a one-line caveat when any traced rule carries `maxPerWindow`.
5. **Faithful context mapping.** `parseExplainArgs` mirrors the enforcer's
   `ctx = { tool, args }` (enforcer.ts:101 `args = toolCall.input ?? …`):
   - first positional = `tool`.
   - `--args=V`: if `V` parses as a JSON object/array → that value; else the
     raw string (so the spec's `--args="npm test"` matches an `argsGlob`).
   - `--path=V`: feeds `pathGlob` via the evaluator's `candidatePaths`
     (which reads `args.path/cwd/files`): if `args` is an object set
     `args.path` (when absent); else wrap to `{ path: V, ...(input) }`; if no
     `--args`, `args = { path: V }`.
   - `--scope=V` → `originScope`; `--tag=V` → `sessionTag`.
     `--key=value` form (matches the spec examples); unknown flags ignored.
6. **Inspector exit codes** (like `routing rules`, NOT a linter): success →
   exit 0. Missing `<toolName>` → usage, exit 2. A MALFORMED policy can't be
   explained → catch, print the error, exit 1 (loadLayeredPolicy throws on a
   bad USER file — same boot-fail semantics; we surface it rather than
   pretend). Workspace cwd = `process.cwd()` (daemon-free, like the other
   subcommands), so a `<cwd>/.qwen/policy.yaml` override is reflected.

## Deferred (NOT this cycle)

- `qwen rc policy reload` (needs a running-gateway IPC surface that does not
  exist yet) and fsnotify hot-reload (Phase 3.1) — separate cycle.
- `policy_decision` SSE frame + web UI (Phase 4).
- Live quota state in `explain` (would require talking to a running store).

## Fail-safe / invariant notes

- 100% inside `packages/rc-gateway/` (+ these docs). No daemon edits.
- Pure additive logic + a behavior-preserving internal refactor of
  `evaluator.ts`; `evaluate()` observable behavior unchanged. No route, no
  notifier, no new throw path on any HTTP handler. The only new entrypoint is
  a CLI branch (smoke-tested; the e2e does not run `cli.ts`).
- Audit hygiene N/A (CLI prints to the operator's own terminal; no audit
  log, no network). It prints rule ids / tokens / the decision — never
  secrets.
