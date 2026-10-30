/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeToolCheckpoint } from './tool-checkpoint.js';
import type { HistoryItem } from '../types.js';

const roots: string[] = [];
const owned = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qwen-tool-checkpoint-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('complete tool checkpoint publication', () => {
  it('keeps both snapshots when identical tool requests share a timestamp', async () => {
    const directory = await owned();
    const clock = vi
      .spyOn(Date.prototype, 'toISOString')
      .mockReturnValue('2026-10-23T00:00:00.000Z');
    try {
      const write = (text: string) =>
        writeToolCheckpoint({
          directory,
          request: {
            callId: 'same-call',
            name: 'replace',
            args: { file_path: '/owned/a' },
            prompt_id: 'p',
          },
          isCurrent: () => true,
          snapshot: () => ({
            history: [{ id: 1, type: 'user', text }],
            clientHistory: [],
          }),
        });
      const first = await write('first');
      const second = await write('second');
      expect(first).not.toBe(second);
      expect(
        (await readdir(directory)).filter((name) => name.endsWith('.json')),
      ).toHaveLength(2);
      expect(JSON.parse(await readFile(first!, 'utf8')).history[0].text).toBe(
        'first',
      );
      expect(JSON.parse(await readFile(second!, 'utf8')).history[0].text).toBe(
        'second',
      );
    } finally {
      clock.mockRestore();
    }
  });
  it('writes the original canonical history and raw tool arguments in the restore schema', async () => {
    const directory = await owned();
    const history: HistoryItem[] = [
      {
        id: 10,
        type: 'gemini',
        text: 'before',
        timestamp: 123,
        images: [{ mimeType: 'image/png', data: 'YQ==' }],
      },
    ];
    const args = {
      file_path: '/owned/a.ts',
      old_string: 'before',
      new_string: 'after',
    };
    const result = await writeToolCheckpoint({
      directory,
      request: {
        callId: 'original-replace',
        name: 'replace',
        args,
        prompt_id: 'session########0',
      },
      isCurrent: () => true,
      snapshot: () => ({
        history,
        clientHistory: [{ role: 'user', parts: [{ text: 'original' }] }],
        promptIds: ['session########0'],
      }),
    });
    expect(result).toBeDefined();
    expect(JSON.parse(await readFile(result!, 'utf8'))).toEqual({
      history,
      clientHistory: [{ role: 'user', parts: [{ text: 'original' }] }],
      promptIds: ['session########0'],
      toolCall: { callId: 'original-replace', name: 'replace', args },
      promptId: 'session########0',
      filePath: '/owned/a.ts',
    });
  });

  it('publishes nothing when complete source capture fails', async () => {
    const directory = await owned();
    await expect(
      writeToolCheckpoint({
        directory,
        request: {
          callId: 'capture-failed',
          name: 'replace',
          args: { file_path: '/owned/a' },
          prompt_id: 'p',
        },
        isCurrent: () => true,
        snapshot: () => {
          throw new Error('Checkpoint history missing canonical assistant');
        },
      }),
    ).rejects.toThrow('missing canonical assistant');
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([2, 3])(
    'cleans an unpublished temporary file when the owner check %i rejects',
    async (rejectedCheck) => {
      const directory = await owned();
      let checks = 0;
      const result = await writeToolCheckpoint({
        directory,
        request: {
          callId: 'owner-expired',
          name: 'replace',
          args: { file_path: '/owned/a' },
          prompt_id: 'p',
        },
        isCurrent: () => ++checks !== rejectedCheck,
        snapshot: () => ({ history: [], clientHistory: [] }),
      });
      expect(checks).toBe(rejectedCheck);
      expect(result).toBeUndefined();
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it('does not capture when the owner is already invalid', async () => {
    const directory = await owned();
    let captured = false;
    await writeToolCheckpoint({
      directory,
      request: {
        callId: 'owner-invalid',
        name: 'replace',
        args: { file_path: '/owned/a' },
        prompt_id: 'p',
      },
      isCurrent: () => false,
      snapshot: () => {
        captured = true;
        return { history: [], clientHistory: [] };
      },
    });
    expect(captured).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });
});
