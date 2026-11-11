/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies auto-compact threshold math interacts correctly with the
 * context-window-config branch's selection feature.
 *
 * Three cases must hold:
 *   (1) Gate OFF                            → threshold ≈ tokenLimit(model)
 *   (2) Gate ON, no user selection          → threshold ≈ tokenLimit(model)
 *   (3) Gate ON, user has picked 1M         → threshold ≈ 1M (not 200K)
 *
 * Without these, picking 1M would either be ignored (case 3 = case 2) or
 * gate-off users would silently see inflated thresholds (B2 regression).
 */

import { ENV_AUTOCOMPACT_WINDOW } from '../config/brand.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  getAutoCompactBufferTokens,
  getRawContextWindowSize,
  getSummaryReserveTokens,
} from './thresholds.js';
import type { Model } from '../provider/model/model.js';
import { testListedModel } from '../test-utils/listed-model.js';

const MODEL = 'claude-sonnet-4';
const MAX_INPUT_TOKENS = 200_000;
const MAX_OUTPUT_TOKENS = 20_000;
const ONE_MILLION = 1_000_000;

let model: Model;

beforeEach(() => {
  model = testListedModel(MODEL, {
    max_input_tokens: MAX_INPUT_TOKENS,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    available_context_windows: [MAX_INPUT_TOKENS, ONE_MILLION],
    default_context_window: MAX_INPUT_TOKENS,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Auto-compact ↔ context-window interaction', () => {
  it('Case 1: gate OFF — threshold uses tokenLimit (max_input_tokens), not inflated to 1M', () => {
    // No context-window source at all → falls back to tokenLimit(model)
    expect(getRawContextWindowSize(model)).toBe(MAX_INPUT_TOKENS);
    expect(getEffectiveContextWindowSize(model)).toBe(
      MAX_INPUT_TOKENS - getSummaryReserveTokens(model),
    );

    const effective = getEffectiveContextWindowSize(model);
    const buffer = getAutoCompactBufferTokens(effective);
    expect(getAutoCompactThreshold(model)).toBe(effective - buffer);

    // CRITICAL: the threshold must NOT be derived from 1_000_000.
    expect(getAutoCompactThreshold(model)).toBeLessThan(MAX_INPUT_TOKENS);
    expect(getAutoCompactThreshold(model)).toBeGreaterThan(
      MAX_INPUT_TOKENS / 2,
    );
  });

  it('Case 2: gate ON, user has NOT selected — threshold uses default (max_input_tokens)', () => {
    // Config returns max_input_tokens via getEffectiveContextWindow because
    // user has no selection (Config.getEffectiveContextWindow falls back to tokenLimit).
    const source = MAX_INPUT_TOKENS;

    expect(getRawContextWindowSize(model, source)).toBe(MAX_INPUT_TOKENS);
    expect(getEffectiveContextWindowSize(model, source)).toBe(
      MAX_INPUT_TOKENS - getSummaryReserveTokens(model),
    );

    const effective = getEffectiveContextWindowSize(model, source);
    const buffer = getAutoCompactBufferTokens(effective);
    expect(getAutoCompactThreshold(model, source)).toBe(effective - buffer);
  });

  it('Case 3: gate ON + selected 1M — threshold uses 1M, not 200K', () => {
    const source = ONE_MILLION;

    expect(getRawContextWindowSize(model, source)).toBe(ONE_MILLION);
    expect(getEffectiveContextWindowSize(model, source)).toBe(
      ONE_MILLION - getSummaryReserveTokens(model),
    );

    const effective = getEffectiveContextWindowSize(model, source);
    const buffer = getAutoCompactBufferTokens(effective);
    expect(getAutoCompactThreshold(model, source)).toBe(effective - buffer);

    // CRITICAL: with 1M selected, compaction must NOT fire at the 200K mark.
    expect(getAutoCompactThreshold(model, source)).toBeGreaterThan(
      MAX_INPUT_TOKENS,
    );
  });

  it('Case 4: selecting 1M then clearing returns threshold to default', () => {
    // First, with 1M selected.
    const selected = ONE_MILLION;
    expect(getRawContextWindowSize(model, selected)).toBe(ONE_MILLION);
    expect(getEffectiveContextWindowSize(model, selected)).toBe(
      ONE_MILLION - getSummaryReserveTokens(model),
    );

    // Then user clears the selection — effective window collapses to default.
    const cleared = MAX_INPUT_TOKENS;
    expect(getRawContextWindowSize(model, cleared)).toBe(MAX_INPUT_TOKENS);
    expect(getEffectiveContextWindowSize(model, cleared)).toBe(
      MAX_INPUT_TOKENS - getSummaryReserveTokens(model),
    );
  });

  it('ENV_AUTOCOMPACT_WINDOW env override is honored regardless of context_window selection', () => {
    const source = ONE_MILLION;
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '50000');

    // Override should clamp the raw window down for debugging.
    expect(getRawContextWindowSize(model, source)).toBe(50_000);
    expect(getEffectiveContextWindowSize(model, source)).toBe(
      50_000 - getSummaryReserveTokens(model),
    );
  });
});
