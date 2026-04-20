# Upstream Sync Skill

Synchronize internal fork (alishu/qwen-code) with upstream (QwenLM/qwen-code).

**Triggers**: "upstream sync", "sync upstream", "analyze upstream", "merge upstream", "sync report"

## Modes

### Mode 1: Analyze (default, read-only)

When the user says "analyze upstream" or "sync report":

1. Run `git fetch upstream main`
2. Find the merge base: `MERGE_BASE=$(git merge-base HEAD upstream/main)`
3. Count new upstream commits: `git log --oneline $MERGE_BASE..upstream/main --no-merges | wc -l`
4. If zero commits, report "Already up to date" and stop
5. Categorize upstream commits by reading their messages and diff stats:
   - For each commit, classify area (cli/core/channels/docs/tests/build/other) and risk (safe/low/medium/high)
6. Identify files changed on both sides:
   ```bash
   comm -12 <(git diff --name-only $MERGE_BASE HEAD | sort) <(git diff --name-only $MERGE_BASE upstream/main | sort)
   ```
7. Run `bash scripts/upstream-fork-divergence.sh` to get current fork divergence state
8. Generate a structured markdown report with:
   - Summary: N new upstream commits, date range
   - Commits grouped by area and risk
   - Both-changed files count and list
   - Redundant internal commits (already in upstream)
   - Current divergence categories and convergence status
   - Recommended next action

### Mode 2: Merge

When the user says "merge upstream" or "sync upstream":

1. Read `.qwen/upstream-sync-rules.yml` for conflict resolution rules
2. Create a sync branch:
   ```bash
   git tag "sync-checkpoint-$(date +%Y-%m-%d)" HEAD
   SYNC_BRANCH="sync/upstream-$(date +%Y-%m-%d)"
   git checkout -b $SYNC_BRANCH
   ```
3. Attempt merge: `git merge upstream/main --no-edit`
4. If conflicts occur:
   - Count conflicted files: `git diff --name-only --diff-filter=U`
   - If count > 20, abort and report (too many conflicts for auto-resolution)
   - For each conflicted file:
     a. Determine which rule applies from upstream-sync-rules.yml
     b. If rule says "keep ours": `git checkout --ours <file> && git add <file>`
     c. If rule says "keep theirs": `git checkout --theirs <file> && git add <file>`
     d. If rule says "ai-resolve": read both versions, apply semantic merge, write result
     e. If rule says "regenerate" (package-lock.json): delete and run `npm install`
5. Run verification:
   ```bash
   npm run build
   npm run typecheck
   npm run test
   ```
6. If verification fails, attempt auto-fix (max 2 rounds):
   - Read error output
   - Identify likely cause (import path changes, type signature changes, etc.)
   - Apply fix and re-run verification
7. If still failing after 2 rounds:
   - Report failure with diagnostics
   - Offer to rollback: `git reset --hard sync-checkpoint-$(date +%Y-%m-%d)`
8. Commit and push:
   ```bash
   git add -A
   git commit -m "chore: sync upstream $(date +%Y-%m-%d)"
   git push origin $SYNC_BRANCH
   ```
9. Report success with MR creation instructions

### Mode 3: Divergence Check

When the user says "check divergence" or "fork status":

1. Run `bash scripts/upstream-fork-divergence.sh` to generate the full divergence report
2. Summarize key metrics: divergence score, categories, convergence status
3. Highlight any new files that need categorization
4. Suggest convergence actions for "review needed" files

## Important Notes

- NEVER force-push or rewrite history on main or staging branches
- ALWAYS create a checkpoint tag before merging
- ALWAYS run build+test after merge before reporting success
- If in doubt about a conflict resolution, ask the user rather than guessing
- Divergence analysis is fully automated via `scripts/upstream-fork-divergence.sh`
