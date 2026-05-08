/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getCurrentAgentId,
  getRuntimeContentGenerator,
  runWithAgentContext,
  runWithRuntimeContentGenerator,
  type RuntimeContentGeneratorView,
} from './agent-context.js';
import {
  AuthType,
  type ContentGenerator,
  type ContentGeneratorConfig,
} from '../../core/contentGenerator.js';

function makeView(model: string): RuntimeContentGeneratorView {
  return {
    contentGenerator: { tag: model } as unknown as ContentGenerator,
    contentGeneratorConfig: {
      model,
      authType: AuthType.USE_OPENAI,
    } as ContentGeneratorConfig,
  };
}

describe('agent-context (agentId)', () => {
  it('returns null outside any frame', () => {
    expect(getCurrentAgentId()).toBeNull();
  });

  it('exposes the agentId inside a frame', async () => {
    await runWithAgentContext('explore-abc', async () => {
      expect(getCurrentAgentId()).toBe('explore-abc');
    });
    expect(getCurrentAgentId()).toBeNull();
  });

  it('propagates across awaits', async () => {
    await runWithAgentContext('outer-1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getCurrentAgentId()).toBe('outer-1');
    });
  });

  it('nested frames shadow the outer agentId', async () => {
    await runWithAgentContext('outer-1', async () => {
      expect(getCurrentAgentId()).toBe('outer-1');
      await runWithAgentContext('inner-2', async () => {
        expect(getCurrentAgentId()).toBe('inner-2');
      });
      expect(getCurrentAgentId()).toBe('outer-1');
    });
  });

  it('isolates concurrent frames', async () => {
    const results: string[] = [];
    await Promise.all([
      runWithAgentContext('a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        results.push(getCurrentAgentId() ?? 'null');
      }),
      runWithAgentContext('b', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        results.push(getCurrentAgentId() ?? 'null');
      }),
    ]);
    expect(results.sort()).toEqual(['a', 'b']);
  });
});

describe('agent-context (runtimeView)', () => {
  it('returns undefined outside any frame', () => {
    expect(getRuntimeContentGenerator()).toBeUndefined();
  });

  it('exposes the view to code running inside the frame', async () => {
    const view = makeView('qwen3.6-plus');
    const inner = await runWithRuntimeContentGenerator(view, async () =>
      getRuntimeContentGenerator(),
    );
    expect(inner).toBe(view);
    expect(getRuntimeContentGenerator()).toBeUndefined();
  });

  it('isolates sibling runs', async () => {
    const v1 = makeView('model-a');
    const v2 = makeView('model-b');
    const [seen1, seen2] = await Promise.all([
      runWithRuntimeContentGenerator(v1, async () =>
        getRuntimeContentGenerator(),
      ),
      runWithRuntimeContentGenerator(v2, async () =>
        getRuntimeContentGenerator(),
      ),
    ]);
    expect(seen1).toBe(v1);
    expect(seen2).toBe(v2);
  });

  it('propagates through await chains', async () => {
    const view = makeView('chained');
    const seen = await runWithRuntimeContentGenerator(view, async () => {
      await Promise.resolve();
      await Promise.resolve();
      return getRuntimeContentGenerator();
    });
    expect(seen).toBe(view);
  });

  it('lets a nested run shadow the outer view', async () => {
    const outer = makeView('outer');
    const inner = makeView('inner');
    const [seenOuter, seenInner] = await runWithRuntimeContentGenerator(
      outer,
      async () => {
        const before = getRuntimeContentGenerator();
        const after = await runWithRuntimeContentGenerator(inner, async () =>
          getRuntimeContentGenerator(),
        );
        return [before, after];
      },
    );
    expect(seenOuter).toBe(outer);
    expect(seenInner).toBe(inner);
    const outerAgain = await runWithRuntimeContentGenerator(outer, async () => {
      await runWithRuntimeContentGenerator(inner, async () => undefined);
      return getRuntimeContentGenerator();
    });
    expect(outerAgain).toBe(outer);
  });
});

describe('agent-context (merging)', () => {
  it('runtimeView wrap preserves agentId from outer frame', async () => {
    const view = makeView('inner-model');
    await runWithAgentContext('outer-agent', async () => {
      await runWithRuntimeContentGenerator(view, async () => {
        expect(getCurrentAgentId()).toBe('outer-agent');
        expect(getRuntimeContentGenerator()).toBe(view);
      });
      // After the inner run resolves, runtimeView is gone but agentId stays.
      expect(getCurrentAgentId()).toBe('outer-agent');
      expect(getRuntimeContentGenerator()).toBeUndefined();
    });
  });

  it('agentId wrap preserves runtimeView from outer frame', async () => {
    const view = makeView('outer-model');
    await runWithRuntimeContentGenerator(view, async () => {
      await runWithAgentContext('inner-agent', async () => {
        expect(getRuntimeContentGenerator()).toBe(view);
        expect(getCurrentAgentId()).toBe('inner-agent');
      });
      expect(getRuntimeContentGenerator()).toBe(view);
      expect(getCurrentAgentId()).toBeNull();
    });
  });
});
