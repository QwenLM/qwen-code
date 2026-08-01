# Autofix review-thread resolution hardening

## Problem

Qwen Autofix already lets the review-address agent identify inline review comments that are resolved in code. The credentialed host workflow maps those REST comment IDs to GitHub review threads and calls `resolveReviewThread` after pushing the fix.

The current ordering is generally safe, but it does not prove that the live PR head being resolved is the exact commit covered by deterministic verification:

- A rejected push may be salvaged by merging a newly moved remote head. The merged commit is pushed even though verification predates the merge.
- The PR author may push again after Autofix pushes and before the resolution mutation.
- A same-run repair can inherit `resolved-comments.txt` or `comment-replies.json` from the rejected first attempt.

These gaps can mark a conversation resolved without evidence that the current PR head still contains the verified fix.

## Current state

The responsibilities are already separated correctly:

- `.qwen/skills/autofix/SKILL.md` tells the agent how to classify findings and write `resolved-comments.txt` or `comment-replies.json`.
- `.github/scripts/run-autofix-review-verification.sh` independently runs deterministic build, typecheck, lint, and affected-package tests.
- `.github/workflows/qwen-autofix.yml` owns the GitHub PAT, pushes the branch, fetches review threads, and performs mutations.
- `scripts/tests/qwen-autofix-workflow.test.js` extracts and executes workflow shell blocks with stubbed GitHub responses.

The GitHub mutation must remain in the trusted workflow. The agent must not receive GitHub credentials.

## Proposed changes

### Verification gate

Require a clean tracked worktree and index before deterministic checks, capture the commit SHA, and require both the SHA and tracked state to remain unchanged after the structural checks and again after build, typecheck, lint, and tests. Then record that captured SHA as a step output named `verified_head`. Do not emit it for no-op or failed outcomes. This rejects persistent tracked changes or commits created by branch-controlled checks; it does not claim an immutable filesystem or detect a script that temporarily changes state and restores it within one command, which remains part of the existing CI trust model.

### Final verification selection

Propagate the selected verification SHA through the final verification step:

- use the first verification SHA when no repair ran;
- use only the repair verification SHA when repair ran;
- never fall back to the first SHA for a successful repaired outcome.

### Repair isolation

Before invoking the repair agent, remove `resolved-comments.txt` and `comment-replies.json` together with the other prior-attempt artifacts. The repair attempt must explicitly regenerate its final dispositions. Missing files therefore fail closed: no thread is resolved or replied to.

### Post-push resolution proof

Before resolving any selected thread, require all of the following:

1. `verified_head` is non-empty.
2. The push-race salvage did not create an unverified merge commit.
3. Local `HEAD` after the successful push equals `verified_head`.
4. A live `gh pr view` query succeeds.
5. The live PR `headRefOid` equals `verified_head` before each mutation.
6. The live PR `headRefOid` still equals `verified_head` immediately after each mutation.

Before each mutation, a single GraphQL guard reads both the live `headRefOid` and the target thread's live `isResolved` state. A thread already resolved by another actor is skipped. After the mutation, the same guard verifies both values again. This post-check also runs when the mutation command returns an error, because a lost response does not prove that GitHub did not apply the mutation.

If a pre-mutation condition is unknown or false, or a post-mutation condition is ambiguous, stop resolving additional conversations. A failed mutation whose post-guard proves the verified head is unchanged and the thread remains open is safe to warn and continue. The workflow does not call `unresolveReviewThread`: GitHub does not expose a compare-and-swap precondition or mutation attribution, so even a successful `resolveReviewThread` response cannot prove that another actor did not resolve the thread between the pre-guard and the mutation. Automatically reopening it could therefore undo another reviewer's action. An unsuccessful mutation command followed by a post-guard that confirms the verified head and resolved state is counted as an observed resolved state, without attributing it to Autofix; any ambiguous result stops the remaining mutations.

The verified code push and normal round report still succeed. Replies for findings deliberately left open may continue after a successful push because they do not assert that a thread is fixed.

## Design decisions

- **Fail closed for resolution:** an unresolved thread is recoverable; an incorrectly resolved thread can hide a real defect.
- **Skip resolution after race merge:** rerunning the full deterministic gate inside the PAT-bearing publish step would duplicate expensive logic and run branch-controlled scripts with credentials in scope. A later review round can safely resolve the thread.
- **Query live PR state immediately before mutation:** workflow concurrency cannot prevent direct contributor pushes.
- **Keep the existing model disposition contract:** semantic judgment remains with the agent, while exact commit identity is enforced deterministically by the host.
- **Do not add general CLI/core code:** this is Autofix workflow orchestration, not a reusable Qwen Code runtime feature.

## Files affected

- `.github/scripts/run-autofix-review-verification.sh`
- `.github/workflows/qwen-autofix.yml`
- `scripts/tests/qwen-autofix-workflow.test.js`
- `.qwen/skills/autofix/SKILL.md` for contract clarification

## Scope boundaries

Included:

- exact verified/live head equality;
- push-race fail-closed behavior;
- repair-attempt disposition isolation;
- focused workflow contract and behavioral tests.

Excluded:

- GraphQL pagination beyond the existing first 100 threads;
- resolving arbitrary non-Autofix PR conversations;
- dismissing `CHANGES_REQUESTED` reviews;
- giving the model direct GitHub credentials;
- changing generic `/review` or CLI behavior.

## Open questions

None. The conservative behavior is deterministic before mutation: uncertainty prevents additional threads from being resolved. After a mutation, the workflow observes and reports state but never automatically unresolves it without atomic ownership evidence.
