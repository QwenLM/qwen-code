# AutoFix Mixed-Feedback Classification Plan

## Goal

Prevent takeover review rounds from treating an overall approval or
non-blocking merge verdict as a reason to ignore a reproduced current
correctness defect in the same feedback batch.

## Root cause

The PR feedback scanner already included the issue-level review comment from
PR #8301 in `feedback.md`. The address-review agent then applied the review's
overall `APPROVE` verdict to the whole batch and emitted `no-action.md`, instead
of classifying the reproduced correctness defect separately from the adjacent
logging, comment, and coverage suggestions.

## Implementation

1. In the shared `address-review` instructions, make review-level merge
   readiness and item-level actionability independent decisions.
2. Keep a reproduced current correctness defect Required even when it is
   described as non-blocking, a follow-up, or not a regression. Continue to
   classify adjacent diagnostics, comments, tests, and hardening independently.
3. Permit the no-change outcome only after every actionable feedback point has
   an explicit disposition and no verified Required item remains unresolved.
4. Add focused contract assertions that pin these rules in the existing AutoFix
   workflow test without adding a second parser or duplicating workflow policy.

## Non-goals

- Do not change feedback ingestion, watermarking, round budgets, or takeover
  lifecycle logic; the reported comment already reached the agent.
- Do not make formal `APPROVED` review bodies trigger AutoFix. Ordinary approval
  text such as `LGTM` should not create no-op rounds.
- Do not automatically implement every suggestion in an approved review.

## Verification

- Prove the new contract test fails against the current skill text, then passes
  after the instruction change.
- Run the focused AutoFix workflow test and the full workflow test file.
- Run Prettier, targeted ESLint, `git diff --check`, repository build, and
  typecheck.
- Review the final diff for correctness, security, maintainability, test value,
  and unnecessary scope.
