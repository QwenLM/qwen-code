/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createHerdrReporter, HerdrReporter } from './herdr-reporter.js';

describe('HerdrReporter', () => {
  it('is disabled outside a Herdr pane', () => {
    expect(createHerdrReporter({})).toBeNull();
    expect(
      createHerdrReporter({
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'w1:p1',
        HERDR_BIN_PATH: '/bin/herdr',
      }),
    ).toBeNull();
  });

  it('serializes session, latest state, session changes, and release', async () => {
    const calls: string[][] = [];
    let resumeFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resumeFirst = resolve;
    });
    const run = vi.fn(async (args: readonly string[]) => {
      calls.push([...args]);
      if (calls.length === 1) await first;
    });
    const reporter = new HerdrReporter('w1:p1', run);

    reporter.report('session-1', 'idle');
    reporter.report('session-1', 'working');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toContain('report-agent-session');
    expect(calls[0]).not.toContain('--seq');

    resumeFirst?.();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toContain('working');
    reporter.report('session-1', 'working');
    await Promise.resolve();
    expect(calls).toHaveLength(2);

    reporter.report('session-2', 'working');
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toContain('session-2');
    expect(calls[2]).toContain('clear');

    await reporter.release();
    expect(calls).toHaveLength(4);
    expect(calls[3]).toContain('release-agent');
    reporter.report('session-2', 'blocked');
    await Promise.resolve();
    expect(calls).toHaveLength(4);

    const stateSeq = BigInt(calls[1]![calls[1]!.indexOf('--seq') + 1]!);
    const releaseSeq = BigInt(calls[3]![calls[3]!.indexOf('--seq') + 1]!);
    expect(releaseSeq).toBeGreaterThan(stateSeq);
  });

  it('swallows transport failures', async () => {
    const reporter = new HerdrReporter('w1:p1', async () => {
      throw new Error('offline');
    });

    reporter.report('session-1', 'working');
    await expect(reporter.release()).resolves.toBeUndefined();
  });
});
