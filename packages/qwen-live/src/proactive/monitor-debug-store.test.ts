/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MonitorDebugStore,
  type MonitorDebugInfo,
  type MonitorDebugRecorder,
} from './monitor-debug-store.js';

const rmFailures = vi.hoisted(() => new Map<string, number>());
const rmCalls = vi.hoisted(
  () => [] as Array<{ path: string; options: unknown }>,
);
// One-shot lstat tampering after `after` real calls, simulating a concurrent
// pruner or tamperer acting between the prune scan and the deletion phase.
const lstatTampers = vi.hoisted(
  () => new Map<string, { after: number; effect: 'enoent' | 'symlink' }>(),
);

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (
      path: Parameters<typeof fs.lstat>[0],
      options?: Parameters<typeof fs.lstat>[1],
    ) => {
      const key = String(path);
      const tamper = lstatTampers.get(key);
      if (tamper) {
        if (tamper.after > 0) {
          tamper.after -= 1;
        } else {
          lstatTampers.delete(key);
          if (tamper.effect === 'symlink') {
            const stat = await fs.lstat(path);
            stat.isSymbolicLink = () => true;
            return stat;
          }
          throw Object.assign(new Error('no such file or directory'), {
            code: 'ENOENT',
          });
        }
      }
      return fs.lstat(path, options);
    },
    rm: async (
      path: Parameters<typeof fs.rm>[0],
      options?: Parameters<typeof fs.rm>[1],
    ) => {
      rmCalls.push({ path: String(path), options });
      const remaining = rmFailures.get(String(path));
      if (remaining) {
        rmFailures.set(String(path), remaining - 1);
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return fs.rm(path, options);
    },
  };
});

const INFO: MonitorDebugInfo = {
  taskId: 'monitor-1',
  taskGeneration: 3,
  model: 'test-model',
  modalities: ['vision', 'audio'],
};

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function sendImage(recorder: MonitorDebugRecorder, bytes: Buffer): void {
  recorder.sent({
    type: 'input_image_buffer.append',
    image: bytes.toString('base64'),
    event_id: 'image-event',
  });
}

function sendAudio(recorder: MonitorDebugRecorder, bytes: Buffer): void {
  recorder.sent({
    type: 'input_audio_buffer.append',
    audio: bytes.toString('base64'),
    event_id: 'audio-event',
  });
}

function commit(recorder: MonitorDebugRecorder): void {
  recorder.sent({
    type: 'input_audio_buffer.commit',
    event_id: 'commit-event',
  });
}

describe('MonitorDebugStore', () => {
  let temporary: string;
  let root: string;
  let store: MonitorDebugStore;
  let log: ReturnType<typeof vi.fn>;
  let stores: MonitorDebugStore[];

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'qwen-live-monitor-store-test-'));
    root = join(temporary, 'archives');
    log = vi.fn();
    store = new MonitorDebugStore(log, root);
    stores = [store];
  });

  afterEach(async () => {
    await Promise.all(stores.map((item) => item.flush()));
    vi.restoreAllMocks();
    rmFailures.clear();
    rmCalls.length = 0;
    lstatTampers.clear();
    await rm(temporary, { recursive: true, force: true });
  });

  async function recorder(apiKey?: string): Promise<MonitorDebugRecorder> {
    expect(await store.initialize()).toBe(true);
    const result = store.create(INFO, apiKey);
    expect(result).toBeDefined();
    await result!.start();
    return result!;
  }

  async function ownedDirectory(createdAt: number): Promise<string> {
    const directory = join(root, `monitor-${createdAt}-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, 'monitor.json'),
      JSON.stringify({ format: 'qwen-live-monitor-debug-v1', createdAt }),
      { mode: 0o600 },
    );
    return directory;
  }

  it('does not create files before debug initialization or for audio-only monitors', async () => {
    expect(store.create(INFO)).toBeUndefined();
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.initialize()).toBe(true);
    expect(store.create({ ...INFO, modalities: ['audio'] })).toBeUndefined();
    await store.flush();
    expect(await readdir(root)).toEqual([]);
  });

  it('archives exact sent media, WAV offsets and ordering with private permissions', async () => {
    const key = 'sk-connection-secret';
    const archive = await recorder(key);
    const image = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const nextImage = Buffer.from([0xff, 0xd8, 3, 4, 0xff, 0xd9]);
    const audio = Buffer.from([0, 0, 0xff, 0x7f, 0, 0x80]);
    const silence = Buffer.alloc(8);
    archive.beginTransport(4);
    archive.sent({
      type: 'session.update',
      headers: { Authorization: `Bearer ${key}` },
      session: {
        instructions: `Remember the private-user-note; key=${key}`,
        apiKey: key,
      },
    });
    archive.sent({
      type: 'conversation.item.create',
      item: { role: 'user', text: 'Keep actual model context.' },
    });
    sendAudio(archive, audio);
    sendImage(archive, image);
    sendAudio(archive, silence);
    sendImage(archive, nextImage);
    commit(archive);
    archive.sent({ type: 'response.create', event_id: 'response-event' });
    archive.result({
      status: 'completed',
      text: `Reply ${key}`,
      result: 'reply',
    });
    await store.flush();

    const directory = join(archive.directory, 'requests', '000001');
    const request = await readJson(join(directory, 'request.json'));
    expect(request).toMatchObject({
      recordingStatus: 'saved',
      monitor: INFO,
      request: 1,
      transportGeneration: 4,
      audioFormat: {
        encoding: 'pcm16le',
        sampleRate: 16_000,
        channels: 1,
        byteOffsetsExcludeWavHeader: true,
      },
      session: [
        {
          type: 'session.update',
          session: {
            instructions: 'Remember the private-user-note; key=[redacted]',
          },
        },
        {
          type: 'conversation.item.create',
          item: { role: 'user', text: 'Keep actual model context.' },
        },
      ],
      events: [
        {
          type: 'input_audio_buffer.append',
          audio: 'input.wav',
          byteOffset: 0,
          bytes: audio.length,
          eventId: 'audio-event',
        },
        {
          type: 'input_image_buffer.append',
          image: 'image-0001.jpg',
          bytes: image.length,
          eventId: 'image-event',
          sha256: createHash('sha256').update(image).digest('hex'),
        },
        {
          type: 'input_audio_buffer.append',
          audio: 'input.wav',
          byteOffset: audio.length,
          bytes: silence.length,
          eventId: 'audio-event',
        },
        {
          type: 'input_image_buffer.append',
          image: 'image-0002.jpg',
          bytes: nextImage.length,
          eventId: 'image-event',
          sha256: createHash('sha256').update(nextImage).digest('hex'),
        },
        { type: 'input_audio_buffer.commit', event_id: 'commit-event' },
        { type: 'response.create', event_id: 'response-event' },
      ],
    });
    expect(JSON.stringify(request)).not.toContain(key);
    expect(JSON.stringify(request)).not.toContain('Authorization');
    expect(JSON.stringify(request)).not.toContain('apiKey');
    expect(await readFile(join(directory, 'image-0001.jpg'))).toEqual(image);
    expect(await readFile(join(directory, 'image-0002.jpg'))).toEqual(
      nextImage,
    );
    const wav = await readFile(join(directory, 'input.wav'));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(audio.length + silence.length);
    expect(wav.subarray(44)).toEqual(Buffer.concat([audio, silence]));
    expect(await readJson(join(directory, 'response.json'))).toEqual({
      status: 'completed',
      text: 'Reply [redacted]',
      result: 'reply',
    });
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_request_saved',
      expect.objectContaining({
        directory: archive.directory,
        requestDirectory: directory,
        imageFrames: 2,
        audioBytes: audio.length + silence.length,
      }),
    );
  });

  // Windows has no POSIX permission bits, so skip (reportedly) rather than
  // passing a test that asserted nothing.
  it.skipIf(process.platform === 'win32')(
    'archives monitor recordings with private permissions',
    async () => {
      const archive = await recorder();
      sendImage(archive, Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]));
      sendImage(archive, Buffer.from([0xff, 0xd8, 3, 4, 0xff, 0xd9]));
      sendAudio(archive, Buffer.from([0, 0, 0xff, 0x7f, 0, 0x80]));
      commit(archive);
      archive.result({ status: 'completed', text: 'reply' });
      await store.flush();

      const directory = join(archive.directory, 'requests', '000001');
      for (const path of [
        root,
        archive.directory,
        join(archive.directory, 'requests'),
        directory,
      ]) {
        expect((await lstat(path)).mode & 0o777).toBe(0o700);
      }
      for (const path of [
        join(archive.directory, 'monitor.json'),
        ...[
          'request.json',
          'response.json',
          'image-0001.jpg',
          'image-0002.jpg',
          'input.wav',
        ].map((file) => join(directory, file)),
      ]) {
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it('separates requests and transports without copying old media or cleared inputs', async () => {
    const archive = await recorder();
    archive.beginTransport(1);
    sendImage(archive, Buffer.from('discarded image'));
    sendAudio(archive, Buffer.from('discarded audio'));
    archive.sent({ type: 'input_audio_buffer.clear' });
    sendImage(archive, Buffer.from('first image'));
    commit(archive);
    archive.result({ text: 'wait', status: 'completed' });
    sendImage(archive, Buffer.from('second image'));
    commit(archive);
    sendImage(archive, Buffer.from('uncommitted old transport image'));
    archive.beginTransport(2);
    commit(archive);
    archive.close();
    await store.flush();

    const requests = join(archive.directory, 'requests');
    expect(await readdir(requests)).toEqual(['000001', '000002', '000003']);
    expect(
      await readFile(join(requests, '000001', 'image-0001.jpg'), 'utf8'),
    ).toBe('first image');
    expect(
      await readFile(join(requests, '000002', 'image-0001.jpg'), 'utf8'),
    ).toBe('second image');
    expect(
      await readJson(join(requests, '000002', 'request.json')),
    ).toMatchObject({ previousRequest: '000001', transportGeneration: 1 });
    expect(
      await readJson(join(requests, '000002', 'response.json')),
    ).toMatchObject({ status: 'recycled', incomplete: true });
    const recycled = await readJson(join(requests, '000003', 'request.json'));
    expect(recycled).toMatchObject({
      request: 3,
      transportGeneration: 2,
      session: [],
      events: [{ type: 'input_audio_buffer.commit' }],
    });
    expect(recycled).not.toHaveProperty('previousRequest');
    expect(await readdir(join(requests, '000003'))).toEqual([
      'input.wav',
      'request.json',
      'response.json',
    ]);
    expect(
      await readJson(join(requests, '000003', 'response.json')),
    ).toMatchObject({ status: 'closed', incomplete: true });
  });

  it('explicitly truncates large response text and ignores media after closing', async () => {
    const archive = await recorder();
    commit(archive);
    archive.result({ text: 'x'.repeat(131_073), status: 'completed' });
    archive.close();
    sendImage(archive, Buffer.from('closed'));
    commit(archive);
    await store.flush();
    const requests = join(archive.directory, 'requests');
    expect(await readdir(requests)).toEqual(['000001']);
    expect(await readJson(join(requests, '000001', 'response.json'))).toEqual({
      text: 'x'.repeat(131_072),
      textTruncated: true,
      status: 'completed',
    });
  });

  it('retains the latest ten created monitors and does not recreate an evicted active archive', async () => {
    const first = await recorder();
    sendImage(first, Buffer.from('pending old image'));
    commit(first);
    const latest: MonitorDebugRecorder[] = [];
    for (let index = 0; index < 10; index += 1) {
      latest.push(store.create({ ...INFO, taskId: `monitor-${index + 2}` })!);
    }
    await store.flush();
    expect((await readdir(root)).sort()).toEqual(
      latest.map((item) => basename(item.directory)).sort(),
    );
    sendImage(first, Buffer.from('later old image'));
    commit(first);
    first.result({ text: 'late response' });
    await store.flush();
    await expect(lstat(first.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_request_skipped',
      expect.objectContaining({
        directory: first.directory,
        reason: 'evicted',
        retained: false,
      }),
    );
    sendImage(latest[9]!, Buffer.from('new retained image'));
    commit(latest[9]!);
    await store.flush();
    expect(
      await readFile(
        join(latest[9]!.directory, 'requests', '000001', 'image-0001.jpg'),
        'utf8',
      ),
    ).toBe('new retained image');
  });

  it('prunes owned monitors by creation time at startup, preserving unrelated and symlink data', async () => {
    await mkdir(root, { mode: 0o700 });
    const owned: string[] = [];
    for (let time = 1; time <= 11; time += 1)
      owned.push(await ownedDirectory(time));
    await utimes(owned[0]!, new Date(), new Date());
    const unrelated = join(root, 'personal-notes');
    await mkdir(unrelated, { mode: 0o700 });
    await writeFile(join(unrelated, 'keep.txt'), 'keep');
    const unmarked = join(root, `monitor-0-${randomUUID()}`);
    await mkdir(unmarked, { mode: 0o700 });
    const wrongMarker = join(root, `monitor-0-${randomUUID()}`);
    await mkdir(wrongMarker, { mode: 0o700 });
    await writeFile(
      join(wrongMarker, 'monitor.json'),
      JSON.stringify({ format: 'different-owner', createdAt: 0 }),
    );
    const outside = join(temporary, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, 'keep.txt'), 'outside');
    await symlink(outside, join(root, `monitor-0-${randomUUID()}`));
    const markerLink = join(root, `monitor-0-${randomUUID()}`);
    await mkdir(markerLink, { mode: 0o700 });
    await symlink(
      join(owned[0]!, 'monitor.json'),
      join(markerLink, 'monitor.json'),
    );
    expect(await store.initialize()).toBe(true);
    await expect(lstat(owned[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const directory of [
      ...owned.slice(1),
      unrelated,
      unmarked,
      wrongMarker,
      markerLink,
    ])
      expect((await lstat(directory)).isDirectory()).toBe(true);
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside');
    expect(await readFile(join(unrelated, 'keep.txt'), 'utf8')).toBe('keep');
    expect(log).toHaveBeenCalledWith('proactive.monitor_debug_pruned', {
      directory: owned[0],
    });
  });

  it('keeps pruning and recording when one stale archive cannot be deleted', async () => {
    await mkdir(root, { mode: 0o700 });
    const owned: string[] = [];
    for (let time = 1; time <= 12; time += 1)
      owned.push(await ownedDirectory(time));
    // The prune visits stale archives newest-first, so blocking owned[1]
    // leaves the older owned[0] to prove the loop continued. Block the media
    // subtree, as a held-open media file does: the removal must fail before
    // the marker is touched, so the next prune still recognizes the archive.
    rmFailures.set(join(owned[1]!, 'requests'), 1);
    expect(await store.initialize()).toBe(true);
    await expect(lstat(owned[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(owned[1]!)).isDirectory()).toBe(true);
    expect((await lstat(join(owned[1]!, 'monitor.json'))).isFile()).toBe(true);
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_debug_prune_failed',
      expect.objectContaining({
        directory: owned[1],
        retained: true,
        reason: 'EBUSY',
      }),
    );
    // A retained archive must never be logged as destroyed.
    expect(log).not.toHaveBeenCalledWith(
      'proactive.monitor_debug_pruned',
      expect.objectContaining({ directory: owned[1] }),
    );
    // maxRetries rides out a transient handle (AV scanner/indexer) on Windows.
    expect(
      rmCalls.find((call) => call.path === join(owned[1]!, 'requests'))
        ?.options,
    ).toEqual(
      expect.objectContaining({ recursive: true, force: true, maxRetries: 3 }),
    );
    // Once the handle clears, the next prune retries and removes the archive.
    expect(await store.initialize()).toBe(true);
    await expect(lstat(owned[1]!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(log).toHaveBeenCalledWith('proactive.monitor_debug_pruned', {
      directory: owned[1],
    });
    const recorder = store.create(INFO);
    expect(recorder).toBeDefined();
    await recorder!.start();
    expect(log).not.toHaveBeenCalledWith(
      'proactive.monitor_debug_failed',
      expect.objectContaining({ reason: 'initialization_failed' }),
    );
  });

  it('reports nothing when a concurrent pruner removes a stale archive first', async () => {
    await mkdir(root, { mode: 0o700 });
    const owned: string[] = [];
    for (let time = 1; time <= 12; time += 1)
      owned.push(await ownedDirectory(time));
    // The scan recognizes owned[1]; a second store on the same root then
    // removes it before this prune's deletion phase. Nothing was retained,
    // so neither a failure nor a pruned event may be logged for it.
    lstatTampers.set(owned[1]!, { after: 1, effect: 'enoent' });
    expect(await store.initialize()).toBe(true);
    await expect(lstat(owned[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(owned[1]!)).isDirectory()).toBe(true);
    expect(log).not.toHaveBeenCalledWith(
      'proactive.monitor_debug_prune_failed',
      expect.objectContaining({ directory: owned[1] }),
    );
    expect(log).not.toHaveBeenCalledWith(
      'proactive.monitor_debug_pruned',
      expect.objectContaining({ directory: owned[1] }),
    );
  });

  it('reports the reason when a stale archive turns unsafe mid-prune', async () => {
    await mkdir(root, { mode: 0o700 });
    const owned: string[] = [];
    for (let time = 1; time <= 11; time += 1)
      owned.push(await ownedDirectory(time));
    // The scan accepts owned[0], then the archive is swapped for a symlink
    // before the deletion phase rechecks it. The refusal is a privacy guard,
    // not a transient OS delete failure, and must be reported by name.
    lstatTampers.set(owned[0]!, { after: 1, effect: 'symlink' });
    expect(await store.initialize()).toBe(true);
    expect((await lstat(owned[0]!)).isDirectory()).toBe(true);
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_debug_prune_failed',
      expect.objectContaining({
        directory: owned[0],
        retained: true,
        reason: 'unsafe_directory',
      }),
    );
  });

  it('rejects shared or symlink archive roots without touching their contents', async () => {
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'keep.txt'), 'keep');
    // Windows has no POSIX permission bits; a shared-looking mode cannot be
    // expressed or rejected there.
    if (process.platform !== 'win32') {
      await chmod(root, 0o755);
      expect(await store.initialize()).toBe(false);
      expect(store.create(INFO)).toBeUndefined();
    }
    const linked = new MonitorDebugStore(
      log,
      join(temporary, 'linked-archives'),
    );
    stores.push(linked);
    await symlink(root, linked.root);
    expect(await linked.initialize()).toBe(false);
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('accepts directories on Windows, where POSIX permission bits do not exist', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    // Both READMEs' Windows isolation caveat assumes the default root stays
    // inside the OS temporary directory.
    expect(new MonitorDebugStore(log).root).toBe(
      join(tmpdir(), 'qwen-live-monitor-debug'),
    );
    await mkdir(root, { mode: 0o700 });
    // Stand-in for Windows reporting every directory with group/other bits.
    await chmod(root, 0o755);
    expect(await store.initialize()).toBe(true);

    // Symlink rejection is not platform-gated and must still apply.
    const linked = new MonitorDebugStore(log, join(temporary, 'linked-win32'));
    stores.push(linked);
    await symlink(root, linked.root);
    expect(await linked.initialize()).toBe(false);
  });

  it('does not recreate an active directory pruned by another store', async () => {
    const archive = await recorder();
    const otherStore = new MonitorDebugStore(log, root);
    stores.push(otherStore);
    expect(await otherStore.initialize()).toBe(true);
    for (let index = 0; index < 10; index += 1)
      otherStore.create({ ...INFO, taskId: `other-${index}` });
    await otherStore.flush();
    await expect(lstat(archive.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    sendImage(archive, Buffer.from('old active monitor'));
    commit(archive);
    await expect(store.flush()).resolves.toBeUndefined();
    await expect(lstat(archive.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await readdir(root)).length).toBe(10);
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_debug_failed',
      expect.objectContaining({
        directory: archive.directory,
        incomplete: true,
      }),
    );
  });

  it('makes write failures nonfatal and logs explicitly incomplete recording', async () => {
    const archive = await recorder();
    const blocked = join(archive.directory, 'requests', '000001');
    await writeFile(blocked, 'existing-file');
    expect(() => {
      sendImage(archive, Buffer.from('image'));
      commit(archive);
    }).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_debug_failed',
      expect.objectContaining({
        directory: archive.directory,
        reason: 'write_failed',
        incomplete: true,
      }),
    );
    expect(await readFile(blocked, 'utf8')).toBe('existing-file');
    commit(archive);
    await store.flush();
    expect(await readdir(join(archive.directory, 'requests'))).toEqual([
      '000001',
    ]);
  });

  it('preserves a completed response and makes serialization failures nonfatal', async () => {
    const archive = await recorder();
    commit(archive);
    archive.result({ status: 'completed', text: 'first response' });
    archive.result({
      status: 'error',
      text: 'unrelated later transport error',
    });
    await store.flush();
    expect(
      await readJson(
        join(archive.directory, 'requests', '000001', 'response.json'),
      ),
    ).toEqual({ status: 'completed', text: 'first response' });
    commit(archive);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => archive.result(circular)).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      'proactive.monitor_debug_failed',
      expect.objectContaining({
        directory: archive.directory,
        incomplete: true,
      }),
    );
  });

  it.each(['pending', 'queued'])(
    'bounds %s media without throwing into the model',
    async (boundary) => {
      const archive = await recorder();
      const image = Buffer.alloc(2 * 1024 * 1024).toString('base64');
      for (let index = 0; index < 16; index += 1)
        archive.sent({ type: 'input_image_buffer.append', image });
      if (boundary === 'queued') commit(archive);
      expect(() =>
        archive.sent({ type: 'input_image_buffer.append', image }),
      ).not.toThrow();
      commit(archive);
      await expect(store.flush()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        'proactive.monitor_debug_failed',
        expect.objectContaining({
          directory: archive.directory,
          reason: 'pending_byte_limit',
          incomplete: true,
        }),
      );
      expect(await readdir(join(archive.directory, 'requests'))).toEqual([]);
    },
  );

  it('does not let a failing log sink break initialization, recording or cleanup', async () => {
    log.mockImplementation(() => {
      throw new Error('log sink unavailable');
    });
    const archive = await recorder();
    commit(archive);
    archive.close();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(
      await readJson(
        join(archive.directory, 'requests', '000001', 'request.json'),
      ),
    ).toMatchObject({ recordingStatus: 'saved' });
  });
});
