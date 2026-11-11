/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ManagedAppendChannelLease } from './managed-append-channel-lease.js';
import type { AppendChannel } from './append-channel.js';
import type { WriterCoordinator } from './writer-coordinator.js';

describe('ManagedAppendChannelLease', () => {
  it('forwards operations to the channel and releases', async () => {
    const channel = {
      append: vi.fn().mockResolvedValue(undefined),
      barrier: vi.fn().mockResolvedValue(undefined),
      readTail: vi.fn().mockResolvedValue(Buffer.from('tail')),
      readAll: vi.fn().mockResolvedValue(Buffer.from('all')),
    } as unknown as AppendChannel;

    const coordinator = {
      release: vi.fn(),
    } as unknown as WriterCoordinator;

    const lease = new ManagedAppendChannelLease(coordinator, '/tmp/t.jsonl', channel);

    await lease.append([{ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', parentUuid: null, isSidechain: false, cwd: '/', sessionId: 's1', userType: 'external', version: '1', message: {} }]);
    await lease.barrier();
    const tail = await lease.readTail();
    const all = await lease.readAll();
    await lease.release();

    expect(channel.append).toHaveBeenCalled();
    expect(tail.toString()).toBe('tail');
    expect(all.toString()).toBe('all');
    expect(coordinator.release).toHaveBeenCalledWith('/tmp/t.jsonl', channel, false);
  });

  it('reports failure to the coordinator when barrier fails', async () => {
    const channel = {
      append: vi.fn().mockResolvedValue(undefined),
      barrier: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as AppendChannel;

    const coordinator = {
      release: vi.fn(),
    } as unknown as WriterCoordinator;

    const lease = new ManagedAppendChannelLease(coordinator, '/tmp/t.jsonl', channel);

    await expect(lease.release()).rejects.toThrow('boom');
    expect(coordinator.release).toHaveBeenCalledWith('/tmp/t.jsonl', channel, true);
  });

  it('throws when used after release', async () => {
    const channel = {
      barrier: vi.fn().mockResolvedValue(undefined),
    } as unknown as AppendChannel;
    const coordinator = {
      release: vi.fn(),
    } as unknown as WriterCoordinator;

    const lease = new ManagedAppendChannelLease(coordinator, '/tmp/t.jsonl', channel);
    await lease.release();

    expect(() => lease.append([])).toThrow('released');
  });
});
