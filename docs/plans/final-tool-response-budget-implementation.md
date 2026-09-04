# Final Tool Response Budget Implementation Plan

## 1. Establish the shared contract

- Add structured persisted-output metadata to tool results and response info.
- Correct the generic fallback writer so it returns the path and committed byte count.
- Separate Shell and MCP persistence triggers from their model previews without changing rich display output.
- Add focused tests for primary/fallback persistence, preview shape, Unicode boundaries, and metadata propagation.

## 2. Implement deterministic batch finalization

- Add a shared utility that measures model-facing tool-response text, reuses persisted paths, persists unpersisted large output once, and enforces a final no-I/O hard cap while preserving the `enter_plan_mode` lifecycle policy outside the output budget.
- Preserve response and part order, media parts, error fields, and function response identity.
- Recompute content length and cover single-large, many-large, mixed output/error/text, persistence failure, disabled budget, and already-persisted cases.

## 3. Move enforcement to true aggregation boundaries

- Replace the scheduler's marker-based batch offload with the shared finalizer and run it on both sides of `PostToolBatch`.
- Finalize interactive executable and synthetic responses together before recording and submission.
- Finalize the whole headless turn outside per-call schedulers before recording and submission.
- Finalize ACP calls before transcript recording while keeping immediate display events unchanged.
- Finalize agent and speculative aggregates before model-facing emission/history mutation.
- Add the tool-response-only no-I/O send guard.

## 4. Verify behavior

- Run package-local unit tests for every changed runtime.
- Run the E2E baseline and fixed scenarios for parallel Shell output in headless and interactive modes; exercise ACP where the local harness permits it.
- Run build, typecheck, and lint.
- Inspect every metadata producer and consumer to prove the field is populated and cannot leak into external schemas.
- Perform open-ended diff audits until two consecutive passes find no actionable issue.
