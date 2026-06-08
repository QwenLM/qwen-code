# RC Gateway — Policy Engine Part 1: Loader + Evaluator (Cycle 13)

> **For agentic workers:** TDD, `- [ ]` steps. All work inside `packages/rc-gateway/`. ZERO edits outside it. Pure functions only this cycle — no server/cli/audit wiring.

**Goal:** A YAML policy loader/validator + a specificity-ordered, side-effect-free evaluator mapping a tool call to allow/deny/prompt. Fully unit-tested.

**Design:** `docs/superpowers/specs/2026-06-08-rc-gateway-policy-loader-evaluator-design.md` — has the full types, semantics, specificity weights, and the deferred-field SAFETY downgrade. Implement as written.

**Dep:** `yaml@^2.8.1` already installed. `import { parse } from 'yaml'`.

**Conventions:** license header on new `src/*.ts`; `.js` imports; commit per task ending with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; run git/npm from repo root `/home/evan/projects/qwen-code`.

---

### Task 1: glob util (TDD)

**Files:** `src/policy/glob.ts` (+ `glob.test.ts`).

- [ ] Failing test per design's `glob.test.ts` bullets.
- [ ] Implement `globToRegExp(glob)`: escape regex metachars (`.[]{}()+?^$|\` and `/` left literal), then replace `*` with `.*`, anchor `^…$`, return `new RegExp`. `matchesAny(globs, value)`: if `globs` undefined → return `true` (absent field doesn't constrain — this is the evaluator's AND semantics); normalize to array; return true if any glob's regex tests `value`.
- [ ] Test passes. Commit: `feat(rc-gateway): policy glob matcher`.

### Task 2: loader (TDD)

**Files:** `src/policy/loader.ts` (+ `loader.test.ts`). Export from `src/index.ts`.

- [ ] Failing test per design's `loader.test.ts` bullets (valid → defaults filled; missing/invalid action → PolicyError; unknown fields ignored; loadPolicyFile missing → null; temp file → parsed).
- [ ] Implement types (`PolicyRuleMatch`, `PolicyRule`, `Policy`, `PolicyError`) + `loadPolicy(text)`:
  - `const doc = parse(text) ?? {}`; if not a plain object → PolicyError.
  - `defaults` = `{ action: doc.defaults?.action ?? 'prompt', requireScope: doc.defaults?.requireScope ?? 'approve' }`; validate action ∈ {allow,deny,prompt} else PolicyError.
  - `rules` = (doc.rules ?? []).map validate: each must be an object with an object `match` and `action ∈ {allow,deny,prompt}` → else PolicyError. Copy through `id, match, action, requireScope, reason, priority` and the deferred `match.timeOfDay`, `maxPerWindow`, `expiresAt` (kept, not evaluated). If a rule uses a deferred field, `console.warn('[policy] rule <id> uses an unevaluated field (timeOfDay/expiresAt/maxPerWindow); will downgrade to prompt')` once.
  - `loadPolicyFile(path)`: `readFile`; ENOENT/absent → return null; else `loadPolicy(text)`.
- [ ] Test passes. Export `loadPolicy`, `loadPolicyFile`, `PolicyError`, and the types. Commit: `feat(rc-gateway): policy YAML loader + schema validation`.

### Task 3: evaluator (TDD)

**Files:** `src/policy/evaluator.ts` (+ `evaluator.test.ts`). Export from `src/index.ts`.

- [ ] Failing test per design's `evaluator.test.ts` bullets — INCLUDING the deferred-field safety case (timeOfDay+allow that matches → downgraded to prompt with `usedDeferredField:true`).
- [ ] Implement `evaluate(policy, ctx)`:
  - Canonical arg string: if `ctx.args` is a string → it; else `JSON.stringify(ctx.args ?? '')`; then collapse whitespace (`.replace(/\s+/g,' ').trim()`).
  - Candidate paths: collect `args.path`, `args.cwd`, and `args.files[]` (when args is an object) into a string array.
  - Specificity weight per rule (design's table): tool: has `match.tool`? explicit (no `*`) → (contains no `*` && not '_') 100, '_' → 10, glob-with-`*`-but-not-bare-`*` → 90; +30 argsGlob, +30 pathGlob, +20 originScope, +20 timeOfDay, +20 sessionTag (count presence of each match field).
  - Sort indices by `(priority??0 desc, weight desc, index asc)`.
  - First rule that matches ALL present (non-deferred) fields: `tool` via `globToRegExp(match.tool).test(ctx.tool)` (or true if absent); `argsGlob` via `matchesAny(match.argsGlob, argString)`; `pathGlob` via candidate paths (true if any path matches any glob; if no candidate paths AND pathGlob present → no match); `originScope` exact (`match.originScope === ctx.originScope`); `sessionTag` exact. **timeOfDay/expiresAt/maxPerWindow are treated as satisfied (ignored) for matching.**
  - On match: `const usedDeferred = !!(match.timeOfDay || rule.maxPerWindow || rule.expiresAt)`. If `usedDeferred && rule.action !== 'prompt'` → return `{action:'prompt', ruleId:rule.id, requireScope: rule.requireScope ?? policy.defaults.requireScope, usedDeferredField:true}`. Else return `{action:rule.action, ruleId:rule.id, requireScope:rule.requireScope, reason:rule.reason, usedDeferredField:usedDeferred}`.
  - No match → `{action:policy.defaults.action, requireScope:policy.defaults.requireScope, usedDeferredField:false}`.
- [ ] Test passes. Export `evaluate`, `PolicyDecision`, `ToolCallContext`. Commit: `feat(rc-gateway): specificity-ordered policy evaluator`.

### Task 4: full verification

- [ ] From repo root: `npm run typecheck && npm run lint && npm run build && npm run test` (each `--workspace @qwen-code/rc-gateway`) → green.
- [ ] (No e2e change — pure functions, not wired yet.)
- [ ] Commit any leftover (skip if clean).

## Self-review checklist

- `loadPolicy` throws `PolicyError` on missing/invalid `action` or non-object `match`; ignores unknown fields (forward-compat); `loadPolicyFile` → null on absent.
- Evaluator is PURE (no I/O, no clock dependence this cycle); deterministic ordering (priority, specificity, index).
- **Safety: a matched allow/deny rule that uses a deferred field (timeOfDay/expiresAt/maxPerWindow) is DOWNGRADED to prompt** — we never auto-allow on an unevaluated constraint. Test asserts this.
- Glob anchored full-match; metacharacters escaped (no regex injection from a rule string).
- Zero files outside `packages/rc-gateway/`; license headers; exports added.
