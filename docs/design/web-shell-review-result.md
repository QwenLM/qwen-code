# Web Shell Review Result

## Problem

`/review` produces canonical structured findings and a composed verdict, but Web Shell only receives the final conversational prose. The existing right-panel “Review” view displays files changed by a turn; it is not a code-review result. This makes findings difficult to scan, filter, and revisit, and creates an ambiguous UI label.

## Current State

- `qwen review findings` writes the canonical findings report under `.qwen/tmp/`.
- `qwen review compose-review` writes the authoritative composed verdict under `.qwen/tmp/`.
- Step 8 saves a durable Markdown report under `.qwen/reviews/`.
- Step 9 removes the temporary findings and composed verdict files.
- Session artifacts already support workspace files with primitive metadata.
- Web Shell already supports artifact-specific rendering selected by metadata.

## Proposed Design

### Durable review-result document

Add `qwen review save-artifact`, which reads:

- the canonical findings report;
- the composed verdict;
- the saved Markdown report path;
- the target and effort supplied by the review skill.

It writes a versioned JSON document under `.qwen/reviews/` containing:

- schema version;
- target and effort;
- authoritative composed verdict fields;
- canonical findings and counts;
- the workspace-relative Markdown report path.

The command copies structured inputs without recalculating the verdict or rewriting findings. It fails closed on unreadable or malformed inputs and refuses output inside `.qwen/tmp/`.

### Session artifact registration

After Step 8 creates the JSON document and before Step 9 cleanup, the `/review` skill calls `record_artifact` with:

- `kind: other`;
- `storage: workspace`;
- the JSON document path;
- `mimeType: application/vnd.qwen.code-review+json`;
- metadata `artifactType: code_review` and `schemaVersion: 1`.

The skill owns registration because it runs in the active session and turn. The CLI command owns document construction so the model does not transcribe findings or verdict fields.

### Web Shell renderer

Web Shell detects `metadata.artifactType === 'code_review'` and renders a dedicated review-result view. It reads and validates the JSON document at runtime and displays:

- verdict and caps;
- severity and confidence counts;
- filterable findings;
- finding source, failure scenario, suggested fix, outcomes, and locations;
- published evidence images as safe links and local evidence files (`assetFiles`) as inline images;
- a link to the durable Markdown report, offered from the error view too when it can be derived from the artifact path.

The renderer never parses transcript prose and never computes a verdict. Malformed documents display an artifact error rather than falling back to a misleading source-code preview, and the error view offers the durable Markdown report derived from the artifact path so a truncated or unparsable document is not a dead end.

### Existing file-change view

Change only the user-visible label from “Review / 审核” to “Changes / 文件更改”. Internal `review` discriminants and public customization values remain unchanged to avoid an unrelated API migration.

## Files Affected

- `packages/cli/src/commands/review/save-artifact.ts`
- `packages/cli/src/commands/review/save-artifact.test.ts`
- `packages/cli/src/commands/review.ts`
- `packages/core/src/skills/bundled/review/SKILL.md`
- `packages/web-shell/client/components/artifacts/CodeReviewArtifactDetail.tsx`
- `packages/web-shell/client/components/artifacts/CodeReviewArtifactDetail.test.tsx`
- `packages/web-shell/client/components/artifacts/ArtifactPanel.tsx`
- `packages/web-shell/client/components/artifacts/ArtifactPanel.module.css`
- `packages/web-shell/client/i18n.tsx`

## Scope Boundaries

Included:

- deterministic durable review-result JSON;
- current-session artifact registration;
- dedicated Web Shell renderer;
- visible naming disambiguation.

Excluded:

- Web Shell review orchestration;
- a review launcher dialog;
- phase/progress events;
- verdict recomputation in the browser;
- one-click fixing;
- daemon protocol changes;
- internal rename of the existing file-change `review` types.

## Decisions

- The canonical findings report remains the only finding authority.
- The composed verdict remains the only verdict authority.
- The durable JSON is created before cleanup and stored outside `.qwen/tmp/`.
- `metadata.artifactType` is sufficient for renderer dispatch; no new artifact kind is introduced.
- Review-result schema changes require a version bump and backward-compatible renderer handling.
