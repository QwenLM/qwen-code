# Architecture invariant classification

Issue #9152 asks for a policy decision: which architectural invariants in this
repository are enforced mechanically, which are left to review, and which are
not worth enforcing — written down where a new invariant will encounter it.

This document is that record. It is the canonical answer to "should this
invariant have a guard?" for every invariant asserted in AGENTS.md or an open
architecture issue.

## Classification scheme

| Category                  | Meaning                                                                                               | Failure mode if unguarded                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Mechanically enforced** | A guard fails the build, lint, or test suite. No human judgment needed.                               | Drift reintroduced silently by a merged PR.                                |
| **Review-only**           | Requires judgment no lint rule can approximate. Enforced by the two-tier gate and reviewer checklist. | Missed in review; no mechanical backstop.                                  |
| **Not worth enforcing**   | The cost of a guard exceeds the cost of occasional violations.                                        | Acceptable — the invariant is a preference, not a load-bearing constraint. |

A guard is **gap** if the invariant is classified as mechanically enforced but
no guard exists yet, or the existing guard is partial.

---

## AGENTS.md conventions

### 1. ESM throughout (`"type": "module"`)

**Mechanically enforced.** `package.json` declares `"type": "module"` in every
package. Node and the TypeScript compiler reject `require()` at runtime and
`import =` syntax at compile time under ESM mode. No separate guard needed.

### 2. TypeScript strict mode

**Mechanically enforced.** `tsconfig.json` sets `"strict": true`,
`"noImplicitAny": true`, `"strictNullChecks": true`, `"noUnusedLocals": true`,
`"verbatimModuleSyntax": true`. `npm run typecheck` fails on any violation.

### 3. Prettier formatting

**Mechanically enforced.** `lint-staged` runs Prettier via the `pre-commit`
hook (`scripts/pre-commit.js`). CI checks formatting with
`node scripts/lint.js --prettier` (the `Run Prettier` step in
`.github/workflows/ci.yml`); `npm run format` is the local write-mode command,
not the CI check.

### 4. No `any` types

**Mechanically enforced.** `@typescript-eslint/no-explicit-any` is configured
as an error in `eslint.config.js`.

### 5. Consistent type imports

**Mechanically enforced.** `@typescript-eslint/consistent-type-imports` in
`eslint.config.js`.

### 6. No relative imports between packages

**Mechanically enforced.** Two guards:

- `eslint-rules/no-relative-cross-package-imports.js` (custom ESLint rule)
- `import/no-relative-packages` (built-in)

### 7. Tests collocated with source (`file.test.ts` next to `file.ts`)

**Review-only.** The collocation convention cannot be mechanically enforced
without false positives — a test file may legitimately live in a shared
`__tests__/` directory for cross-cutting integration tests, and AGENTS.md
itself allowlists this. A lint rule would either miss violations or flag
legitimate exceptions. The reviewer checklist covers this.

### 8. File naming: `PascalCase.tsx` for React components, `kebab-case.ts` for `.ts` in `packages/core` and `packages/cli`

**Mechanically enforced.** `check-file/filename-naming-convention` in
`eslint.config.js` enforces `KEBAB_CASE` for `*.ts`. Legacy camelCase files
are allowlisted in `eslint.legacy-filenames.mjs`, which `eslint.config.js`
imports. `PascalCase.tsx` is the existing
convention but is not separately enforced — a `.tsx` file in kebab-case would
pass the rule. **Gap:** add `PASCAL_CASE` for `*.tsx` or accept the convention
as socially enforced. Low priority — React tooling and imports naturally
converge on PascalCase for components.

### 9. Comments: default to none

**Review-only.** The absence of comments is a style preference, not a
structural invariant. A lint rule cannot distinguish a necessary "why" comment
from noise. The reviewer checklist in AGENTS.md covers this.

### 10. Conventional Commits

**Not worth enforcing.** There is no `commitlint` config or `commit-msg` hook.
The convention is socially enforced through PR titles and squash-merge. A
commit-msg hook would block worktree commits and CI automation without
meaningfully improving the commit history (squash-merge rewrites messages
anyway). The cost exceeds the benefit.

### 11. Node.js `>=22`

**Mechanically enforced — partial.** `package.json` declares
`"engines": { "node": ">=22.0.0" }`, but without `engine-strict` npm only
_warns_ on a version mismatch — nothing fails. CI selecting Node 22 means
shipped artifacts are built and tested on a supported runtime, but an
unsupported local runtime is not rejected. **Gap:** making this mechanical
requires either `engine-strict=true` in `.npmrc` or a check that actually
fails (e.g. a preinstall runtime assertion).

### 12. Core modules are maintainer-only (two-tier gate)

**Review-only.** The two-tier gate in AGENTS.md is a policy, not a lint rule.
It requires judgment about scope, confidence, and downstream consumers —
exactly the kind of decision that cannot be approximated mechanically. The
gate is enforced through the triage skill and reviewer judgment.

### 13. Daemon routes classified by ownership scope

**Review-only.** AGENTS.md's Code Review section requires the reviewer to
classify every added or changed daemon route — process-global,
legacy-primary, selected-runtime, live-session-owner, or persisted-workspace
— and to verify every downstream consumer matches that scope. Deciding which
runtime a route serves is judgment no lint rule can approximate. The Code
Review section is loaded verbatim into every `/review` agent, so the
checklist carries this.

### 14. Workspace-scoped routes must not fall back to the primary runtime

**Review-only.** AGENTS.md's Code Review section requires verifying that a
workspace-scoped route stays inside the resolved runtime — environment,
bridge, service, filesystem, trust boundary, and failure paths — and that
unknown, untrusted, ambiguous, bootstrapping, draining, or removed states
follow their declared failure semantics instead of falling back to the
primary runtime. Whether a failure path honors those semantics is a judgment
call; the reviewer checklist covers this.

### 15. Web Shell UI conventions

**Review-only.** Every requirement in AGENTS.md's Web Shell UI development
section falls in this category. The section covers: preferring the shared
primitives in `packages/web-shell/client/components/ui` over duplicating
them, and the shadcn workflow when a primitive is missing — run
`npx shadcn@latest add` from `packages/web-shell`, review the generated
diff, do not let the CLI overwrite the global CSS, semantic tokens, CSS
scoping, or portal-root integration, and keep generated components internal
unless a public package API is explicitly required; React 18/19
compatibility — ref-accepting wrappers (including Radix `asChild`, `Slot`,
`Presence`, and portal children) must use `React.forwardRef`, and any
ref-sensitive component path gets a regression test; styling through
unprefixed Tailwind classes and shadcn semantic color tokens, with the
package build scoping generated CSS to the Web Shell root and portal root
so changes preserve isolation from host-page styles; and portal components
(dialogs, popovers, dropdowns, tooltips) using `useWebShellPortalRoot()` as
the Radix portal container while preserving existing `data-web-shell-*`
attributes and public `--web-shell-*` CSS variables. None of these has a
mechanical guard — no lint rule or test detects a duplicated primitive, a
missing `forwardRef`, an overwritten scoping integration, a broken CSS
scope, or a raw portal container — so they are enforced by reviewer
judgment against the AGENTS.md section and
`packages/web-shell/README.md`, which carries the full conventions.
Violations surface at integration time (host styles leak in, refs break
under React 18), past the point any lint could see.

---

## Architecture issues

### #8084: acp-integration must not import serve/ internals

**Mechanically enforced — gap.** PR #9144 is still **open** and contains:

- A `no-restricted-imports` entry blocking `**/serve/*` and `**/serve/**` from
  `packages/cli/src/acp-integration/**`
- A `scripts/tests/acp-serve-boundary-guard.test.js` source-level boundary test

Until #9144 merges, the invariant is **unguarded on `main`**. The existing
`no-restricted-imports` for `utils/ → serve/` (from merged #9147) covers one
direction but not the acp-integration direction. **Action: merge #9144.**

### #9145: approval-mode value domain must agree across SDKs

**Mechanically enforced — partial.** `packages/sdk-typescript/test/unit/approval-mode-drift.test.ts`
asserts that `DAEMON_APPROVAL_MODES` (SDK) mirrors `APPROVAL_MODES` (core)
exactly, including order. This covers the SDK ↔ core drift.

**Gap:** the issue identifies drift in the Python and Java SDKs, which PR
#9003 (in progress) addresses. The remaining item worth naming is desktop's
`cyclablePermissionModes` — an intentionally different domain
(allow-all/safe/ask/auto-edit). The drift test does not cover desktop — it
asserts `DAEMON_APPROVAL_MODES` is sequence-equal to core's
`APPROVAL_MODES` and never mentions desktop or `cyclablePermissionModes` —
nor should it: there is no shared contract with the core domain to
drift-check. **No further guard needed for desktop.** The Python/Java gap
closes when #9003 merges.

### #9146: utils/ must be a leaf layer

**Mechanically enforced — partial.** Merged PR #9147 added a
`no-restricted-imports` entry blocking `packages/cli/src/utils/**` from
importing `**/serve/*` and `**/serve/**`. This covers the `serve/` direction
only. The issue identifies 7 upward-importing directories in CLI (`config`,
`ui`, `i18n`, `nonInteractive`, `serve`, `commands`, root) and 10 in core
(`config`, `tools`, `services`, `core`, `agents`, `telemetry`, `memory`,
`hooks`, `models`, root barrel).

**Gap:** the remaining directories are not yet blocked. This is intentional
— the issue's own plan describes steps 5-7 as needing decisions or being
large enough to warrant separate PRs. The guard should be extended directory
by directory as each move lands. **No new guard until the moves are done.**
Prematurely blocking imports into `config/` or `ui/` would break the build
before the code is moved.

### #9151: cross-package constants and contracts must agree

**Mechanically enforced.** Issue is **closed**. Merged PR #9497 added:

- `scripts/tests/cross-package-contracts.test.js` — a table-driven source test
  that pins the single owner file and import path for `LIVE_TASK_TOOL_NAMES`,
  `LiveTaskToolName`, and `MAX_SUB_SESSION_PROMPT_CHARS`.
- `docs/design/9151-cross-package-contracts.md` — ownership decisions.

This is the reusable drift-guard pattern (see below).

### #9152: the excluded desktop workspace stays excluded

**Mechanically enforced.** Issue #9152's inventory of existing mechanical
guards names `scripts/check-desktop-isolation.js` alongside the three guards
above. The script — run in CI as `npm run check:desktop-isolation` (the
`Check desktop workspace isolation` step in `.github/workflows/ci.yml`) —
fails if `packages/desktop` or `packages/desktop-shell` re-enters the root
npm workspace set, if `package-lock.json` gains desktop entries, or if
desktop-only dependencies (`electron`, `electron-builder`, `@sentry/cli`,
`@sentry/electron`, `@sentry/vite-plugin`) are installed in root
`node_modules`. **No gap.**

---

## #4063 structural problems

The 14 structural problems in #4063 are a problem register, not a set of
invariants. Most describe "this module is too large" or "this type is
over-coupled" — they are refactoring targets, not ongoing constraints to
guard. Two exceptions:

### #4063 item 5: Barrel export self-references (core modules import from `'../index.js'`)

**Mechanically enforced — gap (in open PRs, not on main).** An
`eslint-rules/no-core-root-barrel-import.js` rule exists in two open PRs —
#8139 (branch `lane3-core-root-barrel`) and #9635 (branch
`codex/pr-9152-root-barrel-cleanup`) — but has **not merged to `main`**. The
rule blocks `packages/core/src/**` from importing the root barrel
`../index.js`. **Action: merge one of the PRs carrying the rule, or record
why it was deferred.**

### #4063 item 2: Config god-object

**Review-only.** The two-tier gate in AGENTS.md already covers this — core
infrastructure changes require maintainer awareness. A line-count guard was
considered and rejected (the issue itself argues against it; #4063's
commentary and the Qwen Code review of #9152 both reject line-count lint).
Size is a symptom; the invariant is "don't add new responsibilities to
Config," which is a judgment call.

The remaining #4063 items (AppContainer size, useGeminiStream size, naming
like `core/coreToolScheduler.ts`, non-interactive code scattered across 4
locations) are refactoring targets, not invariants. They are tracked in
#4063 itself.

---

## Drift-guard mechanism

Issue #9152 asks whether a reusable drift-guard mechanism should be extracted
from `check-voice-guard-sync.js`, or whether #9145 and #9151 demonstrate that
they do not need one.

**Decision: do not extract a reusable mechanism.** The two drift guards that
now exist — `cross-package-contracts.test.js` and
`approval-mode-drift.test.ts` — are 114 and 44 lines of table-driven test
code respectively, purpose-built for their contracts. They share a
_pattern_ (assert single owner, assert import path, assert value equality)
but not enough structure to justify a shared abstraction:

1. **The contracts differ in shape.** Cross-package constants use source-grep
   (symbol → file). Approval-mode uses runtime value equality (import both
   lists, compare). Voice-guard uses TypeScript AST parsing (block/function
   extraction). A shared framework would need to support all three extraction
   strategies, which is more complexity than the three independent tests.

2. **Each guard is stable.** Once a contract is pinned, the test rarely
   changes. The maintenance cost of three independent 50-line tests is lower
   than one 200-line framework plus three 30-line config files.

3. **New drift guards are rare.** The issue itself notes that #9145 and #9151
   are the only cross-package drift cases found. A framework for two future
   users is speculative abstraction — exactly what AGENTS.md's Simplicity
   First principle prohibits.

The _pattern_ is documented here. When a new cross-package drift case arises,
copy the `cross-package-contracts.test.js` structure: declare a `definitions`
array mapping symbol → owner file, assert single owner via `git grep`, assert
import paths. If a third case needs runtime value comparison, copy
`approval-mode-drift.test.ts`. Extract a shared utility only if a fourth case
demonstrates that the copy-paste cost exceeds the abstraction cost.

`check-voice-guard-sync.js` remains as-is. Its AST-based mirror-set
extraction is specific to the voice-code CLI ↔ desktop mirroring problem and
does not generalize to contract drift. It is also slated for deletion with
the Electron tree in PR #9085 (still open), as #9152 notes; when #9085 lands
the guard goes with it, and the pattern survives only in the two tests above.

---

## Summary table

| Invariant                                          | Source                  | Classification       | Guard                                                                  | Status                                 |
| -------------------------------------------------- | ----------------------- | -------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| ESM only                                           | AGENTS.md               | Mechanical           | `package.json` `"type": "module"`                                      | ✅                                     |
| TS strict mode                                     | AGENTS.md               | Mechanical           | `tsconfig.json`                                                        | ✅                                     |
| Prettier formatting                                | AGENTS.md               | Mechanical           | `lint-staged` / pre-commit                                             | ✅                                     |
| No `any` types                                     | AGENTS.md               | Mechanical           | `@typescript-eslint/no-explicit-any`                                   | ✅                                     |
| Consistent type imports                            | AGENTS.md               | Mechanical           | `@typescript-eslint/consistent-type-imports`                           | ✅                                     |
| No relative cross-package imports                  | AGENTS.md               | Mechanical           | `no-relative-cross-package-imports.js` + `import/no-relative-packages` | ✅                                     |
| Tests collocated                                   | AGENTS.md               | Review-only          | —                                                                      | ✅ (by design)                         |
| kebab-case `.ts` filenames                         | AGENTS.md               | Mechanical           | `check-file/filename-naming-convention`                                | ✅                                     |
| PascalCase `.tsx` filenames                        | AGENTS.md               | Mechanical           | —                                                                      | ⚠️ Gap (low priority)                  |
| No comments by default                             | AGENTS.md               | Review-only          | —                                                                      | ✅ (by design)                         |
| Conventional Commits                               | AGENTS.md               | Not worth enforcing  | —                                                                      | ✅ (by design)                         |
| Node ≥22                                           | AGENTS.md               | Mechanical (partial) | `package.json` `"engines"` (warn-only without `engine-strict`)         | ⚠️ Gap (local runtime not rejected)    |
| Core modules maintainer-only                       | AGENTS.md               | Review-only          | Two-tier gate                                                          | ✅ (by design)                         |
| Daemon routes classified by ownership              | AGENTS.md (Code Review) | Review-only          | Reviewer checklist                                                     | ✅ (by design)                         |
| Workspace-scoped routes never fall back to primary | AGENTS.md (Code Review) | Review-only          | Reviewer checklist                                                     | ✅ (by design)                         |
| Web Shell UI conventions                           | AGENTS.md               | Review-only          | —                                                                      | ✅ (by design)                         |
| acp-integration off serve/                         | #8084                   | Mechanical           | `no-restricted-imports` + boundary test                                | ❌ PR #9144 open                       |
| Approval-mode SDK ↔ core drift                    | #9145                   | Mechanical           | `approval-mode-drift.test.ts`                                          | ⚠️ Partial (Python/Java in #9003)      |
| utils/ is a leaf layer                             | #9146                   | Mechanical (partial) | `no-restricted-imports` (serve/ only)                                  | ⚠️ Intentionally incremental           |
| Cross-package constants agree                      | #9151                   | Mechanical           | `cross-package-contracts.test.js`                                      | ✅ Closed                              |
| Desktop workspace stays excluded                   | #9152 inventory         | Mechanical           | `scripts/check-desktop-isolation.js` (CI)                              | ✅                                     |
| No core root barrel self-import                    | #4063                   | Mechanical           | `no-core-root-barrel-import.js`                                        | ❌ In open PRs #8139/#9635, not merged |
| Config god-object                                  | #4063                   | Review-only          | Two-tier gate                                                          | ✅ (by design)                         |

## Open actions

1. **Merge PR #9144** — closes the #8084 guard gap (acp-integration → serve/).
2. **Merge `no-core-root-barrel-import.js`** by landing one of the open PRs
   that carry it (#8139 or #9635), or record why it was deferred — closes the
   #4063 item 5 guard gap.
3. **Track #9003** — when it merges, the #9145 Python/Java drift gap closes.
4. **Extend `utils/` leaf guard** directory by directory as #9146 steps 5-7
   land — no premature blocking.
5. **No drift-guard framework** — the pattern is documented here; copy it
   when a new case arises.
