/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestRig, validateModelOutput } from '../test-helper.js';

describe('monitor-tool', () => {
  let rig: TestRig;

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  it('should have monitor tool registered', async () => {
    rig = new TestRig();
    await rig.setup('monitor-tool-registered');

    const result = await rig.run(
      'Do you have access to a tool called "monitor"? Reply with just "yes" or "no".',
    );

    validateModelOutput(result, null, 'monitor tool registered');
    expect(result.toLowerCase()).toContain('yes');
  });

  it('should call monitor tool when asked to watch a command', async () => {
    rig = new TestRig();
    await rig.setup('monitor-tool-call', {
      settings: {
        // Cut real-model round trips from the critical path: tools.visible
        // skips the tool_search discovery call, and the background extractor
        // adds a post-turn request before exit; provider TTFT spikes
        // (30-45s observed) otherwise push the run past the timeout (#13001).
        tools: { visible: ['monitor'] },
        memory: { enableManagedAutoMemory: false },
      },
    });

    const resultPromise = rig.run(
      'Use the monitor tool to watch this command: for i in 1 2 3; do echo "EVENT_$i"; sleep 0.3; done. ' +
        'Set description to "test events". After starting the monitor, just say "Monitor launched."',
    );

    const [result, foundMonitor] = await Promise.all([
      resultPromise,
      rig.waitForToolCall('monitor', 180_000),
    ]);
    expect(foundMonitor).toBeTruthy();
    const monitorCalls = rig
      .readToolLogs()
      .filter((log) => log.toolRequest.name === 'monitor');
    expect(
      monitorCalls.some((log) => log.toolRequest.success === true),
      `monitor call did not succeed: ${JSON.stringify(monitorCalls)}`,
    ).toBe(true);
    validateModelOutput(result, null, 'monitor tool call');
  });
});
