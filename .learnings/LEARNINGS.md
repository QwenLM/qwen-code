## [LRN-20260515 ����-001] Git Push Non-Fast-Forward

**Logged**: 2026/05/15 ����  
**Priority**: medium  
**Status**: pending  
**Area**: config

### Summary

When pushing to a fork where the remote branch has diverged from the local branch (e.g., after a rebase or history rewrite), a standard `git push` will fail with a non-fast-forward error.

### Details

If the intention is to update an existing PR with the rewritten local history, the correct approach is to use `git push --force-with-lease`. This safely overwrites the remote branch while ensuring no unseen upstream changes are lost.

### Suggested Action

Use `git push --force-with-lease <remote> <branch>` when updating an existing PR after rewriting local history.

### Metadata

- Source: conversation
- Tags: git, push, pr, workflow

---
