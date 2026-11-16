# PR watch probes

## Baseline

On `main` there is no `qwen autofix-pr` command and no `qwen review watch-repo`
(the global `qwen` 0.25.3 lists neither). Watching a pull request means a
`/loop` or scheduled prompt whose every fire is a model turn, and a check
rollup is read with `gh pr checks`, which pages but reports nothing about what
is new since the previous look.

## Manual check

Built CLI (`node packages/cli/dist/index.js`), `gh` authenticated, run from a
clone of a repository with open PRs you can read. `qwen` below is that
build: put it on PATH under that name with a wrapper script, or write the
`node <clone>/packages/cli/dist/index.js` form instead. An alias is not
enough, since a scheduled gate runs in a fresh shell, and an installed
`qwen` without these commands fails every fire of step 10.

1. Run `qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo>` on an open
   PR with a failing check and a comment by someone else. Expect one JSON line
   with `action`, the `ci_failed` event (with `runId` when it is an Actions
   run) and the comment event, and a cursor at
   `.qwen/tmp/autofix-pr-<n>-gate.json` naming that failure under
   `reportedChecks` and the comment under `reportedCommentIds`.
2. Run it again. Expect no output and an unchanged cursor.
3. Run it on a PR whose head carries more than 100 check contexts (any busy
   repository). Expect `truncated` to be empty and failures from the second
   page to be reported; `gh api graphql` is called once per page. On a PR
   where a failed job was re-run green, expect no `ci_failed` for it.
4. Leave a comment on the PR yourself. Run again and expect no output (your
   own comments are not events). Have someone else comment, or edit the
   cursor to forget one comment id, and expect exactly that comment.
5. Push to the PR. Expect one run to print `head_moved_externally` with
   `resync`, and the next to be quiet.
6. On a PR that is merged, expect one run printing `stop` with `merged` and
   every later run quiet.
7. Run `qwen review watch-repo --repo <owner>/<repo>`. Expect no output and a
   cursor at `.qwen/tmp/review-watch/<host>/<owner>/<repo>.json` listing the
   open PRs. Run again and expect no output.
8. Edit the cursor to rewind one PR's `sha`, run again and expect one
   `pr_pushed` event for that PR with its title, author, labels and whether
   your review was requested; run once more and expect nothing.
9. Run with `--exclude-mine --review-requested` after rewinding a PR of your
   own and one that requests your review. Expect only the latter as an event,
   and both heads updated in the cursor.
10. Schedule it: in a Qwen Code session, ask for a task every 2 minutes with
    the gate `qwen autofix-pr snapshot <n> --gate --repo <owner>/<repo>` and a
    prompt to handle the events. Expect no turns while the PR is quiet and
    one turn carrying the JSON when a check fails or someone comments.

## Automated coverage

`snapshot.test.ts` pins the prepared-mode diffing, including the latest run
per check (apps and workflows kept apart) and the reply-marker rule; `snapshot.gate.test.ts` pins the gate
cursor rules (quiet runs, a failure once per attempt and again after a re-run
fails, a failure re-run green, conflict marks and their clearing, the
viewer's own comments, an untrusted comment as a notice, merge and close once
and reopen, a new cut once and tail cuts never, dismissed reviews, a
prepared watch's pushes and handled comments, which stay quiet after its
state is gone, the 12 KiB output budget with deferred events reported on
later runs and none twice, cut bodies), the check rollup and review thread
paging and the newest-100 read of a thread, and the command layer (cursor
written before the output, byte-identical quiet runs, repository identity
including a non-default port, the recorded host, a blank `--host`). `watch-repo.test.ts` pins the silent first run,
opened/pushed/ready events, quiet repeats, cursor pruning only when the list
was cut (also through the command), the cursor file name per host and per
filter set, a viewer change, every filter and the command line mapped onto
them, the GraphQL arguments, the output envelope and its budget.
`prepare.test.ts`, `cleanup.test.ts` and `ci-log.test.ts` cover the helpers
that wait for the reaction layer.
