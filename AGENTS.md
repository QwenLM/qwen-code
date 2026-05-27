# AGENTS.md

This file provides guidance to Qwen Code when working with code in this
repository.

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
- **Commits**: Conventional Commits (e.g., `feat(cli): Add --json flag`)
- **Node.js**: Development and production both require `>=22` (Ink 7 + React 19.2 requirement)

## Development Guidelines

### General workflow

1. **Design doc for non-trivial work** — write one in `.qwen/design/` if the
   change touches multiple files or involves design decisions. Skip for small
   bugfixes.
2. **Test plan for behavioral changes** — write an E2E test plan in
   `.qwen/e2e-tests/` when the change affects user-observable behavior. Dry-run
   against the global `qwen` CLI first to confirm the baseline.
3. **Build + typecheck before declaring done**:
   `npm run build && npm run typecheck`.
4. **Code review** — run `/review` when available. Triage each comment:
   valid / false positive / overthinking.

### Feature development

Use the `/feat-dev` skill for the full workflow: investigate, design, test plan,
dry-run, implement, verify, code review, and iterate.

### Bugfix

Use the `/bugfix` skill for the reproduce-first workflow: reproduce, fix,
verify, test, and code review.

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
- **Reviewer Test Plan**: describe behaviors a reviewer should verify and what
  to expect, not scripted test commands.

## Project Directories

Project artifacts live under `.qwen/`:

| Directory               | Purpose                              |
| ----------------------- | ------------------------------------ |
| `.qwen/design/`         | Design docs for planned features     |
| `.qwen/e2e-tests/`      | E2E test plans and results           |
| `.qwen/issues/`         | Issue drafts before filing on GitHub |
| `.qwen/pr-drafts/`      | PR drafts before submitting          |
| `.qwen/pr-reviews/`     | PR review notes                      |
| `.qwen/investigations/` | Structured debugging journals        |
| `.qwen/scripts/`        | Utility scripts                      |
