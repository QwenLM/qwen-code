# Task 2 Report: Normalize malformed selectors and rejection logs

## Status

Implemented and committed as `1c5e49adf` (`fix(cli): harden qualified ACP request errors`).

## Changes

- Added a production-shaped Express regression test for malformed parameter decoding.
- Mapped only `URIError` instances carrying `status: 400` or `statusCode: 400` to a structured `400` response:
  `{ "error": "Malformed URL encoding", "code": "invalid_request" }`.
- Added a WebSocket rejection-log regression test using a decoded newline in an unknown workspace selector.
- Sanitized the decoded workspace selector with the existing `logSafe()` helper before interpolation into the rejection log.

## Files

- `packages/cli/src/serve/server/error-handlers.ts`
- `packages/cli/src/serve/server/error-handlers.test.ts`
- `packages/cli/src/serve/acp-http/index.ts`
- `packages/cli/src/serve/acp-http/workspace-qualified-acp.test.ts`

## TDD Evidence

### RED

Command:

```bash
cd packages/cli && npx vitest run src/serve/server/error-handlers.test.ts src/serve/acp-http/workspace-qualified-acp.test.ts
```

Observed before production edits:

- Exit code `1`.
- `2` test files failed; `2` tests failed and `15` passed.
- The malformed route test expected `400` but received `500`.
- The WebSocket log assertion received `workspace-mismatch evil\nFORGED`, proving the decoded selector could split the log line.

### GREEN

The same command after the production edits passed:

- Exit code `0`.
- `2` test files passed.
- `17` tests passed, `0` failed.

Fresh pre-commit verification repeated the same `17/17` passing result.

## Additional Validation

- Scoped Prettier check on all four changed files: passed.
- Scoped ESLint on all four changed files: passed.
- `git diff --check`: passed.
- `cd packages/cli && npm run typecheck`: passed.
- `npm run build -- --cli-only`: completed after rebuilding dependencies and the CLI.
- Commit hook reran Prettier and ESLint with zero failures.

The first package-local `cd packages/cli && npm run build` attempt failed with pre-existing generated `packages/core/dist/*.d.ts` files being both TypeScript inputs and outputs (`TS5055`). The repository build entry point rebuilds dependencies in order and avoided that stale-output condition.

## Self-review

Two broad audits covered error-path ordering, compatibility, boundary cases, test behavior, maintainability, scope, and generated/unrelated changes.

- The new mapping is deliberately narrow: a plain `URIError` without Express/router 400 metadata still follows the generic 500 path.
- JSON body-parser errors retain priority and existing behavior.
- The generic error handler remains unchanged after the new narrow branch.
- The selector sanitizer is the existing transport-wide control-character sanitizer; no new abstraction was introduced.
- Only the four requested source/test files were staged and committed.

No actionable concerns remain. The only validation note is the transient package-local build failure described above; the repository CLI-only build path completed successfully.

## Review fix

- Files: `packages/cli/src/serve/server/error-handlers.test.ts` and this report.
- Tests: added regression coverage proving an unmarked `URIError` remains on the generic `500` `{ error: 'Internal server error' }` path; focused test, scoped formatting, and scoped lint passed.
- Commit: `test(cli): cover unmarked URIError fallback`.
