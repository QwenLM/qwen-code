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

## Part 13 - Dream agent consumer stage A

### Start review

- Overall plan continues from the shared background runtime and extraction-agent work toward the next real consumer: dream/consolidation.
- Parts 10 to 12 already delivered auto dream scheduling, a reusable `BackgroundAgentRunner`, and extraction agent planning.
- Scope for this part: let dream attempt a tool-free background-agent rewrite plan first, while preserving the existing mechanical dream path as a safe fallback.

### Goal

- Add a tool-free dream agent planner that returns structured topic rewrites
- Wire managed dream to prefer agent rewrites when `Config` is available
- Preserve the existing mechanical dream path as fallback on planner failure or absence of config
- Add targeted tests for planner validation, agent-first dream behavior, fallback behavior, and client wiring

### Implemented

- Added `packages/core/src/memory/dreamAgentPlanner.ts`
- Added `packages/core/src/memory/dreamAgentPlanner.test.ts`
- Updated `packages/core/src/memory/dream.ts` to prefer agent-produced topic rewrites and fall back to mechanical dream
- Updated `packages/core/src/memory/dreamScheduler.ts` to accept optional `Config` and pass it into dream execution
- Updated `packages/core/src/core/client.ts` to pass `Config` into auto-dream scheduling
- Updated `packages/core/src/memory/dream.test.ts` with agent-first and fallback coverage
- Updated `packages/core/src/core/client.test.ts` with dream scheduler config coverage
- Exported dream agent planner helpers from `packages/core/src/index.ts`

### Functional verification

- Managed dream can now use `BackgroundAgentRunner` as a tool-free consolidation planner that rewrites full topic bodies in JSON form.
- If the dream agent planner fails, returns invalid output, or no `Config` is available, dream safely falls back to the existing mechanical dedupe implementation.
- Auto dream scheduling now passes runtime config through from the main client so background dream tasks can use the new agent path.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/memory/dreamAgentPlanner.test.ts src/memory/dream.test.ts src/memory/dreamScheduler.test.ts src/core/client.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/background/backgroundAgentRunner.test.ts src/memory/extractionAgentPlanner.test.ts src/memory/extractAgent.test.ts src/memory/extractModel.test.ts src/memory/extract.test.ts src/memory/dreamAgentPlanner.test.ts src/memory/dream.test.ts src/memory/dreamScheduler.test.ts src/core/client.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This stage intentionally keeps the dream agent tool-free and JSON-only, matching the low-risk rollout shape used for extraction agent stage A.
- The existing mechanical dream remains the safety net and still supports manual `/dream` use without requiring runtime config.

### Status

Completed

---

## Part 14 - Dynamic MEMORY index rewrite

### Start review

- Overall plan now shifts from initial dream-agent adoption to the next high-value consistency gap: keeping `MEMORY.md` aligned with real topic-file state.
- Part 13 already delivered agent-first dream planning, but the managed index was still largely scaffold-shaped and not rebuilt after extraction or dream.
- Scope for this part: add a mechanical dynamic index builder, regenerate `MEMORY.md` after topic mutations, and keep the index compact for both prompt loading and manual review.

### Goal

- Add a reusable managed index builder that summarizes topic documents into short hooks
- Rebuild `MEMORY.md` automatically after extraction and dream touch topic files
- Keep the default scaffold index in the same compact dynamic format
- Add targeted tests for hook extraction, index formatting, and extract/dream integration

### Implemented

- Added `packages/core/src/memory/indexer.ts`
- Added `packages/core/src/memory/indexer.test.ts`
- Updated `packages/core/src/memory/store.ts` so the default scaffold index uses the dynamic index format
- Updated `packages/core/src/memory/extract.ts` to rebuild `MEMORY.md` after successful topic patch application
- Updated `packages/core/src/memory/dream.ts` to rebuild `MEMORY.md` after agent or mechanical consolidation
- Updated `packages/core/src/memory/extract.test.ts` and `packages/core/src/memory/dream.test.ts` with index rewrite coverage
- Exported index helpers from `packages/core/src/index.ts`

### Functional verification

- `MEMORY.md` is now a compact, dynamic topic index that lists durable entry counts and short hooks derived from topic bullets.
- Extraction and dream now keep the managed index synchronized with topic-file mutations instead of leaving the scaffold stale.
- Manual review and prompt loading now see a more representative managed memory landing page without needing a model-generated summary step.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/memory/indexer.test.ts src/memory/store.test.ts src/memory/extract.test.ts src/memory/dream.test.ts src/memory/prompt.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This stage intentionally keeps index generation mechanical by using the first few unique topic bullets as hooks.
- A later stage can upgrade the index from mechanical hooks to model-generated summaries if needed.

### Status

Completed

---

## Part 6 - Auxiliary side-query foundation

### Start review

- Overall plan has shifted from memory-only MVP work to shared runtime infrastructure needed for model-driven recall, extraction, and future background work.
- Parts 1 to 5 already completed the memory MVP; the next slice should be reusable outside memory.
- Scope for this part: introduce a small, independently testable side-query foundation for structured auxiliary inference and migrate existing lightweight JSON inference call sites onto it.

### Goal

- Add a reusable side-query helper under a shared auxiliary module
- Centralize structured-response schema validation for lightweight auxiliary inference
- Migrate existing JSON-only helper call sites onto the new side-query layer
- Add targeted tests for helper behavior and migrated call sites

### Implemented

- Added `packages/core/src/auxiliary/sideQuery.ts`
- Added `packages/core/src/auxiliary/sideQuery.test.ts`
- Updated `packages/core/src/utils/nextSpeakerChecker.ts` to use shared side-query execution
- Updated `packages/core/src/utils/subagentGenerator.ts` to use shared side-query execution
- Exported side-query helpers from `packages/core/src/index.ts`

### Functional verification

- Structured auxiliary inference now has a shared entrypoint that defaults model selection, prompt IDs, and schema validation.
- Invalid structured side-query responses now fail fast through schema validation instead of each caller re-implementing checks.
- Existing next-speaker detection and subagent generation now run through the same auxiliary inference path while preserving their caller-facing behavior.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/auxiliary/sideQuery.test.ts src/utils/nextSpeakerChecker.test.ts src/utils/subagentGenerator.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/core/baseLlmClient.test.ts src/utils/schemaValidator.test.ts src/utils/nextSpeakerChecker.test.ts src/utils/subagentGenerator.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This part intentionally does not introduce background task scheduling or fork-agent execution yet.
- The new helper is scoped to lightweight, single-shot structured inference and serves as the first reusable building block for later model-driven memory work.

### Status

Completed

---

## Part 7 - Model-driven recall selection

### Start review

- Overall plan now moves from shared side-query infrastructure to the first memory consumer on top of it.
- Part 6 already established a reusable auxiliary inference path, so the next slice should validate that platform with a real memory workflow.
- Scope for this part: upgrade relevant auto-memory recall from heuristic-only ranking to model-driven side-query selection with safe heuristic fallback and session-level surfacing dedupe.

### Goal

- Add a model-driven managed memory recall selector based on side-query
- Keep heuristic recall as a safe fallback path
- Avoid repeatedly surfacing the same managed memory files within one session
- Add targeted tests for selector behavior, fallback behavior, and client integration

### Implemented

- Added `packages/core/src/memory/relevanceSelector.ts`
- Added `packages/core/src/memory/relevanceSelector.test.ts`
- Updated `packages/core/src/memory/recall.ts` with model-driven resolution and excluded-file filtering
- Updated `packages/core/src/memory/recall.test.ts` with model/fallback coverage
- Updated `packages/core/src/core/client.ts` to track surfaced managed memory files per session
- Updated `packages/core/src/core/client.test.ts` to cover the new recall integration path
- Exported relevance selector helpers from `packages/core/src/index.ts`

### Functional verification

- Relevant auto-memory recall can now ask a lightweight side-query to choose the most relevant topic files from scanned memory candidates.
- If the model selector fails or returns invalid paths, recall safely falls back to the existing heuristic selector.
- Files already surfaced in the current session are excluded from later recall passes, reducing repeated prompt injection.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/memory/relevanceSelector.test.ts src/memory/recall.test.ts src/core/client.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/auxiliary/sideQuery.test.ts src/core/baseLlmClient.test.ts src/core/client.test.ts src/utils/schemaValidator.test.ts src/memory/store.test.ts src/memory/prompt.test.ts src/memory/scan.test.ts src/memory/recall.test.ts src/memory/relevanceSelector.test.ts src/memory/state.test.ts src/memory/extract.test.ts src/memory/dream.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This part intentionally upgrades only recall selection; extraction and dream remain unchanged.
- Session-level surfacing dedupe is in-memory for the active client process and does not yet persist across restarts.

### Status

Completed

---

## Part 8 - Side-query extraction patches

### Start review

- Overall plan now advances from recall selection to the next most valuable model-driven memory improvement: extraction quality.
- Part 7 already validated that side-query can safely drive memory decisions with fallback, so extraction is the next consumer.
- Scope for this part: keep host-side cursoring, patch application, and dedupe, but replace heuristic-only patch planning with a model-driven side-query planner plus heuristic fallback.

### Goal

- Add a side-query extraction planner that consumes transcript slices and topic summaries
- Keep host-side patch application, dedupe, and cursor updates unchanged
- Fallback safely to the existing heuristic extraction planner on model failure
- Add targeted tests for planner behavior, fallback behavior, and client integration

### Implemented

- Added `packages/core/src/memory/extractionPlanner.ts`
- Added `packages/core/src/memory/extractionPlanner.test.ts`
- Added `packages/core/src/memory/extractModel.test.ts`
- Updated `packages/core/src/memory/extract.ts` to use model-driven patch planning with heuristic fallback
- Updated `packages/core/src/core/client.ts` to pass `Config` into managed extraction scheduling
- Updated `packages/core/src/core/client.test.ts` with extraction config coverage
- Exported extraction planner helpers from `packages/core/src/index.ts`

### Functional verification

- Managed extraction now supports a side-query planner that consumes transcript slices plus current topic summaries and returns structured topic patches.
- If the planner fails or returns invalid output, extraction safely falls back to the existing heuristic patch extractor.
- Host-side cursor persistence, topic patch application, dedupe, and system messages remain unchanged.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/memory/extractionPlanner.test.ts src/memory/extractModel.test.ts src/memory/extract.test.ts src/core/client.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/auxiliary/sideQuery.test.ts src/core/baseLlmClient.test.ts src/core/client.test.ts src/utils/schemaValidator.test.ts src/memory/store.test.ts src/memory/prompt.test.ts src/memory/scan.test.ts src/memory/recall.test.ts src/memory/relevanceSelector.test.ts src/memory/state.test.ts src/memory/extractionPlanner.test.ts src/memory/extract.test.ts src/memory/extractModel.test.ts src/memory/dream.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This part intentionally stays single-shot and structured; it does not introduce forked extractor agents or background task runtime yet.

### Status

Completed

---

## Part 9 - Background task runtime foundation

### Start review

- Overall plan now shifts from side-query consumers to the next shared runtime layer needed for auto-dream and future fork-agent execution.
- Parts 6 to 8 already delivered the auxiliary inference layer plus memory recall/extraction consumers.
- Scope for this part: add a minimal background task runtime foundation with registry, scheduler, and drainer primitives, but do not yet wire automatic dream scheduling onto it.

### Goal

- Add a reusable background task registry with status updates and snapshots
- Add a scheduler that can run tracked tasks with simple dedupe behavior
- Add a drainer that waits for in-flight background work with timeout protection
- Add targeted tests for lifecycle updates, dedupe handling, and drain behavior

### Implemented

- Added `packages/core/src/background/taskRegistry.ts`
- Added `packages/core/src/background/taskDrainer.ts`
- Added `packages/core/src/background/taskScheduler.ts`
- Added `packages/core/src/background/taskRegistry.test.ts`
- Added `packages/core/src/background/taskDrainer.test.ts`
- Added `packages/core/src/background/taskScheduler.test.ts`
- Exported background runtime helpers from `packages/core/src/index.ts`

### Functional verification

- Background work now has a shared registry for task snapshots, updates, and subscriptions.
- Background tasks can be scheduled through a common scheduler with simple dedupe-key skipping.
- In-flight background work can be tracked and drained with timeout protection before shutdown.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/background/taskRegistry.test.ts src/background/taskDrainer.test.ts src/background/taskScheduler.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/auxiliary/sideQuery.test.ts src/background/taskRegistry.test.ts src/background/taskDrainer.test.ts src/background/taskScheduler.test.ts src/core/baseLlmClient.test.ts src/core/client.test.ts src/utils/schemaValidator.test.ts src/memory/store.test.ts src/memory/prompt.test.ts src/memory/scan.test.ts src/memory/recall.test.ts src/memory/relevanceSelector.test.ts src/memory/state.test.ts src/memory/extractionPlanner.test.ts src/memory/extract.test.ts src/memory/extractModel.test.ts src/memory/dream.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This part intentionally does not yet hook memory dream or extraction into the new background runtime.

### Status

Completed

---

## Part 10 - Auto dream scheduling stage A

### Start review

- Overall plan now applies the new background runtime to the first real consumer: managed auto-memory dream.
- Part 9 already delivered the shared registry/scheduler/drainer layer, so this slice focuses on wiring mechanical dream into that runtime with minimal gating.
- Scope for this part: schedule mechanical dream in the background after user-query extraction, add consolidation lock and persisted dream gating metadata, but do not yet introduce model-driven dream rewriting or background agents.

### Goal

- Add a managed auto-memory dream scheduler built on the shared background runtime
- Add minimal persisted gating for dream cadence and same-session suppression
- Reuse the existing mechanical dream implementation as the task body
- Add targeted tests for gating, locking, scheduling, and client integration

### Implemented

- Added `packages/core/src/memory/dreamScheduler.ts`
- Added `packages/core/src/memory/dreamScheduler.test.ts`
- Extended `AutoMemoryMetadata` with dream scheduling fields
- Updated `packages/core/src/core/client.ts` to fire-and-forget dream scheduling after managed extraction
- Updated `packages/core/src/core/client.test.ts` to cover dream scheduling integration
- Exported dream scheduler helpers from `packages/core/src/index.ts`

### Functional verification

- Managed auto-memory dream can now be scheduled as a background task using the shared task registry, scheduler, and drainer.
- Dream scheduling persists minimal gating state in metadata, including `lastDreamAt`, `lastDreamSessionId`, and distinct sessions seen since the last dream.
- A consolidation lock now prevents concurrent dream execution for the same project, while the existing mechanical dream logic remains the execution core.
- User-query completion now asynchronously attempts dream scheduling without blocking the main response path.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/memory/dreamScheduler.test.ts src/memory/dream.test.ts src/core/client.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/auxiliary/sideQuery.test.ts src/background/taskRegistry.test.ts src/background/taskDrainer.test.ts src/background/taskScheduler.test.ts src/core/baseLlmClient.test.ts src/core/client.test.ts src/utils/schemaValidator.test.ts src/memory/store.test.ts src/memory/prompt.test.ts src/memory/scan.test.ts src/memory/recall.test.ts src/memory/relevanceSelector.test.ts src/memory/state.test.ts src/memory/extractionPlanner.test.ts src/memory/extract.test.ts src/memory/extractModel.test.ts src/memory/dream.test.ts src/memory/dreamScheduler.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This part intentionally keeps dream execution mechanical and background-only; task visualization and model-driven dream agents remain for later phases.

### Status

Completed

---

## Part 11 - Background agent runner foundation

### Start review

- Overall plan now extends the background runtime from plain tasks to reusable headless agent orchestration.
- Part 10 already proved the scheduler/drainer path with mechanical dream tasks, so the next slice can safely wrap `AgentHeadless` itself.
- Scope for this part: add a shared `BackgroundAgentRunner` that binds task registry updates to `AgentEventEmitter`, but do not yet connect any memory workflow to it.

### Goal

- Add a reusable background agent runner on top of `AgentHeadless`
- Map core agent events into background task registry progress and metadata
- Reuse the shared background scheduler and drainer for lifecycle tracking
- Add targeted tests for success and failure execution paths

### Implemented

- Added `packages/core/src/background/backgroundAgentRunner.ts`
- Added `packages/core/src/background/backgroundAgentRunner.test.ts`
- Exported background agent runner helpers from `packages/core/src/index.ts`

### Functional verification

- Background work can now wrap `AgentHeadless` execution inside the shared task runtime.
- Core agent streaming/tool/usage events are mapped into task registry progress and metadata updates.
- Background agent execution is tracked by the shared scheduler/drainer and returns a summarized completion result.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/background/backgroundAgentRunner.test.ts src/background/taskScheduler.test.ts src/agents/runtime/agent-headless.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/auxiliary/sideQuery.test.ts src/background/taskRegistry.test.ts src/background/taskDrainer.test.ts src/background/taskScheduler.test.ts src/background/backgroundAgentRunner.test.ts src/agents/runtime/agent-headless.test.ts src/core/baseLlmClient.test.ts src/core/client.test.ts src/utils/schemaValidator.test.ts src/memory/store.test.ts src/memory/prompt.test.ts src/memory/scan.test.ts src/memory/recall.test.ts src/memory/relevanceSelector.test.ts src/memory/state.test.ts src/memory/extractionPlanner.test.ts src/memory/extract.test.ts src/memory/extractModel.test.ts src/memory/dream.test.ts src/memory/dreamScheduler.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This part intentionally stops at runner infrastructure; memory extraction/dream agents remain for later phases.

### Status

Completed

---

## Part 12 - Extraction agent consumer stage A

### Start review

- Overall plan now moves from shared background agent infrastructure to the first memory consumer that actually uses it.
- Part 11 already delivered `BackgroundAgentRunner`, so the next slice should connect managed extraction to it while preserving all existing fallbacks.
- Scope for this part: add an extraction agent planner that emits structured patches via `BackgroundAgentRunner`, then fall back to side-query planner and finally heuristic extraction when needed.

### Goal

- Add a managed extraction agent planner on top of `BackgroundAgentRunner`
- Parse and validate structured extraction patches from agent output
- Integrate the agent planner into the extraction fallback chain ahead of side-query/heuristic planning
- Add targeted tests for planner behavior and extraction integration

### Implemented

- Added `packages/core/src/memory/extractionAgentPlanner.ts`
- Added `packages/core/src/memory/extractionAgentPlanner.test.ts`
- Added `packages/core/src/memory/extractAgent.test.ts`
- Updated `packages/core/src/memory/extract.ts` to try extraction-agent planning before side-query and heuristic fallback
- Updated `packages/core/src/memory/extractModel.test.ts` to cover the new fallback order
- Exported extraction agent planner helpers from `packages/core/src/index.ts`

### Functional verification

- Managed extraction can now first invoke a tool-free background extraction agent through `BackgroundAgentRunner` and parse structured JSON patch output.
- If agent output is invalid or the agent fails, extraction safely falls back to the existing side-query planner and then to heuristic extraction.
- Host-side cursoring, patch application, and dedupe remain unchanged.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/memory/extractionAgentPlanner.test.ts src/memory/extractAgent.test.ts src/memory/extractModel.test.ts src/memory/extract.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/auxiliary/sideQuery.test.ts src/background/taskRegistry.test.ts src/background/taskDrainer.test.ts src/background/taskScheduler.test.ts src/background/backgroundAgentRunner.test.ts src/agents/runtime/agent-headless.test.ts src/core/baseLlmClient.test.ts src/core/client.test.ts src/utils/schemaValidator.test.ts src/memory/store.test.ts src/memory/prompt.test.ts src/memory/scan.test.ts src/memory/recall.test.ts src/memory/relevanceSelector.test.ts src/memory/state.test.ts src/memory/extractionAgentPlanner.test.ts src/memory/extractionPlanner.test.ts src/memory/extract.test.ts src/memory/extractAgent.test.ts src/memory/extractModel.test.ts src/memory/dream.test.ts src/memory/dreamScheduler.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This part intentionally keeps the extraction agent tool-free and JSON-only; constrained tool policies come later.

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

---

## Part 4 - Managed auto-memory extraction flow

### Start review

- Overall plan remains: storage → managed index integration → relevant recall → extraction → dream and commands.
- Parts 1 to 3 already provide scaffold, index loading, and request-time relevant recall.
- Scope for this part: add a safe MVP extraction pipeline that runs after a completed user query, tracks incremental cursor state, and writes durable summaries into managed topic files.

### Goal

- Add extraction running-state guards
- Add transcript slicing and cursor persistence
- Add heuristic durable-memory patch extraction and topic-file application
- Trigger extraction after completed user queries in the client flow
- Add tests for extraction state, cursor/idempotency, and client integration

### Implemented

- Added `packages/core/src/memory/state.ts`
- Added `packages/core/src/memory/state.test.ts`
- Added `packages/core/src/memory/extract.ts`
- Added `packages/core/src/memory/extract.test.ts`
- Updated `packages/core/src/core/client.ts` to trigger managed extraction after completed `UserQuery` turns
- Updated `packages/core/src/core/client.test.ts` with extraction integration coverage
- Exported the new extraction/state helpers from `packages/core/src/index.ts`

### Functional verification

- Managed extraction now reads the current session transcript incrementally using `extract-cursor.json`.
- Durable user statements are heuristically classified into `user`, `feedback`, `project`, or `reference` topic patches.
- Topic files are updated idempotently, metadata is bumped, and duplicate writes are avoided on repeated runs.
- Completed user queries can emit a `Managed auto-memory updated` system message when extraction writes topic files.
- Concurrent extraction attempts for the same project are skipped safely in-process.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/memory/state.test.ts src/memory/extract.test.ts src/core/client.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/config/config.test.ts src/core/prompts.test.ts src/utils/memoryDiscovery.test.ts src/memory/store.test.ts src/memory/prompt.test.ts src/memory/recall.test.ts src/memory/scan.test.ts src/memory/state.test.ts src/memory/extract.test.ts src/core/client.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`

### Notes

- This MVP extraction path is intentionally heuristic and host-driven; it does not yet launch a dedicated extractor agent.
- Cursor persistence is session-aware and sufficient for incremental turn-end extraction in the current process model.
- Dream/consolidation and richer extraction prompts remain deferred to the next parts.

### Status

Completed

---

## Part 5 - Dream and command entrypoints

### Start review

- Overall plan remains: storage → managed index integration → relevant recall → extraction → dream and commands.
- Parts 1 to 4 already provide the managed scaffold, prompt integration, recall, and turn-end extraction.
- Scope for this part: add a safe managed auto-memory dream/consolidation primitive plus basic `/memory`, `/dream`, and `/remember` command entrypoints in the CLI.

### Goal

- Add a managed auto-memory dream/consolidation function
- Enhance `/memory` with managed status and manual extraction entrypoints
- Add `/dream` and `/remember` built-in commands
- Register the new commands and add tests for command behavior and loader coverage

### Implemented

- Added `packages/core/src/memory/dream.ts`
- Added `packages/core/src/memory/dream.test.ts`
- Exported dream helpers from `packages/core/src/index.ts`
- Enhanced `packages/cli/src/ui/commands/memoryCommand.ts` with `status` and `extract-now`
- Added `packages/cli/src/ui/commands/dreamCommand.ts`
- Added `packages/cli/src/ui/commands/rememberCommand.ts`
- Added tests in `packages/cli/src/ui/commands/memoryCommand.test.ts`
- Added `packages/cli/src/ui/commands/dreamCommand.test.ts`
- Added `packages/cli/src/ui/commands/rememberCommand.test.ts`
- Updated `packages/cli/src/services/BuiltinCommandLoader.ts` and `packages/cli/src/services/BuiltinCommandLoader.test.ts`
- Added CLI i18n strings in `packages/cli/src/i18n/locales/en.js` and `packages/cli/src/i18n/locales/zh.js`

### Functional verification

- Managed dream now deduplicates topic-file bullet entries, restores the empty placeholder when needed, and updates metadata best-effort.
- `/memory status` shows the managed memory root, extract cursor summary, and per-topic entry counts.
- `/memory extract-now` manually runs managed extraction for the current session transcript and reports the outcome.
- `/dream` manually runs managed consolidation and reports changed topic files plus deduplication count.
- `/remember` provides a direct built-in entrypoint for `save_memory`, including optional project/global scope selection.
- New commands are registered in the built-in command loader.

### Test verification

- Passed targeted tests:
  - `npm exec --workspace=packages/core -- vitest run src/memory/dream.test.ts`
  - `npm exec --workspace=packages/cli -- vitest run src/ui/commands/memoryCommand.test.ts src/ui/commands/dreamCommand.test.ts src/ui/commands/rememberCommand.test.ts src/services/BuiltinCommandLoader.test.ts`
- Passed regression tests:
  - `npm exec --workspace=packages/core -- vitest run src/config/config.test.ts src/core/prompts.test.ts src/utils/memoryDiscovery.test.ts src/memory/store.test.ts src/memory/prompt.test.ts src/memory/recall.test.ts src/memory/scan.test.ts src/memory/state.test.ts src/memory/extract.test.ts src/memory/dream.test.ts src/core/client.test.ts`
  - `npm exec --workspace=packages/cli -- vitest run src/ui/commands/memoryCommand.test.ts src/ui/commands/dreamCommand.test.ts src/ui/commands/rememberCommand.test.ts src/services/BuiltinCommandLoader.test.ts`
- Passed typecheck:
  - `npm run typecheck --workspace=packages/core`
  - `npm run generate && npm run build --workspace=packages/web-templates && npm run typecheck --workspace=packages/cli`

### Notes

- This dream implementation is intentionally mechanical and low-risk; it deduplicates and normalizes managed memory rather than invoking a separate consolidation agent.
- `/memory` enhancement is kept minimal for MVP: status inspection and manual extraction trigger.
- The full staged implementation plan is now complete.

### Status

Completed

