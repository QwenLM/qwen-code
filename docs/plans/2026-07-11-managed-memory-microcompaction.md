# Managed Memory Microcompaction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep successful managed-memory `read_file` results available across every microcompaction trigger without changing ordinary tool-result compaction.

**Architecture:** A realpath-safe memory-path helper classifies project, user, and team memory. Microcompaction receives a pure preservation predicate, correlates response IDs to request paths, and excludes protected reads before calculating clear plans and metadata. The three production callers pass the same predicate.

**Tech Stack:** TypeScript, Vitest, Node.js filesystem/path APIs.

### Task 1: Specify preservation behavior

**Files:**

- Modify: `packages/core/src/services/microcompaction/microcompact.test.ts`

1. Add helpers that build paired `read_file` calls/results with IDs and paths.
2. Add failing tests for idle/force and size-only preservation, ordinary reads, mixed/ambiguous IDs, and eviction metadata.
3. Run `cd packages/core && npx vitest run src/services/microcompaction/microcompact.test.ts` and confirm the new assertions fail because the option is ignored.

### Task 2: Add safe memory path classification

**Files:**

- Modify: `packages/core/src/memory/paths.ts`
- Modify: `packages/core/src/memory/team-paths.test.ts`

1. Add failing tests for project, user, team, outside, and symlink-escape paths.
2. Add a read/retention-specific helper that resolves the nearest existing real path and checks all three managed roots without changing write-approval semantics.
3. Run the path tests and confirm they pass.

### Task 3: Exclude protected reads from clear plans

**Files:**

- Modify: `packages/core/src/services/microcompaction/microcompact.ts`

1. Extend `MicrocompactOptions` with the preservation predicate.
2. Correlate `functionResponse.id` to request-side `read_file` paths.
3. Exclude a result only when its path mapping is unambiguous and every candidate path is protected.
4. Apply the filtered tool-reference set before idle/force and size-based planning so token counts and eviction metadata stay accurate.
5. Run the focused microcompaction tests and confirm they pass.

### Task 4: Wire every production caller

**Files:**

- Modify: `packages/core/src/core/client.ts`
- Modify: `packages/core/src/core/geminiChat.ts`
- Modify: `packages/core/src/services/memoryPressureMonitor.ts`
- Test: corresponding focused test files

1. Resolve relative paths against the configured target directory.
2. Pass the same managed-memory predicate through pre-send idle/size, `/compress-fast`, and memory-pressure compaction.
3. Add or update focused caller tests that verify the option reaches microcompaction.
4. Run all affected focused tests.

### Task 5: Verify and review

**Files:**

- Review all changed files.

1. Run Prettier on changed files.
2. Run focused tests for microcompaction, path classification, client, GeminiChat, and memory-pressure behavior.
3. Run `npm run build && npm run typecheck` from the worktree root.
4. Run an independent code review, fix important findings, and repeat focused verification.
5. Re-run the original E2E reproduction against `node dist/cli.js` after a fresh bundle.
