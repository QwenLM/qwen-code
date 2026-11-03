# Channel Request Owner Approval Implementation Plan

**Goal:** Allow an admitted request owner to approve once or deny in direct and
group shared sessions while retaining operator-only management and delegation.

**Architecture:** Keep shared-session routing and operator predicates unchanged.
Record each permission's active run and filter non-operator lookup results by
that run's attended owner before exposing any request details.

**Tech stack:** TypeScript, existing ChannelBase relay, Vitest.

**Spec:** [Request owner approval](../design/channel-request-owner-approval.md).

## Constraints and Review Focus

- No new public configuration, dependency, route, or automatic migration.
- Explicit operators, including `[]`, still control shared-session management.
- Cross-sender, cross-chat, cross-thread, unattended and stale-run IDs must not
  become owner approvals or leak request titles through ambiguity reporting.
- `/approve-always` does not gain the shared-session owner exception.
- Preserve named selection, operator delegation and native-card settlement.

## Task: Request-Scoped Owner Authority

Files: `packages/channels/base/src/ChannelBase.ts`, its collocated tests,
channel overview and synchronized English/Chinese design documents.

- [x] Add regressions exercising attended owners and denied delegation; run
      `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts -t 'request owner approval'`
      and observe owner approvals fail against the existing operator-only gate.
- [x] Add the private run snapshot and owner filtering; keep all other shared
      commands on the existing operator predicate.
- [x] Run the regression subset, then the complete ChannelBase test file.
- [x] Update the channel overview's request-vs-session permission contract.
- [x] Run changed-file formatting and lint checks, package compilation, and
      independent compiled-code reproduction verification.
- [x] Complete whole-repository build, typecheck, and bundle after synchronizing
      the installed dependencies and sibling build outputs with this checkout.
- [x] Read the full diff in two clean self-audit passes, then obtain a fresh
      code review and fix correctness findings before reporting completion.

The user subsequently requested full verification, an issue following the
community template, and a linked PR before finishing the full checks. Track the
reported failure in [#16086](https://github.com/QwenLM/qwen-code/issues/16086).
Submission does not authorize a release, merge, or deployment.

## Verification Evidence

- The first 28 owner regressions failed against the original operator gate,
  then passed after the fix. The complete updated file passed 783 tests.
- `npm run build` from `packages/channels/base` passed; changed-file ESLint,
  Prettier and whitespace checks passed.
- Independent compiled ChannelBase inbound/event verification passed 33
  scenarios, including a real isolated PairingStore. This is not live IM E2E.
- After refreshing pinned dependencies and synchronizing main, root
  `npm run build`, `npm run bundle`, and
  `NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck` passed. The refreshed
  ChannelBase test file passed all 783 tests again.
- Independent concurrent-session verification passed 13 scenarios, including
  ordinary-member isolation and the existing operator delegation behavior.
- A fresh bundled CLI, isolated extension transport, real ACP child, local
  OpenAI-compatible fixture, and real edit tool passed five end-to-end cases:
  direct approval, group approval after another member's rejection, group
  denial, persistent/management rejection followed by one-time approval, and
  privately paired approval. Approved edits changed files; denial preserved
  the file and completed the attended lifecycle without a second request.
- CI static checks, TUI snapshots, and no-AK integration passed on the tested
  production head. Full Linux unit and Web Shell smoke jobs were still running
  when this evidence was recorded. No live IM or all-platform acceptance is
  claimed.
- Independent review found no actionable correctness or security defects. Its
  suggested original-owner-versus-current-sender regression was added and
  included in the final 783-test run. An active unattended loop/webhook case
  remains outside the independent integration coverage; the owner filter and
  existing automation authorization were inspected without broadening them.
