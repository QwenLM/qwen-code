# Resolve Command Design

## Goal

Add a maintainer-triggered `@qwen-code /resolve` command for pull requests that are blocked by merge conflicts with the default branch.

## Scope

The first version is intentionally conservative:

- The command only runs in `QwenLM/qwen-code`.
- The requester must have `write`, `maintain`, or `admin` permission.
- The target must be an open pull request.
- The pull request branch must live in the base repository.
- Fork pull requests are reported as unsupported instead of being pushed.
- The agent receives no GitHub token. It can only edit and commit locally.
- A separate publish step injects `CI_DEV_BOT_PAT` to push and comment.

## Workflow

1. `issue_comment` or `workflow_dispatch` resolves the target pull request.
2. An authorization job checks the requester's collaborator permission with `CI_BOT_PAT`.
3. The fix job acknowledges comment triggers with an `eyes` reaction.
4. The job reads pull request metadata and rejects closed, draft, non-conflicting, or fork pull requests.
5. For eligible pull requests, the job checks out the pull request branch with persisted credentials disabled, fetches the base branch, and verifies the branch still points at the expected head SHA.
6. Qwen Code runs without GitHub credentials, merges `origin/<base>`, resolves conflicts, verifies the result, commits, and writes a summary artifact.
7. A deterministic verification step fails on unresolved conflicts, missing summary, or failed checks.
8. The publish step pushes with `--force-with-lease` against the original head SHA and comments with the conflict-resolution summary.

## Out of Scope

- Automatically pushing to fork pull requests.
- Replacement pull request creation for external contributors.
- Scheduled scanning of stale conflicted pull requests.
- Resolving non-mergeability states other than direct merge conflicts.
