/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
    const first = endpoint.close();
    let secondFinished = false;
    const second = endpoint.close().then(() => {
      secondFinished = true;
    });
    try {
      await Promise.resolve();
      expect(secondFinished).toBe(false);
      inbox.resolve();
      await recordStarted.promise;
      expect(secondFinished).toBe(false);
      expect(removeOwnRecord).toHaveBeenCalledOnce();
      record.resolve();
      await Promise.all([first, second]);
      expect(close).toHaveBeenCalledOnce();
      await endpoint.close();
      expect(removeOwnRecord).toHaveBeenCalledOnce();
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
});
