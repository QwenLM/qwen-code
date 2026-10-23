/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { Content } from '@google/genai';
import { markApiHistoryPrompt } from '@qwen-code/qwen-code-core/services/session-api-history.js';
import type { HistoryItem } from '../types.js';
import { rewindSession } from './session-rewind.js';

function setup() {
  const order: string[] = [];
  const api: Content[] = [
    { role: 'user', parts: [{ text: 'same' }] },
    { role: 'model', parts: [{ text: 'answer' }] },
    { role: 'user', parts: [{ text: 'same' }] },
  ];
  markApiHistoryPrompt(api[0], 'p1');
  markApiHistoryPrompt(api[2], 'p2');
  const history: HistoryItem[] = [
    { id: 1, type: 'user', text: 'same', promptId: 'p1', sentToModel: true },
    { id: 2, type: 'user', text: '/help', sentToModel: false },
    { id: 3, type: 'info', text: 'help output' },
    { id: 4, type: 'user', text: 'same', promptId: 'p2', sentToModel: true },
  ];
  const rewind = vi.fn(async () => {
    order.push('files');
    return { filesChanged: ['owned.txt'], filesFailed: [] as string[] };
  });
  const truncateHistory = vi.fn(() => {
    order.push('core');
  });
  const rewindRecording = vi.fn(() => {
    order.push('record');
  });
  const getSnapshots = vi.fn(() => ['before', 'first', 'second']);
  const client = { getHistoryShallow: () => api, truncateHistory };
  const config = {
    getShellExecutionSandbox: () => undefined,
    getLlmClient: vi.fn(() => client),
    getFileHistoryService: () => ({ rewind, getSnapshots }),
    getChatRecordingService: () => ({ rewindRecording }),
  } as unknown as Config;
  const commit = vi.fn(() => {
    order.push('ui');
  });
  return {
    config,
    history,
    order,
    rewind,
    truncateHistory,
    rewindRecording,
    getSnapshots,
    commit,
  };
}

describe('shared rewind transaction', () => {
  it('uses identified duplicate text and real-user count, committing UI before the recording branch', async () => {
    const h = setup();
    const result = await rewindSession(
      h.config,
      h.history,
      h.history[3],
      'both',
      h.commit,
      () => true,
    );
    expect(h.rewind).toHaveBeenCalledExactlyOnceWith('p2', true);
    expect(h.truncateHistory).toHaveBeenCalledExactlyOnceWith(2);
    expect(h.commit).toHaveBeenCalledExactlyOnceWith(
      h.history.slice(0, 3),
      'same',
    );
    expect(h.rewindRecording).toHaveBeenCalledExactlyOnceWith(
      1,
      { truncatedCount: 1 },
      ['before', 'first'],
    );
    expect(h.order).toEqual(['files', 'core', 'ui', 'record']);
    expect(result).toEqual({
      stale: false,
      messages: [{ type: 'info', text: 'Restored 1 file(s).' }],
    });
  });

  it.each(['conversation', 'both'] as const)(
    'refuses an ambiguous identified boundary before files in %s',
    async (option) => {
      const h = setup();
      h.history[0] = { ...h.history[3], id: 1 };
      const result = await rewindSession(
        h.config,
        h.history,
        h.history[3],
        option,
        h.commit,
        () => true,
      );
      expect(result.messages[0]).toMatchObject({
        type: 'error',
        text: expect.stringContaining('no longer matches'),
      });
      expect(h.rewind).not.toHaveBeenCalled();
      expect(h.truncateHistory).not.toHaveBeenCalled();
      expect(h.commit).not.toHaveBeenCalled();
    },
  );

  it('keeps conversation and snapshots on code-only restore', async () => {
    const h = setup();
    await rewindSession(
      h.config,
      h.history,
      h.history[3],
      'code',
      h.commit,
      () => true,
    );
    expect(h.rewind).toHaveBeenCalledExactlyOnceWith('p2', false);
    expect(h.truncateHistory).not.toHaveBeenCalled();
    expect(h.rewindRecording).not.toHaveBeenCalled();
  });

  it.each(['conversation', 'both'] as const)(
    'preserves the no-client %s contract',
    async (option) => {
      const h = setup();
      vi.mocked(h.config.getLlmClient).mockReturnValue(undefined as never);
      const result = await rewindSession(
        h.config,
        h.history,
        h.history[3],
        option,
        h.commit,
        () => true,
      );
      if (option === 'both') {
        expect(h.rewind).toHaveBeenCalledExactlyOnceWith('p2', false);
        expect(result.messages).toHaveLength(2);
        expect(result.messages[1]).toMatchObject({
          text: expect.stringContaining('no active client'),
        });
      } else {
        expect(h.rewind).not.toHaveBeenCalled();
        expect(result.messages[0]).toMatchObject({ type: 'error' });
      }
      expect(h.commit).not.toHaveBeenCalled();
      expect(h.rewindRecording).not.toHaveBeenCalled();
    },
  );

  it('reports a partial file restore without truncating conversation', async () => {
    const h = setup();
    h.rewind.mockResolvedValue({
      filesChanged: ['owned.txt'],
      filesFailed: ['failed.txt'],
    });
    const result = await rewindSession(
      h.config,
      h.history,
      h.history[3],
      'both',
      h.commit,
      () => true,
    );
    expect(result.messages).toEqual([
      { type: 'info', text: 'Restored 1 file(s).' },
      { type: 'error', text: 'Failed to restore 1 file(s): failed.txt' },
    ]);
    expect(h.truncateHistory).not.toHaveBeenCalled();
    expect(h.rewindRecording).not.toHaveBeenCalled();
  });

  it('keeps completed file side effects explicit but discards late conversation/UI messages', async () => {
    const h = setup();
    let release!: () => void;
    const files = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    h.rewind.mockImplementation(async () => {
      await files;
      h.order.push('files-restored');
      return { filesChanged: ['owned.txt'], filesFailed: [] };
    });
    const pending = rewindSession(
      h.config,
      h.history,
      h.history[3],
      'both',
      h.commit,
      () => current,
    );
    current = false;
    release();
    expect(await pending).toEqual({ stale: true, messages: [] });
    expect(h.order).toEqual(['files-restored']);
    expect(h.truncateHistory).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.rewindRecording).not.toHaveBeenCalled();
  });

  it('records actual removed live rows supplied by the snapshot consumer', async () => {
    const h = setup();
    await rewindSession(
      h.config,
      h.history,
      h.history[3],
      'conversation',
      () => 7,
      () => true,
    );
    expect(h.rewindRecording).toHaveBeenCalledExactlyOnceWith(
      1,
      { truncatedCount: 7 },
      ['before', 'first'],
    );
  });
});
