# Label-Driven Issue Auto-Assignment

## Problem

Issues that need a maintainer sit unassigned until someone notices them. We want
them routed automatically to a person who has permission to act on them.

The obvious approach — let the triage agent pick an assignee — puts an untrusted
issue body in the path of a write token: whoever writes the issue text can try to
steer who gets assigned. Defending that requires transporting a model decision
across a trust boundary (schema, validation, staleness checks, a separate apply
job). All of that machinery exists only because the model chose the login.

## Design

The model does not choose. Assignment is a pure function of the issue's labels.

Triage already applies labels from the repository's existing taxonomy. A separate
workflow triggers on `issues: labeled`, reads the label names, and maps them to
owners via `.github/issue-owners.json`. The assignment script never reads issue
title, body, or comments, so issue text cannot influence the outcome — not
because it is filtered, but because it is never in scope.

```
issues: labeled ──► assign-issue-owner.mjs ──► labels → area → owner
                    (no model, no plan, no schema)
```

`.github/issue-owners.json` holds three things:

- `requireLabels` — every one must be present. Ships as `["need-discussion"]`, a
  deliberately conservative rollout. Widen or empty it to assign more issues.
- `skipLabels` — any one blocks assignment (`welcome-pr`, `feature/need-help`,
  `good first issue`, `help wanted`), keeping community-facing issues open to the
  community.
- `areas` — ordered label→owners entries. First match wins.

Owners are sourced from `.github/CODEOWNERS`, and a test asserts every login in
the map appears there. That is a review aid, not the security boundary: before
each write the script calls
`GET /repos/{repo}/collaborators/{login}/permission` and keeps only
`admin`/`maintain`/`write`. Editing the map therefore cannot assign someone who
does not already have push access.

Among eligible owners it picks the one with the fewest open assigned issues,
rotating by issue number to break ties so a set of equally loaded owners spreads
round-robin rather than always landing on the first entry.

## Why no plan/apply split

The trigger _is_ the state change, which removes the reasons a split would exist:

| Concern                               | Resolution                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Stale decision overwrites newer state | The script reads live state at write time; a later label change re-fires the workflow    |
| Model output reaching a write token   | No model runs in this workflow                                                           |
| Model selecting an arbitrary login    | The model emits labels only; logins come from a reviewed file and are permission-checked |
| Model selecting an arbitrary label    | Labels are matched against the map, not applied by this workflow                         |

## Trigger dependency

`issues: labeled` only fires for label writes made with a PAT — writes made with
the default `GITHUB_TOKEN` do not trigger downstream workflow runs. The triage
agent labels with `QWEN_CODE_BOT_TOKEN`/`CI_BOT_PAT`, so the chain holds. If
triage ever falls back to `GITHUB_TOKEN` for labelling, this workflow must be
rehung on `workflow_run` of the triage workflow. This is noted in the workflow
header where it would be needed.

`labeled` fires once per label, so one triage run queues several runs. Each is
idempotent — every run after the first sees an assignee and stops — and a
per-issue concurrency group serialises them.

## Failure behavior

A malformed owner map fails the run before any GitHub call. An owner whose
permission lookup fails (renamed, deleted, access revoked) is warned about and
skipped rather than failing the run. If no owner of a matched area has push
access, the run warns and makes no change. Closed, already-assigned, and
non-matching issues are no-ops.

## Validation

Unit tests cover map validation, the skip policy, area matching, and owner
selection. A stubbed-`gh` integration test asserts that dry-run performs no
mutation, that push access is verified before assigning, and that the least
loaded eligible owner is the one assigned. Workflow tests guard the repository
guard, the job-scoped `issues: write`, the step-scoped token,
`persist-credentials: false`, and the absence of any model invocation.

Roll out with the `workflow_dispatch` entry point, which defaults to dry-run.
