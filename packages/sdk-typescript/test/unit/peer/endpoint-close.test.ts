/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { setImmediate } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerEndpoint } from '../../../src/peer/endpoint.js';
import { startPeerInbox } from '../../../src/peer/inbox.js';
import { removeOwnRecord, writeOwnRecord } from '../../../src/peer/registry.js';

vi.mock('../../../src/peer/inbox.js', () => ({ startPeerInbox: vi.fn() }));
vi.mock('../../../src/peer/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/peer/registry.js')>()),
  writeOwnRecord: vi.fn(),
  removeOwnRecord: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('concurrent peer endpoint close', () => {
  beforeEach(() => {
    vi.mocked(writeOwnRecord).mockResolvedValue('/home/sessions/record.json');
    vi.mocked(removeOwnRecord).mockReset();
    vi.mocked(removeOwnRecord).mockResolvedValue(undefined);
  });

  it('waits for both inbox and registry cleanup for every caller', async () => {
    const inbox = deferred();
    const record = deferred();
    const recordStarted = deferred();
    const close = vi.fn(() => inbox.promise);
    vi.mocked(startPeerInbox).mockResolvedValue({
      socketPath: '/inbox.sock',
      close,
      closeSync: vi.fn(),
    });
    vi.mocked(removeOwnRecord).mockImplementation(() => {
      recordStarted.resolve();
      return record.promise;
    });
    const endpoint = await PeerEndpoint.start({
      name: 'bridge',
      closeOnExit: false,
    });
    let firstFinished = false;
    const first = endpoint.close().then(() => {
      firstFinished = true;
    });
    let secondFinished = false;
    const second = endpoint.close().then(() => {
      secondFinished = true;
    });
    try {
      await setImmediate();
      expect(firstFinished).toBe(false);
      expect(secondFinished).toBe(false);
      expect(removeOwnRecord).not.toHaveBeenCalled();
      inbox.resolve();
      await recordStarted.promise;
      await setImmediate();
      expect(firstFinished).toBe(false);
      expect(secondFinished).toBe(false);
      expect(removeOwnRecord).toHaveBeenCalledOnce();
      record.resolve();
      await Promise.all([first, second]);
      expect(firstFinished).toBe(true);
      expect(secondFinished).toBe(true);
      await endpoint.close();
      expect(close).toHaveBeenCalledOnce();
      expect(removeOwnRecord).toHaveBeenCalledOnce();
      expect(removeOwnRecord).toHaveBeenCalledWith(
        '/home/sessions/record.json',
        endpoint.sessionId,
      );
    } finally {
      inbox.resolve();
      record.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it('reports the same cleanup failure to concurrent and later callers', async () => {
    const inbox = deferred();
    const failure = new Error('inbox cleanup failed');
    vi.mocked(startPeerInbox).mockResolvedValue({
      socketPath: '/inbox.sock',
      close: () => inbox.promise,
      closeSync: vi.fn(),
    });
    const endpoint = await PeerEndpoint.start({
      name: 'bridge',
      closeOnExit: false,
    });
    const first = endpoint.close();
    const second = endpoint.close();
    const completed = Promise.allSettled([first, second]);
    inbox.reject(failure);
    expect(await completed).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    await expect(endpoint.close()).rejects.toBe(failure);
  });

  it('reports the same registry failure to concurrent and later callers', async () => {
    const failure = new Error('registry cleanup failed');
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(startPeerInbox).mockResolvedValue({
      socketPath: '/inbox.sock',
      close,
      closeSync: vi.fn(),
    });
    vi.mocked(removeOwnRecord).mockRejectedValue(failure);
    const endpoint = await PeerEndpoint.start({
      name: 'bridge',
      closeOnExit: false,
    });
    const first = endpoint.close();
    const second = endpoint.close();
    await Promise.all([
      expect(first).rejects.toBe(failure),
      expect(second).rejects.toBe(failure),
    ]);
    await expect(endpoint.close()).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(removeOwnRecord).toHaveBeenCalledOnce();
  });
});
