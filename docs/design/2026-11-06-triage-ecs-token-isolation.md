# Triage on ECS: Token Isolation and Containerization

[English](2026-11-06-triage-ecs-token-isolation.md) | [简体中文](2026-11-06-triage-ecs-token-isolation.zh-CN.md)

- Status: proposed
- Date: 2026-11-06
- Scope: `.github/workflows/qwen-triage.yml` (triage lane only), `.qwen/skills/triage/**`, one new publisher script, workflow pin tests

## Problem statement

GitHub-hosted runner capacity is tight while the maintainer-provided ECS pool
has headroom. The triage lane of `qwen-triage.yml` still routes two trigger
classes to `ubuntu-latest`:

- `issue_comment` reruns (`@qwen-code /triage`), because the comment payload
  carries no `github.event.pull_request` object and the target may be a fork
  PR by an external author;
- automatic `pull_request_target` triage of fork PRs whose author lacks write
  access.

The routing is a deliberate security control, not a technical limitation. The
triage agent runs under `--yolo` with a write PAT
(`QWEN_CODE_BOT_TOKEN || CI_BOT_PAT`) in its environment. The workflow's own
comment block states that the command denylist is not a security boundary,
that "fork PRs run on ephemeral hosted runners" is one of the three real
controls, and that the residual risk — a prompt-injected agent exfiltrating
the PAT or forging bot writes — is fixed structurally by token isolation,
"tracked as a follow-up; not yet wired".

Moving the remaining triggers to the persistent pool without that fix would
let a steered agent persist across runs on reused machines and harvest
credentials from later jobs. The goal of this design is to wire the fix and
then route all triage triggers to ECS.

## Current state

- The `triage` job checks out the trusted base repository, never PR code, and
  reaches the PR/issue only through the API. It runs the agent through
  `QwenLM/qwen-code-action`, which receives the write PAT as
  `GITHUB_TOKEN`/`GH_TOKEN` and the model key directly.
- The skill (`.qwen/skills/triage/`) performs all GitHub writes itself:
  staged comment upserts, reviews with votes, PR/issue closes, issue labels,
  assignee adds, and the `approve-on-green` marker consumed by
  `qwen-triage-finalize.yml`.
- The sibling lanes already implement the isolation contract this design
  reuses: `tmux-testing` and `verify` run in a `node:22-bookworm` container,
  launch the CLI directly via `runuser -u node -- env -i` with empty GitHub
  tokens, keep the real model key behind a root-owned loopback proxy, and
  hand artifacts to separate publisher jobs (`publish-tmux`, `publish-verify`)
  that hold the write credential and never execute agent-provided code.
- `qwen-triage-finalize.yml` consumes bot-authored comments by exact marker
  bytes and bot login. Any replacement write path must preserve both.

## Goals

1. Route every triage trigger (issues, `pull_request_target` including
   external fork PRs, `issue_comment`, `workflow_dispatch`) to the ECS pool
   when it is enabled, with the existing hosted fallback when
   `MAINTAINER_ECS_RUNNER_DISABLED=true`.
2. Remove the write PAT from the agent environment. The agent reads GitHub
   with a short-lived read-only token and expresses every write as a
   validated draft executed by a separate publisher.
3. Contain the agent job so nothing it does persists on the runner host
   beyond the sanitized workspace, and keep the real model key out of the
   agent environment.
4. Preserve every downstream contract: marker bytes, bot identity, the
   `approve-on-green` protocol, lifecycle comments, and local `/triage`
   usability.

## Non-goals

- No changes to the `tmux-testing`, `verify`, `publish-tmux`, or
  `publish-verify` jobs, to `qwen-triage-finalize.yml`, or to the
  `/review` pipeline (`qwen-code-pr-review.yml`).
- No change to triage's judgment logic, stage structure, guardrails, or
  comment templates.
- No extraction of the shared model-proxy script (third inline copy here;
  extraction is a follow-up).
- The two pre-existing inconsistencies listed under Observations are recorded
  but not fixed.

## Proposed changes

### A. Runner routing

The `triage` job's `runs-on` collapses to the `publish-tmux` shape:

```
(repo == QwenLM/qwen-code && MAINTAINER_ECS_RUNNER_DISABLED != 'true')
  → ['self-hosted', 'linux', 'x64', 'ecs-qwen']
  → otherwise ['ubuntu-latest']
```

The `author_can_write` output of `authorize` exists only to route triage;
after this change it has no consumer and is removed together with its
permission lookup in the `pull_request_target` branch. The `verify_trust`
classification and every deny gate are unchanged. `precheck-pr` still gates
automatic fork-PR triage.

Routing no longer depends on who authored the target PR because the controls
below, not the machine choice, carry the trust boundary. The hosted fallback
remains safe: the controls are additive.

### B. Token isolation

#### B1. Read-only agent credentials

The `triage` job gets an explicit job-level `permissions` block:
`contents: read`, `issues: read`, `pull-requests: read`, `checks: read`,
`actions: read`. The agent receives this job-scoped `GITHUB_TOKEN` as its
`GH_TOKEN`. It is read-only, expires with the job, and is worthless for
forging bot writes. The pre-agent eyes-reaction step switches from
`GITHUB_TOKEN` to the bot PAT (reactions need write scope).

Two reads in today's skill cannot work with that token and move host-side:

- **Collaborator-permission lookups.** The deterministic maintainer resolver
  calls `repos/{repo}/collaborators/{login}/permission`, which requires a
  write-level token. The whole resolver (env handle override → owner map +
  canWrite filter + load rotation via `.github/scripts/assign-issue-owner.mjs`
  → most-recent-human-reviewer fallback) moves into the publisher script.
  The agent's defer draft carries only the reason; the publisher resolves the
  maintainer, prepends the @mention, posts the comment, and adds the assignee
  best-effort.
- **Cross-repository read.** Stage 1c reads
  `repos/anthropics/claude-code/contents/CHANGELOG.md` as an optional
  direction signal; `GITHUB_TOKEN` is scoped to this repository. A host step
  pre-fetches the file (best-effort, with the PAT) into the agent's context
  directory; the skill greps the local file and treats a missing file as
  "signal unavailable", which the skill already accepts as non-blocking.

The bot login used by the skill's author filters (duplicate guard, reopen
guard, review dedup) is resolved by a host step with the PAT and passed to the
agent as `BOT_LOGIN`; `gh api user` under the read-only token would return
`github-actions[bot]` and silently break every author filter.

#### B2. Draft protocol

The agent stops issuing GitHub write commands. Instead it writes, into a
host-prepared directory exported as `QWEN_TRIAGE_DRAFT_DIR`:

```
actions.jsonl        # ordered actions, one JSON object per line
bodies/<name>.md     # comment and review bodies referenced by actions
```

Action vocabulary (the complete write surface of today's skill):

```json
{"action":"upsert-comment","marker":"stage=1","body":"bodies/stage-1.md"}
{"action":"review","event":"APPROVE","commit_id":"<head oid>","body":"bodies/review.md"}
{"action":"review","event":"REQUEST_CHANGES","body":"bodies/review.md"}
{"action":"close-pr"}
{"action":"close-issue","reason":"not planned"}
{"action":"labels","add":["type/bug"],"remove":["status/need-information"]}
{"action":"defer","body":"bodies/defer.md"}
```

The `approve-on-green` marker is not an action: it stays a line inside the
Stage 3 comment body, exactly as today, so the finalize workflow sees no
change.

#### B3. Publisher

One new script, `.github/scripts/triage-publish.mjs`, is the single
implementation of the write path for both CI and local use. It:

1. Parses and validates the whole draft set before writing anything
   (fail-closed preflight): unknown actions or fields reject the set;
   `marker` must be in the allowlist (`stage=1`, `stage=2`, `stage=3`,
   `stage=1-pre`, `stage=1b`); every comment body must start with the exact
   `<!-- qwen-triage <marker> -->` line (the publisher enforces the prefix,
   the agent is not trusted for it); bodies over GitHub's 65,536-character
   limit are rejected, not truncated (truncation could cut the CI-region or
   approve-on-green markers); review events are limited to `APPROVE` and
   `REQUEST_CHANGES`; `APPROVE` requires `commit_id`; body paths must resolve
   to regular files inside the draft directory; `actions.jsonl` and `bodies/`
   must themselves be a regular file and a real directory (lstat — a
   symlinked container would redirect the realpath containment base);
   `review` and `close-pr` require a PR target, `close-issue` an issue
   target, and `labels` rejects the process labels SKILL.md places
   off-limits.
2. Executes the actions in order, best-effort per action with a per-action
   result summary:
   - `upsert-comment`: bot-owned + body-startswith-marker dedup, last match
     wins, PATCH else POST — the `publish-tmux` discipline, including
     fail-closed identity resolution.
   - `review`: re-reads the head; an `APPROVE` whose `commit_id` no longer
     matches the head is skipped as stale (mirrors finalize). Idempotence:
     the bot's own `APPROVED` at that commit, or an existing
     `CHANGES_REQUESTED`, suppresses a duplicate.
   - `close-pr` / `close-issue`: only when the target is still open.
   - `labels`: verifies every label exists before applying, never creates,
     and rejects the process labels (`welcome-pr`, `maintainer`,
     `help wanted`, `good first issue`) that SKILL.md places off-limits.
   - `defer`: runs the moved maintainer resolver, posts the comment with the
     resolved @mention (or without one if nothing resolves), adds the
     assignee best-effort.

In CI a new `publish-triage` job runs the script: `needs: triage`,
`if: always() && needs.triage.result != 'skipped'` (so drafts written before
a timeout or failure still publish), per-RUN concurrency group and 10-minute
cap like the sibling publishers, `publish-tmux` runner routing, and a sparse
checkout of only the publisher script, `assign-issue-owner.mjs`, and
`issue-owners.json`, pinned to `github.sha` with `persist-credentials: false`
(the `publish-verify` pattern). Because the job may land on the persistent
pool, it takes the agent jobs' workspace precautions before that checkout:
ownership restore and a `Recreate runner Git metadata` step, so git metadata
planted by an earlier run cannot execute in the job that then publishes with
the PAT (pinned by `qwen-runner-checkout-workflow.test.js`). It downloads the
drafts artifact — collected with the sibling lanes'
symlink/non-regular-file strip — and runs the script with the bot PAT. The PAT never enters the triage job's agent environment,
and the publisher never executes agent-provided code, only data.

Locally, the skill runs the same script at the end of the run with the user's
own `gh` auth. One protocol, one implementation, two credential contexts.

#### B4. Skill changes

`SKILL.md`, `references/pr-workflow.md`, and `references/issue-workflow.md`
replace every write command with the corresponding draft write, keep all
reads, and keep every marker byte-identical. A new "Publishing" section
defines the two modes: when `QWEN_TRIAGE_PUBLISH=workflow` (set only by the
workflow) the agent drafts and stops — the CI denylist blocks `node`, so it
structurally cannot run the publisher itself; otherwise it runs
`triage-publish.mjs` as its final step. The resolver heredoc and the
cross-repo CHANGELOG fetch leave the skill. The Rules text about the CI write
PAT is updated to describe the read-only token.

### C. Containerization and agent launch

The `triage` job adopts the sibling contract:

- `container: node:22-bookworm` with `--init`; a tools step installs
  `gh`, `jq`, `git`, `ca-certificates` (the tmux resolver-tools step).
- The action step is replaced by a direct CLI launch in the same shape as
  tmux/verify: the model proxy starts in the same step (third inline copy of
  the hardened loopback proxy — ephemeral port, nonce health check, bearer
  dummy key), then `timeout … runuser -u node -- env -i … qwen --auth-type
openai --approval-mode yolo --prompt '/triage …' --output-format stream-json`.
  The explicit environment carries the read-only `GH_TOKEN`, `BOT_LOGIN`,
  the draft-directory variables, a fresh per-run `QWEN_HOME`, and the proxy
  endpoint instead of the real model key. The denylist/settings block moves
  with the launch unchanged in substance.
- The replacement step keeps the name `Run Qwen Triage` and the id `triage`,
  and extracts the result frame of `output.jsonl` into the same `summary`
  output, so `Check triage response` — whose `RESPONSE`/`TRIAGE_OUTCOME` env
  literals are pinned — stays byte-identical and its API-error suffix
  detection is untouched. The settings/denylist block moves verbatim into a
  settings file the host writes into the fresh per-run `QWEN_HOME` before
  launch.
- Existing workspace hygiene stays (ownership restore, stale-agent-state
  sanitize, git-metadata recreate); the base checkout adds
  `persist-credentials: false`, and an end-of-job ownership-restore step
  mirrors tmux. Drafts upload as an artifact with the non-regular-file
  strip; before the strip, lingering agent-user processes are killed
  (zombies excluded — an unkillable survivor drops the draft set
  deny-by-default), closing the re-plant race between strip and upload.
  The gh/git proxy-wrapper directory is made traversable by the agent user
  (mktemp's 700 would silently drop the wrappers from its PATH), and the
  toolchain step installs `util-linux` for `runuser`, as the sibling lanes
  do.

## Key design decisions

| Decision                                                                 | Rationale                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only `GITHUB_TOKEN` for agent reads, not a new read-only PAT secret | Job-scoped, ephemeral, no new secret to provision or rotate; the two reads it cannot serve move host-side                                                                 |
| Drafts + separate publisher job, not a write proxy sidecar               | Matches `publish-tmux`/`publish-verify`; the credential is isolated by a job boundary, and the publisher is a deterministic, unit-testable script                         |
| One publisher script for CI and local                                    | Prevents the two write paths from drifting; local `/triage` keeps working with the user's own auth                                                                        |
| Stage comments publish in a batch at the end                             | A sidecar that streams drafts would reintroduce a live write channel into the agent job. The lifecycle comment with the live-run link already covers progress observation |
| Maintainer resolver moves to the publisher                               | It is deterministic (owner map, canWrite, load rotation) and needs a write-level token; it was never agent judgment                                                       |
| `author_can_write` removed                                               | Its only consumer was triage routing; a dead switch is a review finding, not a compatibility asset                                                                        |
| Third inline model-proxy copy                                            | Extraction would touch the tmux/verify lanes and their pins; recorded as a follow-up                                                                                      |
| Publisher runs on partial runs (`always()`)                              | Drafts written before a timeout still reach the PR; the lifecycle comment records the early end                                                                           |
| Keep the step name/id `triage` and its `summary` output                  | `Check triage response`'s env literals are pinned; preserving them keeps the failure-detection contract intact without pin churn                                          |

## Contract preservation

- Markers (`stage=N`, `qwen-triage-ci sha=…` region, `approve-on-green sha=…`,
  lifecycle) stay byte-identical; the publisher posts bodies as-is after
  prefix validation.
- All writes still land under the PAT's bot identity, so
  `qwen-triage-finalize.yml`'s author filters, CI-region replacement, and
  deferred approvals work unchanged.
- `Finalize triage status comment` stays in the triage job (`always()`); it
  consumes the pre-agent comment id and API state, not workspace files.
  `Notify silent triage re-run` MOVES to `publish-triage`, after the publish
  step: it inspects the reviews the run posted, and those now land at publish
  time, so running it in the agent job would always see "no review". Its body
  is unchanged; only the number source becomes
  `needs.triage.outputs.pr_number`.
- The duplicate guard, reopen guard, and review dedup keep their semantics;
  only the credential behind the reads changes.

## Files affected

- `.github/workflows/qwen-triage.yml` — triage job (routing, permissions,
  container, launch, drafts upload), authorize (drop `author_can_write`),
  new `publish-triage` job.
- `.github/scripts/triage-publish.mjs` — new publisher (validation +
  execution + maintainer resolver).
- `.qwen/skills/triage/SKILL.md`, `references/pr-workflow.md`,
  `references/issue-workflow.md` — draft protocol, publishing modes, moved
  resolver and CHANGELOG fetch, updated Rules text.
- `.github/scripts/qwen-triage-workflow.test.mjs` (node:test, executed by the
  `lint_and_static` HELPER_TESTS step in `ci.yml`) — the routing pins at
  lines 701-756 encode the OLD trust model (`author_can_write`, the `issues`
  branch) and are rewritten to pin the NEW contract: ECS routing with the
  hosted kill-switch fallback, no `author_can_write`, job-level read-only
  permissions, no write PAT in the agent environment, container present, and
  the settings/denylist content in the host-written settings file. The
  hygiene pins (stale-state sanitize, ownership restore) keep their
  step-name contracts.
- `scripts/tests/qwen-triage-workflow.test.js` (vitest) — step-name/env
  literal pins survive where the design keeps them (status claim/finalize,
  `Check triage response`, the `QWEN_HOME` path); the `QWEN_HOME` env-literal
  pin moves to the `env -i` list; new assertions cover the publish job and
  the drafts artifact strip. The verify-lane runuser-count pin is untouched
  (this change adds no step to that interval).
- `scripts/tests/qwen-runner-checkout-workflow.test.js` — no change expected:
  `Recreate runner Git metadata` stays immediately before checkout.
- `scripts/tests/triage-publish.test.js` — new unit tests for the publisher
  (validation fail-closed cases, dedup, idempotence, resolver, per-action
  failure reporting) against a stubbed `gh`.
- `.github/workflows/.size-baseline` — bump the `qwen-triage.yml` entry in
  this PR (see Constraints).
- `.github/workflows/.ci-budget` — bump the `qwen-triage.yml` entry
  (7→8 jobs, 280→290 declared timeout-minutes) for the new publish job;
  the sibling ratchet aborts `Lint & Static` otherwise.
- This design pair.

## Constraints and risks

- **No pre-merge live trigger.** `issue_comment` and `pull_request_target`
  workflows run from the default branch; the new path can only be exercised
  live after merge. Pre-merge confidence comes from the pin/replay suites,
  publisher unit tests, and a local end-to-end draft→publish dry run.
- **Batched stage comments** are a visible UX change: results land when the
  run ends, not per stage. The lifecycle comment keeps the live log link.
- **Publisher is a new single point of failure.** A preflight rejection
  publishes nothing; the job fails loudly, the lifecycle comment records the
  early end, and a re-run recovers. Per-action execution failures are
  reported individually.
- **Skill/publisher drift.** The publisher's allowlist is authoritative;
  pin tests bind the marker set and the draft-mode contract on both sides.
- **Residual risk after the change.** A prompt-injected agent can still
  draft malicious content within triage's intended capability (a wrong
  review, a misleading comment) — that is the product's inherent surface,
  reviewed by humans. It can no longer exfiltrate a write credential, forge
  writes outside the vocabulary, or persist on the host.
- **Workflow size ratchet.** `qwen-triage.yml` is gated by
  `.github/scripts/check-workflow-size.sh` (absolute cap 470,000 bytes;
  growth beyond `.size-baseline` + 4,096 fails CI). The file already sits
  ~1.2 KB over its 378,242-byte baseline, leaving ~2.9 KB of headroom; the
  inline proxy and the publish job exceed it, so the baseline entry must be
  bumped in the same PR. Publisher logic lives in the script, not the YAML,
  to keep the growth bounded.

## Validation plan

1. `scripts/tests` pin suites updated and green, including new assertions:
   triage `runs-on` shape, job-level read-only permissions, agent environment
   contains no write PAT, container present, publish job shape, marker
   allowlist parity between skill and publisher.
2. Publisher unit tests green, with mutation witnesses (removing a validation
   rule or the bot-identity filter must turn a test red).
3. Workflow YAML parses with the repository's `node yaml` tooling; workflow
   replay harnesses that execute inline shell steps pass.
4. Local end-to-end dry run: `/triage` on a scratch PR against a test repo (or
   a real PR with writes confirmed), verifying draft→publish produces the
   same comment/review shape as today.
5. Post-merge observation checklist on the first live runs: comment triggers
   and automatic fork-PR triage land on ECS; stage comments, lifecycle,
   rerun-summary, and a deferred approve-on-green round-trip through
   finalize; kill-switch fallback exercised once.

Commands (repository root):

```bash
PATH="$HOME/.local/bin:$PATH" npx vitest run \
  --config ./scripts/tests/vitest.config.ts \
  scripts/tests/qwen-triage-workflow.test.js \
  scripts/tests/qwen-runner-checkout-workflow.test.js \
  scripts/tests/workflow-size.test.js
node --test .github/scripts/qwen-triage-workflow.test.mjs
```

The vitest suites silently skip jq-gated cases when `jq` is missing from
`PATH`; the `.mjs` suite is node:test (not vitest) and needs the `yaml`
package installed. The size gate runs in CI's `lint_and_static` job and is
mirrored by `scripts/tests/workflow-size.test.js`.

## Acceptance criteria

- With the pool enabled, every triage trigger runs on ECS; with
  `MAINTAINER_ECS_RUNNER_DISABLED=true`, all fall back to hosted and still
  work.
- The agent environment carries no write credential and no real model key
  (structural property of the `env -i` list, pinned by tests).
- The publisher executes the full action vocabulary; finalize interop is
  unchanged; local `/triage` works through the same publisher.
- All updated pin suites and new unit tests pass; YAML validates.
- The post-merge observation checklist completes without contract drift.

## Open questions

- Whether to extract the three inline model-proxy copies into one shared
  script in a follow-up (touches tmux/verify pins).
- Whether the batched-comment UX warrants a lightweight progress signal
  beyond the lifecycle comment (no action proposed now).

## Observations (pre-existing, out of scope)

- The `Notify silent triage re-run` step assumes a defer leaves a `COMMENTED`
  review, but the skill's defer path posts an issue comment plus an assignee
  and never submits a `COMMENT` review. The `deferred` branch of that step
  appears unreachable today.
- `SKILL.md` forbids touching the `welcome-pr` process label while
  `references/issue-workflow.md` instructed adding it for unreproduced bugs.
  Resolved during review: the publisher now rejects all process labels at
  the chokepoint, and the issue-workflow instruction was aligned with the
  rule.
