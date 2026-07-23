# AGENTS.md

This file provides guidance to Qwen Code when working with code in this
repository.

## Working Principles

### Simplicity First

**Minimum code that solves the problem. Nothing speculative.**
**(This is the principle we care about most.)**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes,
simplify.

_Adapted from Andrej Karpathy's [CLAUDE.md](https://github.com/multica-ai/andrej-karpathy-skills/blob/main/CLAUDE.md)._

### Core Infrastructure Is Maintainer-Only (triage gate, two-tier rule)

Core modules — `packages/core/src/**`, `packages/*/src/auth/**`,
`packages/*/src/providers/**`, `packages/*/src/models/**`,
`packages/*/src/config/**`, `packages/*/src/tools/**`,
`packages/*/src/services/**`, cross-package changes — are the architectural
backbone. External PRs touching them face a two-tier gate (maintainer-authored
PRs are exempt):

1. **Large-scope `refactor` changes (500+ production logic lines in core,
   excluding test and generated/schema files) → hard block.**
   Skip evaluation entirely — the maintainer exemption above is the sole
   exception. Large-scale core refactors must be maintainer-initiated.
   When counting lines, exclude files matching `*.test.ts`, `*.test.tsx`,
   `*.spec.ts`, `*.spec.tsx`, `__tests__/**`, `*.schema.ts`, `*.schema.json`,
   `*.generated.ts`, and `**/generated/**` — only production logic counts.
   `feat`-type and other non-`refactor` PRs are NOT hard-blocked on size; they
   escalate to the maintainer for awareness instead. A non-blocking advisory
   also applies at 1000+ production logic lines. Breadth alone is not size — a
   low-risk sweep that touches 10+
   files but changes a line or two each is escalated to a maintainer for
   awareness and otherwise judged under Tier 2's 100%-confidence bar, not
   auto-rejected on file count.
2. **Small-scope changes → gate may evaluate, but must be 100% confident.**
   Any doubt at all → escalate to maintainer. "The direction looks correct"
   is not confidence. The gate must name every downstream consumer; if it
   cannot, escalate.

**When in doubt, escalate. Better to wrongly escalate than to wrongly
approve.**

## Common Commands

### Building

```bash
npm install        # Install all dependencies
npm run build      # Build all packages (TypeScript compilation + asset copying)
npm run build:all  # Build everything including sandbox container
npm run bundle     # Bundle dist/ into a single dist/cli.js via esbuild
                   # (requires build first)
```

`npm run build` compiles TS into each package's `dist/`. `npm run bundle`
takes that output and produces a single `dist/cli.js` via esbuild. Bundle
requires build to have run first.

### Development

```bash
npm run dev        # Run CLI directly from TypeScript source (no build needed)
```

Runs the CLI via `tsx` with `DEV=true`. Changes to `packages/core` or
`packages/cli` are reflected immediately without rebuilding.

### Unit Testing

Tests must be run from within the specific package directory, not the project
root.

**Run individual test files** (always preferred):

```bash
cd packages/core && npx vitest run src/path/to/file.test.ts
cd packages/cli && npx vitest run src/path/to/file.test.ts
```

**Update snapshots:**

```bash
cd packages/cli && npx vitest run src/path/to/file.test.ts --update
```

**Avoid:**

- `npm run test -- --filter=...` — does NOT filter; runs the entire suite
- `npx vitest` from the project root — fails due to package-specific vitest
  configs
- Running the whole test suite unless necessary (e.g., final PR verification)

**Test gotchas:**

- In CLI tests, use `vi.hoisted()` for mocks consumed by `vi.mock()` — the
  mock factory runs at module load time, before test execution.

### Integration Testing

Build the bundle first: `npm run build && npm run bundle`

Run from the project root using the dedicated npm scripts:

```bash
npm run test:integration:cli:sandbox:none
npm run test:integration:interactive:sandbox:none
```

Or combined in one command:

```bash
cd integration-tests && \
  cross-env QWEN_SANDBOX=false npx vitest run cli interactive
```

**Gotcha:** In interactive tests, always call `session.idle()` between sends —
ANSI output streams asynchronously.

### Linting & Formatting

```bash
npm run lint       # ESLint check
npm run lint:fix   # Auto-fix lint issues
npm run format     # Prettier formatting
npm run typecheck  # TypeScript type checking
npm run preflight  # Full check: clean → install → format → lint → build
                   # → typecheck → test
```

## Code Conventions

- **Module system**: ESM throughout (`"type": "module"` in all packages)
- **TypeScript**: Strict mode with `noImplicitAny`, `strictNullChecks`,
  `noUnusedLocals`, `verbatimModuleSyntax`
- **Formatting**: Prettier — single quotes, semicolons, trailing commas,
  2-space indent, 80-char width
- **Linting**: No `any` types, consistent type imports, no relative imports
  between packages
- **Tests**: Collocated with source (`file.test.ts` next to `file.ts`),
  vitest framework
- **File naming**: `PascalCase.tsx` for React components, `kebab-case.ts` for
  `.ts` files in `packages/core` and `packages/cli` (enforced by ESLint). Existing camelCase files are allowlisted in `eslint.legacy-filenames.mjs`; rename opportunistically when touching them, updating all imports in the same commit (note: renames lose `git blame` history).
- **Comments**: Default to none. Add only when _why_ is non-obvious; don't delete existing ones as cleanup.
- **Commits**: Conventional Commits (e.g., `feat(cli): Add --json flag`)
- **Node.js**: Development and production both require `>=22` (Ink 7 + React 19.2 requirement)

### Web Shell UI development

- Prefer the shared primitives in
  `packages/web-shell/client/components/ui` when developing Web Shell UI. Do
  not duplicate an existing primitive or rewrite stable CSS Modules solely for
  consistency.
- If a required primitive is missing, run
  `npx shadcn@latest add <component>` from `packages/web-shell`, then review the
  generated diff. Do not let the CLI overwrite the existing global CSS,
  semantic tokens, CSS scoping, or portal-root integration. Keep generated
  components internal unless a public package API is explicitly required.
- Web Shell supports React 18 and React 19. Generated shadcn components often
  assume React 19 ref semantics, so wrappers that accept or receive refs —
  including Radix `asChild`, `Slot`, `Presence`, and portal children — must use
  `React.forwardRef` and pass the ref to the underlying DOM or Radix primitive.
  Add a regression test for any ref-sensitive component path.
- Use unprefixed Tailwind classes and shadcn semantic color tokens such as
  `background`, `primary`, and `muted`. The package build scopes generated CSS
  to the Web Shell root and portal root and prefixes global animations and CSS
  property registrations; changes must preserve that isolation from host-page
  styles.
- Components with portals, such as dialogs, popovers, dropdown menus, and
  tooltips, must use `useWebShellPortalRoot()` as the Radix portal container so
  themes, scoped CSS, and z-index variables continue to apply. Preserve
  existing `data-web-shell-*` attributes and public `--web-shell-*` CSS
  variables. See `packages/web-shell/README.md` for the full conventions.

## Development Guidelines

### General workflow

1. **Design doc for non-trivial work** — write one in `docs/design/` if the
   change touches multiple files or involves design decisions. Skip for small
   bugfixes.
2. **Test plan for behavioral changes** — write an E2E test plan in
   `.qwen/e2e-tests/` when the change affects user-observable behavior. Dry-run
   against the global `qwen` CLI first to confirm the baseline.
3. **Build, typecheck, and test before declaring done**:
   `npm run build && npm run typecheck`, plus unit tests for the files you
   changed.
4. **Self-audit before declaring done** — read the full diff you are about
   to ship, including new untracked files, in open-ended passes, not hunting
   for anything specific. Then verify each change, and each green test you
   rely on as evidence, presuming it wrong (a passing test can assert the
   wrong thing). Stop after two consecutive clean passes — a clean pass is
   evidence about that pass, not the code. A fix re-runs step 3, resets the
   clean-pass count, and gets a further pass over the updated diff — never
   exit on a pass that found something. If five passes bring no convergence,
   say so instead of declaring done. Scale to the diff: one clean, careful
   pass suffices for a trivial change.
5. **Code review** — run `/review` when available. Triage each comment:
   valid / false positive / overthinking. Fixes go back through steps 3-4.
   Here, `/review` means the Codex code-review workflow, not Qwen Review or
   the `qwen-review` plugin. Do not invoke Qwen Review unless the user
   explicitly requests it by name.

### Feature development

Use the `/feat-dev` skill for the full workflow: investigate, design, test plan,
dry-run, implement, verify, self-audit, code review, and iterate.

### Bugfix

Use the `/bugfix` skill for the reproduce-first workflow: reproduce, fix,
verify, test, self-audit, and code review.

## Code Review

Project-specific rules for `/review`. The skill loads this section verbatim (by
its `## Code Review` heading) and hands it to every review agent, so keep it to
things a reviewer of _this_ codebase must check — not general advice.

- **Verify a finding against the exact reviewed commit before reporting it.**
  Read the lines you are about to cite. A Critical that quotes code not present at
  the commit under review is worse than no finding — it blocks the author over
  nothing. Do not report a defect you have only inferred from a symbol name or a
  diff fragment.
- **A `C=0` / APPROVE is a claim, not a default.** Before submitting one, take
  each unresolved Critical already on the PR and check it against the code as it
  stands: _still stands_ / _fixed by this diff_ / _cannot tell_. A GitHub thread
  can read `isResolved: false, isOutdated: false` for a bug that a later commit
  fixed on an adjacent line — the flag tracks the anchored line, not the fix.
- **For every added field, option, or optional parameter, grep its read sites**,
  including outside the diff. A `foo?: boolean` that is declared and read but never
  set by any caller is a dead switch (`options.foo ?? true` always takes the
  default). Decide severity at the read site; never explain an unpopulated field
  with author intent you cannot observe.
- **Classify every added or changed daemon route by ownership.** Name whether it
  is process-global, legacy-primary, selected-runtime, live-session-owner, or
  persisted-workspace scoped, and verify every downstream consumer matches that
  scope.
- **Verify workspace-scoped routes stay inside the resolved runtime.** Check the
  environment, bridge, service, filesystem, trust boundary, and failure paths.
  Each unknown, untrusted, ambiguous, bootstrapping, draining, or removed state
  must follow its declared failure semantics and must never fall back to the
  primary runtime.
- **Match the house style when judging.** ESM only; no `any`; no relative imports
  between packages; `kebab-case.ts` for `.ts` in `packages/core` and `packages/cli`,
  `PascalCase.tsx` for React components; tests collocated as `file.test.ts`.
  Comments default to none — flag a _missing_ comment only where the _why_ is
  genuinely non-obvious, and never fault a diff for deleting a comment that no
  longer applies.
- **A missing test for changed behavior is a Suggestion, not a Critical**, unless
  the untested path is itself the defect.

## GitHub Operations

Use the `gh` CLI for all GitHub-related operations — issues, pull requests,
comments, CI checks, releases, and API calls. Prefer `gh issue view`,
`gh pr view`, `gh pr checks`, `gh run view`, `gh api`, etc. over web fetches
or manual REST calls.

## Testing, Debugging, and Bug Fixes

- **Bug reproduction & verification**: spawn the `test-engineer` agent. It
  reads code and docs to understand the bug, then reproduces it via E2E testing
  (or a test-script fallback). It also handles post-fix verification. It cannot
  edit source code — only observe and report.
- **Hard bugs**: use the `structured-debugging` skill when debugging requires
  more than a quick glance — especially when the first attempt at a fix didn't
  work or the behavior seems impossible.
- **E2E testing**: the `e2e-testing` skill covers headless mode, interactive
  (tmux) mode, MCP server testing, and API traffic inspection. The
  `test-engineer` agent invokes this skill internally — you typically don't
  need to use it directly.

## Submitting PRs

When creating a PR, follow the template at `.github/pull_request_template.md`.
After the PR is submitted, post a separate comment with the E2E test report if
applicable.

- **PR description**: explain the motivation and changes in prose. Avoid
  referencing file names or function names.
- **Reviewer Test Plan** (template section): describe behaviors a reviewer
  should verify and what to expect, not scripted test commands. Use **How to
  verify** for reproduction steps; Before/After for TUI evidence when
  applicable.
- **Line wrapping**: do not hard-wrap the PR body at a fixed column width.
  GitHub renders single newlines as `<br>`, so a wrapped description displays
  as a narrow column. Write each paragraph or list item as one long line.
- **Don't let review rounds balloon the PR.** Every accepted change widens the
  diff and tends to trigger another round, so a PR can drift far past its
  original intent. Once a PR has been through roughly **5 review rounds**, land
  only Critical fixes — correctness, security, data loss, regressions — and
  defer remaining Suggestions to a follow-up issue or PR. Record each deferral
  in the PR thread so nothing is silently dropped.

## Project Directories

Design docs and implementation plans are committed under `docs/` so they are
tracked in version control:

| Directory      | Purpose                          |
| -------------- | -------------------------------- |
| `docs/design/` | Design docs for planned features |
| `docs/plans/`  | Implementation plans             |

Other working artifacts live under `.qwen/` (git-ignored):

| Directory               | Purpose                              |
| ----------------------- | ------------------------------------ |
| `.qwen/e2e-tests/`      | E2E test plans and results           |
| `.qwen/issues/`         | Issue drafts before filing on GitHub |
| `.qwen/pr-drafts/`      | PR drafts before submitting          |
| `.qwen/pr-reviews/`     | PR review notes                      |
| `.qwen/investigations/` | Structured debugging journals        |
| `.qwen/scripts/`        | Utility scripts                      |
