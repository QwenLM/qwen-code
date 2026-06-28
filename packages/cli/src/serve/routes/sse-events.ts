/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mapDomainErrorToErrorKind } from '@qwen-code/acp-bridge';
import type { Application } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { DaemonLogger } from '../daemon-logger.js';
import {
  SubscriberLimitExceededError,
  type BridgeEvent,
} from '@qwen-code/acp-bridge/eventBus';
import {
  errorMessage,
  type SendBridgeError,
} from '../server/error-response.js';
import {
  parseLastEventId,
  parseMaxQueuedQuery,
} from '../server/request-helpers.js';

let activeSseCount = 0;

export function getActiveSseCount(): number {
  return activeSseCount;
}

interface RegisterSseEventsRoutesDeps {
  bridge: AcpSessionBridge;
  daemonLog?: DaemonLogger;
  writerIdleTimeoutMs?: number;
  sendBridgeError: SendBridgeError;
}

type OmitId<T> = Omit<T, 'id'>;

function formatSseFrame(event: BridgeEvent | OmitId<BridgeEvent>): string {
  // SSE format: id (optional), event (optional), data, blank line.
  // The `id:` line is intentionally omitted when `event.id` is absent —
  // terminal/synthetic frames (e.g. daemon-side `stream_error`) must not
  // burn a slot in the per-session monotonic sequence the client uses for
  // `Last-Event-ID` reconnect tracking.
  //
  // We always emit the payload as a single `data:` line. The EventSource
  // spec also allows a frame to span multiple `data:` lines (which a
  // conformant parser joins with `\n`); we don't emit that form because
  // our payload is JSON without embedded newlines after `JSON.stringify`.
  // The SDK parser at `sdk-typescript/src/daemon/sse.ts` handles the
  // multi-line variant on the receive side — input/output asymmetry is
  // intentional.
  //
  // `_meta.serverTimestamp`: EventBus stamps normal session frames when they
  // are published so SSE and load/replay share the same event time. Keep this
  // fallback for synthetic frames that do not pass through EventBus.
  const existingMeta = (event as { _meta?: Record<string, unknown> })._meta;
  const existingServerTimestamp = existingMeta?.['serverTimestamp'];
  const serverTimestamp =
    typeof existingServerTimestamp === 'number' &&
    Number.isFinite(existingServerTimestamp)
      ? existingServerTimestamp
      : Date.now();
  const stamped = {
    ...event,
    _meta: { ...(existingMeta ?? {}), serverTimestamp },
  };
  const dataJson = JSON.stringify(stamped);
  const idLine =
    'id' in event && event.id !== undefined ? `id: ${event.id}\n` : '';
  return `${idLine}event: ${event.type}\ndata: ${dataJson}\n\n`;
}

export function registerSseEventsRoutes(
  app: Application,
  deps: RegisterSseEventsRoutesDeps,
): void {
  const { bridge, daemonLog, sendBridgeError, writerIdleTimeoutMs } = deps;

  app.get('/session/:id/events', (req, res) => {
    const sessionId = req.params['id'];
    const lastEventId = parseLastEventId(req.headers['last-event-id']);
    const maxQueued = parseMaxQueuedQuery(req.query['maxQueued'], res);
    // `parseMaxQueuedQuery` sends its own 400 + JSON body on rejection
    // (returns `null`) so the SSE handshake doesn't get half-written.
    // `undefined` means "client didn't ask for an override; use bus
    // default 256" — proceed as before.
    if (maxQueued === null) return;

    let iter: AsyncIterator<BridgeEvent> | undefined;
    const abort = new AbortController();
    try {
      const snapshot = req.query['snapshot'] === '1';
      const iterable = bridge.subscribeEvents(sessionId, {
        signal: abort.signal,
        lastEventId,
        ...(maxQueued !== undefined ? { maxQueued } : {}),
        ...(snapshot ? { snapshot: true } : {}),
      });
      iter = iterable[Symbol.asyncIterator]();
    } catch (err) {
      // `EventBus` throws `SubscriberLimitExceededError` when the
      // per-session subscriber cap (default 64) is reached.
      //
      // Surface as `429 Too Many Requests` + `Retry-After`
      // header rather than `200 + stream_error`. The previous
      // SSE-shaped response triggered `EventSource`'s
      // auto-reconnect (which honors the `retry:` directive AND
      // default-reconnects on any closed stream). The reconnect hit
      // the same cap, looped, amplifying the exact load the limit
      // exists to prevent.
      //
      // `429` is the standard "back off" signal — browsers'
      // `EventSource` treats `4xx` as terminal and does NOT
      // auto-reconnect on it, unlike `200 + close` which DOES
      // reconnect. Body shape mirrors the SSE frame's data field so
      // a raw-fetch client gets the same structured error.
      if (err instanceof SubscriberLimitExceededError) {
        writeStderrLine(
          `qwen serve: subscriber limit reached for session ${sessionId} (limit=${err.limit}); rejecting new SSE client with 429`,
        );
        res.setHeader('Retry-After', '5');
        res.status(429).json({
          error: err.message,
          code: 'subscriber_limit_exceeded',
          limit: err.limit,
        });
        return;
      }
      sendBridgeError(res, err, {
        route: 'GET /session/:id/events',
        sessionId,
      });
      return;
    }

    if (daemonLog) {
      const sseOpenedAt = Date.now();
      const sseClientId = req.headers['x-qwen-client-id'] as string | undefined;
      daemonLog.info('SSE stream opened', { sessionId, clientId: sseClientId });
      res.on('close', () => {
        try {
          daemonLog.info('SSE stream closed', {
            sessionId,
            clientId: sseClientId,
            durationMs: Date.now() - sseOpenedAt,
          });
        } catch {
          /* logger failure must not prevent counter decrement */
        }
      });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable proxy buffering (nginx); event-stream content type alone
    // doesn't always reach the client through every proxy.
    res.setHeader('X-Accel-Buffering', 'no');
    // Always present on the supported Node versions (engines.node >=22).
    res.flushHeaders();

    activeSseCount++;
    let sseCounted = true;
    res.on('close', () => {
      if (sseCounted) {
        sseCounted = false;
        activeSseCount--;
      }
    });

    // Backpressure helper: `res.write` returns false when the kernel send
    // buffer is full. Without awaiting `drain` Node accumulates the
    // payload in user-space memory unboundedly — a slow consumer on a
    // chatty session can balloon daemon RSS. Wait for `drain` (or
    // close/error) before scheduling the next write.
    //
    // Concurrency: serialize ALL writes through a per-connection chain
    // so the heartbeat (fire-and-forget interval, see below) can't
    // interleave with the main event-write loop. Without serialization,
    // the heartbeat firing while the main loop is mid-`drain` await
    // would issue a second `res.write()` that bypasses the
    // backpressure guard — and could even interleave bytes between two
    // SSE frames on the wire. The chain is single-flight: each call
    // waits for the previous write to settle before scheduling its own.
    let writeChain: Promise<void> = Promise.resolve();
    // T2.9: epoch (ms) of the last write that fully resolved — either
    // synchronous `res.write` returned `true`, or the async `drain`
    // fired. The idle-timeout interval below compares
    // `Date.now() - lastWriteAt` against the configured budget; a
    // writer that stalls indefinitely on `drain` will never refresh
    // this stamp, so the timer fires and forces cleanup. Initialized
    // to "now" because cleanup runs only after the FIRST stall, and
    // the SSE handshake itself counts as activity.
    //
    // Gated on `trackWriterIdle` so the default (flag unset) avoids
    // a per-chunk `Date.now()` on a chatty stream — SSE writers can
    // be in the hundreds-to-thousands of frames per session.
    const trackWriterIdle =
      writerIdleTimeoutMs !== undefined && writerIdleTimeoutMs > 0;
    let lastWriteAt = trackWriterIdle ? Date.now() : 0;
    const doWrite = (chunk: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (res.writableEnded) {
          resolve();
          return;
        }
        // `res.write` can throw synchronously when the socket is
        // already destroyed (typical EPIPE shape). Wrap in try/catch
        // so that surfaces as a rejection on this promise instead of
        // escaping the executor and turning into an unhandled
        // exception. Async failures still arrive via the `'error'`
        // event handler below — Node's Writable.write callback isn't
        // documented to receive an error argument (errors come on
        // the event), so we don't rely on it.
        let ok: boolean;
        try {
          ok = res.write(chunk);
        } catch (err) {
          reject(err);
          return;
        }
        if (ok) {
          if (trackWriterIdle) lastWriteAt = Date.now();
          resolve();
          return;
        }
        const onDrain = () => {
          res.off('close', onClose);
          res.off('error', onError);
          if (trackWriterIdle) lastWriteAt = Date.now();
          resolve();
        };
        const onClose = () => {
          res.off('drain', onDrain);
          res.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          res.off('drain', onDrain);
          res.off('close', onClose);
          reject(err);
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
        res.once('error', onError);
      });
    const writeWithBackpressure = (chunk: string): Promise<void> => {
      const next = writeChain.then(() => doWrite(chunk));
      // Tail-swallow rejections on the chain itself so a single failed
      // write doesn't poison every subsequent call. The CALLER's
      // returned promise still rejects — chain-internal failures are
      // someone else's problem, not blockers for queueing.
      writeChain = next.catch(() => undefined);
      return next;
    };

    // Tell EventSource to retry after 3s on disconnect. Awaiting drain on
    // the very first write is overkill but cheap — `ok` is true the
    // overwhelming majority of the time. Always swallow rejection: a
    // socket that errors before the very first write would otherwise
    // surface as an unhandled promise rejection (the `res.on('error')`
    // hook below is what we actually rely on for cleanup).
    void writeWithBackpressure('retry: 3000\n\n').catch(() => {});

    // Heartbeat keeps NAT/proxy connections alive and lets the server
    // notice a dead client through write-back-pressure. Comment frame is
    // ignored by EventSource.
    //
    // The 15s heartbeat detects a TCP-dead writer
    // via `drain` back-pressure on the comment frame itself. The
    // `--writer-idle-timeout-ms` flag below adds the orthogonal
    // application-level guard: if the LAST SUCCESSFUL FLUSH (any
    // write — heartbeat, replay frame, live event) is older than the
    // configured budget, the writer is considered stuck (NAT silently
    // dropping flows, peer process frozen, etc.) and we force a
    // terminal `client_evicted` frame + cleanup. The historical "Stage
    // 2 may add an explicit application-level idle timeout" gap
    // referenced here is now closed when the flag is set.
    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) {
        // Heartbeat writes are best-effort; failure swallowed via the
        // `res.on('error')` hook below.
        void writeWithBackpressure(': heartbeat\n\n').catch(() => {});
      }
    }, 15_000);
    heartbeatTimer.unref();

    // T2.9: declare the idle-timer slot up-front so `cleanup` below can
    // clear it unconditionally. The actual interval is armed only when
    // `--writer-idle-timeout-ms` is configured.
    let idleTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      if (idleTimer !== undefined) clearInterval(idleTimer);
      abort.abort();
    };

    // T2.9: arm the SSE writer idle timeout (if configured). Distinct
    // from the heartbeat above: heartbeat = "try to ping every 15s";
    // this = "if no write SUCCEEDED for N ms, force-evict." Values
    // BELOW the 15s heartbeat interval WILL evict otherwise-healthy
    // idle connections before the first heartbeat fires — they're not
    // a no-op. Production deployments should pick a value comfortably
    // above 15s (e.g. 30000–300000ms) so legitimate idle streams stay
    // alive and only genuinely stuck writers are reaped; small values
    // are useful for tests / short-lived dev sessions. The interval
    // polls at 1/4 the budget (bounded by [250ms, 5s]) so tests
    // using short budgets still detect promptly, while long
    // production budgets stay cheap. Values below roughly 1000ms all
    // use the 250ms polling floor, so eviction can lag until the next
    // tick instead of landing at exact millisecond precision.
    if (trackWriterIdle) {
      // Narrowed by `trackWriterIdle`; the const assertion keeps
      // TypeScript happy inside the closure without re-reading opts.
      const writerIdleTimeoutMsValue = writerIdleTimeoutMs as number;
      const checkIntervalMs = Math.max(
        250,
        Math.min(5_000, Math.floor(writerIdleTimeoutMsValue / 4)),
      );
      idleTimer = setInterval(() => {
        if (res.writableEnded) return;
        const idleForMs = Date.now() - lastWriteAt;
        if (idleForMs < writerIdleTimeoutMsValue) return;
        // Reuse the existing `client_evicted` taxonomy from the bridge event
        // bus so SDK reducers branch on the same frame type they already
        // handle for queue-overflow eviction; the new `reason` slot is the
        // differentiator. Write DIRECTLY here
        // (bypassing `writeWithBackpressure`) because the chain may
        // already be stuck on a `drain` that will never come — which
        // is the exact scenario this timer exists to catch. If the
        // kernel send buffer has room the client sees the frame; if
        // not, the client gets EPIPE on next read. Either way the
        // socket is closed in the next two statements, so any drop
        // is bounded.
        try {
          res.write(
            formatSseFrame({
              v: 1,
              type: 'client_evicted',
              data: {
                reason: 'writer_idle_timeout',
                errorKind: 'writer_idle_timeout',
                idleForMs,
                timeoutMs: writerIdleTimeoutMsValue,
              },
            }),
          );
        } catch {
          /* socket already destroyed; nothing to send. */
        }
        // Wrap stderr + res.end so an
        // EPIPE on the stderr pipe (or a synchronous throw from
        // `res.end()` against a destroyed socket) can't escape this
        // interval callback. If it did, `cleanup()` wouldn't run, the
        // heartbeat + idle timers would never clear, and every
        // subsequent tick would re-throw — turning one transient
        // failure into a permanent uncaughtException loop.
        try {
          writeStderrLine(
            `qwen serve: evicting SSE client (session ${sessionId}) — ` +
              `writer idle for ${idleForMs}ms > ${writerIdleTimeoutMsValue}ms timeout`,
          );
        } catch {
          /* stderr pipe closed; eviction is still happening. */
        }
        cleanup();
        try {
          if (!res.writableEnded) res.end();
        } catch {
          /* socket already destroyed; nothing more to do. */
        }
      }, checkIntervalMs);
      idleTimer.unref();
    }
    req.on('close', cleanup);
    // Swallow socket-level write errors. When the underlying TCP connection
    // dies (RST, mid-flight kill -9), the next `res.write` throws EPIPE.
    // Without an `error` listener Express forwards it to its default error
    // handler which logs noisily. The req.on('close') path above is what we
    // actually rely on to tear down the subscription; this listener just
    // suppresses the noise + ensures cleanup runs even if for some reason
    // the close event doesn't fire first.
    res.on('error', (err) => {
      // Without this log the daemon side is blind to SSE disconnects
      // (RST, mid-flight kill -9, network blip). Cleanup still runs —
      // the listener exists primarily so Node doesn't crash on EPIPE
      // — but operators get a breadcrumb when chasing flaky clients.
      writeStderrLine(
        `qwen serve: SSE socket error (session ${sessionId}): ${err.message}`,
      );
      cleanup();
    });

    void (async () => {
      try {
        while (true) {
          const next = await iter!.next();
          if (next.done) break;
          if (res.writableEnded) break;
          // Log ring eviction events for operator observability.
          if (next.value.type === 'state_resync_required') {
            const data = next.value.data as {
              lastDeliveredId?: number;
              earliestAvailableId?: number;
              reason?: string;
            };
            const gap =
              typeof data.earliestAvailableId === 'number' &&
              typeof data.lastDeliveredId === 'number'
                ? data.earliestAvailableId - data.lastDeliveredId - 1
                : undefined;
            writeStderrLine(
              `qwen serve: SSE ring eviction detected (session ${sessionId}): ` +
                `lastEventId=${data.lastDeliveredId ?? '?'}, ` +
                `earliestInRing=${data.earliestAvailableId ?? '?'}, ` +
                `gap=${gap ?? '?'} events, ` +
                `reason=${data.reason ?? '?'}. ` +
                `Consumer must call loadSession to recover.`,
            );
          }
          await writeWithBackpressure(formatSseFrame(next.value));
        }
      } catch (err) {
        if (!res.writableEnded) {
          // Don't burn an `id:` slot — `stream_error` is a terminal frame
          // emitted on the daemon side when the bridge iterator throws, so
          // it has no place in the per-session monotonic sequence and a
          // hard-coded `id: 0` would regress the client's `Last-Event-ID`
          // tracker. `formatSseFrame` omits the `id:` line when the input
          // event has no id.
          //
          // Stamp the classified error kind so UIs can render typed responses
          // (auth retry / file picker / proxy hint / etc.) rather than
          // regex-matching the human-readable `error` string. Returns
          // `undefined` for unclassified errors — SDK falls back to
          // rendering `error` text as before, so adding `errorKind` is
          // strictly additive / backward-compatible.
          const errorKind = mapDomainErrorToErrorKind(err);
          // Log bridge iterator errors to daemon stderr for
          // operator observability.
          writeStderrLine(
            `qwen serve: bridge iterator error (session ${sessionId}): ` +
              `${errorMessage(err)}` +
              (errorKind ? ` [${errorKind}]` : ''),
          );
          await writeWithBackpressure(
            formatSseFrame({
              v: 1,
              type: 'stream_error',
              data: {
                error: errorMessage(err),
                ...(errorKind ? { errorKind } : {}),
              },
            }),
          ).catch(() => {});
        }
      } finally {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    })();
  });
}
