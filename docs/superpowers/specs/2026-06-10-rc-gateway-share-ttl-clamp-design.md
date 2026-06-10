# Cycle 30 — Share ttlSec clamp [300s, 30d] — design

## Context

`add-link-share` mints session-locked guest tokens with a caller-supplied
`ttlSec` (cycle 18 core; cycle 26 added `maxUses` clamping). The POST
`/rc/share` handler currently validates `ttlSec` is a finite number `> 0`
but applies **no upper bound** — a share could be minted to last decades,
defeating the feature's central mitigation ("short default TTL; fast
revoke"). The design's threat table calls for a **max TTL clamp of 30
days**. This cycle adds that clamp (and a small minimum), exactly
mirroring the existing `clampMaxUses`.

## Deviation from the proposal

None of substance — the design explicitly lists "max TTL clamp 30d" as a
mitigation. We implement it gateway-side in the same handler that already
clamps `maxUses`. No daemon edit.

## Decisions

- **D1 — Clamp to `[300, 2592000]` (5 min … 30 days).** `2592000s = 30d`
  is the documented hard cap. `300s = 5 min` is a usability floor: a share
  that expires before the guest can open the link is almost certainly a
  mistake. Mirrors `clampMaxUses([1,100])`.

- **D2 — Clamp, don't reject, an out-of-range value.** Consistent with
  `maxUses` (clamped, not 400'd). The existing **400 `invalid_share`** is
  retained for a non-number / non-finite / `<= 0` `ttlSec` (those are
  malformed, not merely out of range).

- **D3 — The max-clamp is the safe direction and is transparent.**
  Silently capping a 90-day request to 30 days makes the share expire
  _earlier_ than the over-asking caller imagined — the safe direction
  (never grants more than the cap). And it is not even hidden: the
  response already returns `expiresAt` computed from the effective
  (clamped) `ttlSec`, so the caller sees the real, earlier expiry.

- **D4 — The min-clamp's tiny over-grant is acceptable.** Clamping a
  sub-5-minute request _up_ to 300s extends validity by at most ~5
  minutes — negligible inside the "short TTL" threat mitigation, and the
  request was near-certainly a mistake. Documented, not a security hole
  (TTL + `maxUses` + revoke remain the bounds).

- **D5 — Record the effective ttl in the `share_created` audit.** The
  audit detail gains `ttlSec: <effective>` (free-form detail, no
  `AuditAction` enum change) so the log shows the actual granted TTL, not
  the (possibly larger) request.

## Implementation

`src/routes/share.ts`:

- Add `TTL_MIN = 300`, `TTL_MAX = 2592000`, and
  `clampTtlSec(v: number): number = Math.min(TTL_MAX, Math.max(TTL_MIN, Math.floor(v)))`
  (called only after the existing `> 0` finite-number validation, so the
  input is always a positive finite number).
- Pass the clamped value to `store.issueShare({ ttlSec })` and include it
  in the `share_created` audit detail.

This is a pure, self-contained hardening: one handler, no store/auth/hot-
path change, fail-safe under any mid-cycle cut (the validation already
rejects malformed input; the clamp only tightens an accepted value).

## Deferred (not this cycle)

- L4 `share_id`/`share_label` audit tagging + `--share-id` filter
  (touches `resolve()`/auth + the bounded set of share-reachable routes —
  its own cycle).
- `/ui/share/<token>` bootstrap page + watermark (browser).
- `qwen rc share` CLI.

## Verification

`typecheck/lint/build/test --workspace @qwen-code/rc-gateway` +
`node scripts/rc-gateway-e2e.mjs`. New unit tests: a huge ttlSec caps at
2592000 (assert `expiresAt - now ≈ 30d`), a tiny positive ttlSec floors at
300, an in-range value passes through, and `0`/negative/non-number still 400. The e2e is unaffected (no share mint in the e2e path).
