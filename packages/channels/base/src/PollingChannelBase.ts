import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { ChannelAgentBridge } from './ChannelAgentBridge.js';
import type { ChannelBaseOptions } from './ChannelBase.js';
import { ChannelBase } from './ChannelBase.js';
import type { ChannelConfig } from './types.js';
import { getGlobalQwenDir } from './paths.js';

const INITIAL_BACKOFF = 2_000;
const MAX_BACKOFF = 30_000;

/**
 * Inclusive bounds the poll loop enforces at runtime. Node clamps a timeout
 * above its 32-bit range to 1ms and rounds a sub-millisecond one to ~1ms, so
 * either end left open turns the loop into a hot loop that burns the platform's
 * rate quota. The descriptor vocabulary has only an exclusive lower bound, so
 * the inclusive floor a field documents is enforced here; a plugin declares
 * `maximum: MAX_POLL_INTERVAL_MS` so the two cannot drift apart.
 */
export const MIN_POLL_INTERVAL_MS = 1;
export const MAX_POLL_INTERVAL_MS = 86_400_000;

export abstract class PollingChannelBase<Cursor> extends ChannelBase {
  protected cursor: Cursor;
  private abortController = new AbortController();
  private running = false;
  private consecutiveErrors = 0;

  protected abortableSleep(ms: number): Promise<void> {
    const signal = this.abortController.signal;
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

  protected validateCursor(parsed: unknown): Cursor | null {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null;
    return parsed as Cursor;
  }

  protected get pollInterval(): number {
    const configured: unknown = this.config.pollInterval;
    if (
      typeof configured === 'number' &&
      Number.isFinite(configured) &&
      configured > 0
    ) {
      // Node clamps a timeout above its 32-bit range to 1ms, which would turn
      // the poll loop into a hot loop that burns the platform's rate quota.
      // Clamp rather than fall back: an interval between one day and that limit
      // was honoured before this ceiling existed and is not a hot loop, so
      // replacing it with 60s would multiply the poll rate by orders of
      // magnitude. One day matches the ceiling Email enforces and GitHub
      // declares.
      //
      // The low end needs the same treatment from the other direction: a
      // fractional interval such as 0.5 passes the descriptor's exclusive
      // lower bound and the store, and setTimeout rounds it to ~1ms.
      return Math.min(
        Math.max(configured, MIN_POLL_INTERVAL_MS),
        MAX_POLL_INTERVAL_MS,
      );
    }
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
    if (this.running) return;
    this.running = true;
    this.consecutiveErrors = 0;
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
        await this.abortableSleep(backoff);
        continue;
      }
      await this.abortableSleep(this.pollInterval);
    }
  }

  private loadCursorFromDisk(): Cursor | null {
    try {
      const raw = readFileSync(this.cursorPath(), 'utf-8').trim();
      if (!raw) return null;
      return this.validateCursor(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private cursorPath(): string {
    const encoded = this.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
    const hash = createHash('sha256')
      .update(this.name)
      .digest('hex')
      .slice(0, 16);
    return join(
      getGlobalQwenDir(),
      'channels',
      `${encoded}-${hash}-poll-cursor.json`,
    );
  }
}
