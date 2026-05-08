/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for ToolSearch / deferred-tool flow.
 *
 * Validates the core contract: tools flagged `shouldDefer=true` are NOT in
 * the initial function-declaration list, but the model can reach them via
 * `tool_search` (either by `select:Name` lookup or keyword query) and then
 * invoke them in the same session.
 *
 * Cron tools (cron_create, cron_list, cron_delete) are convenient deferred
 * targets: deterministic, side-effect-free in -p mode, and gated behind the
 * `experimental.cron` setting so we control when they're registered.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  TestRig,
  printDebugInfo,
  validateModelOutput,
} from '../test-helper.js';

describe('tool-search / deferred tools', () => {
  let rig: TestRig;

  afterEach(async () => {
    if (rig) await rig.cleanup();
  });

  it('reveals a deferred tool via select: and lets the model invoke it', async () => {
    rig = new TestRig();
    await rig.setup('tool-search-select-then-invoke', {
      settings: { experimental: { cron: true } },
    });

    // Force the model down the select: path so the assertion isn't dependent
    // on whether the model spontaneously chose keyword search vs. select.
    const result = await rig.run(
      'Step 1: call the tool_search tool with query "select:cron_list". ' +
        'Step 2: call cron_list with no arguments. ' +
        'Step 3: reply with just the word "done".',
    );

    const foundSearch = await rig.waitForToolCall('tool_search');
    const foundList = await rig.waitForToolCall('cron_list');

    if (!foundSearch || !foundList) {
      printDebugInfo(rig, result, {
        'tool_search found': foundSearch,
        'cron_list found': foundList,
      });
    }

    expect(foundSearch, 'expected tool_search to be called').toBeTruthy();
    expect(
      foundList,
      'cron_list must succeed after tool_search reveals it',
    ).toBeTruthy();

    // Order matters: tool_search must come before cron_list. If cron_list
    // were called first, the API would have rejected it (schema not loaded).
    const calls = rig.readToolLogs().map((l) => l.toolRequest.name);
    const searchIdx = calls.indexOf('tool_search');
    const listIdx = calls.indexOf('cron_list');
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThan(searchIdx);

    validateModelOutput(result, null, 'select-then-invoke');
  });

  it('finds deferred tools via keyword search', async () => {
    rig = new TestRig();
    await rig.setup('tool-search-keyword', {
      settings: { experimental: { cron: true } },
    });

    // The tool_search response is a synthetic <functions>...</functions>
    // block; we check the ARGS the model sent (a keyword query, not select:)
    // and trust the schema-loading behavior covered above.
    const result = await rig.run(
      'Use the tool_search tool with the keyword query "cron schedule" ' +
        '(no select: prefix). Then reply with just the word "ok".',
    );

    const foundSearch = await rig.waitForToolCall('tool_search');
    expect(foundSearch, 'expected tool_search to be called').toBeTruthy();

    const searchCalls = rig
      .readToolLogs()
      .filter((l) => l.toolRequest.name === 'tool_search');
    expect(searchCalls.length).toBeGreaterThan(0);

    // At least one tool_search call must have used a keyword query.
    const usedKeyword = searchCalls.some((c) => {
      try {
        const args = JSON.parse(c.toolRequest.args || '{}');
        const q = String(args.query ?? '');
        return q.length > 0 && !q.toLowerCase().startsWith('select:');
      } catch {
        return false;
      }
    });
    expect(
      usedKeyword,
      `expected at least one keyword tool_search; saw args: ${searchCalls
        .map((c) => c.toolRequest.args)
        .join(' | ')}`,
    ).toBeTruthy();

    validateModelOutput(result, null, 'keyword search');
  });

  it('does not register deferred tools when their feature flag is off', async () => {
    rig = new TestRig();
    // No experimental.cron setting → cron_* tools must not be registered at
    // all (deferred or otherwise). tool_search has nothing to surface.
    await rig.setup('tool-search-no-cron');

    const result = await rig.run(
      'Call tool_search with query "select:cron_list". ' +
        'Then reply with the literal text "missing" if cron_list was not in the result, ' +
        'or "found" if it was.',
    );

    const foundSearch = await rig.waitForToolCall('tool_search');
    expect(foundSearch, 'tool_search should still be available').toBeTruthy();

    // cron_list must NOT have been invoked — it was never registered.
    const calls = rig.readToolLogs().map((l) => l.toolRequest.name);
    expect(calls).not.toContain('cron_list');
    expect(calls).not.toContain('cron_create');

    validateModelOutput(result, null, 'no-cron');
  });
});
