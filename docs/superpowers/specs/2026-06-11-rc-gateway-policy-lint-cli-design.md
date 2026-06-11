# rc-gateway — `qwen-rc policy lint <file>` CLI (cycle 40)

## Context

`add-policy-engine` spec (`specs/policy-engine/spec.md:203-211`) requires operator
commands, including:

> `qwen rc policy lint <file>` — schema validation without daemon reload.

Cycle 13/14 shipped the policy loader/evaluator/enforcer and cycles 22/38/39
extended evaluation, layering, and audit. But there is no operator-facing way to
validate a `policy.yaml` BEFORE deploying it — a typo (bad action, non-mapping
match) currently surfaces only at gateway boot (where a malformed user file
crashes boot, cycle 14). `lint` gives a fast, daemon-free pre-flight check.

(Selected over a net-new per-rule provenance audit field — that was gold-plating
beyond the spec; `lint` is an explicit, unbuilt backlog requirement.)

## Deviation from the daemon-centric spec

The spec frames it as `qwen rc policy lint`; our binary is `qwen-rc`, so it is
`qwen-rc policy lint <file>`. Pure gateway-side; no daemon, no upstream edit.

## Decisions

- **D1 — Pure `lintPolicyFile(path) → PolicyLintResult`** in `policy/loader.ts`
  (alongside the load functions). It reads the file and runs the EXISTING
  `loadPolicy` validator (so lint and boot agree exactly — no second schema
  implementation to drift). Result:
  `{ ok: true, ruleCount, deferred: string[] } | { ok: false, error: string }`.
  - A missing file (ENOENT) → `{ ok:false, error:'file not found: <path>' }`
    (NOT the loader's "absent → null/default" — for an explicit `lint <file>`,
    a missing target is a lint FAILURE, not a silent pass).
  - A `PolicyError` (bad schema) → `{ ok:false, error: <message> }`.
  - Valid → `{ ok:true, ruleCount, deferred }` where `deferred` lists the
    rule id (or `[index]`) of each rule using the still-deferred `maxPerWindow`
    field (a pure post-load scan — these rules will downgrade to prompt at
    runtime, worth surfacing). Never throws.
- **D2 — `formatPolicyLint(path, result) → string`** — a human-readable one/two
  line summary (`✓ <path>: valid (N rule(s))` + an optional deferred note, or
  `✖ <path>: <error>`). Pure; no I/O.
- **D3 — Thin argv dispatch in cli.ts** alongside `serve`: `process.argv[2] ===
'policy' && argv[3] === 'lint'` → `lintPolicyFile(argv[4])` → print
  `formatPolicyLint` → `process.exit(result.ok ? 0 : 1)`; a missing path arg →
  usage to stderr + exit 2. The bug-prone logic lives in the two PURE,
  unit-tested functions; the argv branch is trivial glue (cli.ts is never
  unit-tested, consistent with prior cycles).
- **D4 — Exit codes:** 0 valid, 1 invalid (schema/IO), 2 usage error. Standard
  for a lint tool; lets CI gate on `policy.yaml` validity.

## Safety / fail-safe

- Read-only, daemon-free, no hot path, no audit, no AuditAction change. A new
  argv branch added BEFORE nothing it can break (the `serve` path is untouched).
- `lintPolicyFile` never throws (every failure → `{ok:false}`), so the CLI
  branch can't hang/crash on a bad file.
- Fail-safe commit order: docs → `lintPolicyFile` + `formatPolicyLint` + barrel +
  unit tests (INERT — cli.ts doesn't call them yet) → cli.ts argv dispatch LAST.

## Tests

- `lintPolicyFile` (temp files): valid file → `{ok:true, ruleCount}`; malformed
  (bad action) → `{ok:false}` with the loader's error message; missing file →
  `{ok:false, error: file not found …}`; a file with a `maxPerWindow` rule →
  `deferred` lists that rule.
- `formatPolicyLint`: valid → `✓ … valid (N rule(s))`; deferred present → the
  note line; invalid → `✖ … <error>`.

## Deferred (policy CLI, unchanged)

`qwen rc policy reload` (needs a running-gateway IPC surface — none exists),
`qwen rc policy explain <tool>` (dry-run evaluator trace formatting), plus the
larger Phase 2b quotas / hot-reload / Phase 4 SSE+UI.
