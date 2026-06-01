/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentAssertCanStartBackground,
  agentRegister,
  BACKGROUND_AGENT_CONCURRENCY_ENV,
  DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS,
  MAX_CONCURRENT_BACKGROUND_AGENTS,
  resolveMaxConcurrentBackgroundAgents,
  setAgentBackgroundCapForTest,
} from './agent-task.js';
import { TaskRegistry } from './registry.js';

function makeAgentReg(
  agentId: string,
  overrides: { isBackgrounded?: boolean; status?: 'running' | 'paused' } = {},
) {
  return {
    agentId,
    description: `Agent ${agentId}`,
    isBackgrounded: overrides.isBackgrounded ?? true,
    status: overrides.status ?? ('running' as const),
    startTime: Date.now(),
    abortController: new AbortController(),
    outputFile: `/tmp/${agentId}.jsonl`,
  };
}

describe('background-agent concurrency cap', () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = new TaskRegistry();
  });

  afterEach(() => {
    setAgentBackgroundCapForTest(undefined);
  });

  describe('resolveMaxConcurrentBackgroundAgents', () => {
    it('returns the default when the env var is unset', () => {
      expect(resolveMaxConcurrentBackgroundAgents({})).toBe(
        DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS,
      );
    });

    it('returns the parsed env value when valid', () => {
      expect(
        resolveMaxConcurrentBackgroundAgents({
          [BACKGROUND_AGENT_CONCURRENCY_ENV]: '3',
        }),
      ).toBe(3);
    });

    it('falls back to the default for non-integer env values', () => {
      expect(
        resolveMaxConcurrentBackgroundAgents({
          [BACKGROUND_AGENT_CONCURRENCY_ENV]: '2.5',
        }),
      ).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS);
    });

    it('falls back to the default for values < 1', () => {
      expect(
        resolveMaxConcurrentBackgroundAgents({
          [BACKGROUND_AGENT_CONCURRENCY_ENV]: '0',
        }),
      ).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS);
    });

    it('treats whitespace-only env values as unset', () => {
      expect(
        resolveMaxConcurrentBackgroundAgents({
          [BACKGROUND_AGENT_CONCURRENCY_ENV]: '   ',
        }),
      ).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_AGENTS);
    });
  });

  describe('agentAssertCanStartBackground', () => {
    it('does not throw when no background agents are running', () => {
      expect(() => agentAssertCanStartBackground(registry)).not.toThrow();
    });

    it('counts only running backgrounded agents toward the cap', () => {
      setAgentBackgroundCapForTest(2);
      // A foreground agent and a paused agent should NOT count.
      agentRegister(
        registry,
        makeAgentReg('fg-1', { isBackgrounded: false, status: 'running' }),
      );
      agentRegister(
        registry,
        makeAgentReg('paused-1', { isBackgrounded: true, status: 'paused' }),
      );
      // One real running background agent.
      agentRegister(registry, makeAgentReg('bg-1'));

      // Cap is 2; only `bg-1` counts. Asserting should still pass.
      expect(() => agentAssertCanStartBackground(registry)).not.toThrow();
    });

    it('throws once the cap is reached', () => {
      setAgentBackgroundCapForTest(1);
      agentRegister(registry, makeAgentReg('bg-1'));

      expect(() => agentAssertCanStartBackground(registry)).toThrow(
        /maximum concurrent background agents \(1\)/,
      );
    });

    it('uses the live module-level cap, not a snapshot at import', () => {
      setAgentBackgroundCapForTest(1);
      agentRegister(registry, makeAgentReg('bg-1'));
      expect(() => agentAssertCanStartBackground(registry)).toThrow();

      setAgentBackgroundCapForTest(5);
      expect(() => agentAssertCanStartBackground(registry)).not.toThrow();
    });
  });

  describe('agentRegister cap guard', () => {
    it('rejects a fresh background agent that would exceed the cap', () => {
      setAgentBackgroundCapForTest(1);
      agentRegister(registry, makeAgentReg('bg-1'));

      expect(() =>
        agentRegister(registry, makeAgentReg('bg-2')),
      ).toThrow(/maximum concurrent background agents/);
      // Failed register must NOT have inserted the entry.
      expect(registry.get('bg-2')).toBeUndefined();
    });

    it('does not count foreground agents toward the cap', () => {
      setAgentBackgroundCapForTest(1);
      agentRegister(
        registry,
        makeAgentReg('fg-1', { isBackgrounded: false }),
      );

      expect(() =>
        agentRegister(registry, makeAgentReg('bg-1')),
      ).not.toThrow();
    });

    it('skips the cap check when re-registering an already-running entry (resume race)', () => {
      setAgentBackgroundCapForTest(1);
      agentRegister(registry, makeAgentReg('bg-1'));

      // Resume re-registers under the same id with status: 'running'. Even
      // though the cap is full, the same entry shouldn't double-count
      // against itself.
      expect(() =>
        agentRegister(
          registry,
          makeAgentReg('bg-1', { status: 'running' }),
        ),
      ).not.toThrow();
    });

    it('does not check the cap when registering a paused entry', () => {
      setAgentBackgroundCapForTest(0); // 0 is invalid, so falls back to default.
      // Paused entries — used by resume restoration — bypass the cap because
      // they don't hold any of the resources the cap is meant to bound.
      expect(() =>
        agentRegister(
          registry,
          makeAgentReg('paused-1', { status: 'paused' }),
        ),
      ).not.toThrow();
    });
  });

  describe('module-level cap', () => {
    it('exposes the env-derived value at module load', () => {
      // Whatever process.env says at load time, the constant should be ≥1.
      expect(MAX_CONCURRENT_BACKGROUND_AGENTS).toBeGreaterThanOrEqual(1);
    });

    it('setAgentBackgroundCapForTest(undefined) restores the env-derived default', () => {
      setAgentBackgroundCapForTest(3);
      setAgentBackgroundCapForTest(undefined);
      // Re-resolved from process.env — same value the module captured at load.
      expect(MAX_CONCURRENT_BACKGROUND_AGENTS).toBe(
        resolveMaxConcurrentBackgroundAgents(),
      );
    });
  });
});
