/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getCurrentAgentId, runWithAgentContext } from './agent-context.js';

describe('agent-context', () => {
  it('returns null outside any frame', () => {
    expect(getCurrentAgentId()).toBeNull();
  });

  it('exposes the agentId inside a frame', async () => {
    await runWithAgentContext({ agentId: 'explore-abc' }, async () => {
      expect(getCurrentAgentId()).toBe('explore-abc');
    });
    expect(getCurrentAgentId()).toBeNull();
  });

  it('propagates across awaits', async () => {
    await runWithAgentContext({ agentId: 'outer-1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getCurrentAgentId()).toBe('outer-1');
    });
  });

  it('nested frames shadow the outer agentId', async () => {
    await runWithAgentContext({ agentId: 'outer-1' }, async () => {
      expect(getCurrentAgentId()).toBe('outer-1');
      await runWithAgentContext({ agentId: 'inner-2' }, async () => {
        expect(getCurrentAgentId()).toBe('inner-2');
      });
      expect(getCurrentAgentId()).toBe('outer-1');
    });
  });

  it('isolates concurrent frames', async () => {
    const results: string[] = [];
    await Promise.all([
      runWithAgentContext({ agentId: 'a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        results.push(getCurrentAgentId() ?? 'null');
      }),
      runWithAgentContext({ agentId: 'b' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        results.push(getCurrentAgentId() ?? 'null');
      }),
    ]);
    expect(results.sort()).toEqual(['a', 'b']);
  });
});
