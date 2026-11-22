# Verify-PR execution preflight

[English](verify-pr-execution-preflight.md) | [简体中文](verify-pr-execution-preflight.zh-CN.md)

Status: implemented first version; verification evidence is in the E2E log.

## Problem statement and current state

A local `/verify-pr` round executes untrusted PR code. The skill says that a
host or VM round must receive the maintainer's explicit approval before that
code runs, but the only machine-owned check is the publication checker. The
usual failure is therefore expensive and confusing: the battery has already
run on the host before `verify-pr-check.mjs` asks for `boundary.json` and an
approval permalink.

The coordinate path cannot solve this by applying `--require-isolation` to
itself. That mode requires an observed container marker, while coordinate
resolution deliberately runs on the host because it needs authenticated `gh`.
The declaration cannot simply be written earlier either: the artifact
directory is inside the PR-writable clone.

The current approval check is also intentionally shallow. With a trusted
context it compares the permalink's repository and PR number; without one it
checks only the URL shape. It does not establish that the comment exists,
that its author can approve execution, or that the approval names this head
and round.

## Goals and scope

This first version makes the supported local workflow fail closed before PR
code execution:

1. A coordinate prepare runs as `container` by default, preserving legacy
   watch prompts. Only `vm` and `host` require an explicit new selection.
2. A VM or host selection is accepted only with either an explicit local
   trust decision for the maintainer's own or same-repository PR, or a real
   maintainer approval comment plus an in-flight trusted watch registration
   for another fork, bound to the current repository, PR, head, round and
   per-registration nonce. A new nonce is allocated by every actual --start.
3. Prepare stores the resulting declaration in the existing host-held
   context snapshot and a copy in the artifact directory.
4. The publication checker compares that copy with the host snapshot and
   retains its existing report and CI-lane checks.

This is process enforcement for rounds that use the trusted prepare and
publish commands. It is not an OS security boundary: an agent that bypasses
those commands can still execute shell commands on the host. A privileged
execution wrapper or mandatory sandbox is out of scope. Live revalidation of
comment edits/deletion and repository-permission withdrawal after prepare is
also out of scope; the record retains the comment metadata, permission and
body digest observed at preflight.

The CI lane keeps its publisher-owned `container` and `ci-lane` records. No
workflow changes are intended.

## Command contract

The coordinate path adds the following options:

| Option                   | Meaning                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `--execution container`  | The next execution stage will enter a real container; prepare does not mint a container declaration.              |
| `--execution vm`         | The operator selected a VM and supplies approval and attestation.                                                 |
| `--execution host`       | The operator selected a waived host round and supplies approval.                                                  |
| `--trust-pr-head`        | Explicit local trust for the maintainer's own or a same-repository PR head; mutually exclusive with `--approval`. |
| `--approval <permalink>` | Maintainer's issue-comment permalink for another fork; alternative to `--trust-pr-head`.                          |
| `--state-root <dir>`     | Absolute, PR-external trusted directory holding the approval's in-flight head/round; required with `--approval`.  |
| `--round <n>`            | Positive round number; required for `vm` and `host`.                                                              |
| `--reason <text>`        | Why this round runs outside an observed container; required for `vm` and `host`.                                  |
| `--attestation <text>`   | What the operator confirmed about the VM; required only for `vm`.                                                 |

`--execution` defaults to `container` on the coordinate path so legacy watch
prompts remain usable. This omission never issues a host/VM approval or a
container claim; the real container still has to pass its gate. New callers
may write `--execution container` explicitly. `--context-out` was already
part of the trusted local recipe and becomes required for `vm` and `host`, so
the approval has an authoritative destination outside the PR clone. The
existing in-boundary `--require-isolation` form does not accept or require an
execution selection.

Every VM or host invocation supplies exactly one of `--trust-pr-head` and
`--approval`. `--approval` additionally takes `--state-root`. Approval-
specific options are rejected for `container`; a container still obtains
`boundary.json` and `boundary-gate.json` only after the real in-boundary gate
passes. Mixing inapplicable options or omitting a required approval field is
a usage error. A remote approval, permission, identity, registration or
filesystem failure is a prepare refusal (exit 3).

## Approval verification

### Local trusted-head approval

For the maintainer's own PR, including their fork, or a same-repository
collaboration PR, `--trust-pr-head` records an explicit local decision without
requiring a public approval comment. Prepare establishes through `gh` that:

- the current user is the intended local operator;
- that user has `write`, `maintain`, or `admin` permission on the target
  repository;
- the PR author is that user, or `isCrossRepository` is false;
- the clean checkout's HEAD is exactly the trusted `headRefOid` before the
  declaration is written.

Neither author equality nor same-repository placement alone selects host
execution. The explicit flag trusts the whole current head for this round,
including commits written by collaborators. Head and round binding prevent a
record from silently carrying forward. The operator is represented by the
authenticated login, not a `--by` argument. An unattended watch may not add
this flag on its own.

### Approval comment for another fork

For any other fork, even a fresh round first runs
`node <trusted-clone>/scripts/verify-pr-watch-state.mjs <n> --start --head <40hex> --round <r> --repo <owner>/<repo> --state-root "<trusted-dir>"`
with an unused positive round and an absolute trusted state root outside the
PR clone. Registration remains outside the PR clone and precedes PR-code
execution. The round continues using the existing complete/release commands.
Prepare requires one actual in-flight entry for that repo, PR, head and round,
in a single-link regular state file whose fully canonicalized path is outside
the PR clone, including every intermediate `.qwen/tmp` directory. Each actual
`--start` allocates and prints a `registrationNonce`; prefix matching against
the registered head and lookup of this entry stay owned by watch-state. The
nonce stays unchanged during that registration's in-flight prepare retries
and execution-mode changes. Completion or release consumes that identity: a
later `--start`, including one for the same head/round or in another trusted
state root, gets a different nonce and cannot reuse its old comment.

Legacy in-flight entries without a nonce remain readable by the existing
complete/release commands, but cannot authorize a new comment approval. The
operator must deliberately release and restart to allocate a nonce, then
request a fresh marked approval; prepare never silently migrates an old
comment into approval for the new registration.

The maintainer, never the round, then posts a comment on the PR. The comment
contains one exact marker and human-readable approval text:

```text
<!-- verify-pr-boundary-approval: {"mode":"host","head":"<40hex>","round":2,"registrationNonce":"<nonce from this --start>"} -->
Approved host execution for this verify round.
```

For a VM, `mode` is `vm`. Prepare validates all of the following through
authenticated `gh` before creating the artifact directory:

- the permalink has the existing accepted shape and names this repository and
  PR;
- the numbered issue comment exists and belongs to that PR;
- exactly one marker parses as JSON and its `mode`, `head`, `round` and
  `registrationNonce` equal the requested execution, trusted `headRefOid`,
  positive round and current normalized in-flight entry;
- the comment author has `write`, `maintain`, or `admin` repository permission,
  established through the collaborators permission endpoint rather than the
  free-text `by` value;
- the marker and permission API calls succeed; errors fail closed.

The recorded `by` is the comment author's login. A previous round's marker,
an ordinary comment that happens to quote a head, and an approval for another
PR cannot satisfy this contract. Local trust and a comment are mutually
exclusive so a caller cannot combine two divergent approval claims.

## Recording and publication

Prepare validates the current checkout before writing as it does today. On a
valid VM or host approval it adds an `executionApproval` object to the same
host context bytes that `--context-out` already writes. The object contains
`mode`, `source`, `by`, `basis`, `reason`, optional `attestation`, `head`,
`round`, and the authenticated permission. `source` is `local-trust` or
`comment`; `basis` is `own-pr` or `same-repository` for local trust and
`maintainer-comment` for a comment. A local decision has no `approval`
permalink; a comment decision adds `approval`, the observed comment id and
body sha256, and its `registrationNonce`. The declaration's `mode` remains
the existing vocabulary: `vm` or `waived`.

The artifact's `boundary.json` carries the same object. Existing checker
rules ignore additional declaration fields, so the declaration schema does
not fork. The context sha256 printed by prepare covers the approval bytes too.

When `verify-pr-check.mjs` sees a `vm` or `waived` artifact declaration, it
requires a trusted `--context` snapshot whose validated `executionApproval`
is deeply equal to the artifact declaration and whose `head` equals the
trusted `headRefOid`. It also revalidates `basis` against the snapshot's
author and `isCrossRepository`. Unlike the older optional context-digest
warning, VM and host publication requires `--context-sha256` and a byte
match. The existing outside-clone, non-symlink and single-link rules apply
too. The PR-tree copy of the snapshot is never authoritative. Before any
context or approval file is written, the time-stamped artifact directory must
be a real directory, not a symbolic link or other file, whose fully canonical
path is exactly the expected direct child of the real `tmp/` directory. An
ordinary same-second retry still reuses that existing real directory; a
redirect or non-directory exits 3 without writing into its target.

Container and CI-lane behavior remains unchanged. Older host or VM artifacts
without the host-held record are deliberately refused rather than presented
as preflight-approved rounds.

## Skill and watch flow

The local instructions keep the existing register-ahead delivery rule:

```text
resolve the current head
→ register every new comment-backed head/round, and all watch / re-verification rounds before an approval wait (R17-2)
→ choose container / vm / host
→ for vm / host choose explicit local trust or register and request a fork approval comment
→ run prepare with the matching execution and approval arguments
→ execute PR code only after the relevant boundary / approval gate passes
```

Waiting for approval does not move ahead of registration: the watch cursor
has already delivered the head, so an interrupted wait must leave the
recoverable in-flight marker. When changing container to host/VM, keep the
same registration through prepare, battery, publication and `--complete`.
Do not release merely to change modes. Registration runs ahead even for
local trust, whose prepare itself needs no public marker or `--state-root`.

A fresh local-trust round without a marker uses round 1 because its explicit
flag is a new trust decision on every invocation. A comment-backed round,
including a fresh one, also registers: its first registration may use round
1; subsequent executions need another unused positive round rather than
silently replaying the old comment. The in-flight state's only schema addition
is `registrationNonce`; there is no parallel approval file or new next-round
command. A transient prepare failure keeps the registration and nonce, so its
retry can reuse its matching comment. An actual release followed by `--start`
always allocates a new nonce: even the same head/round then needs a fresh
comment marker. Non-comment container retries or later rounds need matching
head/round registration but no comment approval.

An unattended watch must not invent host approval. It selects a container or
stops for the maintainer rather than persisting `--trust-pr-head` for unknown
future heads. A persisted legacy watch prompt without `--execution` remains
on the container default: it is neither rejected after cursor delivery nor
promoted into an unapproved host round.

The local-trust request explains that author or repository matching is not
an automatic waiver and that the flag trusts the complete current head. The
fork approval request explains that the comment records where untrusted code
will run, is external to the PR-writable artifact tree, is not a code review
or merge approval, and is checked before execution rather than only at
publication.

## Files affected

- `scripts/verify-pr-prepare.mjs`: execution arguments, remote approval
  verification, context/declaration writing and output/usage documentation.
- `scripts/verify-pr-check.mjs`: host-context approval comparison and
  refusal cases.
- `scripts/tests/verify-pr-prepare.test.js`: fake-`gh` API responses, argument
  and ordering coverage, refusal and success witnesses.
- `scripts/tests/verify-pr-check.test.js`: trusted authority, tamper, stale
  head, missing context/digest and CI/container regression coverage.
- `scripts/tests/verify-pr-model-proxy.test.js`: trusted-path pin covering
  every prepare/checker invocation in the skill.
- `scripts/tests/qwen-triage-workflow.test.js`: register-ahead, shell replay
  and publisher compatibility pins; the workflow itself stays unchanged.
- `.qwen/skills/verify-pr/SKILL.md`: local, container-recipe and watch call
  order, approval instructions and artifact/checker examples.
- `docs/design/verify-pr-execution-preflight.md` and
  `docs/design/verify-pr-execution-preflight.zh-CN.md`: this design.
- `.qwen/e2e-tests/verify-pr-execution-preflight.md`: baseline and local E2E
  evidence (git-ignored working artifact).

## Design decisions and risks

- **Selection is explicit except for backward-compatible container calls.**
  An unattended watch opts out of local trust. Only host/VM requires a new
  mode selection; omitted arguments preserve the old container behavior
  without claiming that a container gate has passed.
- **The approval rides in the existing trusted context.** A second host file,
  digest flag and containment implementation would duplicate an already
  audited trust path. `executionApproval` stays absent from container and CI
  snapshots; the shared coordinate addition is only `isCrossRepository`.
- **Binding to head, round and one registration identity is mandatory.** PR
  and head/round matching alone would allow a completed approval to be reused
  after a new `--start` in another trusted state root. The marked comment must
  carry the exact nonce owned by the current in-flight registration; fresh
  short-head starts use the same normalized lookup and legacy nonce-less
  registrations fail closed instead of guessing an identity.
- **Permission and local eligibility are verified remotely.** Repository
  permission is queried directly. Local trust additionally requires the
  current user to be the PR author or the PR not to be cross-repository;
  neither fact alone creates an implicit waiver.
- **Publication remains an audit.** Preflight does not replace the checker.
  The copy comparison catches PR-side replacement of the declaration.
- **The change intentionally rejects old host/VM artifacts, not old container
  calls.** New workflows may explicitly name the container; legacy ones keep
  working. Host and VM callers must supply the new approval fields, and
  comment approvals additionally require a trusted registration. CI-owned
  records do not use this contract.
- **Preflight is not containment.** The documentation must not describe it as
  proof that later commands ran in the selected boundary, nor as protection
  from a caller that bypasses prepare.

## Validation and acceptance criteria

- Unit and CLI tests prove argument refusal precedes artifact creation and
  that no refusal writes a fresh authoritative approval snapshot.
- Fake-`gh` witnesses cover valid own-fork and same-repository local trust,
  valid local-trust VM with attestation, valid comment-backed host and VM
  approvals, an ineligible other-fork local attempt, nonexistent comment,
  wrong PR, duplicate or malformed markers, wrong head/round/nonce,
  insufficient author permission (with an admin decoy), and API failure. The
  fake projects requested PR fields and answers permission lookups by login.
- A valid prepare creates the artifact declaration and host context with the
  same approval; the checker accepts their matching copies.
- Editing or deleting the artifact declaration, substituting another approval,
  changing its source or round, or moving the trusted head makes publication
  fail.
- Existing container fixture tests and the in-boundary gate suite remain
  green without an observed-marker requirement on host coordinate prepare.
- Watch/re-verification registration still precedes an approval wait, and a
  killed wait leaves the existing recoverable marker. Start → mode fallback →
  prepare → successful checker → complete works with no earlier verdict for
  both local trust and comment approval. A matching in-flight retry keeps its
  nonce. A completion in root A followed by a fresh same-head/round start in
  root B refuses A's marker, accepts B's new marker, and has a source-removal
  red control. Legacy nonce-less entries disclose and test their fresh-marker
  migration. Old persisted prompts retain the container default instead of
  losing the delivered head.
- Frozen-clock real-CLI probes reject a symlinked or non-directory stamped
  artifact parent with controlled exit 3 and no external context/approval
  write. They also accept a normal same-second retry and turn red when the
  canonical-parent guard is removed. A read-only approval file produces
  controlled exit 3. Checker CLI tests accept genuine VM records for both
  local trust and comment approval and reject no-context/no-digest forms.
- The stale host context/digest files are removed before each local prepare;
  a host/VM checker invocation without a current digest fails closed.
- The script fixture suite, formatting, lint, build and typecheck commands
  run after implementation, plus the required bundle and focused E2E probes.
- A pre-implementation baseline using global `qwen` 0.28.3 documents the
  absence of the new selection/preflight behavior; the local built CLI and
  real scripts are used for post-implementation verification without posting
  comments or executing an untrusted PR battery.

## Open questions

None for the first version. Comment revocation or permission withdrawal after
prepare, and mandatory execution confinement, are explicitly deferred
follow-up boundaries, not silently unimplemented requirements.
