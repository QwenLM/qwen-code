# Review successor-chain sentinel (issue #9905)

## Problem

The `/review` cross-round ledger tracks finding ids, carries, and
supersession, but nothing reads the _lineage_: when the fix for round N's
Critical produces round N+1's Critical on the same subsystem, every round
looks locally normal while the subsystem is diverging. On #9659 the
stop-round blocker-dating chain produced three generations of successor
Criticals (R9-1 → R10-2/3/4 → R11-4/R11-6 → R12-1/R12-2); recognizing the
divergence took a manual round-count analysis and cost four rounds of
patch-and-regress before the mechanism was deleted and the open-finding
count collapsed.

The convergence module's recurrence cluster already says "the file sees
findings again" — it cannot say "the fix closed one and the mechanism grew
another", because no round records the _closures_.

## Design

A deterministic lineage check inside `diagnoseConvergence`, fed by a
bounded closure list the ledger marker carries. No model judgement: it is
a walk over data the pipeline already writes.

### The marker carries one `closed` list

`Ledger` gains an optional `closed` array. An entry `{r, id, f}` records a
**Critical** that was open in the previous round's work list and is absent
from this round's: composing round `r` diffs the recovered list against the
built ledger and appends one entry per vanished Critical id. Suggestions
are not tracked — Critical churn is the signal. `fixed` and `superseded`
both read as closure; a positional diff cannot tell them apart, and the
advisory note does not need it to.

The list carries **one generation, no carry-forward**: the check at round
N reads closures at N (minted while composing) and N-1 (read back off the
previous marker), so older entries are dead bytes. Bounds, matching the
marker's "footnote, never a payload" contract:

- count: `LEDGER_MAX_CLOSED` (50) entries — one full work list — newest
  kept;
- bytes: in the serializer's shed cascade the closures go **after** the
  volume telemetry and **before** the anchor pair and the work list —
  advisory data never costs a re-review or a ruling. Shedding them never
  sets `dropped`: closures certify no range.

Minting is suppressed wherever absence from the posting set does not
mean "ruled fixed" — the same honesty legs the `openCriticals` gate
applies to the identical inference: an incomplete recovered work list
(`dropped`/rejected entries — a missing id may be truncation, not a
ruling), a diff-only round that could not rule, a round that publicly
answered "cannot tell" on a Critical, and a pure-foreign previous list
whose entries are a stranger's. Minting also closes on CLAIM identity,
not id identity: a claim the round re-posts under a re-minted id (a
regenerated gate Critical, a model re-post the readback lost) still
stands. The re-post channels — the deferral channel and the
floor-enforced reroute — join on the ID they carry: an entry whose title
bears the original finding id keeps that claim standing under whichever
severity or path re-posts it, and an entry that bears none leaves the
round unable to prove what it re-posts, so the mint fails closed and
mints nothing that round. Thin history stays silent rather than
guesses.

`parseLedger` validates closures through `isLedgerClosure` (caps and the
round bound, mirrored from the serializer); `prevLedgerFacts` carries them
into compose through the same admission test on the side-file route.

### The check (K = 2, current round included)

Inside `diagnoseConvergence`, beside the recurrence cluster: a file F
fires a **successor chain** when

- F closed a Critical in the previous round (`prev.closed` with
  `r === round - 1`), and
- F closes a Critical this round (`closuresThisRound` with `r === round`),
  and
- this round posts a **fresh** Critical on F (the built ledger's
  `R<round>-*` ids — the built id's round IS the first-reported round,
  after readback and admission).

The cluster's own file rules apply unchanged: the `(body)`/`(unknown)`
stand-ins never participate, and the `k` flag still separates a real path
spelled like one.

Checked against the #9659 evidence: composing round 11 closes R10-2/3/4
(r=11) on top of R9-1's closure at r=10, while R11-4/R11-6 land on the
same file — the note fires at round 11, one round before the manual
analysis caught the rebound.

### Output (advisory, first-class)

The note never moves the event and never withholds the anchor:

- `ConvergenceDiagnosis.successorChains` carries the typed chains
  (`{file, generations, newIds}`), rendered by `renderSuccessorChain` as
  `R9-1 → R10-2/R10-3 → R11-4`;
- the convergence observation (posted body + the stderr `CONVERGENCE:`
  line) leads with the ⚠️ Divergence sentence naming the subsystem and
  the chain, bilingually, `mdField`-escaped like every other
  PR-controlled segment;
- `recommendationsFor` emits a new closed-vocabulary code,
  `successor-chain`, with the chain in its `basis` — the machine-readable
  half the autofix tooling reads. It rides the composed artifact through
  the existing `recommendations` validation, which checks codes against
  the runtime list.

### What it deliberately does not do

- It cannot distinguish `fixed` from `superseded` or a dropped carry —
  closure is positional. The note is advisory, so a rare false positive
  costs one sentence; the carry-forward machinery (`LEDGER_ID_READBACK`,
  the stray-id rules) is what keeps carries honest.
- It never caps the verdict and never withholds the anchor. A divergence
  is a property of the code under review, not of what this round read.
- File-level matching only; the ledger records no symbols (the issue's
  "symbol, if recorded" — it is not recorded).
