/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  promptLatencySkipReason,
  shouldSkipPromptLatency,
} from './_prompt-latency-policy.js';

const POOL = { RUNNER_ENVIRONMENT: 'self-hosted' };
const HOSTED = { RUNNER_ENVIRONMENT: 'github-hosted' };
const KEY = { OPENAI_API_KEY: 'test-key' };

describe('shouldSkipPromptLatency', () => {
  it('skips on the shared self-hosted pool', () => {
    expect(shouldSkipPromptLatency({ ...POOL, ...KEY })).toBe(true);
  });

  it('force-runs on the pool for ENABLE=1 only, not mere presence', () => {
    expect(
      shouldSkipPromptLatency({
        ...POOL,
        ...KEY,
        QWEN_BASELINE_ENABLE_PROMPT_LATENCY: '1',
      }),
    ).toBe(false);
    expect(
      shouldSkipPromptLatency({
        ...POOL,
        ...KEY,
        QWEN_BASELINE_ENABLE_PROMPT_LATENCY: '0',
      }),
    ).toBe(true);
  });

  it('runs with a credential off the pool', () => {
    expect(shouldSkipPromptLatency({ ...HOSTED, ...KEY })).toBe(false);
    // RUNNER_ENVIRONMENT is unset on legs that never map it.
    expect(shouldSkipPromptLatency({ ...KEY })).toBe(false);
  });

  it('skips without a credential', () => {
    expect(shouldSkipPromptLatency({ ...HOSTED })).toBe(true);
    expect(shouldSkipPromptLatency({ ...HOSTED, OPENAI_API_KEY: '' })).toBe(
      true,
    );
  });

  it('honours the explicit skip flag over the force-run switch', () => {
    expect(
      shouldSkipPromptLatency({
        ...HOSTED,
        ...KEY,
        QWEN_BASELINE_SKIP_PROMPT_LATENCY: '1',
        QWEN_BASELINE_ENABLE_PROMPT_LATENCY: '1',
      }),
    ).toBe(true);
  });

  it('counts ENABLE=1 and a populated QWEN_CUSTOM_API_KEY_* as credentials', () => {
    expect(
      shouldSkipPromptLatency({
        ...HOSTED,
        QWEN_BASELINE_ENABLE_PROMPT_LATENCY: '1',
      }),
    ).toBe(false);
    expect(
      shouldSkipPromptLatency({ ...HOSTED, QWEN_CUSTOM_API_KEY_TEAM: 'k' }),
    ).toBe(false);
    expect(
      shouldSkipPromptLatency({ ...HOSTED, QWEN_CUSTOM_API_KEY_TEAM: '' }),
    ).toBe(true);
  });
});

describe('promptLatencySkipReason', () => {
  it('names the explicit skip flag when that is the clause that fired', () => {
    expect(
      promptLatencySkipReason(
        { ...HOSTED, ...KEY, QWEN_BASELINE_SKIP_PROMPT_LATENCY: '1' },
        20,
      ),
    ).toBe('Prompt latency skipped via QWEN_BASELINE_SKIP_PROMPT_LATENCY=1.');
    expect(
      promptLatencySkipReason(
        { ...POOL, ...KEY, QWEN_BASELINE_SKIP_PROMPT_LATENCY: '1' },
        20,
      ),
    ).toBe('Prompt latency skipped via QWEN_BASELINE_SKIP_PROMPT_LATENCY=1.');
  });

  it('never advises the force-run switch while the explicit skip is set', () => {
    // The explicit flag is the first disjunct and outranks ENABLE=1, so this
    // advice could never re-enable the probe.
    expect(
      promptLatencySkipReason(
        { ...POOL, ...KEY, QWEN_BASELINE_SKIP_PROMPT_LATENCY: '1' },
        20,
      ),
    ).not.toContain('QWEN_BASELINE_ENABLE_PROMPT_LATENCY');
  });

  it('reports the missing credential when none is set', () => {
    expect(promptLatencySkipReason({ ...HOSTED }, 20)).toMatch(
      /^No recognized model credential env var is set/,
    );
  });

  it('reports the pool with the iteration count the probe would have used', () => {
    expect(promptLatencySkipReason({ ...POOL, ...KEY }, 7)).toBe(
      'Shared self-hosted pool: 7 real model round-trips would measure host contention, not the daemon. Set QWEN_BASELINE_ENABLE_PROMPT_LATENCY=1 to force-run.',
    );
  });
});
