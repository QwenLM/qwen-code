/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BridgeEvent } from './eventBus.js';
import { writeStderrLine } from './internal/stderrLine.js';

export interface ReplayStore {
  append(event: BridgeEvent): void;
  snapshot(): Promise<BridgeEvent[]>;
  close(): void;
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly events: BridgeEvent[] = [];
  private closed = false;

  append(event: BridgeEvent): void {
    if (this.closed) return;
    this.events.push(event);
  }

  async snapshot(): Promise<BridgeEvent[]> {
    return this.events.slice();
  }

  close(): void {
    this.closed = true;
    this.events.length = 0;
  }
}

export interface FileReplayStoreOptions {
  dir: string;
  sessionId: string;
  deleteOnClose?: boolean;
}

export function fileReplayStorePath(dir: string, sessionId: string): string {
  return path.join(dir, `${safeFileSegment(sessionId)}.jsonl`);
}

export function deleteFileReplayStore(dir: string, sessionId: string): void {
  try {
    fs.rmSync(fileReplayStorePath(dir, sessionId), { force: true });
  } catch {
    // Best-effort cleanup for runtime cache. A failure should not turn a
    // successful session close/delete into a user-visible error.
  }
}

/**
 * Append-only replay store for daemon UI events.
 *
 * Chat history JSONL stores semantic conversation records; this store keeps
 * the exact daemon event projection used by web clients. That lets live
 * `/load` recover pending tools, permission requests, subagent updates, and
 * turn sentinels without retaining an unbounded in-memory replay array.
 */
export class FileReplayStore implements ReplayStore {
  private readonly dir: string;
  private readonly sessionId: string;
  private readonly filePath: string;
  private readonly deleteOnClose: boolean;
  private readonly pendingEvents: BridgeEvent[] = [];
  private readonly writeQueue: BridgeEvent[] = [];
  private readonly fallbackEvents: BridgeEvent[] = [];
  private stream: fs.WriteStream | undefined;
  private pendingStartIndex = 0;
  private writeQueueStartIndex = 0;
  private waitingForDrain = false;
  private failed = false;
  private closed = false;
  private warnedReadFailure = false;
  private warnedMalformedLine = false;

  constructor(opts: FileReplayStoreOptions) {
    this.dir = opts.dir;
    this.sessionId = opts.sessionId;
    this.filePath = fileReplayStorePath(this.dir, this.sessionId);
    this.deleteOnClose = opts.deleteOnClose ?? true;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.dir, 0o700);
    } catch {
      // Best effort: the file itself is still created with 0600 below.
    }
  }

  append(event: BridgeEvent): void {
    if (this.closed) return;
    if (this.failed) {
      this.fallbackEvents.push(event);
      return;
    }
    this.pendingEvents.push(event);
    this.writeQueue.push(event);
    this.flushWriteQueue();
  }

  async snapshot(): Promise<BridgeEvent[]> {
    const events: BridgeEvent[] = [];
    try {
      await fs.promises.access(this.filePath);
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as BridgeEvent);
        } catch (error) {
          // A malformed temp replay line should not make `/load` fail.
          // The store is best-effort runtime state; later valid lines still
          // carry useful UI history.
          if (!this.warnedMalformedLine) {
            this.warnedMalformedLine = true;
            writeStderrLine(
              `qwen serve: replay cache contains malformed JSONL for ` +
                `session ${JSON.stringify(this.sessionId)} at ` +
                `${JSON.stringify(this.filePath)}; skipping malformed line: ` +
                `${formatReplayStoreError(error)}`,
            );
          }
        }
      }
    } catch (error) {
      const maybeNodeError = error as { code?: unknown };
      if (maybeNodeError.code !== 'ENOENT' && !this.warnedReadFailure) {
        this.warnedReadFailure = true;
        writeStderrLine(
          `qwen serve: replay cache read failed for session ` +
            `${JSON.stringify(this.sessionId)} at ${JSON.stringify(this.filePath)}; ` +
            `using in-memory fallback only: ${formatReplayStoreError(error)}`,
        );
      }
    }
    return appendUniqueEvents(events, [
      ...this.pendingEvents.slice(this.pendingStartIndex),
      ...this.fallbackEvents,
    ]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream?.destroy();
    this.stream = undefined;
    if (this.deleteOnClose) {
      deleteFileReplayStore(this.dir, this.sessionId);
    }
    this.writeQueue.length = 0;
    this.writeQueueStartIndex = 0;
    this.pendingStartIndex = 0;
    this.pendingEvents.length = 0;
    this.fallbackEvents.length = 0;
  }

  private flushWriteQueue(): void {
    if (this.closed || this.failed || this.waitingForDrain) return;
    try {
      const stream = this.ensureStream();
      while (this.writeQueueStartIndex < this.writeQueue.length) {
        const event = this.writeQueue[this.writeQueueStartIndex++];
        const ok = stream.write(
          `${JSON.stringify(event)}\n`,
          'utf8',
          (error) => {
            if (this.failed || this.closed) return;
            if (error) {
              this.failWrites(error);
              return;
            }
            this.pendingStartIndex++;
            this.compactPendingEvents();
          },
        );
        if (!ok) {
          this.waitingForDrain = true;
          stream.once('drain', () => {
            this.waitingForDrain = false;
            this.flushWriteQueue();
          });
          break;
        }
      }
      this.compactWriteQueue();
    } catch (error) {
      // EventBus.publish() is a never-throw hot path. If the temporary
      // replay stream cannot be created or written, preserve correctness for
      // this process by keeping unwritten events in memory.
      this.failWrites(error);
    }
  }

  private ensureStream(): fs.WriteStream {
    if (this.stream) return this.stream;
    const stream = fs.createWriteStream(this.filePath, {
      flags: 'a',
      encoding: 'utf8',
      mode: 0o600,
    });
    stream.on('error', (error) => {
      this.failWrites(error);
    });
    this.stream = stream;
    return stream;
  }

  private failWrites(error: unknown): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    writeStderrLine(
      `qwen serve: replay cache write failed for session ` +
        `${JSON.stringify(this.sessionId)} at ${JSON.stringify(this.filePath)}; ` +
        `falling back to in-memory replay: ${formatReplayStoreError(error)}`,
    );
    this.fallbackEvents.push(
      ...this.pendingEvents.slice(this.pendingStartIndex),
    );
    this.writeQueue.length = 0;
    this.writeQueueStartIndex = 0;
    this.pendingStartIndex = 0;
    this.pendingEvents.length = 0;
    this.stream?.destroy();
    this.stream = undefined;
  }

  private compactPendingEvents(): void {
    if (
      this.pendingStartIndex > 1024 &&
      this.pendingStartIndex * 2 > this.pendingEvents.length
    ) {
      this.pendingEvents.splice(0, this.pendingStartIndex);
      this.pendingStartIndex = 0;
    }
  }

  private compactWriteQueue(): void {
    if (this.writeQueueStartIndex === this.writeQueue.length) {
      this.writeQueue.length = 0;
      this.writeQueueStartIndex = 0;
      return;
    }
    if (
      this.writeQueueStartIndex > 1024 &&
      this.writeQueueStartIndex * 2 > this.writeQueue.length
    ) {
      this.writeQueue.splice(0, this.writeQueueStartIndex);
      this.writeQueueStartIndex = 0;
    }
  }
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function formatReplayStoreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendUniqueEvents(
  persistedEvents: BridgeEvent[],
  volatileEvents: BridgeEvent[],
): BridgeEvent[] {
  const out = persistedEvents.slice();
  const seenIds = new Set(
    persistedEvents
      .map((event) => event.id)
      .filter((id): id is number => typeof id === 'number'),
  );
  for (const event of volatileEvents) {
    if (typeof event.id === 'number') {
      if (seenIds.has(event.id)) continue;
      seenIds.add(event.id);
    }
    out.push(event);
  }
  return out;
}
