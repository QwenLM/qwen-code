/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readManagedJournalStream,
  encodeManagedJournalSnapshotStream,
} from './managed-journal-stream.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function file(text: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-journal-stream-'));
  roots.push(root);
  const target = path.join(root, 'journal.jsonl');
  await writeFile(target, text);
  return target;
}
const snapshot = (type: string, state: object) =>
  JSON.stringify({
    v: 2,
    type,
    state,
    digest: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
  }) + '\n';

describe('Managed journal streaming codec', () => {
  it('checks the parsed canonical state while dropping consumed array entries', async () => {
    const messages = Array.from({ length: 3_000 }, (_, index) => ({
      index,
      payload: { '2': '中文', '1': '\u0000🙂', text: 'x'.repeat(100) },
    }));
    const text = snapshot('inbox.snapshot', { messages, nextSequence: 9_001 });
    let count = 0;
    let ended = false;
    const summary = await readManagedJournalStream(
      await file(text),
      'inbox',
      async (items) => {
        for (const item of items) {
          if (item.type === 'snapshot-field' && item.field === 'messages') {
            expect(item.value).toEqual(messages[count++]);
          }
          if (item.type === 'snapshot-end') ended = true;
        }
      },
    );
    expect(count).toBe(messages.length);
    expect(ended).toBe(true);
    expect(summary.snapshotBytes).toBe(Buffer.byteLength(text));
  });

  it('preserves epoch object keys and accepts whitespace outside the state encoding', async () => {
    const state = {
      nextEpoch: { '["tenant","session"]': 7 },
      activations: [],
      nextSequence: 11,
    };
    const text = snapshot('activation.snapshot', state).replace(
      '"state":',
      '"state" : ',
    );
    const fields: unknown[] = [];
    await readManagedJournalStream(
      await file(text),
      'activation',
      async (items) => {
        fields.push(...items);
      },
    );
    expect(fields).toContainEqual({
      type: 'snapshot-field',
      field: 'nextEpoch',
      key: '["tenant","session"]',
      value: 7,
    });
    expect(fields.at(-1)).toEqual({ type: 'snapshot-end' });
  });

  it('rejects a damaged snapshot and does not accept a complete JSON snapshot without newline', async () => {
    const valid = snapshot('inbox.snapshot', { nextSequence: 1, messages: [] });
    await expect(
      readManagedJournalStream(
        await file(valid.replace('"nextSequence":1', '"nextSequence":2')),
        'inbox',
        async () => {},
      ),
    ).rejects.toThrow(/digest/);
    await expect(
      readManagedJournalStream(
        await file(valid.trimEnd()),
        'inbox',
        async () => {},
      ),
    ).rejects.toThrow(/no complete record/);
  });

  it('returns only complete v1 lines and reports the physical torn tail', async () => {
    const first = '{"v":1,"type":"event","sequence":1,"at":0}\n';
    const text = first + '{"v":1,"type":"broken';
    const records: unknown[] = [];
    const summary = await readManagedJournalStream(
      await file(text),
      'inbox',
      async (items) => {
        records.push(...items);
      },
    );
    expect(records).toEqual([
      { type: 'record', record: JSON.parse(first), line: 1 },
    ]);
    expect(summary.syncedBytes).toBe(Buffer.byteLength(first));
    expect(summary.totalBytes).toBe(Buffer.byteLength(text));
  });

  it('streams the identical existing v2 encoding and digest', async () => {
    const state = { nextSequence: 1, messages: [] };
    const pieces = async function* () {
      yield Buffer.from('{"nextSequence":1,');
      yield Buffer.from('"messages":[]}');
    };
    const parts: Buffer[] = [];
    for await (const bytes of encodeManagedJournalSnapshotStream(
      'inbox.snapshot',
      pieces(),
    ))
      parts.push(bytes);
    expect(Buffer.concat(parts).toString('utf8')).toBe(
      snapshot('inbox.snapshot', state),
    );
  });
});
