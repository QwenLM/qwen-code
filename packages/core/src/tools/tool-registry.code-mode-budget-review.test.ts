/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { CHARS_PER_TOKEN } from '../services/tokenEstimation.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolMode } from './code-mode.js';
import { ToolNames } from './tool-names.js';
import { ExecTool } from './exec.js';

const target = () =>
  new MockTool({
    name: 'deferred',
    description: 'Budget-controlled deferred tool. '.repeat(80),
    shouldDefer: true,
    params: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  });

function fixture(mode: ToolMode, hiddenExec = false) {
  const config = makeFakeConfig({ toolMode: mode });
  const registry = new ToolRegistry(config);
  registry.registerTool(new MockTool({ name: ToolNames.TOOL_SEARCH }));
  registry.registerTool(new MockTool({ name: ToolNames.TOOL_CALL }));
  if (mode === ToolMode.CodeMode) {
    if (hiddenExec) {
      registry.registerPermissionDeferredFactory(
        ToolNames.EXEC,
        async () => new ExecTool(config),
      );
    } else {
      registry.registerTool(new ExecTool(config));
    }
  }
  const deferred = target();
  registry.registerTool(deferred);
  return { registry, deferred };
}

describe('Code-mode preload follows actual declaration growth', () => {
  it('keeps Direct preload at the raw-schema budget', () => {
    const { registry, deferred } = fixture(ToolMode.Direct);
    const rawTokens = Math.ceil(
      JSON.stringify(deferred.schema).length / CHARS_PER_TOKEN,
    );
    expect(registry.preloadDeferredToolsWithinBudget(rawTokens - 1)).toBe(0);
    expect(registry.preloadDeferredToolsWithinBudget(rawTokens)).toBe(1);
  });

  it('keeps real exec declared even from a permission-deferred factory', async () => {
    const { registry, deferred } = fixture(ToolMode.CodeMode, true);
    await registry.warmAll();
    const rawTokens = Math.ceil(
      JSON.stringify(deferred.schema).length / CHARS_PER_TOKEN,
    );
    const before = registry.getFunctionDeclarations();
    expect(registry.isPermissionDeferred(ToolNames.EXEC)).toBe(true);
    expect(before.some((item) => item.name === ToolNames.EXEC)).toBe(true);

    expect(registry.preloadDeferredToolsWithinBudget(rawTokens)).toBe(0);
    expect(registry.isDeferredToolRevealed(deferred.name)).toBe(false);
  });

  it('rejects a budget that fits the target declaration but not the actual prompt growth', () => {
    const measuring = fixture(ToolMode.CodeMode);
    const before = measuring.registry.getFunctionDeclarations();
    measuring.registry.revealDeferredTool(measuring.deferred.name);
    const after = measuring.registry.getFunctionDeclarations();
    const targetDeclaration = after.find(
      (item) => item.name === measuring.deferred.name,
    );
    const ownSchemaTokens = Math.ceil(
      JSON.stringify(targetDeclaration).length / CHARS_PER_TOKEN,
    );
    const actualGrowthTokens = Math.ceil(
      (JSON.stringify(after).length - JSON.stringify(before).length) /
        CHARS_PER_TOKEN,
    );
    expect(actualGrowthTokens).toBeGreaterThan(ownSchemaTokens);

    const { registry, deferred } = fixture(ToolMode.CodeMode);
    expect(
      registry.preloadDeferredToolsWithinBudget(ownSchemaTokens),
      `Own schema budget ${ownSchemaTokens}, actual growth ${actualGrowthTokens}`,
    ).toBe(0);
    expect(registry.isDeferredToolRevealed(deferred.name)).toBe(false);

    // The accepting half: a budget that covers the real growth must reveal.
    // Every other CodeMode assertion on this method expects 0, so without it
    // a code-mode-only overcharge of the exec-delta term would retire the
    // startup preload with the suite fully green.
    const accepting = fixture(ToolMode.CodeMode);
    expect(
      accepting.registry.preloadDeferredToolsWithinBudget(actualGrowthTokens),
    ).toBe(1);
    expect(
      accepting.registry.isDeferredToolRevealed(accepting.deferred.name),
    ).toBe(true);
  });
});
