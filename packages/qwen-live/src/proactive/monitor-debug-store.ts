/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID, createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';

export const MONITOR_DEBUG_ROOT = join(tmpdir(), 'qwen-live-monitor-debug');
const FORMAT = 'qwen-live-monitor-debug-v1';
const DIRECTORY = /^monitor-\d+-[a-f0-9-]{36}$/u;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
type Log = (event: string, details: Record<string, unknown>) => void;
type Media = {
  type: 'input_image_buffer.append' | 'input_audio_buffer.append';
  bytes: Buffer;
  eventId?: string;
  sentAt: number;
};

export interface MonitorDebugInfo {
  taskId: string;
  taskGeneration: number;
  model: string;
  modalities: readonly string[];
}

async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    // Windows reports every directory with group/other bits set, so POSIX
    // mode bits cannot reject a shared directory there.
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('unsafe_directory');
}

async function json(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function wav(chunks: Buffer[]): Buffer {
  const bytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, ...chunks]);
}

export class MonitorDebugStore {
  readonly root: string;
  private ready = false;
  private lastCreatedAt = 0;
  private tail = Promise.resolve();
  private readonly recorders = new Set<MonitorDebugRecorder>();

  constructor(
    private readonly log: Log,
    root = MONITOR_DEBUG_ROOT,
  ) {
    this.root = resolve(root);
  }

  async initialize(): Promise<boolean> {
    try {
      await mkdir(this.root, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      await privateDirectory(this.root);
      this.ready = true;
      await this.prune();
      this.emit('proactive.monitor_debug_ready', {
        directory: this.root,
        retainedMonitors: 10,
      });
      return true;
    } catch {
      this.ready = false;
      this.emit('proactive.monitor_debug_failed', {
        directory: this.root,
        reason: 'initialization_failed',
      });
      return false;
    }
  }

  create(
    info: MonitorDebugInfo,
    apiKey?: string,
  ): MonitorDebugRecorder | undefined {
    if (!this.ready || !info.modalities.includes('vision')) return undefined;
    const createdAt = Math.max(Date.now(), this.lastCreatedAt + 1);
    this.lastCreatedAt = createdAt;
    const directory = join(this.root, `monitor-${createdAt}-${randomUUID()}`);
    const recorder = new MonitorDebugRecorder(
      directory,
      info,
      apiKey,
      (event, details) => this.emit(event, details),
      () => this.recorders.delete(recorder),
    );
    this.recorders.add(recorder);
    const start = this.tail.then(async () => {
      await privateDirectory(this.root);
      await mkdir(directory, { mode: 0o700 });
      await json(join(directory, 'monitor.json'), {
        format: FORMAT,
        createdAt,
        ...recorder.clean(info),
      });
      await mkdir(join(directory, 'requests'), { mode: 0o700 });
      await this.prune();
    });
    this.tail = start.catch(() => undefined);
    recorder.prepare(start);
    return recorder;
  }

  async flush(): Promise<void> {
    await this.tail;
    await Promise.all([...this.recorders].map((recorder) => recorder.flush()));
  }

  private emit(event: string, details: Record<string, unknown>): void {
    try {
      this.log(event, details);
    } catch {
      /* Debugging must not break a call. */
    }
  }

  private async prune(): Promise<void> {
    await privateDirectory(this.root);
    const owned: Array<{ directory: string; createdAt: number }> = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !DIRECTORY.test(entry.name)) continue;
      const directory = join(this.root, entry.name);
      try {
        await privateDirectory(directory);
        const markerPath = join(directory, 'monitor.json');
        const stat = await lstat(markerPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384)
          continue;
        const marker: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
        if (
          !marker ||
          typeof marker !== 'object' ||
          !('format' in marker) ||
          marker.format !== FORMAT ||
          !('createdAt' in marker) ||
          typeof marker.createdAt !== 'number' ||
          !Number.isSafeInteger(marker.createdAt) ||
          !entry.name.startsWith(`monitor-${marker.createdAt}-`)
        )
          continue;
        owned.push({ directory, createdAt: marker.createdAt });
      } catch {
        /* Do not remove unrecognized temporary data. */
      }
    }
    owned.sort(
      (a, b) =>
        b.createdAt - a.createdAt || b.directory.localeCompare(a.directory),
    );
    this.lastCreatedAt = Math.max(this.lastCreatedAt, owned[0]?.createdAt ?? 0);
    for (const entry of owned.slice(10)) {
      try {
        for (const recorder of this.recorders)
          if (recorder.directory === entry.directory) recorder.evict();
        await privateDirectory(entry.directory);
        // Remove the media subtree first and the marker last: a removal that
        // fails part-way leaves the archive recognizable, so the next prune
        // retries it instead of orphaning it.
        await rm(join(entry.directory, 'requests'), {
          recursive: true,
          force: true,
          maxRetries: 3,
        });
        await rm(entry.directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
        });
        this.emit('proactive.monitor_debug_pruned', {
          directory: entry.directory,
        });
      } catch (error) {
        /* One undeletable archive must not wedge the remaining prune. */
        const code = (error as NodeJS.ErrnoException).code;
        // A concurrent pruner on the same root already removed it.
        if (code === 'ENOENT') continue;
        this.emit('proactive.monitor_debug_prune_failed', {
          directory: entry.directory,
          retained: true,
          reason: code ?? (error instanceof Error ? error.message : 'unknown'),
        });
      }
    }
  }
}

export class MonitorDebugRecorder {
  private tail = Promise.resolve();
  private disabled = false;
  private disabledReason?: string;
  private closed = false;
  private pending: Media[] = [];
  private pendingBytes = 0;
  private queuedBytes = 0;
  private sequence = 0;
  private transport = 0;
  private session: Array<Record<string, unknown>> = [];
  private previousRequest?: string;
  private activeRequest?: {
    directory: string;
    record: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
    completed: boolean;
  };

  constructor(
    readonly directory: string,
    private readonly info: MonitorDebugInfo,
    private readonly apiKey: string | undefined,
    private readonly log: Log,
    private readonly release: () => void,
  ) {}

  clean<T>(value: T): T {
    return JSON.parse(
      JSON.stringify(value, (key, item: unknown) => {
        if (/^(authorization|apiKey|headers)$/iu.test(key)) return undefined;
        return typeof item === 'string' && this.apiKey
          ? item.split(this.apiKey).join('[redacted]')
          : item;
      }),
    ) as T;
  }

  prepare(start: Promise<void>): void {
    this.tail = start
      .then(() => this.emit('proactive.monitor_debug_started', {}))
      .catch(() => this.fail('initialization_failed'));
  }

  async start(): Promise<void> {
    await this.tail;
  }
  async flush(): Promise<void> {
    await this.tail;
  }

  beginTransport(transport: number): void {
    this.result({ status: 'recycled', incomplete: true });
    this.pending = [];
    this.pendingBytes = 0;
    this.session = [];
    this.previousRequest = undefined;
    this.activeRequest = undefined;
    this.transport = transport;
  }

  sent(body: Record<string, unknown>): void {
    if (this.closed) return;
    if (this.disabled) {
      if (body['type'] === 'input_audio_buffer.commit')
        this.emit('proactive.monitor_request_skipped', {
          reason: this.disabledReason,
          retained: false,
        });
      return;
    }
    try {
      this.recordSent(body);
    } catch {
      this.fail('recording_failed');
    }
  }

  private recordSent(body: Record<string, unknown>): void {
    const type = body['type'];
    if (type === 'session.update' || type === 'conversation.item.create') {
      this.session.push(this.clean(body));
    } else if (type === 'input_audio_buffer.clear') {
      this.pending = [];
      this.pendingBytes = 0;
    } else if (
      type === 'input_image_buffer.append' ||
      type === 'input_audio_buffer.append'
    ) {
      const payload =
        type === 'input_image_buffer.append' ? body['image'] : body['audio'];
      if (typeof payload !== 'string') return;
      const bytes = Buffer.from(payload, 'base64');
      if (
        this.pendingBytes + this.queuedBytes + bytes.length >
        MAX_PENDING_BYTES
      ) {
        this.fail('pending_byte_limit');
        return;
      }
      this.pending.push({
        type,
        bytes,
        sentAt: Date.now(),
        ...(typeof body['event_id'] === 'string'
          ? { eventId: body['event_id'] }
          : {}),
      });
      this.pendingBytes += bytes.length;
    } else if (type === 'input_audio_buffer.commit') {
      this.commit(this.clean(body));
    } else if (type === 'response.create' && this.activeRequest) {
      const active = this.activeRequest;
      active.events.push(this.clean(body));
      this.enqueue(async () =>
        json(join(active.directory, 'request.json'), active.record),
      );
    }
  }

  result(value: Record<string, unknown>): void {
    if (this.disabled || !this.activeRequest || this.activeRequest.completed)
      return;
    try {
      const active = this.activeRequest;
      active.completed = true;
      const safe = this.clean({
        ...value,
        ...(typeof value['text'] === 'string' && value['text'].length > 131_072
          ? { text: value['text'].slice(0, 131_072), textTruncated: true }
          : {}),
      });
      this.enqueue(
        async () => {
          await json(join(active.directory, 'response.json'), safe);
          this.emit('proactive.monitor_request_result', {
            requestDirectory: active.directory,
          });
        },
        Buffer.byteLength(JSON.stringify(safe)),
      );
    } catch {
      this.fail('recording_failed');
    }
  }

  close(): void {
    if (this.activeRequest && !this.activeRequest.completed)
      this.result({ status: 'closed', incomplete: true });
    this.closed = true;
    this.pending = [];
    this.pendingBytes = 0;
    void this.tail.then(this.release);
  }
  evict(): void {
    if (this.disabled) return;
    this.emit('proactive.monitor_debug_evicted', { retained: false });
    this.disabled = true;
    this.disabledReason = 'evicted';
    this.pending = [];
    this.pendingBytes = 0;
    void this.tail.then(this.release);
  }

  private commit(event: Record<string, unknown>): void {
    const media = this.pending;
    const byteCost = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    const directory = join(
      this.directory,
      'requests',
      String(++this.sequence).padStart(6, '0'),
    );
    const events: Array<Record<string, unknown>> = [];
    const audio: Buffer[] = [];
    let audioOffset = 0;
    let imageIndex = 0;
    const images: Array<{ path: string; bytes: Buffer }> = [];
    for (const input of media) {
      if (input.type === 'input_image_buffer.append') {
        const path = `image-${String(++imageIndex).padStart(4, '0')}.jpg`;
        images.push({ path, bytes: input.bytes });
        events.push({
          type: input.type,
          image: path,
          bytes: input.bytes.length,
          sentAt: input.sentAt,
          eventId: input.eventId,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
        });
      } else {
        audio.push(input.bytes);
        events.push({
          type: input.type,
          audio: 'input.wav',
          byteOffset: audioOffset,
          bytes: input.bytes.length,
          sentAt: input.sentAt,
          eventId: input.eventId,
        });
        audioOffset += input.bytes.length;
      }
    }
    events.push(event);
    const record = {
      format: FORMAT,
      recordingStatus: 'writing',
      monitor: this.clean(this.info),
      request: this.sequence,
      transportGeneration: this.transport,
      createdAt: Date.now(),
      previousRequest: this.previousRequest,
      session: this.session.map((item) => this.clean(item)),
      audioFormat: {
        encoding: 'pcm16le',
        sampleRate: 16000,
        channels: 1,
        byteOffsetsExcludeWavHeader: true,
      },
      events,
    };
    this.previousRequest = basename(directory);
    this.activeRequest = { directory, record, events, completed: false };
    this.enqueue(async () => {
      await mkdir(directory, { mode: 0o700 });
      await json(join(directory, 'request.json'), record);
      for (const image of images)
        await writeFile(join(directory, image.path), image.bytes, {
          flag: 'wx',
          mode: 0o600,
        });
      await writeFile(join(directory, 'input.wav'), wav(audio), {
        flag: 'wx',
        mode: 0o600,
      });
      record.recordingStatus = 'saved';
      await json(join(directory, 'request.json'), record);
      this.emit('proactive.monitor_request_saved', {
        requestDirectory: directory,
        request: record.request,
        imageFrames: images.length,
        audioBytes: audioOffset,
      });
    }, byteCost);
  }

  private enqueue(operation: () => Promise<void>, byteCost = 0): void {
    if (this.disabled) return;
    if (this.pendingBytes + this.queuedBytes + byteCost > MAX_PENDING_BYTES) {
      this.fail('pending_byte_limit');
      return;
    }
    this.queuedBytes += byteCost;
    this.tail = this.tail
      .then(async () => {
        if (this.disabled) return;
        await privateDirectory(this.directory);
        await privateDirectory(join(this.directory, 'requests'));
        await operation();
      })
      .catch(() => this.fail('write_failed'))
      .finally(() => {
        this.queuedBytes -= byteCost;
      });
  }

  private fail(reason: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.disabledReason = reason;
    this.pending = [];
    this.pendingBytes = 0;
    this.emit('proactive.monitor_debug_failed', { reason, incomplete: true });
  }

  private emit(event: string, details: Record<string, unknown>): void {
    try {
      this.log(event, {
        directory: this.directory,
        taskId: this.info.taskId,
        ...details,
      });
    } catch {
      /* Non-fatal diagnostics. */
    }
  }
}
