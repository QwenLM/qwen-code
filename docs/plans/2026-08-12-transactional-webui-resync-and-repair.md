# Transactional WebUI resync and live-journal repair implementation

## Scope

Implement Issue #8678 PR3c-B on top of the existing WebUI restore coordinator.
The change is limited to WebUI/WebShell behavior, tests, and documentation. It
does not change daemon wire formats, SDK restore schemas, selective transcript
reading, or durable checkpoints.

## Implementation sequence

1. Extend the existing restore intent with recovery purposes and keep a resync
   safety episode outside any individual intent.
2. Park a gapped runner, retain its transcript, and prepare an authoritative
   same-session full load with its committed client identity, refreshing that
   identity if a pending prompt admission self-heals it before request start.
3. Reconstruct recovery replay in a shadow store, validate ownership,
   completeness, epoch/watermark, prompt evidence, lifecycle, and deadline,
   then atomically replace the source attachment.
4. Separate prompt-promise settlement from transcript terminal publication and
   replace historical replay side effects with one post-commit reconciliation.
5. Move live-journal repair onto the same coordinator while retaining its
   checkpoint, target suffix, and bounded source-tail capture; tail metadata
   and usage must override the older candidate snapshot through runner startup.
6. Apply one mutation-blocking rule to the main WebShell, split panes, queued
   prompts, and provider action boundaries.
7. Preserve the explicit legacy-daemon fallback; fail closed when a modern
   daemon cannot provide an owned client attachment.

## Verification

- Run focused WebUI provider and WebShell layout/action tests.
- Run real-daemon ring-eviction and live-journal repair integration tests.
- Run formatting, lint, build, bundle, and typecheck.
- Audit the final diff until two consecutive passes find no new actionable
  issue, then run the available Codex review workflow.

## Delivery

Ship the design, implementation, and test evidence as one Draft PR titled
`fix(webui): Make resync and repair transactional`, referencing Issue #8678.
The rollback is a revert of the complete PR; no feature flag or alternate
coordinator is retained.
