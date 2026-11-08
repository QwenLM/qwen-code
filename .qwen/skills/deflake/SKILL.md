---
name: deflake
description: Stabilize a flaky test with a minimal, assertion-preserving fix — never by weakening or deleting the check.
---

# Deflake a flaky test

A `deflake:` issue names ONE test that has been observed failing and then
passing on a rerun of the same commit — the definitive flaky signature. Your
job is to make that test deterministic **without changing what it verifies**.

The issue body carries the test identity (file + name) and the observed failure
signature (e.g. `Test timed out in 5000ms`, `Timed out waiting for …`, an
order-dependent assertion, a wall-clock/random-dependent value). Read the test,
reproduce the mechanism in your head, and apply the SMALLEST fix from the
allowed set below that removes the nondeterminism.

## The only allowed fixes

1. **Raise a timeout / poll budget.** A test that blows vitest's default under
   CI contention (fully-mocked or I/O-bound, not a perf test) gets a generous
   per-test `testTimeout` (3rd arg to `it`), or its internal poll loop is given
   a real wall-clock budget instead of a fixed iteration count (a fixed count of
   `setImmediate` turns elapses in milliseconds and races real I/O).
2. **Stabilize timing / waiting.** Replace a bare `setTimeout`/fixed `sleep`
   with an explicit `await` of the real condition (`vi.waitFor`, a resolved
   promise, an event). Pre-warm a lazy load (e.g. a WASM runtime) in
   `beforeAll` so per-test time doesn't include first-load cost.
3. **Make randomness / time deterministic.** Seed the RNG, `vi.useFakeTimers()`
   / mock `Date.now`, or pin the input so a value that depends on the real clock
   or `Math.random` can't drift.
4. **Isolate / serialize interference.** Give tests that collide on a shared
   resource (a same-named tempdir, a fixed port, a global singleton) unique
   per-test resources, or serialize them.

## Hard rules

- **Never** delete the test, `skip`/`todo` it, loosen an assertion, widen an
  expected range, add a blanket `try/catch`, or add a retry wrapper around the
  assertion. Those hide the flake instead of fixing it — and could hide a real
  bug. If none of the four fixes applies, or the failure looks like a REAL
  intermittent product bug (not test nondeterminism), write
  `<workdir>/failure.md` explaining what you found and stop. A human deflakes it.
- Keep the diff minimal and local to the named test (and its file's helpers).
  Do not refactor unrelated code.
- Preserve every assertion and every input exactly. A timeout bump changes only
  the ceiling; a determinism fix changes only the source of nondeterminism.
- Prefer a per-test or per-file change over a global config change unless the
  same class demonstrably spans the whole package (then a `testTimeout` in that
  package's `vitest.config.ts` is acceptable, as it only raises the ceiling and
  weakens no assertion).

## Verify

Run the named test's file several times (`npx vitest run <file>` in the right
package, repeated) — it must pass every time. Then run the standard verify gate
(build / typecheck / lint / the changed test). If you cannot make it pass
deterministically, write `<workdir>/failure.md` and stop.

Then follow `.qwen/skills/prepare-pr/SKILL.md` for the PR body and write the
bilingual `<workdir>/e2e-report.md` (per the Shared Rules) stating: the flaky
mechanism, which of the four fixes you applied and why, and the repeated-run
evidence that it is now deterministic.
