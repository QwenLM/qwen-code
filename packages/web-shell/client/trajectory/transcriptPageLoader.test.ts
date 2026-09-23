/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createTrajectoryPageLoader } from './transcriptPageLoader';
import type { TrajectoryTranscriptClient } from './transcriptPageLoader';

function stubClient() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client: TrajectoryTranscriptClient = {
    getSessionTranscriptPage: vi.fn(async (sessionId, opts) => {
      calls.push([sessionId, opts as Record<string, unknown>]);
      return { events: [], hasMore: false };
    }),
  };
  return { client, calls };
}

describe('createTrajectoryPageLoader', () => {
  it('reads the newest page first', async () => {
    const { client, calls } = stubClient();

    await createTrajectoryPageLoader(client, 's-1')({ limit: 100 });

    expect(calls).toEqual([['s-1', { direction: 'backward', limit: 100 }]]);
  });

  it('walks back by the cursor a previous page handed out', async () => {
    const { client, calls } = stubClient();

    await createTrajectoryPageLoader(
      client,
      's-1',
    )({
      limit: 100,
      cursor: 'older-1',
    });

    expect(calls).toEqual([
      ['s-1', { direction: 'backward', limit: 100, cursor: 'older-1' }],
    ]);
  });

  it('never asks for the summary projection', async () => {
    const { client, calls } = stubClient();

    await createTrajectoryPageLoader(client, 's-1')({ limit: 100 });

    // Summary rewrites the event stream that the timing frames sit in.
    expect(calls[0]![1]).not.toHaveProperty('compactedReplayMode');
  });

  it('returns one loader per session so the window hook does not refetch', () => {
    const { client } = stubClient();

    const first = createTrajectoryPageLoader(client, 's-1');
    expect(createTrajectoryPageLoader(client, 's-1')).toBe(first);
    expect(createTrajectoryPageLoader(client, 's-2')).not.toBe(first);
  });

  it('keeps loaders of different clients apart', () => {
    const a = stubClient().client;
    const b = stubClient().client;

    expect(createTrajectoryPageLoader(a, 's-1')).not.toBe(
      createTrajectoryPageLoader(b, 's-1'),
    );
  });
});
