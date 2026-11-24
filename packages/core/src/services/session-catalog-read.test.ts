/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from './sessionService.js';
import {
  sessionTitleSidecarPath,
  writeSessionTitleSidecar,
} from './session-title-sidecar.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('SessionService catalog transcript reads', () => {
  let root: string;
  let transcript: string;
  let service: SessionService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'qwen-session-catalog-read-'));
    service = new SessionService(root, {
      runtimeBaseDir: path.join(root, '.qwen'),
    });
    transcript = service.getSessionTranscriptPath(SESSION_ID);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { force: true, recursive: true });
  });

  function line(type: string, fields: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type,
      uuid: 'message',
      parentUuid: null,
      cwd: root,
      sessionId: SESSION_ID,
      timestamp: '2026-01-01T00:00:00.000Z',
      ...fields,
    });
  }

  function title(value: string, source?: string): string {
    return line('system', {
      subtype: 'custom_title',
      systemPayload: { customTitle: value, titleSource: source },
    });
  }

  function source(value: string): string {
    return line('system', {
      subtype: 'session_source',
      systemPayload: { sourceType: value, sourceId: 'source-id' },
    });
  }

  function prompt(text = '初次提问'): string {
    return line('user', { message: { role: 'user', parts: [{ text }] } });
  }

  async function expectSingleOpen() {
    const baseline = await service.listSessions();
    const open = vi.spyOn(fs.promises, 'open');
    const stream = vi.spyOn(fs, 'createReadStream');
    const openSync = vi.spyOn(fs, 'openSync');
    const actual = await service.listSessions({ forCatalog: true });
    expect(actual).toEqual({ ...baseline, catalogReadFallbacks: 0 });
    expect(
      open.mock.calls.filter(([file]) => file === transcript),
    ).toHaveLength(1);
    expect(
      stream.mock.calls.filter(([file]) => file === transcript),
    ).toHaveLength(0);
    expect(
      openSync.mock.calls.filter(([file]) => file === transcript),
    ).toHaveLength(0);
    return actual.items[0];
  }

  it('reads short CRLF transcripts once and preserves head source and winning title', async () => {
    fs.writeFileSync(
      transcript,
      [
        prompt(),
        source('channel'),
        title('自动', 'auto'),
        source('default'),
        title('手动'),
      ].join('\r\n'),
    );
    expect(await expectSingleOpen()).toMatchObject({
      prompt: '初次提问',
      sourceType: 'channel',
      sourceId: 'source-id',
      customTitle: '手动',
      titleSource: undefined,
    });
  });

  it('checks the tail when a legacy source record has an empty type', async () => {
    fs.writeFileSync(
      transcript,
      [prompt(), source(''), source('channel')].join('\n'),
    );
    expect(await expectSingleOpen()).toMatchObject({
      sourceType: 'channel',
      sourceId: 'source-id',
    });
  });

  it('reads one long transcript handle with head title and boundary-aligned tail source', async () => {
    const tailSource = `${source('channel')}\n`;
    const emptyTail = `${line('assistant', { padding: '' })}\n`;
    const padding = 'x'.repeat(
      64 * 1024 - Buffer.byteLength(tailSource + emptyTail),
    );
    const tail = tailSource + line('assistant', { padding }) + '\n';
    const prefix = [
      prompt(),
      title('旧标题', 'manual'),
      ...Array(8).fill(line('assistant')),
    ];
    const middle = line('assistant', { padding: 'x'.repeat(130 * 1024) });
    fs.writeFileSync(transcript, [...prefix, middle, tail].join('\n'));
    expect(await expectSingleOpen()).toMatchObject({
      customTitle: '旧标题',
      titleSource: 'manual',
      sourceType: 'channel',
    });
    expect(
      (
        await service.listSessions({
          forCatalog: true,
          excludeSourceTypes: ['channel'],
        })
      ).items,
    ).toEqual([]);
  });

  it('retains the title sidecar when the transcript only has later records', async () => {
    fs.writeFileSync(transcript, line('assistant'));
    writeSessionTitleSidecar(
      sessionTitleSidecarPath(path.dirname(transcript), SESSION_ID),
      '此前的标题',
      'manual',
    );
    expect(await expectSingleOpen()).toMatchObject({
      customTitle: '此前的标题',
      titleSource: 'manual',
    });
  });

  it.each([
    [
      'a long first record',
      () =>
        [
          prompt('字'.repeat(30_000)),
          ...Array(10).fill(line('assistant')),
          source('channel'),
          title('long'),
        ].join('\n'),
    ],
    ['malformed joined lines', () => prompt() + title('recovered')],
    [
      'a managed header',
      () =>
        [
          line('system', { subtype: 'managed_session_header_v1' }),
          prompt(),
        ].join('\n'),
    ],
  ])('uses the legacy reader for %s', async (_label, contents) => {
    fs.writeFileSync(transcript, contents());
    const baseline = await service.listSessions();
    expect(baseline.items).toHaveLength(1);
    const realOpen = fs.promises.open.bind(fs.promises);
    const stream = vi.spyOn(fs, 'createReadStream');
    const openSync = vi.spyOn(fs, 'openSync');
    const openedStreams = vi.fn();
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === transcript) {
        const createStream = handle.createReadStream.bind(handle);
        vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
          openedStreams();
          return createStream(options);
        });
      }
      return handle;
    });
    expect(await service.listSessions({ forCatalog: true })).toEqual({
      ...baseline,
      catalogReadFallbacks: 1,
    });
    expect(stream.mock.calls.some(([file]) => file === transcript)).toBe(false);
    expect(
      openSync.mock.calls.some(
        ([file, flags]) => file === transcript && flags === 'r',
      ),
    ).toBe(false);
    expect(openedStreams).toHaveBeenCalledOnce();
  });

  it('skips legacy fallback if its safe open is refused', async () => {
    fs.writeFileSync(transcript, prompt('字'.repeat(30_000)));
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open')
      .mockImplementationOnce(realOpen)
      .mockRejectedValueOnce(
        Object.assign(new Error('Cannot verify file identity'), {
          code: 'EUNVERIFIABLE',
        }),
      );
    expect(await service.listSessions({ forCatalog: true })).toMatchObject({
      items: [],
      catalogReadFallbacks: 1,
    });
  });

  it('uses the legacy reader if the file grows after the initial stat', async () => {
    fs.writeFileSync(transcript, prompt() + '\n');
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      const realStat = handle.stat.bind(handle);
      let appended = false;
      vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
        const stats = await realStat(options);
        if (options === undefined && !appended) {
          fs.appendFileSync(transcript, title('appended', 'manual') + '\n');
          appended = true;
        }
        return stats;
      });
      return handle;
    });
    const actual = await service.listSessions({ forCatalog: true });
    expect(actual.catalogReadFallbacks).toBe(1);
    expect(actual.items[0]).toMatchObject({
      customTitle: 'appended',
      titleSource: 'manual',
    });
  });

  it('closes the file and preserves the cancellation reason', async () => {
    fs.writeFileSync(transcript, prompt() + '\n');
    const controller = new AbortController();
    const reason = new Error('catalog canceled');
    const realOpen = fs.promises.open.bind(fs.promises);
    const close = vi.fn();
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      const realClose = handle.close.bind(handle);
      handle.close = async () => {
        close();
        await realClose();
      };
      controller.abort(reason);
      return handle;
    });
    await expect(
      service.listSessions({ forCatalog: true, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the verified fallback stream when a catalog read is canceled', async () => {
    fs.writeFileSync(transcript, prompt('字'.repeat(30_000)));
    const controller = new AbortController();
    const reason = new Error('catalog canceled during fallback');
    const realOpen = fs.promises.open.bind(fs.promises);
    const handles: FileHandle[] = [];
    let streamDestroyedOnAbort = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      handles.push(handle);
      const createStream = handle.createReadStream.bind(handle);
      vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
        const stream = createStream(options);
        stream.once('data', () => {
          controller.abort(reason);
          streamDestroyedOnAbort = stream.destroyed;
        });
        return stream;
      });
      return handle;
    });

    await expect(
      service.listSessions({ forCatalog: true, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(streamDestroyedOnAbort).toBe(true);
    await vi.waitFor(() =>
      expect(handles.map((handle) => handle.fd)).toEqual([-1, -1]),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'does not reopen a symlink through the legacy path',
    async () => {
      const target = path.join(root, 'outside-chat.jsonl');
      fs.writeFileSync(target, prompt());
      fs.symlinkSync(target, transcript);
      const stream = vi.spyOn(fs, 'createReadStream');
      expect(await service.listSessions({ forCatalog: true })).toMatchObject({
        items: [],
        catalogReadFallbacks: 0,
      });
      expect(stream).not.toHaveBeenCalled();
    },
  );
});
