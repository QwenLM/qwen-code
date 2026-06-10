# Cycle 30 — Share ttlSec clamp — plan (TDD)

Single self-contained commit (pure hardening, fail-safe; the existing
validation already rejects malformed input, the clamp only tightens an
accepted value).

## `src/routes/share.ts`

- Add constants `TTL_MIN = 300`, `TTL_MAX = 2592000` (5 min … 30 days).
- Add `clampTtlSec(v: number): number` =
  `Math.min(TTL_MAX, Math.max(TTL_MIN, Math.floor(v)))`. Called only after
  the existing finite-`>0` check (input always a positive finite number),
  mirroring `clampMaxUses`.
- In POST `/`: `const effectiveTtl = clampTtlSec(ttlSec);` pass to
  `issueShare({ ttlSec: effectiveTtl })`; add `ttlSec: effectiveTtl` to
  the `share_created` audit detail.

## `src/routes/share.test.ts`

- A huge `ttlSec` (e.g. `999999999`) → 201; returned `expiresAt - now`
  ≈ 2592000s (within a small tolerance). (Use the route's injected clock
  if available, else assert the delta is ≤ 2592000\*1000 and ≥ near it.)
- A tiny positive `ttlSec` (e.g. `5`) → 201; `expiresAt - now` ≈ 300s.
- An in-range `ttlSec` (e.g. `3600`) → 201; `expiresAt - now` ≈ 3600s.
- `ttlSec: 0` / negative / non-number → still 400 `invalid_share` (the
  clamp does not swallow malformed input).
- The `share_created` audit detail carries the effective (clamped)
  `ttlSec`.

Commit: `feat(rc-gateway): clamp share ttlSec to [300s, 30d]`

## Then

advisor (done) → opus review on the diff → fix → full verify
(typecheck/lint/build/test + e2e) → push → update both memory files.
