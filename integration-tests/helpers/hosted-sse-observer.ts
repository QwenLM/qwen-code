/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #14147: the SSE observer and event projection the hosted gate drivers
// used to carry as private copies (FG6e's hosted-sse-gap-driver.ts and
// FG8's hosted-monitor-run-fault-driver.ts held byte-identical parse loops
// and field mappings). One class serves both surfaces of a Session's event
// stream: `public` (the snake_case /v1/agents feed) and `web` (the
// camelCase WebShell feed).

import assert from 'node:assert/strict';
import { waitUntil } from './hosted-harness-process.js';

export type SseFrame = {
  id: number;
  event: string;
  data: Record<string, unknown>;
};

export class SseObserver {
  readonly frames: SseFrame[] = [];
  readonly controller = new AbortController();
  task?: Promise<void>;
  failure?: unknown;

  constructor(
    private readonly opts: {
      readonly surface: 'public' | 'web';
      readonly sessionId: string;
      readonly storeUrl: string;
      readonly tenantId: string;
      readonly timeoutMs: number;
    },
  ) {}

  async start(after?: number) {
    const { surface, sessionId, storeUrl, tenantId, timeoutMs } = this.opts;
    const response = await fetch(
      new URL(
        surface === 'public'
          ? `/v1/agents/sessions/${sessionId}/events?stream=true&after=0`
          : '/api/agent/web-shell/v1/events/stream',
        storeUrl,
      ),
      {
        method: surface === 'public' ? 'GET' : 'POST',
        headers: {
          'X-Qwen-Tenant-Id': tenantId,
          Accept: 'text/event-stream',
          ...(surface === 'web' ? { 'Content-Type': 'application/json' } : {}),
          ...(surface === 'public' && after !== undefined
            ? { 'Last-Event-ID': String(after) }
            : {}),
        },
        ...(surface === 'web'
          ? {
              body: JSON.stringify({
                sessionId,
                afterSequence: after ?? 0,
              }),
            }
          : {}),
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(timeoutMs),
        ]),
      },
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') ?? '',
      /text\/event-stream/,
    );
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    this.task = (async () => {
      let pending = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += value;
          let end: number;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const block = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const lines = block.split('\n');
            const data = lines
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            const idRaw = lines
              .find((line) => line.startsWith('id:'))
              ?.slice(3)
              .trim();
            // Validate the cursor format before numeric conversion: a
            // malformed id (1e0, 0x1, +2) coerces to a valid number and
            // would mask the cursor-format regression the replay and
            // continuity assertions rely on.
            assert.match(idRaw ?? '', /^\d+$/);
            const frame = {
              id: Number(idRaw),
              event:
                lines
                  .find((line) => line.startsWith('event:'))
                  ?.slice(6)
                  .trim() ?? '',
              data: JSON.parse(data) as Record<string, unknown>,
            };
            assert.equal(
              frame.id,
              frame.data['sequence'],
              'SSE id must equal payload sequence',
            );
            assert.equal(frame.event, frame.data['type']);
            this.frames.push(frame);
          }
        }
      } catch (cause) {
        if (!this.controller.signal.aborted) this.failure = cause;
      } finally {
        reader.releaseLock();
      }
    })();
  }

  /** The turn a frame belongs to, read in the surface's own key style. */
  turnIdOf(frame: SseFrame): string | undefined {
    const value =
      frame.data[this.opts.surface === 'web' ? 'turnId' : 'turn_id'];
    return typeof value === 'string' ? value : undefined;
  }

  async through(sequence: number) {
    await waitUntil(() => {
      if (this.failure) throw this.failure;
      return this.frames.some((frame) => frame.id >= sequence);
    }, 10_000);
  }

  /** Wait until a terminal frame of a turn other than `exclude` arrived. */
  async terminalOfOtherTurn(exclude: string) {
    await waitUntil(() => {
      if (this.failure) throw this.failure;
      return this.frames.some((frame) => {
        const turnId = this.turnIdOf(frame);
        return (
          frame.data['terminal'] === true &&
          turnId !== undefined &&
          turnId !== exclude
        );
      });
    }, 120_000);
  }

  async close() {
    this.controller.abort();
    await this.task;
    if (this.failure) throw this.failure;
  }
}

/**
 * The events one case's Session committed, projected exactly the way the
 * public/WebShell surfaces shape them: snake_case keys and second-precision
 * created_at on the public surface, camelCase keys and raw gmt_create on
 * the WebShell surface.
 */
export function projectEvents(
  rows: Array<Record<string, unknown>>,
  surface: string,
) {
  return rows.map((row) => {
    const fields: Record<string, unknown> = {
      schema_version: row['schema_version'],
      projection_version: row['projection_version'],
      sequence: row['sequence_id'],
      event_id: row['event_id'],
      session_id: row['session_id'],
      turn_id: row['turn_id'],
      item_id: row['item_id'],
      content_part_id: row['content_part_id'],
      type: row['event_type'],
      created_at:
        surface === 'public'
          ? Math.floor(Number(row['gmt_create']) / 1000)
          : row['gmt_create'],
      data: JSON.parse(String(row['data_json'])),
      terminal: Boolean(row['terminal']),
    };
    return Object.fromEntries(
      Object.entries(fields)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => [
          surface === 'web'
            ? key.replace(/_([a-z])/g, (_, letter: string) =>
                letter.toUpperCase(),
              )
            : key,
          value,
        ]),
    );
  });
}
