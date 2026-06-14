/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { splitForDiscord } from './streamSplit.js';

/**
 * Routes streamed `session_update` text into bound Discord channels
 * (`add-discord-bridge`: "session_update rendering" + "Threads on long
 * streams"). It owns the three concerns the runner must not get wrong:
 *
 * 1. BUFFERING — chunks accumulate and flush when a paragraph break / fence
 *    close is reached, OR the buffer hits 1800 chars, OR 1500 ms pass since the
 *    last chunk (the idle timer). Each flush is split to ≤2000 by the splitter.
 *
 * 2. ORDERED, SERIALIZED POSTING — chunk *append* is synchronous (string
 *    concat); every async post for a channel runs through a single per-channel
 *    promise chain. Two rapid chunks therefore can't interleave their `await`s
 *    into out-of-order messages, and the per-turn message count stays exact.
 *
 * 3. TURNS & THREADS — a turn is SESSION-scoped (one stream fans out to N
 *    channels); the message count and thread are CHANNEL-scoped. After 6
 *    messages POSTED to a channel within one turn, the 7th and later go into a
 *    public thread opened off the turn's first message. A turn ends at the event
 *    after a `permission_resolved` OR at the next inbound user prompt; the next
 *    turn's flushes go back to the channel, not the old thread.
 *
 * DELIBERATE SCOPE: only `agent_message_chunk` text is rendered (thought/tool
 * chunks are skipped to keep channels readable). A code block split ACROSS two
 * separate flushes renders as two blocks (each individually fence-balanced) —
 * the splitter guarantees per-message balance; cross-flush continuity is not
 * attempted. Last-Event-ID resume is not used (the daemon replays nothing
 * without a cursor, so a reconnect drops in-blip chunks rather than double-
 * posting — see runner notes).
 *
 * KNOWN LIMITATION (cosmetic): if turn N ends (resolve / new prompt) while a
 * sub-trigger tail is still buffered (no paragraph break, < cap, idle timer not
 * yet fired), that tail is not force-flushed at the boundary — the next chunk
 * appends to the same buffer and the combined text flushes as turn N+1's first
 * message. Content and fence balance are preserved; only the turn attribution of
 * a trailing partial line is off. A correct fix must capture the turn id at
 * flush-ENQUEUE time (resetTurnIfStale reads the seq at doFlush execution time,
 * so a naive "flush then bump" still resolves to the new turn); deferred as not
 * worth the added complexity for a cosmetic effect.
 */

/** Flush when the buffer reaches this many chars (below the 2000 hard cap). */
export const FLUSH_MAX_CHARS = 1800;
/** Flush this long after the last chunk if no hard trigger fired. */
export const FLUSH_IDLE_MS = 1500;
/** Messages posted to a channel within one turn before a thread is opened. */
export const MAX_CHANNEL_MESSAGES = 6;

/** A growable buffer that knows when a "hard" flush trigger is present. */
export class StreamBuffer {
  private buf = '';
  append(text: string): void {
    this.buf += text;
  }
  get length(): number {
    return this.buf.length;
  }
  isEmpty(): boolean {
    return this.buf.length === 0;
  }
  /** Paragraph break present, a fenced block just closed, or ≥ FLUSH_MAX_CHARS. */
  hardDue(): boolean {
    if (this.buf.length >= FLUSH_MAX_CHARS) return true;
    if (this.buf.includes('\n\n')) return true; // paragraph break
    const fences = this.buf
      .split('\n')
      .filter((l) => l.trimStart().startsWith('```')).length;
    return fences > 0 && fences % 2 === 0; // a complete block has closed
  }
  /** Return the buffered text and clear. */
  take(): string {
    const s = this.buf;
    this.buf = '';
    return s;
  }
}

/** The outbound surface the router needs (a subset of DiscordRestApi, mocked). */
export interface StreamPoster {
  /** Post text to a channel or thread; resolves the created message id, or null. */
  postMessage(
    channelOrThreadId: string,
    content: string,
  ): Promise<string | null>;
  /** Open a public thread off a message; resolves the thread id, or null. */
  createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<string | null>;
}

export interface StreamRouterConfig {
  poster: StreamPoster;
  /** Channels currently bound to a session (resolved fresh per chunk). */
  channelsFor: (sessionId: string) => string[];
  /** Arm a one-shot timer; returns a cancel fn. Injectable for tests. */
  setTimer?: (ms: number, fn: () => void) => () => void;
  /** Thread name for a long stream (default "qwen output"). */
  threadName?: string;
  log?: (msg: string) => void;
}

/** Per-channel mutable state. */
interface ChannelState {
  channelId: string;
  sessionId: string;
  buffer: StreamBuffer;
  /** Serialized flush chain — every async post runs here, in order. */
  chain: Promise<void>;
  cancelTimer?: () => void;
  /** Turn-scoped counters; reset lazily when the session's turn id advances. */
  turnId: number;
  posted: number;
  anchorId: string | null;
  threadId: string | null;
}

export class StreamRouter {
  private readonly cfg: StreamRouterConfig;
  private readonly setTimer: (ms: number, fn: () => void) => () => void;
  private readonly threadName: string;
  /** Session-scoped current turn id (bumped on resolve-next / inbound prompt). */
  private readonly turnSeq = new Map<string, number>();
  /** Set when a permission_resolved arrives → next chunk starts a new turn. */
  private readonly pendingBump = new Set<string>();
  private readonly channels = new Map<string, ChannelState>();

  constructor(cfg: StreamRouterConfig) {
    this.cfg = cfg;
    this.setTimer = cfg.setTimer ?? defaultSetTimer;
    this.threadName = cfg.threadName ?? 'qwen output';
  }

  private seq(sessionId: string): number {
    return this.turnSeq.get(sessionId) ?? 0;
  }

  /** A new agent turn begins: bump the session's turn id (channels reset lazily). */
  bumpTurn(sessionId: string): void {
    this.turnSeq.set(sessionId, this.seq(sessionId) + 1);
    this.pendingBump.delete(sessionId);
  }

  /** A permission_resolved arrived: the NEXT chunk is a new turn (spec boundary). */
  notePermissionResolved(sessionId: string): void {
    this.pendingBump.add(sessionId);
  }

  /** Route a chunk of streamed agent text into every channel bound to the session. */
  onChunk(sessionId: string, text: string): void {
    if (!text) return;
    if (this.pendingBump.has(sessionId)) this.bumpTurn(sessionId);
    for (const channelId of this.cfg.channelsFor(sessionId)) {
      const st = this.channelState(channelId, sessionId);
      st.buffer.append(text);
      if (st.cancelTimer) {
        st.cancelTimer();
        st.cancelTimer = undefined;
      }
      if (st.buffer.hardDue()) {
        this.flush(channelId);
      } else {
        // Arm the idle timer (debounced: re-armed on each chunk).
        st.cancelTimer = this.setTimer(FLUSH_IDLE_MS, () => {
          st.cancelTimer = undefined;
          this.flush(channelId);
        });
      }
    }
  }

  private channelState(channelId: string, sessionId: string): ChannelState {
    let st = this.channels.get(channelId);
    if (!st) {
      st = {
        channelId,
        sessionId,
        buffer: new StreamBuffer(),
        chain: Promise.resolve(),
        turnId: this.seq(sessionId),
        posted: 0,
        anchorId: null,
        threadId: null,
      };
      this.channels.set(channelId, st);
    } else {
      st.sessionId = sessionId;
    }
    return st;
  }

  /** Enqueue a serialized flush of the channel's buffer. */
  private flush(channelId: string): void {
    const st = this.channels.get(channelId);
    if (!st || st.buffer.isEmpty()) return;
    const text = st.buffer.take();
    st.chain = st.chain.then(() => this.doFlush(st, text)).catch(() => {});
  }

  private async doFlush(st: ChannelState, text: string): Promise<void> {
    const parts = splitForDiscord(text);
    for (const part of parts) {
      this.resetTurnIfStale(st);
      st.posted += 1;
      if (st.posted <= MAX_CHANNEL_MESSAGES) {
        const id = await this.cfg.poster.postMessage(st.channelId, part);
        if (st.posted === 1) st.anchorId = id;
        continue;
      }
      // 7th+ message of the turn → into a thread off the turn's first message.
      if (
        st.posted === MAX_CHANNEL_MESSAGES + 1 &&
        !st.threadId &&
        st.anchorId
      ) {
        st.threadId = await this.cfg.poster.createThread(
          st.channelId,
          st.anchorId,
          this.threadName,
        );
      }
      // If the thread couldn't be created, fall back to the channel (still posts).
      const dest = st.threadId ?? st.channelId;
      await this.cfg.poster.postMessage(dest, part);
    }
  }

  /** Reset a channel's per-turn counters if the session advanced to a new turn. */
  private resetTurnIfStale(st: ChannelState): void {
    const current = this.seq(st.sessionId);
    if (st.turnId === current) return;
    st.turnId = current;
    st.posted = 0;
    st.anchorId = null;
    st.threadId = null;
  }

  /** Test helper: await every channel's in-flight flush chain. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.channels.values()].map((s) => s.chain));
  }
}

/** Default one-shot timer using setTimeout; returns a cancel fn. */
function defaultSetTimer(ms: number, fn: () => void): () => void {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}
