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
`.qwen/scripts/`, `.qwen/rules/`.

File names at any depth, because context files load hierarchically:
`AGENTS.md`, `QWEN.md`, `QWEN.local.md`, `CLAUDE.md`, `package.json`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.mjs`.

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

| Reason code                          | Matches                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ambient_credential:cloud_metadata`  | `100.100.100.200`, `169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`, `metadata.google.internal`, `metadata.goog`                                                                                                                                                                                                                                  |
| `ambient_credential:proc_environ`    | `/proc/<self\|thread-self\|pid\|$$\|$VAR>[/task/<tid>]/environ`                                                                                                                                                                                                                                                                                      |
| `ambient_credential:env_dump`        | `env`, `env -0`, `env --null`, bare `set`, bare `export`, `export -p`, bare `declare`/`typeset` and their `-x`/`-p` forms, in command position followed by a pipe, redirect, separator or end of line; `printenv`; a dump command inside `bash/sh/zsh/dash -c '…'`, including combined flags such as `-lc` and flags preceding `-c` such as `--norc` |
| `ambient_credential:credential_file` | `.aws/credentials`, `.docker/config.json`, `.config/gcloud`, `.kube/config`, `.ssh/id_*`, `.netrc`, `.git-credentials`, and `.credentials` **only at a path boundary**                                                                                                                                                                               |

These run over the PR title, body and added lines, so an instruction carried
only by the body is caught even when the diff is a single harmless docs file.

Two boundaries keep the rules from gating ordinary work. The dump commands share
one terminator lookahead, applied once **outside** their alternation in both the
bare command-position branch and the shell `-c` wrapper: an operator, a closing
paren (so `$(env)` and `(env)` work), end of line, or a quote that closes the
wrapper and is followed by an operator or end of line — which is what reaches a
dump placed after the first command of a `-c` string, such as
`bash -c "cd repo && env"`. An option-taking prefix therefore stays ungated
either way: `set -euo pipefail`, `env FOO=bar cmd`, `env -i FOO=bar node x.mjs`,
`declare -x FOO=bar`, and the same forms wrapped as
`sh -c "set -euo pipefail; make"`. Two earlier revisions are recorded as closed:
the wrapper once had no terminator test at all, which gated each of those wrapped
forms.

`env FOO=bar` with **no utility** is a dump, so an assignment prefix is allowed
before the lookahead while `env FOO=bar cmd` still stops at the utility — the
precision fix that released wrapper false positives had also released that dump
spelling.

And `.credentials` requires a preceding path separator, whitespace, quote
(including a markdown code span's backtick), or line start. The allowed set is **enumerated, not negated**: a negated class such
as `[^.\w]` also admits `?` and `)`, which gated ordinary TypeScript like
`a?.credentials` and `(await client).credentials`. Without any boundary the
pattern also matched the object spread `{ ...credentials }`, which copies an
in-memory object and appears in ordinary product code
(`packages/channels/msteams/src/ingress.ts`). Each of these was measured as a
real false positive before its fix.

### 3. Truncation fails closed

The collect step reads one byte past the cap. A read of exactly the cap is
indistinguishable from a complete diff of that size, so the extra byte is the
truncation witness. When the file exceeds the cap the step emits
`diff_truncated=true`, and the script adds `input:diff_truncated`.

### 4. Unreadable PR metadata fails closed

When the metadata call fails, the collect step used to substitute an empty title
and body while keeping a valid head SHA. The body is a payload channel of its
own, so that substitution silently stopped scanning it: a body-only probe with a
harmless docs diff went back to being admitted whenever the API call failed. The
step now reports `metadata_unavailable=true` and the script adds
`input:metadata_unavailable`. A distinct code is used rather than reusing
`input:diff_unavailable`, because the maintainer-facing reason must say which
input was missing.

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
`.github` path, so a `.github`-only rule misses it. Instruction files are a
stronger channel than a docs page whenever they are loaded, because they enter
the system prompt rather than being read as evidence.

**The path rule is deliberately broader than the channel live today.** An
earlier revision of this design claimed the reviewer loads `QWEN.md` and
`AGENTS.md` from the checked-out contribution. That is not true of the review
lane at this head, and the claim is withdrawn: the review job checks out the
repository's default branch, and workspace memory discovery is gated on folder
trust (`packages/core/src/memory/memoryDiscovery.ts`), whose setting defaults to
false (`packages/cli/src/config/config.ts`) and which the review workflow never
enables. The project-local slot additionally needs implicit discovery and a
resolved project root, and `.qwen/rules/` needs folder trust as well
(`packages/core/src/config/rulesDiscovery.ts`). So `QWEN.local.md` and
`.qwen/rules/` are **latent** instruction slots, not live ones. They are
protected anyway: a lane that later turns trust on — the natural configuration
for interactive use — must not silently widen what an outside contribution can
inject, and a path list is cheap to keep ahead of that change.

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
- **A bare `set` line in non-shell code is gated.** The dump rule cannot tell a
  shell `set` from a lone `set` identifier on its own line, so a destructuring
  pattern written as `const {` / `set` / `} = obj` is held. Accepted: narrowing
  it by surrounding braces would hand an attacker a trivial wrapper, and the
  cost is one maintainer opt-in.
- **Detection remains defence in depth.** #18364 shows an attacker need not
  touch any protected path. Only the out-of-scope credential hardening removes
  the payoff. The env-dump rule enumerates the shapes a shell prints the
  environment with; a shape it does not enumerate still passes, which is why
  the rule is a list of forms rather than a claim of completeness.

## Validation plan

- Unit suite: `node --test .github/scripts/pr-safety-precheck.test.mjs`.
- Real payloads: run the script against the captured title, body and diff of
  #18362 and #18364 and require `manual_required`.
- Mutation witness: remove each new rule in a temporary copy of the module and
  require the corresponding tests to fail, including a whole-file revert to the
  pre-change module. Every arm must assert its anchor matched, so a drifted
  anchor cannot report a silent skip as a kill.
- Workflow end-to-end table: drive the real collect and assess `run:` blocks
  with a stubbed `gh` and assert the final decision, across the cap boundary and
  the metadata-failure arm. A text pin can verify neither a numeric threshold nor
  a fail-open branch.
- Repository gates: `prettier --check`, `eslint`, `actionlint`, and
  `node --test .github/scripts/ci/classify-profile.test.mjs`.

## Acceptance criteria

- Both probe payloads yield `manual_required`, each on at least two independent
  reason codes.
- A diff truncated at the cap yields `input:diff_truncated` even when the
  visible portion is clean.
- An `env VAR=value command` prefix is not gated, nor is `set -euo pipefail`,
  `declare -x FOO=bar`, or an object spread copying credentials.
- Every enumerated dump form is held, including combined shell flags and a
  relative `.credentials` read.
- A metadata read failure yields `input:metadata_unavailable` even when the diff
  is fetched successfully and looks ordinary.
- Trusted authors are unaffected.
- Every mutation arm is killed, with no skipped arm.
- The cap boundary behaves correctly at exactly 2 MiB and at 2 MiB plus one byte.

## Verified results (2026-11-26)

- Unit suite: 116 passed, 0 failed. Four cases drive the real CLI so the flag
  spellings are under test, and one derives the flag names from the CLI source
  and requires the workflow to pass each one from the collect step's matching
  output, including the untrusted path's own echo line — asserting only
  `echo "<name>=` had been satisfied by the trusted branch's `=false`, so deleting
  the untrusted write went unseen. Renaming a flag on either side, or deleting
  that echo, now reds the suite.
- #18362: `protected_path:authority_surface`,
  `ambient_credential:cloud_metadata`, `ambient_credential:env_dump`.
- #18364: `ambient_credential:cloud_metadata`,
  `ambient_credential:proc_environ`.
- Mutation witness: 30 arms, all killed, none skipped, plus an unmutated control
  that must stay green. The harness mirrors the repository layout in its temp
  dir, because the workflow-contract test reads the workflow through a relative
  URL — without the mirror that case reds in every arm for a missing file, and a
  missing file would have passed for a kill. The control is what makes the rest
  of the run worth reading.
- Workflow end-to-end table: 9 cases passed. It executes the real collect and
  assess `run:` blocks under their own bash contract with a stubbed `gh`, and
  asserts the final decision rather than an intermediate flag. Covers
  exactly-cap, cap-plus-one, a failing diff call, a trusted author, and a
  hostile body with the metadata call both succeeding and failing.
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

A second round followed review at the first commit. It closed four reported
gaps — the missing dump forms, the unanchored `.credentials`, the two latent
instruction slots, and the metadata fail-open — and withdrew the context-loading
rationale corrected above. An adversarial pass over that round then found three
problems in the round's own fix, all now closed and pinned: combined shell flags
(`bash -lc "env"`) were still admitted; the new `.credentials` boundary had
introduced a **regression** by no longer matching a relative `cat .credentials`;
and a lone `set` identifier in non-shell code is gated, which is recorded as an
accepted false positive rather than narrowed. A further sibling sweep closed
bare `export`, bare `declare`/`typeset` and their `-p` form, and
`/proc/thread-self/environ`, each of which dumps the same environment as a form
already covered.

A third round followed review of the second commit and closed five more items:
the quoted relative `.credentials` read that the second round's boundary had
dropped; the shell `-c` wrapper's missing terminator test, which gated ordinary
`sh -c "set -euo pipefail; make"`; flags preceding `-c` such as `--norc`;
`/proc/self/task/<tid>/environ`; and the unpinned CLI flags, now covered by
committed CLI cases plus a two-sided workflow contract case. An adversarial pass
over that round found one more problem in its own fix: expressing the
`.credentials` boundary as a negated class `[^.\w]` admitted `?` and `)`, gating
ordinary TypeScript optional chaining and parenthesized property access. The
allowed set is now enumerated, and both false-positive shapes are pinned.

One enumerated-list gap is disclosed rather than closed: a shell flag that takes
a separate argument, as in `bash -o posix -c printenv`, is still admitted.

A fourth round closed six more: the backtick code-span spelling of
`.credentials`; a dump placed after the first command of a `-c` string, which
needed the closing quote to count as a terminator in the bare branch too;
`env FOO=bar` with no utility; the inert `$(…)` and `(…)` anchors, which needed
`)` as a terminator; `--flag=value` before `-c`; and the flag pin's blind spot
where a matching `echo` in the trusted branch hid a deleted untrusted one.
Disclosed rather than chased, since they are option and prefix grammar rather
than the forms this rule enumerates: `env -u NAME`, the quoted-assignment spelling
`env "FOO=bar"`, and command prefixes outside the anchor set — `time env`,
`command env`, `{ env; }`, `! env`, `sudo -E env`.

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
