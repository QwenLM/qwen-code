# Current-PR Autofix controls

## Problem

Qwen Autofix already manages opted-in pull requests in GitHub Actions, but the CLI has no focused entry point for the pull request associated with the current branch. Users must remember the workflow's exact comment commands and inspect labels, CI, and review state separately.

## Scope

Add a bundled `/autofix` skill with three exact user-invoked operations:

- `status`: read the current branch's open pull request and summarize Autofix labels, CI, review state, and eligibility facts.
- `on`: post the workflow's existing `@qwen-code /takeover` command.
- `off`: post the workflow's existing `@qwen-code /takeover stop` command.

This change does not add a watcher, daemon, workflow, confirmation mode, status-line indicator, direct label mutation, or arbitrary-PR targeting. The existing GitHub Actions workflow remains the only owner of authorization, eligibility, label mutation, review triage, fixes, pushes, audit comments, and round limits.

## Design

Use a Markdown-only bundled skill. The operation is thin orchestration over stable `gh` and workflow contracts, so a TypeScript command would duplicate skill loading and command plumbing without adding a deterministic runtime requirement.

Resolve the pull request with one current-branch query:

```bash
gh pr view --json number,url,state,baseRefName,isCrossRepository,maintainerCanModify,author,labels,statusCheckRollup,reviewDecision,latestReviews
```

Writes use only the validated numeric `number` field and one of two constant, single-quoted comment bodies. GitHub-provided strings are display-only and never reach executable shell text.

A posted comment is a request, not proof of state change. The skill must not report takeover as active until a later status read observes workflow-owned labels. `autofix/skip` takes precedence over `autofix/takeover`.

## Status mapping

CI matches the repository's existing GitHub pull-request aggregation semantics: failure-like CheckRun conclusions or StatusContext states win, then pending, then passing, with an empty rollup reported as no checks. Review status uses `reviewDecision`, with `latestReviews` summarized by reviewer and state without quoting review bodies.

## Failure behavior

Invalid arguments, missing or unauthenticated `gh`, API failure, no current-branch pull request, a non-open pull request, or an invalid pull-request number stop before any write. Workflow-side rejection remains visible through the workflow's acknowledgement comments and subsequent status reads.
