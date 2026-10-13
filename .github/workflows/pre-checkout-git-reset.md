# `ci.yml` / `sdk-java*.yml` — the pre-checkout git reset

The `Clean stale .qwen before checkout` step in `ci.yml`, `sdk-java.yml`,
`sdk-java-flyway-open-prs.yml` and `sdk-java-contract-open-prs.yml` ends by
resetting the reused workspace's git store, so the `Checkout` step that follows
cannot negotiate against it (#13951).

Twelve step bodies share that text **byte-for-byte** — six `ci.yml` jobs
(`classify_pr`, `test`, `lint_and_static`, `web_shell_e2e_smoke`,
`integration_no_ak`, `integration_cli`) and six across the `sdk-java*`
workflows (`test`, `flyway-migrations`, `mysql-integration`, `daemon-e2e`,
`recheck`, `recheck`). Two suites pin that identity:

- `scripts/tests/review-worktree-cleanup-workflow.test.js` — every `ci.yml`
  copy after the first must equal the first.
- `scripts/tests/sdk-java-workflow.test.js` — every `sdk-java*` copy must equal
  `ci.yml`'s **first** copy, which it derives by document order.

So a change to the block is a change to twelve sites at once, and a change to
one site alone is a red test rather than a silently half-applied fix.

## Why the prose moved out of the YAML

The same doctrine as [`qwen-autofix.md`](./qwen-autofix.md): GitHub refuses to
start runs for a workflow file larger than 500 KB and reports nothing when it
stops. `.github/scripts/check-workflow-size.sh` enforces a ceiling and a
per-file growth ratchet against `.github/workflows/.size-baseline`.

A block repeated twelve times multiplies everything it says by twelve, so what
stays in the workflow is a pointer plus the shortest true summary. The
mechanism, the measurements, the rejected alternatives and the question this
change does **not** settle live here.

## How the pointers work

Each pointer is spelled `pre-checkout-git-reset.md#pcr-NNN`, and every `pcr-NNN`
section below carries a matching `<a id="pcr-NNN"></a>` anchor. The pointer in
the workflow is the only thing a reader debugging a checkout failure sees, so
`scripts/tests/review-worktree-cleanup-workflow.test.js` asserts that every
pointer resolves and that no section is left orphaned.

## Contents

- [1. The reset — drop the whole store, not the boundary](#pcr-001)
- [2. The diagnostic — what is captured, and why it is unconditional](#pcr-002)
- [3. The guard — a failed reset must warn, never redden the job](#pcr-003)
- [4. What this change does not settle](#pcr-004)

<a id="pcr-001"></a>

### 1. The reset — drop the whole store, not the boundary

The incident (#13951) is a `Checkout` failure on the shared `ecs-qwen` pool.
The pinned `actions/checkout` retries its fetch three times inside ~30 seconds
and every attempt fails identically:

```text
git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 \
    origin +refs/pull/N/head:refs/remotes/pull/N/head
fatal: pack has 1 unresolved delta
fatal: fetch-pack: invalid index-pack output
```

Byte-identical retries are the tell: whatever the client advertises to the
server does not change between attempts. On a **reused** workspace the client's
advertisement is stale in a way a fresh clone's never is:

- The previous job fetched a single ref at `fetch-depth: 1`. A shallow fetch
  prunes the objects that fall outside the new boundary, while
  `refs/remotes/pull/N/head` and friends accumulate across jobs — `git clean
-ffdx` and `git reset --hard` never touch them.
- `actions/checkout` pins `gc.auto=0`, so nothing reclaims or repairs the
  mismatch between jobs.
- The next `--depth=1` fetch then sends `have <oid>` for commits it can parse
  while their subtrees are gone. The server takes those `have` lines at face
  value and builds a **thin pack** whose delta base the client cannot resolve.

**Why not just delete `.git/shallow`.** The first version of this change dropped
the two metadata files `.github/scripts/resanitize-git-config.sh` already
removes (`.git/shallow` and `.git/commondir`). Measured on git 2.43.0 — the
version all three failing runners report — that does not clear the state: a
depth-1 fetch after `rm -f .git/shallow .git/commondir` still fails `rc=128` on
all three retries, while `--refetch` and a fresh `clone --depth=1` both return
`rc=0`. What closes the failure is resetting the **object store**, not the
boundary.

`.git/commondir` also never belonged in that pair: it has no role in thin-pack
negotiation, and `resanitize-git-config.sh` removes it _first_ because a planted
one repoints local config, refs and objects — a property a removal placed after
the `worktree`/`branch` sweeps does not obtain either.

So the reset drops the whole `$GITHUB_WORKSPACE/.git` and lets the `Checkout`
below re-clone at depth 1: the end state a fresh hosted runner starts from. The
cost is one depth-1 clone per pooled job; the alternative measured on the
incident is a checkout that fails identically three times and skips every later
step.

Two placement facts:

- **Last inside the existing `[ -e "$GITHUB_WORKSPACE/.git" ]` guard.** The
  `worktree prune` / `worktree remove --force` / `branch -D` sweeps above need
  the repository to still exist, so the reset must follow them. The guard
  itself is what makes this a no-op on a fresh hosted runner, which has no
  `.git` at all.
- **Spelled as the literal `$GITHUB_WORKSPACE/.git`, never via
  `rev-parse --absolute-git-dir`.** A leftover `.git` _file_ is a `gitdir:`
  pointer, and resolving it would name a directory **outside** the workspace —
  the runner's persistent main checkout, which the trusted
  `qwen-code-pr-review.yml` steps use. `rm -rf` on the literal path unlinks the
  pointer file itself and never follows it, so the only paths this step can
  delete are the ones it is entitled to delete.

<a id="pcr-002"></a>

### 2. The diagnostic — what is captured, and why it is unconditional

#13951's triage asks for state captured _on the failing runner_ so the
hypothesis "confirms or kills ... on the next occurrence instead of leaving it
inferred". The reset destroys that state, so the annotation and
`count-objects -v` run **before** the `rm -rf`:

| Field                | Why it discriminates                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shallow-boundaries` | How many boundary oids the previous job left behind. A healthy depth-1 checkout leaves one per fetched ref, so growth over a runner's life is the "degrading pool" signal.                                            |
| `unresolved-locally` | How many of those oids `git cat-file -e` cannot resolve. A well-formed shallow file names commits the client _does_ hold; a non-zero count is corruption. Each unresolved oid is also named in its own `::warning::`. |
| `refs`               | How many refs the next fetch will advertise `have` lines for. The accumulated `refs/remotes/pull/N/head` are the advertisement this mechanism blames.                                                                 |
| `commondir`          | Whether a repo redirect was present. It is not part of the fetch fix, but a later investigation into which job planted one on that runner should find a record that this step saw it.                                 |
| `git=<version>`      | The field #13951's own suggestion names first; the runner's version is otherwise not in the log.                                                                                                                      |
| `count-objects -v`   | Loose/packed object counts. ~4 ms on a checkout of this repo, so the cost is log clutter rather than wall clock.                                                                                                      |

The annotation is deliberately **unconditional** rather than gated on a
suspicious-looking value: its value is the contrast between a failing run and
the succeeding ones on the same runner, and a presence gate destroys exactly
that comparison.

<a id="pcr-003"></a>

### 3. The guard — a failed reset must warn, never redden the job

`defaults.run.shell: 'bash'` makes GitHub invoke the step under
`bash --noprofile --norc -eo pipefail`, and the step's own first line
(`set -uo pipefail`) does not turn errexit back off. A bare `rm -rf` as the
step's last command would therefore make its exit status the step's status, and
`rm` swallows a missing operand but not `EACCES`/`EPERM`/`EISDIR`.

That state is reachable on this pool by the step's own account: a containerised
job can leave residue owned by another uid, and unlink permission is decided by
the containing `.git` directory's write bit, not the file's. On a
`merge_group` run a red here ejects the queue entry and stalls every PR batched
with it.

So the reset degrades the way every other rung in this step degrades — `rm -rf`
→ `sudo -n rm -rf` → `::warning::` — and never fails the job. A reset that
could not happen leaves the boundary in place, which is the pre-change
behaviour, not a new failure.

<a id="pcr-004"></a>

### 4. What this change does not settle

Two credible parties disagree about the mechanism, and this change does not
adjudicate between them:

- The automated review measured that injecting a `.git/shallow` entry naming an
  absent commit leaves the fetch **succeeding** (`rc=0`), and that the state
  which does reproduce the recorded signature survives a boundary-only reset.
- The independent human analysis on #13951 concluded the root cause is
  "thin-pack against stale shallow boundary on a reused self-hosted `.git`",
  cross-checked against all three failing job logs.

The object-store reset is chosen because it is the **superset**: it clears the
boundary state the human analysis blames _and_ the object-store state the
automated review measured, and it is the only reset with a measurement behind
it (`fresh clone --depth=1` → `rc=0`). It is not proof that the mechanism is
understood — the diagnostic in §2 exists so the next occurrence settles that.
