/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_SENTINEL_DYNAMIC,
  AutonomousLoopTickResolver,
} from './autonomous-loop.js';

describe('AutonomousLoopTickResolver', () => {
  it('delivers the full preamble only after a tick is marked delivered', () => {
    const resolver = new AutonomousLoopTickResolver();

    const first = resolver.resolveAutonomous('dynamic');
    expect(first.full).toBe(true);
    expect(first.modelText).toContain('# Autonomous loop check');
    expect(first.modelText).toContain(
      '# Autonomous loop tick (dynamic pacing)',
    );

    const undelivered = resolver.resolveAutonomous('dynamic');
    expect(undelivered.full).toBe(true);
    expect(undelivered.modelText).toContain('# Autonomous loop check');

    resolver.markDelivered();
    const delivered = resolver.resolveAutonomous('dynamic');
    expect(delivered.full).toBe(false);
    expect(delivered.modelText).not.toContain('# Autonomous loop check');
    expect(delivered.modelText).toContain(
      '# Autonomous loop tick (dynamic pacing)',
    );
  });

  it('re-delivers the full preamble after resetCache', () => {
    const resolver = new AutonomousLoopTickResolver();

    resolver.resolveAutonomous('cron');
    resolver.markDelivered();
    expect(resolver.resolveAutonomous('cron').full).toBe(false);

    resolver.resetCache();
    const tick = resolver.resolveAutonomous('cron');

    expect(tick.full).toBe(true);
    expect(tick.modelText).toContain('# Autonomous loop check');
  });

  it('uses the autonomous re-arm text for dynamic ticks', () => {
    const resolver = new AutonomousLoopTickResolver();
    const tick = resolver.resolveAutonomous('dynamic');

    expect(tick.modelText).toContain(AUTONOMOUS_SENTINEL_DYNAMIC);
    expect(tick.modelText).toContain('call LoopWakeup again');
    expect(tick.modelText).toContain('at the end of this turn');
  });
});
