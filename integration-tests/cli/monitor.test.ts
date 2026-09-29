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
    await rig.setup('monitor-tool-call');

    const resultPromise = rig.run(
      'Use the monitor tool to watch this command: for i in 1 2 3; do echo "EVENT_$i"; sleep 0.3; done. ' +
        'Set description to "test events". After starting the monitor, just say "Monitor launched."',
    );

    // The monitor call typically sits behind a ToolSearch roundtrip, so the
    // model needs two chained turns before the tool call lands in telemetry.
    // On a loaded Docker leg that exceeds the 60s CI default (#12962).
    const [result, foundMonitor] = await Promise.all([
      resultPromise,
      rig.waitForToolCall('monitor', 180_000),
    ]);
    expect(foundMonitor).toBeTruthy();
    validateModelOutput(result, null, 'monitor tool call');
  });
});
