# Fix Phase

You are the fix phase. A previous scan-phase job already wrote
`<workdir>/findings.json` (and `<workdir>/report-only.md` when report-only
findings exist). Read the findings,
apply the accepted fixes on one branch, and write the PR files. Do NOT
re-scan — trust the existing findings, but re-verify each one's evidence
against this checkout before touching code.

## Steps

1. Read `<workdir>/findings.json`. If its `fixes` array is empty, stop —
   that is a valid, silent outcome (step 8 applies): do not create a branch
   and do not write failure.md.
2. Select `fixes` entries — the most certain, lowest-risk, easiest to
   explain. Selecting none is valid. No cap on count.
3. If you selected at least one fix, create the branch from current HEAD:
   `git checkout -b <branch>`.
4. For each selected finding, one at a time:
   a. Re-verify the evidence still holds on this checkout. If it does not
   (the base advanced between the scan and fix jobs), move the entry from
   `fixes` to `reportOnly` in findings.json with `"status": "dropped"` and
   the reason (evidence stale on this checkout) appended to `minimalFix`,
   then continue with the next finding.
   b. Make the minimal change. Add or update a focused regression test that
   fails before the fix and passes after it whenever the fix is
   test-coverable. If a test is impossible, the finding must carry static
   proof (every caller, read/write point, default-value chain, or a
   docs-vs-behavior contradiction, all grep-able in the repo) — otherwise
   move the entry from `fixes` to `reportOnly` in findings.json with
   `"status": "dropped"` and the drop reason (no regression test possible,
   no static proof) appended to `minimalFix`, and move on.
   c. Run focused verification for the touched package, plus
   `npm run generate:settings-schema` when the fix touched a settings
   source — the regenerated schema belongs in the same commit (Shared
   Rules). If it fails and you
   cannot make it pass confidently, revert this finding's edits
   (`git checkout -- <paths>`; delete untracked files you created), move
   the entry from `fixes` to `reportOnly` in findings.json with
   `"status": "dropped"` and the drop reason appended to `minimalFix`, and
   move on. A dropped finding must surface in the consolidated issue, not
   vanish. Never commit a finding whose verification failed.
   d. Commit as ONE Conventional Commit whose subject ends with the
   finding's id in brackets, e.g. `fix(cli): summary [<id>]`, then mark
   `"status": "committed"`. The workflow correlates commits to findings by
   that bracketed id — a commit without it cannot be tracked when dropped.
5. After all fixes: run `npm run build`, `npm run typecheck`, `npm run lint`,
   and focused Vitest runs for every touched package (plus
   `npm run generate:settings-schema` if a settings source changed). If any
   fails and you cannot fix it confidently, write `<workdir>/failure.md` and
   stop — do not leave a half-verified branch.
6. Re-read the full diff as a skeptical reviewer: no unrelated changes, no
   over-abstraction, no speculative edits, `git status --short` clean.
7. If at least one commit exists on the branch, write
   `<workdir>/pr-title.txt` and `<workdir>/pr-body.md` following
   `.qwen/skills/prepare-pr/SKILL.md`. The body's "What this PR does" must
   walk each committed finding with its root cause and evidence summary, and
   "Why it's needed" must state these are real test gaps, behavior
   inconsistencies, or contract mismatches — not style cleanup. No issue
   number applies; omit the `Fixes #` line.
8. If zero commits: stay on the base HEAD, keep the scan outputs untouched,
   and do NOT write pr-title.txt or pr-body.md.

Update `<workdir>/findings.json` to its final state (per-finding statuses
included) as your last write.
