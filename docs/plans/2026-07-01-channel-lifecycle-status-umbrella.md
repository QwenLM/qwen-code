# Channel Lifecycle Status Umbrella Review Plan

Date: 2026-07-01

## Goal

Verify that the lifecycle-status documentation stays aligned across the adapter
design and umbrella review surfaces.

## Review Checklist

- Confirm no document says Feishu lifecycle `text_chunk` appends or updates the
  answer body.
- Confirm the umbrella matrix lists:
  - supported lifecycle events
  - native surface
  - `started` behavior
  - `text_chunk` behavior
  - terminal behavior
  - unsupported or no-op reason
  - exact test files
- Confirm Slack remains out of scope.
- Confirm DingTalk terminal emoji remains out of scope.
- Confirm branch-, issue-, and PR-facing language stays neutral and does not
  name external tools or vendors.

## Verification

- Run the review-provided grep against these four documentation files.
- Run `git diff --check`.
