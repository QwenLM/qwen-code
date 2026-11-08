/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReasoningEffort } from './reasoning-effort.js';

// Single source of truth for the Claude family list. Both the `ClaudeModelFamily`
// union and the model-id regex are derived from this array, so adding a family
// updates the type and the parser together — a maintainer can't update one and
// silently leave the other (and the `as ClaudeModelFamily` cast) stale.
const CLAUDE_MODEL_FAMILIES = [
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'mythos',
] as const;
type ClaudeModelFamily = (typeof CLAUDE_MODEL_FAMILIES)[number];

interface ParsedClaudeModelVersion {
  family: ClaudeModelFamily;
  major: number;
  minor: number;
}

/**
 * Parse a Claude model id into `{ family, major, minor }`, or `null` for
 * non-Claude / unversioned ids. The single source of truth for the capability
 * gating below — both `anthropicSupportedEffortTiers` and
 * `modelSupportsAdaptiveThinking` consume this so the family list and the
 * version-parsing rules can't drift apart when Anthropic ships a new family.
 *
 * The regex is unanchored so reseller-prefixed ids (`bedrock/…`, `vertex_ai/…`,
 * `idealab:…`) match the same Anthropic models on the wire. The minor-version
 * group is capped at one or two digits with a trailing `(?!\d)` so an 8-digit
 * date suffix (`claude-opus-4-20250514` = Opus 4.0) is not mis-parsed as a giant
 * minor version. The `{1,2}` cap alone is not enough — `\d{1,2}` is greedy and
 * still matches `20` from `20250514`; it's the trailing `(?!\d)` negative
 * lookahead that does the real work, forcing the engine to backtrack past any
 * digit-followed match so the optional minor group fails to match entirely.
 * Both together make dated ids with no real minor resolve to `minor = 0`
 * (otherwise `minor` would wrongly clear `atLeast(4, 6)` / `atLeast(4, 7)` gates
 * the model doesn't support — a server 400). Dated ids that do carry a minor,
 * like `claude-opus-4-7-20251101`, still resolve to minor `7`; a bare major
 * (`claude-opus-5`) resolves to minor `0`.
 */
export function parseClaudeModelVersion(
  model: string,
): ParsedClaudeModelVersion | null {
  // The minor separator accepts both `-` (Anthropic canonical, e.g.
  // `claude-opus-4-8`) and `.` (LiteLLM/Vertex/Bedrock alias convention, e.g.
  // `claude-opus-4.8`). Without the `.` branch a dotted alias parses as
  // `{major, minor:0}`, silently disabling adaptive thinking, the
  // temperature-rejection gate, and the version-gated effort tiers for 4.6+
  // models — which surfaces as a server 400 the first time the harness sends
  // `thinking.type.enabled` to an Opus 4.7+ / 5.x model group.
  const match = model
    .toLowerCase()
    .match(
      new RegExp(
        `claude-(${CLAUDE_MODEL_FAMILIES.join(
          '|',
        )})-(\\d+)(?:[-.](\\d{1,2})(?!\\d))?`,
      ),
    );
  if (!match) {
    return null;
  }
  return {
    family: match[1] as ClaudeModelFamily,
    major: Number.parseInt(match[2], 10),
    minor: match[3] ? Number.parseInt(match[3], 10) : 0,
  };
}

/**
 * The reasoning-effort tiers a real Anthropic model accepts on
 * `output_config.effort`. Every effort-capable model takes low/medium/high; the
 * extra-strong tiers are gated by model version per the Anthropic docs
 * (https://platform.claude.com/docs/en/build-with-claude/effort):
 *   - `max`:   Opus/Sonnet 4.6+ and every 5.x family (Fable 5, Mythos 5, …).
 *   - `xhigh`: Opus 4.7+ and every 5.x family (NOT Sonnet 4.6 / Opus 4.6).
 *
 * Unknown/unversioned ids fall back to low/medium/high so we never send a tier
 * the server might 400 on. Effort levels above what the model supports are
 * clamped by the caller via clampReasoningEffort.
 */
export function anthropicSupportedEffortTiers(
  model: string,
): ReasoningEffort[] {
  const tiers: ReasoningEffort[] = ['low', 'medium', 'high'];
  const parsed = parseClaudeModelVersion(model);
  if (!parsed) {
    return tiers;
  }
  const { family, major, minor } = parsed;
  const atLeast = (maj: number, min: number) =>
    major > maj || (major === maj && minor >= min);

  // xhigh: Opus 4.7+ and all 5.x families.
  if (major >= 5 || (family === 'opus' && atLeast(4, 7))) {
    tiers.push('xhigh');
  }
  // max: 4.6+ (opus/sonnet only) and all 5.x families. The 4.x branch is
  // family-guarded to match the documented support above — haiku 4.x never
  // gains `max` (a server 400), while every 5.x family still does via major>=5.
  if (
    major >= 5 ||
    ((family === 'opus' || family === 'sonnet') && atLeast(4, 6))
  ) {
    tiers.push('max');
  }
  return tiers;
}
