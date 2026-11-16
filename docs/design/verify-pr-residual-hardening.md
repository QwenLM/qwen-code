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

Split `STATE_KEYS` into `IDENTITY_KEYS` and `STATE_BEARING_KEYS`. The shape guard
admits a body only when at least one **state-bearing** key is present (the legacy
`inFlight` key still counts only as a non-empty string head). Identity-only keys
no longer satisfy the guard, so an identity key plus an unrecognised head spelling
fails closed like corrupt JSON. `STATE_BEARING_KEYS` = `inFlightHeads`,
`inFlightHead`, `inFlight`, `verifiedHeads`, `verifiedHead`, `previousHead`,
`deferredHeads`, `releasedHeads`, `retiredSeqs`, `seqCounter`. `IDENTITY_KEYS` =
`pr`, `repo`, `round`, `artifactDir`, `startedAt`, `completedAt`, `verdict`,
`commentId`. The migration ladder (`inFlightEntries`, `verifiedEntries`, …) is
unchanged; D17-3 is closed by witnesses pinning its boundary (a string
`inFlight`/`inFlightHead` migrates and blocks; `inFlight:true` or an object alone
does not).

### B — store only the nonce hash in the record; enforce corroboration in the checker

- `requireBoundary` stores `nonceSha256` (sha256 of the plaintext) in the record
  instead of the plaintext `nonce`. The plaintext is written only to the
  container-local `$HOME/.qwen-verify-nonce`. A host battery cannot recover the
  plaintext from the hash, so it cannot produce a matching log line.
- `verify-pr-check.mjs` becomes the authoritative enforcement point: for a
  `mode:"container"` declaration it requires `gate.nonceSha256` (a 64-hex string)
  **and** a `container-nonce: <value>` line in the round's logs whose value's
  sha256 equals it. The scan walks the round dir, skips `boundary.json` /
  `boundary-gate.json` and non-regular files, and bounds each file read. A
  missing/mismatched hash or absent matching line refuses the container claim.
- The step-7 shell nonce grep is removed (the checker now enforces it); step-5
  and the boundary-gate prose state that the record carries the hash, never the
  plaintext, and that the battery echoes a `container-nonce:` line read from the
  container-local file.
- D17-2: the refusal message states plainly that `mode:"waived"` requires the
  maintainer's approval — it is not a free bypass.

This closes the host-copy path while keeping the conceded boundary honest: a
round that forges both the record hash and a matching log line is still out of
scope (the record corroborates an operator who skipped the gate, not PR code that
forges both).

### C — scope the VM sentence

Rewrite the preflight sentence to "a VM boundary runs the same file from the
trusted checkout **without the `--require-isolation` gate** instead", matching the
VM bullet.

## Files affected

- `scripts/verify-pr-watch-state.mjs` — split key sets; tighten the shape guard.
- `scripts/verify-pr-prepare.mjs` — record `nonceSha256`, drop plaintext `nonce`.
- `scripts/verify-pr-check.mjs` — nonce-hash + log-line corroboration for container.
- `.qwen/skills/verify-pr/SKILL.md` — step-5/step-7 nonce prose, VM sentence.
- `scripts/tests/verify-pr-watch-state.test.js` — identity-only fail-closed +
  per-bearing-key acceptance + migration-boundary witnesses.
- `scripts/tests/verify-pr-prepare.test.js` — record carries hash, no plaintext;
  hash matches the container-local file.
- `scripts/tests/verify-pr-check.test.js` — matching line accepts; missing /
  mismatched hash or line refuses.
- `scripts/tests/qwen-triage-workflow.test.js` — step-5/step-7 raw-skill pins.

## Scope boundaries

- Clusters D (R17-2 liveness), E (R8 long tail), F (D17-4…14) stay tracked in
  #17371; not touched here.
- The core `--context` trust boundary and sha256 content binding (#17375) are
  unchanged.
- No new script or CLI surface; the nonce check moves from shell into the existing
  checker, not into a new entry point.

## Open questions

- None blocking. The nonce enforcement location (checker vs shell) is decided in
  favour of the checker for testable, witnessable enforcement; the shell recipe
  keeps only the `container-nonce:` echo instruction.
