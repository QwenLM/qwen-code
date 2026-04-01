# Auto-Memory Implementation Work Log

## Overall Goal

Implement a Claude Code parity memory system in Qwen Code incrementally:

1. Human-managed context: `QWEN.md` / `AGENTS.md`
2. Explicit user memory: keep and narrow `save_memory`
3. Managed auto-memory: `.qwen/memory/`
4. Recall / Extract / Dream lifecycle
5. `/memory` / `/dream` / `/remember` UX and observability

## Working Rules

- Each part should be independently deliverable.
- Each part must include tests.
- Each part must finish with:
  - functional verification
  - targeted tests passing
  - regression checks passing
  - git commit completed
  - work log updated
- At the start and end of each part, review the overall plan and this log.

---

## Part 0 - Baseline and breakdown

### Start review

- Source plan: `auto-memory-doc/02-technical-design.md` in the analysis repo.
- Current implementation repo: `/Users/mochi/code/memory-worktree`
- Branch: `feat/auto-memory`
- Working tree baseline: clean

### Goal

- Confirm repo baseline
- Create implementation work log in repo
- Break work into independently verifiable parts

### Result

- Confirmed target repo and clean baseline
- Confirmed implementation branch `feat/auto-memory`
- Created in-repo work log
- Established staged plan:
  1. storage skeleton
  2. prompt integration
  3. recall
  4. extraction
  5. dream and commands

### Verification

- `git status --short` was empty before changes
- No code behavior changed in this part

### Status

Completed

---

## Part 1 - Managed auto-memory storage scaffold

### Start review

- Overall plan remains unchanged: build the full memory system incrementally, starting with the lowest-risk storage layer.
- Current repo baseline after Part 0: clean branch plus work log commit.
- Scope for this part: add independent managed auto-memory storage primitives without touching main prompt flow or existing `/memory` behavior.

### Goal

- Add managed auto-memory types
- Add managed auto-memory path helpers
- Add scaffold creation for `.qwen/memory/`
- Add tests for path stability, scaffold creation, idempotency, and read behavior

### Implemented

- Added `packages/core/src/memory/types.ts`
- Added `packages/core/src/memory/paths.ts`
- Added `packages/core/src/memory/store.ts`
- Added `packages/core/src/memory/store.test.ts`
- Exported the new modules from `packages/core/src/index.ts`

### Functional verification

- `ensureAutoMemoryScaffold(projectRoot)` now creates:
  - `.qwen/memory/`
  - `MEMORY.md`
  - `meta.json`
  - `extract-cursor.json`
  - `user.md`
  - `feedback.md`
  - `project.md`
  - `reference.md`
- Re-running scaffold creation preserves existing files.

### Test verification

- Passed targeted test:
  - `npm exec --workspace=packages/core -- vitest run src/memory/store.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/utils/memoryDiscovery.test.ts src/core/prompts.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This part intentionally does not integrate auto-memory into prompt assembly yet.
- Existing `QWEN.md` / `AGENTS.md` behavior remains unchanged.

### Status

Completed

---

## Part 2 - Managed auto-memory index prompt integration

### Start review

- Overall plan remains: storage first, then controlled prompt integration, then recall/extract/dream.
- Part 1 already established a safe on-disk scaffold under `.qwen/memory/`.
- Scope for this part: load the managed `MEMORY.md` index into prompt memory without changing existing `QWEN.md` / `AGENTS.md` discovery behavior.

### Goal

- Add managed auto-memory prompt formatting helpers
- Append managed auto-memory index after hierarchical memory when present
- Preserve legacy behavior when no managed index exists
- Add tests for prompt formatting and config integration

### Implemented

- Added `packages/core/src/memory/prompt.ts`
- Added `packages/core/src/memory/prompt.test.ts`
- Updated `Config.refreshHierarchicalMemory()` to append managed auto-memory index content
- Added config tests for merge and legacy fallback behavior
- Exported the new prompt helpers from `packages/core/src/index.ts`

### Functional verification

- If `.qwen/memory/MEMORY.md` exists, it is appended to `userMemory` as a dedicated `Managed Auto-Memory` block.
- If managed auto-memory does not exist, `userMemory` remains exactly the same as before.
- Oversized managed indexes are truncated to a safe prompt budget.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/memory/prompt.test.ts src/config/config.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/core/prompts.test.ts src/utils/memoryDiscovery.test.ts src/memory/store.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This part only integrates the managed memory index, not relevant recall.
- Existing hierarchical memory file discovery is unchanged.
- Existing `save_memory` behavior is unchanged.

### Status

Completed

---

## Part 3 - Relevant managed auto-memory recall

### Start review

- Overall plan remains: storage → managed index integration → relevant recall → extraction → dream and commands.
- Parts 1 and 2 already established the managed `.qwen/memory/` scaffold and appended `MEMORY.md` into `userMemory` safely.
- Scope for this part: add low-risk, query-sensitive relevant recall from managed topic files without changing legacy hierarchical memory discovery or `save_memory` semantics.

### Goal

- Scan managed auto-memory topic files into structured documents
- Select relevant managed memory for a user query
- Inject the relevant memory block into the per-request reminder path
- Add tests for scanning, recall selection, and client integration

### Implemented

- Added `packages/core/src/memory/scan.ts`
- Added `packages/core/src/memory/scan.test.ts`
- Added `packages/core/src/memory/recall.ts`
- Added `packages/core/src/memory/recall.test.ts`
- Updated `packages/core/src/core/client.ts` to prepend relevant managed auto-memory for `UserQuery`
- Updated `packages/core/src/core/client.test.ts` with recall prompt injection coverage
- Exported the new scan/recall helpers from `packages/core/src/index.ts`

### Functional verification

- Managed topic files are parsed into structured recall candidates with title/frontmatter/body support.
- User queries now receive a dedicated `Relevant Managed Auto-Memory` reminder block when matching managed topic content exists.
- If no managed topic files exist or no relevant content is found, request behavior remains unchanged.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/memory/scan.test.ts src/memory/recall.test.ts src/core/client.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/config/config.test.ts src/core/prompts.test.ts src/utils/memoryDiscovery.test.ts src/memory/prompt.test.ts src/memory/store.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This part uses heuristic recall selection for a safe first integration point.
- The recall prompt is injected through the existing request reminder path, minimizing surface-area risk.
- Extraction and dream/consolidation are intentionally deferred to later parts.

### Status

Completed
