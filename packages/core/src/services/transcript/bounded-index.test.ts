/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptRepository } from './repository.js';
import { EntryScanner } from './scanner.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function file() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-index-'));
  directories.push(dir);
  return path.join(dir, 'session.jsonl');
}
const message = (
  uuid: string,
  parentUuid: string | null = null,
  content = uuid,
) => ({
  type: 'user',
  uuid,
  parentUuid,
  sessionId: 'session',
  isSidechain: false,
  cwd: '/tmp',
  version: '1',
  userType: 'external',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: 'user', content },
});
async function write(filePath: string, entries: unknown[]) {
  await fs.writeFile(
    filePath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
}

describe('bounded complete transcript index', () => {
  it('preserves inactive branches and every physical entry while projecting the selected history', async () => {
    const filePath = await file();
    await write(filePath, [
      message('root'),
      message('branch', 'root', 'old'),
      message('branch', 'root', 'new'),
      message('selected', 'root'),
      {
        type: 'active-leaf',
        sessionId: 'session',
        leafUuid: 'selected',
        explicit: true,
        timestamp: Date.now(),
      },
    ]);
    const repository = new TranscriptRepository();
    const result = await repository.resolveBoundedSession(filePath, {
      sessionId: 'session',
      view: 'historical',
    });
    expect(result?.chain.map((entry) => entry.uuid)).toEqual([
      'root',
      'selected',
    ]);
    expect([...result!.index.messagesByUuid.keys()]).toEqual([
      'root',
      'branch',
      'selected',
    ]);
    expect(result?.index.entriesInFileOrder).toHaveLength(5);
    expect(await repository.loadBoundedIndex(filePath)).toEqual(result?.index);
  });

  it('loads full history above 64 MiB without a compact boundary and releases admission', async () => {
    const filePath = await file();
    const text = 'x'.repeat(1024 ** 2);
    for (let i = 0; i < 65; i++) {
      await fs.appendFile(
        filePath,
        JSON.stringify(message(`m${i}`, i ? `m${i - 1}` : null, text)) + '\n',
      );
    }
    const scanner = new EntryScanner();
    const consume = vi.spyOn(scanner, 'consume');
    const repository = new TranscriptRepository({ scanner });
    const result = await repository.resolveBoundedSession(filePath, {
      sessionId: 'session',
      view: 'historical',
    });
    expect(result?.chain).toHaveLength(65);
    expect(result?.chain.at(-1)?.uuid).toBe('m64');
    expect(consume).toHaveBeenCalled();
    await write(filePath, [message('ok')]);
    expect(
      (await repository.loadBoundedIndex(filePath))?.messagesByUuid.has('ok'),
    ).toBe(true);
  });

  it('loads legal historical records above the former line and nested value limits', async () => {
    const filePath = await file();
    const repository = new TranscriptRepository();
    await write(filePath, [
      message('large', null, 'x'.repeat(8 * 1024 ** 2)),
    ]);
    expect(
      (await repository.loadBoundedIndex(filePath))?.messagesByUuid.has('large'),
    ).toBe(true);
    await write(filePath, [
      {
        ...message('nested'),
        extra: Array(50_001).fill(0),
      },
    ]);
    expect(
      (await repository.loadBoundedIndex(filePath))?.messagesByUuid.has('nested'),
    ).toBe(true);
  });

  it('cancels during scanning, closes the read and admits the next reader', async () => {
    const filePath = await file();
    await write(filePath, [message('root'), message('child', 'root')]);
    const scanner = new EntryScanner({ chunkBytes: 64 });
    const controller = new AbortController();
    const consume = scanner.consume.bind(scanner);
    vi.spyOn(scanner, 'consume').mockImplementation(
      (filePath, visitor, options) =>
        consume(
          filePath,
          async (line, nested) => {
            await visitor(line, nested);
            controller.abort();
          },
          options,
        ),
    );
    await expect(
      new TranscriptRepository({ scanner }).loadBoundedIndex(filePath, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: 'cancelled' });
    expect(
      (await new TranscriptRepository().loadBoundedIndex(filePath))
        ?.messagesByUuid.size,
    ).toBe(2);
  });

  it('retries a changing snapshot once using a fresh descriptor', async () => {
    const filePath = await file();
    await write(filePath, [message('root')]);
    const scanner = new EntryScanner();
    const consume = scanner.consume.bind(scanner);
    const spy = vi
      .spyOn(scanner, 'consume')
      .mockImplementation(async (filePath, visitor, options) => {
        const result = await consume(filePath, visitor, options);
        await fs.appendFile(
          filePath,
          `${JSON.stringify(message(`append-${spy.mock.calls.length}`, 'root'))}\n`,
        );
        return result;
      });
    await expect(
      new TranscriptRepository({ scanner }).loadBoundedIndex(filePath),
    ).rejects.toMatchObject({ reason: 'snapshot' });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
