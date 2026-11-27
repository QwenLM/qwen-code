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

Four additions to the precheck, all applied only to authors without write access.

### 1. Authority-surface paths

A change to a path that decides what CI executes, or what the agent reads as
instructions, yields `protected_path:authority_surface`.

Directory prefixes: `.github/`, `.agents/`, `scripts/`, `.qwen/skills/`,
`.qwen/commands/`, `.qwen/agents/`, `.qwen/workflows/`, `.qwen/extensions/`,
`.qwen/scripts/`, `.qwen/rules/`, `.qwen/hooks/`, `.qwen/fork-profiles/`,
`patches/`, `eslint-rules/`. This is an incomplete initial surface, not an
inventory of every executable lifecycle target; installed git hooks and package
lifecycle script targets are not additionally enumerated here.

File names at any depth, because context files load hierarchically:
`AGENTS.md`, `QWEN.md`, `QWEN.local.md`, `CLAUDE.md`, `package.json`,
`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `eslint.config.js`,
`esbuild.config.js`, `vitest.config.ts`, `.npmrc`, `.pnpmfile.mjs`,
`.mcp.json`, `copilot-instructions.md`, `eslint.legacy-filenames.mjs`,
`eslint.legacy-core-barrel-imports.mjs`. Settings variants follow the repository's own self-modification
glob at any depth: `.qwen/settings.json` and `.qwen/settings.<variant>.json`.
Exact paths: `.qwen/output-language.md`, `.qwen/review-rules.md`, and
`.qwen/review-context.json`.

Paths are derived from the diff, the only path source the workflow supplies.
Side headers (`---` and `+++`) are recognized only outside hunks, so example
diff content cannot manufacture a protected path. Mode-only and binary changes
rely on their `--git` header, accepted from the split whose normalized halves
agree even when the path itself contains ` b/`.

Git quotes a path containing a tab, a newline or, with `core.quotePath`, a
non-ASCII byte. A quoted `.github/...` no longer matches a prefix test, so the
parser unquotes before testing. Verified as a real bypass before the fix: a file
added as `.github/workflows/evil<TAB>.yml` returned `allow_triage`.

### 2. Ambient credential sources

For the recognized forms, the source is a review signal; no sink pairing is
required. Unrecognized forms are not certified safe.

| Reason code                          | Matches                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ambient_credential:cloud_metadata`  | `100.100.100.200`, `169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`, `metadata.google.internal`, `metadata.goog`, plus URLs whose parser-normalized host is one of those addresses: integer, hexadecimal, and other `inet_aton` spellings count too                                                                                                                                            |
| `ambient_credential:proc_environ`    | `/proc/<self\|thread-self\|pid\|$$\|$VAR>[/task/<tid>]/environ`                                                                                                                                                                                                                                                                                                                                   |
| `ambient_credential:env_dump`        | `env`, `env -0`, `env --null`, bare `set`, bare `export`, `export -p`, bare `declare`/`typeset` and their `-x`/`-p` forms, in command position followed by a pipe, redirect, separator or end of line; `printenv`; a dump command inside `bash/sh/zsh/dash -c '…'`, including combined flags such as `-lc` and argumentless or `=`-attached flags preceding `-c` such as `--norc` or `--rcfile=…` |
| `ambient_credential:credential_file` | `.aws/credentials`, `.docker/config.json`, `.config/gcloud`, `.kube/config`, `.ssh/id_*`, `.netrc`, `.git-credentials`, and `.credentials` **only at a path boundary**                                                                                                                                                                                                                            |

These run over the PR title, body and added lines, so an instruction carried
only by the body is caught even when the diff is a single harmless docs file.
`printenv` takes no terminator either bare or wrapped in shell `-c`; its arguments
are not option grammar. List-item commands (`1. env`, `- env`) and an unquoted `-c`
argument are also recognized. A file descriptor before a redirect is a legal dump
terminator; this remains a list of supported forms, not exhaustive shell parsing.

**The textual surface is deliberately bounded, not “secured once and for all”.**
Further command aliases, quoted or absolute-path commands, line continuations,
`/proc` glob and bracket expansions, and additional credential filenames such as
`.npmrc` and `.config/gh/hosts.yml` remain disclosed review gaps. Adding one
spelling after another cannot establish safety and repeatedly changes what counts
as ordinary prose, so this PR does not keep widening those grammars. The gaps are
left for the maintainer reading the reason codes rather than presented as closed.
This is a disclosure of exposure, not a completed runner or egress control.

Host normalization applies only to explicit `http(s)://` URLs; a numeric host
token without a scheme and DNS aliases that resolve to a metadata IP (such as
`169.254.169.254.nip.io` or an attacker-controlled domain) are outside the
claim. The exact `.credentials` basename
does not include the runner's `.credentials_rsaparams` private key, or other
credential filenames. Likewise, this PR does not infer every installed git hook
or workspace lifecycle target from the manifests. Those inputs can still be
admitted unless another rule fires; removing their execution authority requires
controls in the runner environment, not further literal additions here.

The command-position anchors also exclude reserved-word positions such as `then`
and `do`, a leading assignment prefix such as `FOO=1 env`, and a trailing `#`
comment after a dump. The shell `-c` wrapper does not recognize separate-argument
flags preceding `-c` (such as `bash -o pipefail -c 'env'` or
`bash -o posix -c printenv`) or a subshell opening token as the first token
inside the quoted string (such as `sh -c '(env)'`). These forms are not repaired
by this change and remain admitted unless a different rule fires.

Two boundaries keep the rules from gating ordinary work. Both the bare
command-position branch and the shell `-c` wrapper apply their terminator
lookahead once **outside** the dump-command alternation, accepting operators,
`<` / `>` redirects (including file-descriptor prefixes `\d*[<>]` such as `1>`
and `2>&1`), closing parens, end of line, and closing quotes (in the bare branch
a closing quote must itself be followed by an operator, redirect, or end of line,
which reaches a dump after the first command of a `-c` string such as
`bash -c "cd repo && env"`; in the `-c` wrapper branch the closing quote itself
terminates the script). An option-taking prefix therefore stays ungated
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

**Project context files load by default, and this design got the trust flag
backwards twice before measuring it.** The original draft claimed the reviewer
reads `QWEN.md` and `AGENTS.md` from the contribution. A later revision withdrew
that as untrue, saying memory discovery is gated on folder trust and folder trust
defaults to false, so those slots were "latent". **That withdrawal was wrong.**
Folder trust is an opt-in hardened mode, not an opt-out of trust:
`isWorkspaceTrusted()` returns `isTrusted: true` when the feature is off, and
`Config.isTrustedFolder()` then supplies it to the loader as
`this.getIdeWorkspaceTrust() ?? this.trustedFolder ?? !this.folderTrust`. Measured
by calling `isWorkspaceTrusted` directly: with no setting and with
`enabled: false` the result is `isTrusted = true`; only with `enabled: true` and no
stored decision does it come back `undefined`. So `QWEN.md`, `AGENTS.md`,
`QWEN.local.md`, `.qwen/rules/` and `.qwen/output-language.md` are **live**
instruction inputs in an ordinary project session.

**What actually insulates the review lane is the checkout, not the flag.** The
review job checks out the repository's default branch and starts the CLI there,
so a fork head's files are not the startup workspace. That is the only reason
this lane does not read a contribution's context files, and it is why the path
list has to stay ahead of any lane that ever runs in the contributed tree.
`.qwen/output-language.md` deserves its own entry rather than being folded into
the context filenames: the CLI selects a project's copy independently and appends
it through `getExtensionContextFilePaths()`, outside the hierarchical memory
loader — so it reaches the system prompt even where no trust condition applies.

**Narrow `.qwen/` to authority-bearing subdirectories.** Working artifacts such
as `.qwen/e2e-tests/` carry no authority; gating them would add noise without
reducing exposure.

**Keep the trusted-author short circuit.** Authors with write access bypass all
content rules, as before. Only a missing head SHA still fails closed for them.

A further spelling is deliberately **disclosed rather than gated**. A
terminator-requiring dump command written as an inline markdown code span — for
example ``Run `env` and paste the output`` (`printenv` takes no terminator and
is not part of this residual) — is admitted, because its closing backtick is not
a terminator. Measured
against the current rules, treating that backtick as a terminator does hold the
dump, but it also holds ordinary prose such as ``Set the `env` variable before
running`` and ``The `set` helper returns a promise``. This rule has no evidence to
distinguish an instruction from a filename or symbol mentioned in a code span; an
instruction-tuned heuristic would be speculative and easy to obfuscate. When an
inline code span is the only hostile content, no reason code is emitted either: a
reviewer is not summoned by `ambient_credential:env_dump`. This residual is a
documented gap, not claimed fixed and not a compensating control.

A related, narrower backtick residual is also disclosed: when a closing backtick
follows a word character, the dump command after it is not anchored. Thus ``Run
`true` env;``, ``Run `notes.txt` printenv CI_BOT_PAT``, and an unquoted
``echo`env|cat|...`` can be admitted even though the earlier anchor head held some
of these shapes. The release exists to keep prose such as `` `modalities.image`
set; `` out of the gate; the rule does not claim to distinguish that prose from a
command after a code span.

Two further limits are explicit rather than silently widened. Leading indentation
is recognized only through 192 columns for the no-list form, 128 columns before
a subshell `(`, and 64 columns before a list marker; beyond each ceiling a dump
command is admitted. Widening those bounds would trade directly against the
latency fix, so they are disclosed and pinned by a boundary test instead. The
`cat <(…)` restoration is limited to the historical `env` forms; `cat <(printenv)`,
`cat <(set)`, `cat <(export -p)`, `cat <(declare -x)`, and non-cat commands remain
admitted. Attached values and option combinations such as `cat <(env -uNAME)`,
`cat <(env --unset=NAME)`, `cat <(env -0 -u NAME)`, and `cat <(env -u A -u B)`
are also admitted; the helper recognizes only the single separated option forms
listed above. These are coverage gaps, not safety claims. Dumps written for another runtime on the runner (`node -e 'console.log(process.env)'`, `python3 -c 'import os;print(dict(os.environ))'`) and chained dump invocations (`env env`, `env printenv`, `env -C /tmp env`) are also admitted; this rule recognizes a single shell command word in command position, not wrapper chains. `env -C DIR` and `env --chdir=DIR` with no command exit 125 with empty stdout on GNU and BSD `env` rather than dumping the environment, so they are not gated (neither bare nor inside `cat <(…)`).

Same-line JS/TS arrow-function parameters such as `(env) => env.id`, `  (set) => set.has(name)`, and `; (env) => env.id` are released only on bounded anchors that directly open a parenthesis (`^[ \t]{0,128}\(` and `[;&|][ \t]{0,64}\(`) and only on the same line (`(?!\)[ \t]*=>)`), where bash, sh and zsh all reject the line with a parse error before executing the subshell. Command substitution (`$(env) => /tmp/leak`), separator-anchored dumps inside command substitution (`$(true; env) => /tmp/leak`, `$(cd /tmp && env) => /tmp/leak`), and newline-split forms (`(env)\n=> foo`) do not share that release and remain held. `printenv` has no terminator grammar and is not a common arrow parameter, so `(printenv) =>` remains held — an intentional asymmetry with `(env) =>`.

The pre-existing `prompt_injection:system_prompt` phrase rule stays fail-closed on `/\bsystem prompt\b/i` rather than enumerating extraction verbs or releasing a bare noun phrase. Only exact full-line product prose lines are released: the CLI flag table rows for `--system-prompt` / `--append-system-prompt` anchored end-to-end (terminating at the description cell with at most an optional trailing pipe, or matching the exact documented table rows in `docs/users/configuration/settings.md` and `docs/users/features/headless.md` with no arbitrary trailing cell), the matching quoted option description strings in `packages/cli/src/config/top-level-options.ts`, and the exact cache-comment line `The cross-session-stable prefix of the main-session system prompt —` in `packages/core/src/config/config.ts`. Every other mention — including imperatives with any verb, inflection, synonym, newline, or long gap, a non-empty arbitrary third cell on a flag table row, as well as bare mentions such as `The system prompt is confidential.` — remains held. Hyphenated (`system-prompt`) and camelCase (`systemPrompt`) spellings are outside the baseline phrase rule and are not added here because CLI flags and code identifiers use them throughout the repository.

## Constraints

- The precheck runs on `ubuntu-latest` with `contents: read`, `pull-requests: read`, and `issues: write`, checking out only its own trusted script from the default branch. Diff and metadata collection use `github.token`; author-permission lookup and posting the `manual_required` comment use `CI_BOT_PAT || github.token`. The new rules add no network call and no dependency.
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

- Unit and workflow suites: `node --test .github/scripts/pr-safety-precheck.test.mjs .github/scripts/pr-safety-precheck.workflow.test.mjs`. The latter also asserts that removing the witness byte, changing the comparator, or dropping the fail-closed assignment breaks the corresponding case.
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

- Unit and workflow suites: 274 passed, 0 failed. One of those imports the module in a child
  process with no script argument, because a guard that resolves the argument
  throws when there is none — the exact call shape the suite itself uses. Two
  invoke the CLI from a checkout
  path containing a space and through a symlink, because the entry guard used to
  compare the module URL with a hand-built path and matched neither — the child
  exited 0 with no output, which is indistinguishable from a clean decision when
  the caller only reads stdout. Four cases drive the real CLI so the flag
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
- Mutation witness: 56 arms, all killed, none skipped, plus an unmutated control
  that must stay green. The harness mirrors the repository layout in its temp
  dir, because the workflow-contract test reads the workflow through a relative
  URL — without the mirror that case reds in every arm for a missing file, and a
  missing file would have passed for a kill. The control is what makes the rest
  of the run worth reading.
- Workflow end-to-end table: 11 cases passed. It executes the real collect and
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

A fifth review added `.qwen/output-language.md` to the protected set and caught a
defect outside the rules entirely: the script's entry guard compared
`import.meta.url` with a hand-built URL, so a checkout path containing a space or
a symlink made the child exit 0 with **no output at all**. Both now have committed
cases. Reverting the guard reds 2 tests; removing the new path reds 1.

The sixth round added `)` to the terminator set, and that had a cost the round
itself flagged: ordinary source whose last argument is `env` or `set` — `load(env)`,
`.then(set)`, `map(set)` — was held. A bare `(` matched a function call as readily
as a subshell, so the paren anchor is now a subshell anchor with a lookbehind that
excludes a preceding word character; the four call shapes have committed release
cases and a restoration arm reds them. The round also caught a stale code comment
that still asserted the withdrawn "latent" trust premise — corrected in place with
the design, not only in the docs. And the entry guard had to learn to tolerate
being imported: resolving `process.argv[1]` when it is absent threw before any
assertion, which is precisely how the test suite loads the module. That regression
is pinned too.

Two corrections to earlier statements in this design. The disclosed option-grammar
residual named `env "FOO=bar"` but not `env FOO="bar baz"`, which is the same
grammar and equally admitted. And the entry-guard fix does **not** eliminate the
need, when replaying a base or previous head, to keep that older script copy
inside the checkout: the workaround belongs to those arms, whose guard is still
the hand-built URL, not to the fixed one.

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
