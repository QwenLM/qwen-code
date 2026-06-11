# Cycle 48 plan — world-writable policy file warning

Fail-safe order: pure module + tests FIRST (inert), wire into runServe LAST.

## Commit 1 (docs)

- spec + this plan.

## Commit 2 — pure module (inert)

- New `src/policy/permissions.ts`:
  - `interface InsecurePolicyFile { path: string; mode: number }`
  - `const NON_OWNER_WRITE_MASK = 0o022`
  - `async checkPolicyFilePermissions(paths: string[], statFn?): Promise<InsecurePolicyFile[]>`
    — stat each; ENOENT/error skipped; `(mode & MASK) !== 0` -> push
    `{ path, mode: mode & 0o7777 }`. Injected `statFn` defaults to `fs.stat`.
  - `formatInsecurePolicyWarning(f): string` — the operator-facing message
    (path + octal mode + `chmod go-w` hint).
- New `src/policy/permissions.test.ts`: world-writable -> flagged; group-writable
  -> flagged; 0600 -> not flagged; ENOENT -> skipped (no throw); stat throws
  EACCES -> skipped; multiple paths mixed; format string contains path + octal.

## Commit 3 — wire into runServe (boot diagnostic)

- `src/cli.ts` runServe: after the user + workspace policy paths are known, call
  `checkPolicyFilePermissions([userPolicyPath, workspacePolicyPath?])` and
  `console.warn(formatInsecurePolicyWarning(f))` for each. Guarded so a check
  failure never blocks boot (the function already never throws).
- Smoke-test: a throwaway script against `dist/` that chmods a temp policy file
  0666 and asserts the pure function flags it (the function is the tested unit;
  runServe glue is type-checked + manually smoke-verified).

## Verify

- typecheck / lint / build / test (expect +~7 vitest)
- e2e unchanged (boot-only path, not in createGatewayApp; e2e stays 41/41)
- build the CLI + run the pure function via a throwaway script on a chmod 0666
  temp file to confirm the wiring shape.
- opus review on `git diff <base>..HEAD -- packages/rc-gateway/`.
