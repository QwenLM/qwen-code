# Hosted Harness Session test split

[English](2026-11-24-hosted-harness-session-test-split.md) | [简体中文](2026-11-24-hosted-harness-session-test-split.zh-CN.md)

## Test layout

`hosted-harness-session.test.ts` spans more than 50,000 lines. Keep the core text Turn and event stream cases there and move the other cases into `hosted-harness-session.<topic>.test.ts` files beside it. Group routes and their failure cases by the behavior they exercise, such as lifecycle, wake reconciliation, approvals, and Runtime takeover.

Import the shared Harness fixture before route modules so Vitest installs its existing Store, model, and wake mocks first. Keep topic-specific helpers with their consumers and share setup only where several files use it. Run the two crash-hold cases in their original order because they share a module-level one-shot latch.

## Verification

Compare test names, parameterized cases, and assertions before and after the move. From `packages/cli`, run `npx vitest run src/serve/hosted-harness-session --coverage.enabled=false` to exercise the full family. Run the repository build and typecheck as well. The split covers test code only and preserves the production routes and assertions.
