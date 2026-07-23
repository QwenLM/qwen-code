import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { ChannelAgentBridge } from './ChannelAgentBridge.js';
import type { ChannelBaseOptions } from './ChannelBase.js';
import { ChannelBase } from './ChannelBase.js';
import type { ChannelConfig } from './types.js';
import { getGlobalQwenDir } from './paths.js';

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const INITIAL_BACKOFF = 2_000;
const MAX_BACKOFF = 30_000;

export abstract class PollingChannelBase<Cursor> extends ChannelBase {
  protected cursor: Cursor;
  private abortController = new AbortController();
  private running = false;
  private consecutiveErrors = 0;

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.cursor = this.loadCursorFromDisk() ?? this.createInitialCursor();
  }

  protected abstract pollOnce(): Promise<void>;
  protected abstract createInitialCursor(): Cursor;

  protected get pollInterval(): number {
    return 60_000;
  }

  protected saveCursor(): void {
    const path = this.cursorPath();
    mkdirSync(join(getGlobalQwenDir(), 'channels'), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cursor) + '\n', 'utf-8');
    renameSync(tmp, path);
  }

  protected startPollLoop(): void {
    this.running = true;
    this.abortController = new AbortController();
    this.runLoop();
  }

  protected stopPollLoop(): void {
    this.running = false;
    this.abortController.abort();
  }

  private async runLoop(): Promise<void> {
    const signal = this.abortController.signal;
    while (this.running && !signal.aborted) {
      try {
        await this.pollOnce();
        this.saveCursor();
        this.consecutiveErrors = 0;
      } catch (err) {
        this.consecutiveErrors++;
        const backoff = Math.min(
          INITIAL_BACKOFF * 2 ** (this.consecutiveErrors - 1),
          MAX_BACKOFF,
        );
        process.stderr.write(
          `[Channel:${this.name}] poll error (attempt ${this.consecutiveErrors}), backing off ${backoff}ms: ${err}\n`,
        );
        await abortableSleep(backoff, signal);
        continue;
      }
      await abortableSleep(this.pollInterval, signal);
    }
  }

  private loadCursorFromDisk(): Cursor | null {
    try {
      const raw = readFileSync(this.cursorPath(), 'utf-8').trim();
      if (!raw) return null;
      return JSON.parse(raw) as Cursor;
    } catch {
      return null;
    }
  }

  private cursorPath(): string {
    const encoded = this.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(getGlobalQwenDir(), 'channels', `${encoded}-poll-cursor.json`);
  }
}
