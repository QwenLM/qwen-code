# PR Safety Precheck: Authority-Surface Gate

[English](pr-safety-precheck-authority-gate.md) | [简体中文](pr-safety-precheck-authority-gate.zh-CN.md)

Status: implemented and verified locally on 2026-11-25. The runner-side
credential hardening described under "Out of scope" is not part of this change.

## Problem statement

On 2026-11-25 two fork pull requests from the same author probed the automation
that reviews outside contributions. Both were closed by their own author within
minutes of opening.

- #18362 modified `.github/scripts/check-disk-floor.sh`, a script CI executes
  after checking out the PR head. The added function dumped the process
  environment and walked the Alibaba Cloud and AWS instance metadata endpoints
  for RAM/IAM role credentials.
- #18364 added `docs/runner-preflight.md` and a PR body that instructed the
  review agent to run each listed command with its shell tool and paste the raw
  output verbatim into a public comment. The list included
  `/proc/self/environ` and the same metadata endpoints.

Neither payload names a GitHub secret. The first targets credentials the runner
host holds ambiently; the second targets the reviewer itself.

## Current state

Three observations, each measured on the two pull requests above.

1. **The manual fork approval gate does not cover the attacked workflows.**
   GitHub's "Approve workflows to run" setting gates `pull_request` events from
   forks. `pull_request_target` runs the base-branch definition with base-repo
   privileges and is exempt. On both pull requests the `pull_request_target`
   triage and review workflows started within one second of the pull request
   being opened, while the `pull_request` CI run recorded zero jobs. Relying on
   a maintainer clicking the right button protects the lane that was not
   attacked, and still depends on a human recognising a payload phrased as
   "read-only diagnostics".

2. **The existing code-level precheck passed both payloads.**
   `.github/scripts/pr-safety-precheck.mjs` returned `allow_triage` with an
   empty `reason_codes` array for both. Its rules are a blocklist that pairs a
   JavaScript logging or network sink with a _named_ secret reference
   (`secrets.*`, `process.env.*_API_KEY`, `GITHUB_TOKEN`). A bash `echo` is not a
   sink, an ambient credential source is not a named secret, and the injection
   wording rules only match known phrases such as "ignore previous
   instructions". The precheck also never looked at which paths a pull request
   changes.

3. **A capped diff could be reported as a clean one.**
   `.github/workflows/qwen-pr-safety-precheck.yml` piped `gh pr diff` through
   `head -c 2MiB` and tolerated the resulting SIGPIPE status. A payload placed
   past the cap was therefore never scanned. Verified: a payload that the
   existing rules do catch (`sensitive_diff:secret_network`) flips to
   `allow_triage` once padding pushes it beyond 2 MiB.

The repository already documents the underlying exposure in
`.github/workflows/qwen-code-pr-review.yml`: "a prompt-injected agent with
arbitrary code execution already holds the job's PAT, network and unsandboxed
shell."

## Goals

- Decide admission from what a pull request _can reach_, not from whether its
  wording matches a known-bad phrase.
- Fail closed before an agent runs, at the gate that already controls agent
  admission.
- Keep the decision reproducible from the pull request alone, so a maintainer
  can re-run it.

## Scope boundaries

In scope: `.github/scripts/pr-safety-precheck.mjs`, its colocated test, and the
diff-collection step of `.github/workflows/qwen-pr-safety-precheck.yml`.

Out of scope, and still required to make this attack class worthless:

- Attaching no RAM role to CI runner instances, or hardening the instance
  metadata service so containers cannot reach it. A disposable runner is not a
  credential-free runner, and container isolation is not credential isolation.
- A default-deny egress allowlist for the review agent. The existing
  `configure_qwen_network` helper is a proxy bypass for the model host, not an
  egress restriction.
- Redaction of agent-authored comment bodies before publication.

## Proposed solution

Three additions to the precheck, all applied only to authors without write
access.

### 1. Authority-surface paths

A change to a path that decides what CI executes, or what the agent reads as
instructions, yields `protected_path:authority_surface`.

Directory prefixes: `.github/`, `.agents/`, `scripts/`, `.qwen/skills/`,
`.qwen/commands/`, `.qwen/agents/`, `.qwen/workflows/`, `.qwen/extensions/`,
`.qwen/scripts/`.

File names at any depth, because context files load hierarchically:
`AGENTS.md`, `QWEN.md`, `CLAUDE.md`, `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.mjs`.

Exact paths: `.qwen/settings.json`.

Paths are derived from the diff, the only path source the workflow supplies.
`---` and `+++` headers carry one unambiguous path each, so deletions, renames
and paths containing spaces are covered; the `diff --git` header additionally
covers mode-only changes, which emit no side headers.

Git quotes a path containing a tab, a newline or, with `core.quotePath`, a
non-ASCII byte. A quoted `.github/...` no longer matches a prefix test, so the
parser unquotes before testing. Verified as a real bypass before the fix: a file
added as `.github/workflows/evil<TAB>.yml` returned `allow_triage`.

### 2. Ambient credential sources

The source itself is the signal; no sink pairing is required.

| Reason code                          | Matches                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ambient_credential:cloud_metadata`  | `100.100.100.200`, `169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`, `metadata.google.internal`, `metadata.goog`                    |
| `ambient_credential:proc_environ`    | `/proc/<self\|pid\|$$\|$VAR>/environ`                                                                                                  |
| `ambient_credential:env_dump`        | `env` in command position followed by a pipe, redirect, separator or end of line; `printenv`; `export -p`                              |
| `ambient_credential:credential_file` | `.aws/credentials`, `.docker/config.json`, `.config/gcloud`, `.kube/config`, `.ssh/id_*`, `.netrc`, `.git-credentials`, `.credentials` |

These run over the PR title, body and added lines, so an instruction carried
only by the body is caught even when the diff is a single harmless docs file.

### 3. Truncation fails closed

The collect step reads one byte past the cap. A read of exactly the cap is
indistinguishable from a complete diff of that size, so the extra byte is the
truncation witness. When the file exceeds the cap the step emits
`diff_truncated=true`, and the script adds `input:diff_truncated`.

## Design decisions and rationale

**Gate, do not auto-close.** Closing a pull request cannot preempt the attack:
the `pull_request_target` workflows start within one to two seconds, and any
detector that closes the pull request is itself a `pull_request_target` workflow
running in parallel. Both probe pull requests were closed by their own author,
so closing is the outcome the attacker already wants. `manual_required` instead
withholds agent admission and leaves a maintainer able to opt in with
`@qwen-code /triage` or `@qwen-code /review`.

**Show capability facts, not diff prose.** The manual-approval comment lists
reason codes such as `protected_path:authority_surface`. A maintainer is asked
to judge "this pull request changes a CI script", not to spot malicious wording
that a human reads as routine diagnostics.

**Protect the agent instruction surface, not only `.github`.** #18364 changes no
`.github` path, so a `.github`-only rule misses it. Project context files are a
stronger channel than a docs file: the CLI loads `QWEN.md` and `AGENTS.md` from
the checked-out head, and the review workflow's generated `settings.json` sets
a shell timeout and, when configured, a reasoning effort — it does not disable
context loading.

**Narrow `.qwen/` to authority-bearing subdirectories.** Working artifacts such
as `.qwen/e2e-tests/` carry no authority; gating them would add noise without
reducing exposure.

**Keep the trusted-author short circuit.** Authors with write access bypass all
content rules, as before. Only a missing head SHA still fails closed for them.

## Constraints

- The precheck runs on `ubuntu-latest` with a read-only token and checks out
  only its own trusted script from the default branch. The new rules add no
  network call and no dependency.
- The diff cap stays at 2 MiB. Raising it is not a substitute for failing closed.
- Reason codes are part of the public comment contract; existing codes are
  unchanged.

## Risks

- **False positives gate legitimate contributions.** In a sample of 80 open
  pull requests on 2026-11-25, out of 578 open in total, 67 had authors without
  write access and 7 of those touch a protected path. The sample is not a
  repo-wide rate. The cost per hit is a maintainer opt-in, not a rejection.
- **The repository's own fixtures contain metadata addresses.**
  `packages/network-policy/src/network-policy.test.ts` and
  `packages/core/src/utils/fetch.test.ts` include the IMDS literals, so an
  outside pull request editing them is gated. Accepted for the same reason.
- **Detection remains defence in depth.** #18364 shows an attacker need not
  touch any protected path. Only the out-of-scope credential hardening removes
  the payoff.

## Validation plan

- Unit suite: `node --test .github/scripts/pr-safety-precheck.test.mjs`.
- Real payloads: run the script against the captured title, body and diff of
  #18362 and #18364 and require `manual_required`.
- Mutation witness: remove each new rule in a temporary copy of the module and
  require the corresponding tests to fail, including a whole-file revert to the
  pre-change module. Every arm must assert its anchor matched, so a drifted
  anchor cannot report a silent skip as a kill.
- Shell decision table: drive the real collect step with a stubbed `gh` across
  the cap boundary, because a text pin cannot verify a numeric threshold.
- Repository gates: `prettier --check`, `eslint`, `actionlint`, and
  `node --test .github/scripts/ci/classify-profile.test.mjs`.

## Acceptance criteria

- Both probe payloads yield `manual_required`, each on at least two independent
  reason codes.
- A diff truncated at the cap yields `input:diff_truncated` even when the
  visible portion is clean.
- An `env VAR=value command` prefix is not gated.
- Trusted authors are unaffected.
- Every mutation arm is killed, with no skipped arm.
- The cap boundary behaves correctly at exactly 2 MiB and at 2 MiB plus one byte.

## Verified results (2026-11-25)

- Unit suite: 61 passed, 0 failed.
- #18362: `protected_path:authority_surface`,
  `ambient_credential:cloud_metadata`, `ambient_credential:env_dump`.
- #18364: `ambient_credential:cloud_metadata`,
  `ambient_credential:proc_environ`.
- Mutation witness: 8 arms, all killed, none skipped. One arm widens the `env`
  rule instead of removing it, so the false-positive guard is pinned too.
- Shell decision table: 6 cases passed, including exactly-cap and cap-plus-one.
- `prettier --check`, `eslint`, `actionlint`: clean. Both `eslint` and
  `actionlint` were first proven live against a deliberately invalid input.
- `classify-profile.test.mjs`: 27 passed, 0 failed.
- `scripts/tests/qwen-autofix-workflow.test.js`: 57 failed, 287 passed,
  13 skipped — identical counts and an identical set of 57 failing test names
  with the change stashed. Every failure is an `ENOENT` for the harness's own
  temporary `typescript.cjs`, a worktree prerequisite gap unrelated to this
  change.

Three pre-existing tests asserted that untrusted `.github` and `scripts/`
changes are allowed. They were retargeted to the new policy rather than deleted,
and one fixture was corrected to carry a real diff header so it exercises the
path rule instead of passing vacuously.

## Open questions

- The review run for #18364 aborted at its first check because `CI_BOT_PAT` was
  empty, while an in-repo review in the same minute succeeded. The mechanism was
  not determined. Until it is, an empty secret must not be counted as a control.
- Whether dependency manifests should stay in the protected set given that
  automated dependency pull requests will now require a maintainer opt-in.
- Whether `gh pr diff` can itself return a silently shortened patch for a very
  large pull request. The witness byte only detects truncation by this step; an
  upstream short read would arrive under the cap and look complete. Not measured
  here, so it is not claimed to be closed.
