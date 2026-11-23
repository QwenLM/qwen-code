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
| `--round <r>`            | Positive round number; required for `vm` and `host`.                                                              |
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
and execution-mode changes. For a nonce-bearing registration, `--complete`
and `--release` must repeat that start's value with
`--registration-nonce <nonce>`; it is never inferred from current state for
a caller. A recorded verified entry retains the nonce for replay validation.
If the same head/round restarts, an old nonce cannot consume the replacement
live marker or overwrite its completed verdict. A later `--start`, including
one in another trusted state root, gets a different nonce and cannot reuse
its old comment. Missing or stale identities fail without changing state.

Legacy in-flight entries without a nonce remain readable by the existing
complete/release commands, but cannot authorize a new comment approval. The
operator must deliberately release and restart to allocate a nonce, then
request a fresh marked approval; prepare never silently migrates an old
comment into approval for the new registration.

A watch continued from an old saved prompt is not a nonce exemption when its
registration was created by the new implementation. Recover the nonce from
that exact `--start` invocation's output. If that output is no longer
available, an operator may read the matching entry in the trusted state
file's `inFlightHeads` (or `verifiedHeads` for completion/replay), then pass
that value explicitly with `--registration-nonce` to `--complete` or
`--release`. The command does not look up or silently supply a current value
for a bare invocation. A genuinely legacy entry without a nonce remains the
only omission-compatible case.

The maintainer, never the round, then posts a comment on the PR. The comment
contains one exact marker and human-readable approval text:

```text
<!-- verify-pr-boundary-approval: {"mode":"host","head":"<40hex>","round":2,"registrationNonce":"<nonce from this --start>"} -->
Approved host execution for this verify round.
```

For a VM, `mode` is `vm`. The marker is an instruction only when the complete
HTML comment occupies one direct line at column zero; blockquote, fenced or
indented-code examples are not approvals, and additional literal prefixes still
violate the exactly-once rule. Prepare hashes the actual GitHub body rather than
a normalized extraction. Prepare validates all of the following through
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

After all GitHub calls and the review-state fetch finish, comment approval
enters the same cooperative watch-state lock used by start, release and
complete. Inside that lock prepare first reads the registration again and
rechecks its repo, PR, normalized head/round and exact `registrationNonce`. It
then repeats the exact HEAD/clean-status/index-flag check with the same hardened
Git arguments and local-filter overrides used by the initial check, without any
new network request in the lock, before writing the host context and artifact
declaration. Local trust uses that same final checkout recheck after the review
response but needs no registration lock. A release plus a new start while the
comment response is paused therefore makes the old prepare exit 3 without
writing approval bytes. A checkout dirtied while the final GraphQL response is
paused likewise exits 3 without new approval or host snapshot bytes. Lock contention also exits 3; it never treats the old approval
as live. A retry of the unchanged in-flight registration retains its nonce and
can issue normally. An actual release followed by a new start rotates the nonce
and needs a fresh comment; a legacy entry without a nonce remains usable by the
existing complete/release commands but must be released and restarted before a
new comment approval can authorize execution. This cooperative final check is
not an OS sandbox against a caller that bypasses prepare and executes PR code.

Both exact-tree passes resolve Git's actual `info/exclude` with `git rev-parse
--path-format=absolute --git-path info/exclude`, rather than assuming it lives
under `.git/info/exclude`. This includes the common exclude of a linked
worktree, so that file cannot hide untracked files from status. Failure to
resolve or read the exclude also refuses preparation.

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

The artifact's `boundary.json` carries the same object. Publication uses a
deep strict comparison with the host-held `executionApproval`, not an
additional-fields-ignored subset check: the declaration keys must match
exactly, including `registrationNonce` for a comment approval. The context
sha256 printed by prepare covers the approval bytes too.

When `verify-pr-check.mjs` sees a `vm` or `waived` artifact declaration, it
requires a trusted `--context` snapshot whose validated `executionApproval`
is deeply equal to the artifact declaration and whose `head` equals the
trusted `headRefOid`. It also revalidates `basis` against the snapshot's
author and `isCrossRepository`. Unlike the older optional context-digest
warning, VM and host publication requires `--context-sha256` and a byte
match. The existing outside-clone, non-symlink and single-link rules apply
too. The PR-tree copy of the snapshot is never authoritative, and an artifact
`context.json` cannot self-mint coordinates. Every `vm` or `waived`
declaration checked against an external context requires that context to carry
a valid `owner/repo` slug and a positive `pr` or `number`; a missing or
malformed repository or PR number is a hard refusal, and neither the artifact
basename nor its `context.json` may fill the gap. Canonical prepare output
always supplies both. With those trusted coordinates, a `pr<N>-verify-*`
directory whose N differs is refused for both comment and local-trust
approvals, even at the same head on a shared branch; a missing or
cross-identifying artifact context cannot change that host identity. For this
comparison the artifact ROOT must itself be a real directory, not a symlink or
other non-directory; an alias named for the approved PR must not hide a
different target. The operator must pass the resolved artifact directory path.
For a round carrying this host-held `executionApproval`, publication also
requires a `pr<N>-verify-*` directory and a readable artifact `context.json`
whose repo and PR coordinates match the host snapshot. A missing, malformed
or conflicting witness is refused; it never substitutes for the host
snapshot. Legacy context records without this field are not subject to this
additional witness requirement.

Before any context or approval file is written, the time-stamped artifact directory must
be a real directory, not a symbolic link or other file, whose fully canonical
path is exactly the expected direct child of the real `tmp/` directory. An
ordinary same-second retry still reuses that existing real directory; a
redirect or non-directory exits 3 without writing into its target. The
canonical artifact parent is retained with each transaction record and compared
again when records are captured, written and restored. A directory replaced by
a symlink while the final review response is paused is refused before the
write group is committed. Artifact
`context.json` must likewise be absent or a single-link regular file, so a
symlink or hard link cannot overwrite its origin. `--context-out` containment
uses the canonical PR-clone root and the canonical parent directory after that
parent exists; a nonexistent new leaf is not passed to `realpath`, and an alias
whose real parent leads back into the clone exits 3 before approval bytes are
written. On the comment path, the state-lock critical section also compares the
canonical output with the live watch state JSON and its `.lock`, including
parent-directory aliases and same-file identity for an existing target; either
identity exits 3 before authority writes, while a distinct external context
still succeeds. The external and in-tree contexts, artifact coordinates and
approval, and the review snapshot form one write group. Prepare preserves their previous
bytes before the first mutation; a later failure restores those bytes and
removes newly created members. It exits 3 and names any record it could not
restore, rather than claiming a restored state.

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
A comment path that used an explicit state root repeats that identical trusted
root on every prepare retry and on this registration's `--complete` or
`--release`; the default container path still needs no comment marker.

A fresh local-trust round without a marker uses round 1 because its explicit
flag is a new trust decision on every invocation. A comment-backed round,
including a fresh one, also registers: its first registration may use round
1; subsequent executions need another unused positive round rather than
silently replaying the old comment. `registrationNonce` is the registration
identity recorded in flight and retained by a resulting verified entry;
there is no parallel approval file or new next-round command. Its
`--complete` and `--release` forms accept the matching nonce, and a resulting
verified entry also accepts only the same nonce for replay. A transient
prepare failure keeps the registration and nonce, so its retry can reuse its
matching comment. An actual release followed by `--start` always allocates a
new nonce: even the same head/round then needs a fresh comment marker.
Non-comment container retries or later rounds need matching head/round
registration and the registration's nonce at completion/release, but no
public approval marker. A published round supplies the resulting numeric
comment ID to the existing `--complete` command. A withheld/no-publish round,
after the local checker succeeds, uses that same command with the exact same
head/round/nonce/state-root and artifact directory but omits the optional
comment ID. The verified entry retains `commentId: null` and the artifact
directory, and no successful registration remains in flight. Neither success
branch implicitly auto-completes or uses `--release`, which remains the
abandonment path in manual and watch recovery.

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
- `scripts/verify-pr-watch-state.mjs`: registration identity propagation,
  nonce-bound complete/release and verified replay compatibility.
- `scripts/tests/verify-pr-watch-state.test.js`: rotation, replacement and
  missing/wrong nonce witnesses, normal replay, legacy migration and CLI.
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
- `docs/design/verify-pr-watch.md` and
  `docs/design/verify-pr-watch.zh-CN.md`: watch/registration lifecycle.
- `docs/design/verify-pr-register-ahead-of-prepare.md` and
  `docs/design/verify-pr-register-ahead-of-prepare.zh-CN.md`: registration
  ordering and recovery.
- `docs/design/verify-pr-local-round.md` and
  `docs/design/verify-pr-local-round.zh-CN.md`: local-round compatibility.
- `docs/design/2026-11-14-verify-pr-java-container-recipe.md` and
  `docs/design/2026-11-14-verify-pr-java-container-recipe.zh-CN.md`: Java
  container proposal.
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
  nonce. A same-head/round replacement refuses an old or missing nonce for
  both its live marker and its already-completed verdict, preserves the new
  verdict and artifacts, and accepts the correct completion, release and
  nonce-bearing replay. Head-only release and the explicit legacy no-nonce
  migration retain their compatibility tests. A completion in root A
  followed by a fresh same-head/round start in root B refuses A's marker,
  accepts B's new marker, and has a source-removal red control. Legacy
  nonce-less entries disclose and test their fresh-marker
  migration. Old persisted prompts retain the container default instead of
  losing the delivered head.
- Frozen-clock real-CLI probes reject a symlinked or non-directory stamped
  artifact parent with controlled exit 3 and no external context/approval
  write. They also accept a normal same-second retry and turn red when the
  canonical-parent guard is removed. A read-only approval file produces
  controlled exit 3. Checker CLI tests accept genuine VM records for both
  local trust and comment approval and reject no-context/no-digest forms.
- The previous digest is removed before each local prepare. The transactional
  writer may preserve the previous `pr.json`, but a host/VM checker invocation
  without a current digest fails closed.
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
