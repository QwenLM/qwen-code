# Issue Draft

## Title

feat(review): support multi-model code review with arbitration

## Body

### Summary

Extend `/review` to support multiple models reviewing the same code changes in parallel, with an arbitrator model producing a unified final report. This leverages different models' strengths to catch issues that a single model might miss.

### Motivation

The current `/review` skill runs 4 parallel agents (correctness, quality, performance, audit), but all are powered by a single model. A single model's blind spots cause certain issues to be consistently overlooked. Different models excel in different areas — some are better at security analysis, others at performance or code quality.

### User Configuration

Minimal config — just list model IDs in `settings.json`, auto-resolved from `modelProviders`:

```jsonc
{
  "review": {
    "models": ["gpt-4o", "claude-sonnet-4-6-20250514"],
    "arbitratorModel": "claude-opus-4-6-20250725", // optional, defaults to session model
  },
}
```

Progressive complexity levels:

- **Level 0**: `/review --multi` — lists available models from `modelProviders`, guides user to configure
- **Level 1**: `"models": ["a", "b"]` — model IDs auto-resolved from `modelProviders`
- **Level 2**: `+ "arbitratorModel"` — separate arbitrator for users with fast session models
- **Level 3**: Mix strings and inline objects for models not in `modelProviders`

### Usage

```bash
/review              # review.models configured → multi-model; otherwise → single (unchanged)
/review 123          # review PR #123 (same mode logic)
/review --multi      # force multi-model (guides config if not set up)
/review --single     # temporarily use single-model (ignores review.models)
```

### Three Role Separation

| Role          | Typical Choice                     | Purpose                            |
| ------------- | ---------------------------------- | ---------------------------------- |
| Session Model | Qwen Coder Turbo, GPT-4o-mini      | Fast daily coding                  |
| Review Models | GPT-4o, Claude Sonnet, DeepSeek V3 | Multi-perspective review, parallel |
| Arbitrator    | Claude Opus, o3                    | Strong reasoning, final judgment   |

### Technical Design

**Two-phase pipeline with no branching:**

```
Phase 1: Parallel Collection (Service layer)
  - Create temporary ContentGenerator per model
  - Parallel generateContent() calls with p-limit
  - Collect free-text reviews (no JSON schema constraint)
  - Individual failure tolerance (skip failed models)

Phase 2: Arbitration (always runs)
  - If arbitratorModel configured → independent arbitrator via generateContent()
  - If not → session model arbitrates with full project context
  - Merges/deduplicates findings, resolves severity conflicts, final verdict
```

Key design decisions:

- **Free-text output** from review models (not `generateJson()`) — avoids function-calling compatibility issues and doesn't constrain reasoning quality
- **Arbitration always runs** — even when models "agree", multiple free-text reviews still need merging into one report; programmatic verdict extraction from free text is unreliable
- **Service layer does NO semantic work** — only parallel calls + collection; all merging/dedup/judgment by the arbitrator LLM

### Error Handling

- Partial model failure → skip, continue with remaining results
- All models fail → automatic fallback to single-model review
- Missing API key → skip model at startup with actionable hint
- Ambiguous model ID in `modelProviders` → clear error with fix suggestion

### Example Output

```
> /review 123

  Reviewing PR #123 with 2 models + arbitrator...

  gpt-4o                ✓ done (12.3s)
  claude-sonnet         ✓ done (18.7s)
  claude-opus (judge)   ✓ done (8.2s)

  ── Multi-Model Review: PR #123 ──────────────────────────

  Review models: gpt-4o, claude-sonnet
  Arbitrator: claude-opus
  Files: 15 files, +342/-128 lines

  Critical (1)

  [gpt-4o, claude-sonnet] src/db.ts:42 — SQL injection
    Query string built via concatenation without sanitization.
    Fix: Use parameterized queries.

  Suggestions (2)

  [claude-sonnet] src/utils.ts:15 — Duplicated logic
    Similar pattern exists in src/helpers.ts:30.

  [gpt-4o] src/api.ts:8 — Missing input validation
    User input passed directly to internal API.

  Verdict: Request Changes
  Both models identified critical SQL injection at src/db.ts:42.
```

### Implementation Plan

**Phase 1 — MVP:**

1. Settings schema: add `review.models` and `review.arbitratorModel` to `settingsSchema.ts`
2. Config layer: `getReviewModels()` / `getArbitratorModel()` with model ID resolution
3. Service layer: `MultiModelReviewService` — parallel `generateContent()` + arbitration
4. Tool layer: `MultiModelReviewTool` (returns guidance when < 2 models available)
5. Skill layer: extend `/review` SKILL.md

**Phase 2 — UX polish:** 6. Real-time progress display per model 7. `--single` flag support 8. Level 0 guided setup (`--multi` without config)

**Phase 3 — Advanced:** 9. Per-model custom review prompts (e.g., one model focused on security) 10. Review result caching 11. Zero-config auto model selection from `modelProviders`

### Files Changed

| File                                                         | Change  | Description                   |
| ------------------------------------------------------------ | ------- | ----------------------------- |
| `packages/cli/src/config/settingsSchema.ts`                  | Modify  | Add `review` settings schema  |
| `packages/core/src/config/config.ts`                         | Modify  | Add `getReviewModels()` etc.  |
| `packages/core/src/services/multiModelReviewService.ts`      | **New** | Core multi-model review logic |
| `packages/core/src/tools/multiModelReview.ts`                | **New** | MultiModelReviewTool          |
| `packages/core/src/tools/tool-names.ts`                      | Modify  | Register new tool name        |
| `packages/core/src/tools/tool-registry.ts`                   | Modify  | Register MultiModelReviewTool |
| `packages/core/src/skills/bundled/review/SKILL.md`           | Modify  | Add multi-model branch        |
| `packages/core/src/services/multiModelReviewService.test.ts` | **New** | Unit tests                    |

### Open Questions

1. **Large diff handling**: When diff exceeds a model's context window — MVP skips that model with a warning; future iteration supports per-file chunking.
2. **Independent arbitrator context**: Arbitrator called via API has no tool access — arbitration prompt includes the full diff (same as what review models see), sufficient for validating findings.

### Design Document

See `docs/design/multi-model-review.md` for the full design document.
