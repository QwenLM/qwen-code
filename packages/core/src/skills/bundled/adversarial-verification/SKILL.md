---
name: adversarial-verification
description: Use when you need to verify code changes by actively trying to break them - not just confirming they work, but probing for failures through boundary testing, concurrency, and edge cases
agentOnly: true
---

# Adversarial Verification

## Purpose

Your job is NOT to confirm the implementation works. Your job is to try to break it.

## Two Failure Modes That Will Get You

1. **Check-skipping:** Finding reasons not to actually run checks. Reading source and deciding it "looks correct." Writing PASS with no supporting command output. This is not verification — it is storytelling.

2. **Getting lulled by the obvious 80%:** Seeing a polished UI or green test suite and feeling inclined to pass. Meanwhile half the buttons do nothing, state vanishes on refresh, backend crashes on malformed input.

## Rationalization Traps

If you catch yourself thinking any of these, stop and course-correct:

- "The code looks correct based on my reading" — Inspection alone does not constitute proof. Execute it.
- "The implementer's tests already pass" — Tests may rely on mocks, contain circular assertions, or cover only the happy path. Verify independently.
- "This is probably fine" — "Probably" is not "verified." Run the check.
- "Let me start the server and check the code" — No. Start the server and HIT THE ENDPOINTS.
- "This would take too long" — That is not your decision to make.

## Universal Required Steps

Regardless of what changed:

1. Read the project's PROTO.md, README, or equivalent to discover build and test commands.
2. Run the build. Broken build = automatic FAIL.
3. Run the full test suite. Any failing test = automatic FAIL.
4. Run linters and type-checkers if the project has them configured.
5. Check for regressions in areas adjacent to the change.

## Adversarial Probes

Run at least one of these before issuing ANY pass:

- **Concurrency:** Fire parallel requests at the same resource. Do duplicate records appear? Does data corrupt?
- **Boundary values:** Feed 0, -1, empty string, extremely long strings, unicode characters, MAX_INT.
- **Idempotency:** Submit the same request twice. Does the system handle it gracefully?
- **Orphan operations:** Attempt to delete a nonexistent resource, or reference an ID that was never created.

## Verification Strategies by Change Type

- **Frontend/UI:** Start dev server. Navigate pages, click elements, fill forms. Curl subresources (JS bundles, CSS, images) to confirm they load.
- **Backend/API:** Start server. Curl each relevant endpoint. Check response status codes, headers, body shapes. Send bad input to test error handling.
- **CLI/script:** Execute with representative arguments. Check stdout, stderr, exit codes. Feed edge-case inputs.
- **Infrastructure/config:** Validate syntax. Perform dry-run commands where available (terraform plan, docker build --check, nginx -t).
- **Bug fixes:** Reproduce the original bug FIRST. Confirm the fix resolves it. Run regression tests. Check for side effects.
- **Refactoring:** Existing test suite MUST pass without modification. Diff public API surface to confirm nothing changed unintentionally.

## Output Format

Every verification step must follow this exact format:

```
### Check: [what you are verifying]
**Command:** `[exact command executed]`
**Output:** [actual terminal output, copy-pasted verbatim]
**Result: PASS** (or **FAIL** with Expected vs Actual)
```

Bad example (REJECTED):

```
### Check: API returns correct data
**Command:** (reviewed the handler source code)
**Output:** The logic appears correct
**Result: PASS**
```

This contains no executed command and no real output. It proves nothing.

Good example (ACCEPTABLE):

```
### Check: API returns correct data
**Command:** `curl -s http://localhost:3000/api/users/1 | jq .`
**Output:** {"id": 1, "name": "Alice", "email": "alice@example.com"}
**Result: PASS** - response contains expected fields with valid values
```

## Final Verdict

End every verification report with exactly one of:

```
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL
```

Use PARTIAL only when environmental limitations genuinely prevented certain checks. Uncertainty = FAIL, not PARTIAL.
