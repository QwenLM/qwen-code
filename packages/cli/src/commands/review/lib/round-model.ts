/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The identity a review round runs under — read from the runtime's published
// env slots, in ONE place.
//
// Four boundaries need it (`fetch-pr` stamps the round with it, `submit` and
// the `compose-review` handler certify the posted marker with it, `pr-context`
// rules on whether a recovered anchor is admissible), and the whole point of
// the same-model contract is that they all mean the same string by it. Four
// inline `??` chains would be four chances to drift.

/**
 * The identity this round runs under.
 *
 * Prefers the PROVIDER-QUALIFIED id (`<model>@<8-hex of authType+baseUrl>`):
 * a bare model id is unique only inside one provider configuration, so two of
 * them exposing the same name would otherwise pass each other's same-model
 * gate and skip code neither reviewed. Falls back to the bare id for a runtime
 * that publishes no identity — whether the slot is absent or BLANK, which are
 * the same fact said two ways — and to `''`, meaning "unknown" and read by
 * every caller as a mismatch rather than as agreement, for a runtime that
 * publishes neither.
 *
 * The empty case is reachable in normal operation, not just in tests: the
 * identity slot is blanked (not omitted) when a session has none to publish,
 * precisely so a stale value from a parent process cannot ride the spawn-site
 * env spread. An empty string therefore means "this runtime told us nothing",
 * and it must never compare equal to another empty one.
 */
export function roundModelIdFrom(env: NodeJS.ProcessEnv): string {
  // `??` would be wrong here, and was: it falls back on absent, not on EMPTY,
  // and the identity slot is deliberately written as `''` when a session has
  // none to publish (an omitted key is not withheld — the spawn-site
  // `{...process.env, ...}` spread leaks the parent's stale one). So `??` made
  // a blanked slot mean "this round has no identity at all" rather than "no
  // qualification, use the bare id", and every such round then certified
  // nobody and re-reviewed the full diff for ever after. Blanking must cost
  // the qualification, never the identity.
  const identity = (env['QWEN_CODE_MODEL_IDENTITY'] ?? '').trim();
  if (identity !== '') return identity;
  return (env['QWEN_CODE_MODEL'] ?? '').trim();
}

/**
 * Is a marker's certifying identity the one running THIS round?
 *
 * Whole-string equality, never a prefix: `qwen3.7-max` must not match
 * `qwen3.7-max@9f8e7d6c`, and two different providers' digests must not match
 * each other — that separation is the only thing the digest buys.
 *
 * Both empty cases are a MISMATCH by construction. An absent `certifier` is a
 * marker written before the field; an empty `running` is a runtime that
 * published no identity at all. Neither knows who reviewed the range, and the
 * fallback for not knowing is always the full review, never a skip.
 */
export function certifierMatchesRound(
  certifier: string | undefined,
  running: string,
): boolean {
  const c = certifier?.trim() ?? '';
  return c !== '' && running !== '' && c === running;
}
