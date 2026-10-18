# Java CI failure reporting

[English](2026-10-18-java-ci-failure-reporting.md) | [简体中文](2026-10-18-java-ci-failure-reporting.zh-CN.md)

Java failures must reach their author or the issue queue without requiring a search through Actions jobs. A manual SDK Java run on main (39042781121) failed while its failure reporter (39047669819) skipped every job. Approval-triggered Managed Agent runs are also excluded by the reporter's main-only branch filter, even when they finish after the PR merged.

Extend the existing failure reporter rather than creating another reporting pipeline:

- Continue reporting the existing main push and scheduled failures, and also accept manual SDK Java failures on main or a PR branch.
- Accept failed Managed Agent PR and approval runs. Resolve their PR by the exact head SHA against the repository's pull requests; the run's `pull_requests` array can be empty, and an approval run records the base repository as its head repository, so the SHA — not a source-repository filter derived from the run — qualifies the PR (a same-named branch on an unrelated fork carries a different SHA). Ignore superseded heads and PRs closed without merging.
- Post or update one PR comment per failed run, listing failed jobs with direct links, failed steps, and identified tests. A merged PR also routes to the existing issue deduplication and autofix assignment. An open PR gets the comment without opening a main-regression issue.
- Keep the existing one-time infrastructure retry for main and merged PRs, and failing-test issue deduplication. Open PR infrastructure failures get a comment without dispatching a privileged rerun. Only a successfully dispatched retry suppresses a report.
- Prepare the PR summary before issue lookup so an issue API failure cannot swallow the comment. Retry comment lookup and publication up to three times, re-reading before each write to avoid duplicates.

The read-only analyzer checks out only the default branch, never the triggering PR. The comment and issue writers check out nothing and execute no repository code; report strings travel through environment variables and body files. PR matching requires the destination repository, the `main` base branch, the current head SHA, and an open or merged state before allowing a comment or an issue. Untrusted PR code cannot obtain the bot PAT or create an autofix-approved issue before merge.

Verification replays real failed-run metadata, exercises PR resolution and comment upsert through a fake GitHub CLI boundary, and checks the existing parser/deduplication and infrastructure-retry behavior. Live dispatch and publication are separate from local verification.
