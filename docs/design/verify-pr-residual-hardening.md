# verify-pr: harden the watch-state shape guard, the container nonce, and the VM prose

Language: English | [中文](verify-pr-residual-hardening.zh-CN.md)

Tracking issue: #17371 (residual risks accepted by #17185's land-with-residual-risk
decision and #17375's round-8 acceptance). This change closes three cheap,
self-contained clusters from that inventory: **A** (watch-state shape guard,
R16-2 / D17-3), **B** (container nonce integrity, R16-1 / D17-1 / D17-2), and
**C** (VM prose contradiction, R16-4). The core trust boundary (host-held
authoritative `--context` snapshot + sha256 content binding) landed in #17375 and
is not touched here.

## Problem statement and current state

### A — watch-state shape guard is satisfied by identity-only keys

`readState` (`scripts/verify-pr-watch-state.mjs`) fails closed on a well-formed
object whose keys are _all_ unknown, so a hand-written body cannot read as "no
state" and let `--start` rewrite the file from empty lists. But the recognised
set `STATE_KEYS` mixes **identity** keys (`pr`, `repo`, `round`, `artifactDir`,
`startedAt`, `completedAt`, `verdict`, `commentId`) with **state-bearing** keys
(`inFlightHeads`, `verifiedHeads`, `seqCounter`, …). A body such as
`{"pr":1,"startedAt":"…","inflightHead":"abc"}` (one identity key plus a
misspelled head marker) satisfies the guard, yields no migratable in-flight head,
and `--start` resets the file — erasing whatever the operator intended the
misspelled marker to block. This is R16-2; D17-3 is the same cluster's widened
legacy migration in `inFlightEntries` (accepting a string `inFlight` head).

Every state this helper writes carries state-bearing keys: `startRound` and
`completeRound` always emit `inFlightHeads`, `verifiedHeads`, `deferredHeads`,
`releasedHeads`, `retiredSeqs`, `seqCounter`, and `deriveView` adds the derived
`verifiedHead` / `previousHead` / `inFlightHead` / `inFlight`. So requiring a
state-bearing key never refuses a legitimate state.

### B — the container nonce plaintext rides in the PR-writable gate record

`requireBoundary` (`scripts/verify-pr-prepare.mjs`) writes a per-round nonce to
the container-local `$HOME/.qwen-verify-nonce` **and** stores the same plaintext
in `boundary-gate.json` (`nonce`). The artifact tree is PR-writable, so a battery
that ran on the host can copy the plaintext out of the record into its logs and
mint `mode:"container"` without ever reading the container-local file. The
step-7 shell recipe extracts the expected nonce _from that same PR-writable
record_ and greps the round dir for it, so the oracle is attacker-supplied: the
check corroborates "a value got copied into a log", not "the battery ran inside
the container" (R16-1). D17-1 is step 7 reading the PR-writable record for the
oracle; D17-2 is the escape-hatch wording in the refusal message.

The record's own prose already concedes it "is not proof against a round that
forges both" record and logs. The threat it _should_ close is the incident shape:
an operator who ran the round on the host and skipped the container gate.

### C — VM prose contradicts the VM bullet

The preflight paragraph (`.qwen/skills/verify-pr/SKILL.md`, ~line 280) says "a VM
boundary runs the same file from the trusted checkout instead", immediately after
prescribing `--require-isolation --artifact-dir <round-dir>` for the container
path. The VM bullet above (~line 208) states the VM path runs **no**
`--require-isolation` gate. The unscoped sentence can push a VM operator to run
the container gate (R16-4).

## Proposed changes

### A — require a state-bearing key (fail closed)

The shape guard is **derived from what the migration ladder actually consumes**,
so the guard's acceptance and the ladder's consumption cannot drift (R2-1). A
body is admitted when `inFlightEntries`, `verifiedEntries`, `deferredEntries`
or `releasedEntries` yields an entry, or `seqCounter` is an integer, or
`retiredSeqs` is a non-empty object. A legacy resting body that predates the
list/seqCounter format — only identity keys and the pre-list single-marker head
keys (`inFlight`/`inFlightHead`/`verifiedHead`/`previousHead`), all holding
resting values (null/empty/false) — is admitted as no-state: the ladder consumes
it as resting, so refusing it would strand a PR whose state holds no dedup
history at all (R7-1). The resting clause is scoped to the legacy single-marker
keys: a body carrying a `*Heads` LIST key (even empty) is the new format, which
always writes `seqCounter`, so an empty list with no bearing entry stays refused.
Any other body with no consumable bearing entry fails closed like corrupt JSON;
an identity key plus a misspelled (UNKNOWN) head marker is likewise refused
(R16-2). Independently of that disjunction, a `*Heads` key that is PRESENT but
holds a non-array value (a bare string `inFlightHeads:"<hex>"`) is refused even
when an integer `seqCounter` admits the file — the ladder cannot consume that
marker and `--start` would otherwise erase it, breaking the one-round-per-PR
serialisation (R6-1). `inFlightEntries` consumes a bare `inFlightHead` (a
non-empty string) even alongside the resting empty `inFlightHeads: []`, as well
as a string `inFlight`, so the marker blocks a second round and survives the
refused start (R1-1, R2-1). Every state the helper writes goes through
`deriveView`, which emits the lists as arrays plus an integer `seqCounter` (and
the derived `inFlight:false` / `inFlightHead:null` resting view), so a legitimate
file is never refused. Witnesses pin the consumable shapes, the legacy
resting-body admission, the refused non-consumable shapes (string-under-array
with and without a bearing `seqCounter`, empty lists with no bearing entry, an
unknown head spelling), and the legacy migration boundary (a non-empty string
head migrates and blocks; `inFlight:true` or an object alone is refused; an empty
string is resting — admitted but never migrates to block a head).

### B — store only the nonce hash in the record; enforce corroboration in the checker

- `requireBoundary` stores `nonceSha256` (sha256 of the plaintext) in the record
  instead of the plaintext `nonce`. The plaintext is written only to the
  container-local `$HOME/.qwen-verify-nonce`. A host battery cannot recover the
  plaintext from the hash, so it cannot produce a matching log line.
- `verify-pr-check.mjs` adds the authoritative machine-owned enforcement:
  `containerNonceErrors(boundaryText, gateText, roundDir)`, run from `main`
  (the round dir is available there, not in `checkArtifacts`). For a
  `mode:"container"` declaration backed by a `require-isolation` record it
  requires `gate.nonceSha256` (a 64-hex string) **and** a `container-nonce:
<value>` line in the round's logs whose value's sha256 equals it. The scan
  walks the round dir, skips `boundary.json` / `boundary-gate.json`, the
  TOP-LEVEL `evidence/` subtree (the skill's binary PNG artifacts — a nested dir
  named evidence is still scanned, R4-5), and non-regular files (a symlink is
  not followed). It reads each regular file WHOLE in chunks, scanning the
  straddling partial line BEFORE capping the carry so a marker at its head is
  never lost (R3-3) — a marker behind earlier output or across a chunk boundary
  is still found. The AGGREGATE work is bounded: one hoisted 1 MiB scratch
  buffer (no per-file allocation), a 64 MiB total byte budget, and a 20000
  visited-entry cap that counts directories too (R1-2, R2-5, R4-4). The scan
  returns whether it stopped at a bound, so exhaustion gets its own refusal
  message distinct from "no matching line" (R4-1). A missing/mismatched hash or
  absent matching line refuses the container claim. The check runs
  UNCONDITIONALLY: the exemption is the RECORD,
  not a flag — `containerNonceErrors` returns `[]` for the `ci-lane` record and
  for non-container modes, so neither `--publish-lane` (R1-7) nor
  `$QWEN_VERIFY_CONTEXT` (R2-7) switches the binding off for a
  `require-isolation` container claim.
- The container-local nonce write is part of the gate: an unwritable or absent
  `$HOME` fails the gate (exit 3) before the pass line and invalidates any stale
  pass record, rather than silently writing a record whose plaintext exists
  nowhere and leaving the round uncertifiable only after the battery ran
  (R1-4, R2-4). `$HOME` is resolved lazily and defensively: `os.homedir()`
  throwing (no passwd entry for the UID with HOME unset) or returning `''` (HOME
  set but empty) both reach the same exit-3 refusal — never an uncaught throw
  (exit 1) that skips invalidation, and never a relative `join('', …)` write that
  lands the plaintext in the PR-writable CWD (R5-1).
- The step-7 shell **no longer re-implements the nonce match**: the checker is
  the SINGLE authoritative matcher, removing the shell↔checker parity drift
  (R1-2, R2-6) and the second matcher that stalled on a PR-planted long line
  (R1-3). The shell still writes the declaration and invokes the checker, which
  refuses a host battery; the nonce accept/refuse/parity witnesses live in the
  checker unit tests and the real-environment round trip. Step-5 and the
  boundary-gate prose state that the record carries the hash, never the
  plaintext, and that the battery echoes a `container-nonce:` line read from the
  container-local file.
- `requireBoundary` gains an optional `{env, exists, home}` seam (its detectors
  already accepted one) and is exported, so an ungated unit witness exercises
  the hash-only record write on a bare host; the gate-pass path is otherwise
  ambient-gated on an observed container marker.
- D17-2: the refusal message states plainly that `mode:"waived"` requires the
  maintainer's approval — it is not a free bypass.

This closes the host-copy path for the `require-isolation` record while keeping
the conceded boundary honest: a round that forges both that record's nonce hash
and a matching log line is still out of scope (the record corroborates an
operator who skipped the gate, not PR code that forges both). The CI publish
job's own `ci-lane` record is a separate trusted lane: honored only under
`--publish-lane` / the CI entry path, it is exempt from the nonce binding (the
publish job writes it inside the lane it owns), so the "forge both" bar names
the `require-isolation` container path, not that lane (R5 deferred).

### C — scope the VM sentence

Rewrite the preflight sentence — in both the skill and prepare's printed
guidance — to "a VM boundary takes the same trusted copy but runs **no
`--require-isolation` gate** … there is no in-boundary gate command and no
`boundary-gate.json` to produce — declare `mode:"vm"` per the VM bullet above",
matching the VM bullet. The attestation gloss names what the operator confirmed
(nothing mounted, no host credentials), never the inverted "what the VM mounts",
and no wording prescribes an `--artifact-dir` invocation without the gate, which
parseArgs refuses (R3-4).

## Files affected

- `scripts/verify-pr-watch-state.mjs` — ladder-derived shape guard; a legacy
  resting body (identity + pre-list single-marker keys, all resting values) is
  admitted as no-state (R7-1); a present non-array `*Heads` key is refused
  independently of the bearing disjunction (R6-1); `inFlightEntries` consumes a
  bare legacy marker alongside an empty list.
- `scripts/verify-pr-prepare.mjs` — record `nonceSha256`, drop plaintext `nonce`;
  fatal nonce-file write (exit 3) invalidating a stale record; lazy defensive
  `$HOME` resolution with an exit-3 refusal on an unresolvable/empty home
  (R5-1); corrected VM guidance gloss and invocation (R3-4); export
  `requireBoundary` with an `{env, exists, home}` seam.
- `scripts/verify-pr-check.mjs` — `containerNonceErrors` + whole-file
  aggregate-bounded log scan, run unconditionally from `main`.
- `.qwen/skills/verify-pr/SKILL.md` — step-5 nonce prose, step-7 shell nonce
  match removed (checker sole matcher), VM sentence scoping (R3-4).
- `scripts/tests/verify-pr-watch-state.test.js` — consumable / non-consumable
  shape witnesses, identity-only fail-closed, migration-boundary witnesses,
  non-array `*Heads`-with-`seqCounter` refusal + resting-file acceptance (R6-1),
  legacy resting-body admission with the unknown-key and bearing-less-list
  refusals intact (R7-1; the empty-legacy-head fixture no longer injects
  `seqCounter:0`).
- `scripts/tests/verify-pr-prepare.test.js` — gated record assertion, ungated
  hash-only record witness via the seam, stale-record invalidation witness,
  unresolvable/empty-home refusal witness (R5-1), corrected VM guidance pin
  (R3-4).
- `scripts/tests/verify-pr-check.test.js` — `containerNonceErrors` witnesses
  (matching line accepts; missing / mismatched hash or line refuses; symlink not
  followed; ci-lane / non-container exempt; whole-file & cross-chunk reads;
  line-semantics parity; directory AND file entry-cap witnesses, R5-3) + CLI
  refusal witnesses (`--publish-lane`, `$QWEN_VERIFY_CONTEXT`); container
  fixtures carry `nonceSha256` + a log line.
- `scripts/tests/qwen-triage-workflow.test.js` — step-5 flat pins, the VM
  scoping pin, the checker-sole-matcher pin, the step-5↔checker nonce-spelling
  pin (R6 deferred); the shimmed-node replay keeps the declaration/teardown
  witness (nonce witnesses moved to the checker tests).
- `docs/design/verify-pr-watch.md` + `.zh-CN.md` — the canonical watch design's
  shape-guard prose aligned to the ladder-derived guard (F3: previously omitted
  from this list).
- `docs/design/2026-11-14-verify-pr-java-container-recipe.md` + `.zh-CN.md` —
  the recipe's nonce/boundary prose aligned to the hash-only record; the full
  waived-model coherence sweep was deferred as R5-2 at the time and is completed
  by verify-pr-deferred-residual-hardening.md (F1) (F3: previously omitted).

## Scope boundaries

- Clusters D (R17-2 liveness), E (R8 long tail), F (D17-4…14) stay tracked in
  #17371; not touched here. The Java recipe's whole-document coherence sweep to
  a single waived model (R5-2: step 1's Node rationale, step 4's lead-in, the
  Validation plan, the Acceptance criteria, and the report `**Boundary.**` line
  wording that avoids the waived-contradiction warning) is a bot-deferred
  Suggestion in that proposal doc, recorded under #17371 rather than landed in
  this round (the PR is past the five-round convergence posture).
- The core `--context` trust boundary and sha256 content binding (#17375) are
  unchanged.
- No new script or CLI entry point; the checker gains a dir-dependent nonce check
  and is the SINGLE matcher — the step-7 shell no longer re-implements it (the
  pre-minting shell refusal of #17185 is superseded by the authoritative checker
  refusal, which runs before publication). `requireBoundary` is exported only as
  a testability seam, consistent with the already-exported detectors.
- The one-record/one-nonce binding constrains the multi-container Java recipe
  (R1-10, R3-6): the checker reads one record and one hash, and the
  `container-nonce:` line must be echoed by the container that runs the battery.
  A round whose battery runs in a different container than the gate cannot read
  the gate's plaintext, so — per the skill's step 5 — it declares
  `mode:"waived"` with the maintainer's approval; a gate-container attestation
  is not a substitute. That recipe records the constraint in step 1 (nonce
  binding) and step 5 (the `mode:"waived"` declaration example), in both
  languages; it is a proposal, not shipped code.

## Open questions

- None blocking. Nonce enforcement has a SINGLE implementation (the checker),
  witnessed by node unit tests and the real-environment round trip; removing the
  shell's second matcher eliminates the parity drift the review loop kept
  regenerating (R1-2/R2-2/R2-3/R2-6). The record carries only the hash, so the
  matcher reads no plaintext oracle from the PR-writable record. The aggregate
  byte budget means a log beyond 64 MiB total is not scanned (fails closed); a
  legitimate round's logs are far below that bound.
