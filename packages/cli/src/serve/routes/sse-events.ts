/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  addDaemonRequestAttribute,
  captureDaemonTelemetryContext,
  emitDaemonLog,
  runWithDaemonTelemetryContext,
} from '@qwen-code/qwen-code-core';
import { mapDomainErrorToErrorKind } from '@qwen-code/acp-bridge';
import type { Application } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { DaemonLogger } from '../daemon-logger.js';
import {
  SubscriberLimitExceededError,
  type BridgeEvent,
  type EventBusSubscriberDiagnostic,
} from '@qwen-code/acp-bridge/eventBus';
import {
  errorMessage,
  type SendBridgeError,
} from '../server/error-response.js';
import {
  CLIENT_ID_RE,
  MAX_CLIENT_ID_LENGTH,
  parseLastEventId,
  parseMaxQueuedQuery,
} from '../server/request-helpers.js';
import { parseEventEpochHeader } from '../sse-last-event-id.js';
import { omitSkillDetailsForSdkSurface } from '../skill-details-redaction.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import { requireSessionRuntime } from './session-runtime.js';
import {
  parseVirtualSubagentSessionId,
  type VirtualSubagentSessions,
} from '../virtual-subagent-sessions.js';

let activeSseCount = 0;

const SSE_STREAM_ID_HEADER = 'X-Qwen-SSE-Stream-Id';
// Keep in sync with the REST transport's response-header validator.
const SSE_STREAM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SSE_CONNECT_REASONS = [
  'initial',
  'resume',
  'prompt_restart',
  'stream_end',
  'transport_error',
  'state_resync',
  'unknown',
] as const;
const SSE_CONNECT_REASON_SET: ReadonlySet<string> = new Set(
  SSE_CONNECT_REASONS,
);

type SseConnectReason = (typeof SSE_CONNECT_REASONS)[number];

type SseCloseReason =
  | 'writer_idle_timeout'
  | 'socket_error'
  | 'iterator_error'
  | 'event_bus_evicted'
  | 'session_terminal'
  | 'source_complete'
  | 'client_disconnect';

function parseSseConnectReason(raw: unknown): SseConnectReason {
  return typeof raw === 'string' && SSE_CONNECT_REASON_SET.has(raw)
    ? (raw as SseConnectReason)
    : 'unknown';
}

function parsePreviousSseStreamId(raw: unknown): string | undefined {
  return typeof raw === 'string' && SSE_STREAM_ID_RE.test(raw)
    ? raw.toLowerCase()
    : undefined;
}

function parseSseClientId(raw: unknown): string | undefined {
  // Observability hints are best-effort and must not reject an SSE handshake.
  return typeof raw === 'string' &&
    raw.length > 0 &&
    raw.length <= MAX_CLIENT_ID_LENGTH &&
    CLIENT_ID_RE.test(raw)
    ? raw
    : undefined;
}

function boundedDiagnosticString(value: string): string {
  return Array.from(value.slice(0, 256))
    .slice(0, 128)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029 ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
        ? ' '
        : character;
    })
    .join('');
}

export function getActiveSseCount(): number {
  return activeSseCount;
}

interface RegisterSseEventsRoutesDeps {
  bridge: AcpSessionBridge;
  workspaceRegistry: WorkspaceRegistry;
  daemonLog?: DaemonLogger;
  writerIdleTimeoutMs?: number;
  sendBridgeError: SendBridgeError;
  virtualSubagentSessions?: VirtualSubagentSessions;
}

type OmitId<T> = Omit<T, 'id'>;

function formatSseFrame(event: BridgeEvent | OmitId<BridgeEvent>): string {
  const shaped = omitSkillDetailsForSdkSurface(event);
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
  const existingMeta = (shaped as { _meta?: Record<string, unknown> })._meta;
  const existingServerTimestamp = existingMeta?.['serverTimestamp'];
  const serverTimestamp =
    typeof existingServerTimestamp === 'number' &&
    Number.isFinite(existingServerTimestamp)
      ? existingServerTimestamp
      : Date.now();
  const stamped = {
    ...shaped,
    _meta: { ...(existingMeta ?? {}), serverTimestamp },
  };
  const dataJson = JSON.stringify(stamped);
  const idLine =
    'id' in shaped && shaped.id !== undefined ? `id: ${shaped.id}\n` : '';
  return `${idLine}event: ${shaped.type}\ndata: ${dataJson}\n\n`;
}

export function registerSseEventsRoutes(
  app: Application,
  deps: RegisterSseEventsRoutesDeps,
): void {
  const { workspaceRegistry, daemonLog, sendBridgeError, writerIdleTimeoutMs } =
    deps;

  app.get('/session/:id/events', async (req, res) => {
    const sessionId = req.params['id'];
    const diagnosticSessionId = boundedDiagnosticString(sessionId);
    const streamId = randomUUID();
    const clientId = parseSseClientId(req.headers['x-qwen-client-id']);
    const connectReason = parseSseConnectReason(req.query['connectReason']);
    const previousStreamId = parsePreviousSseStreamId(
      req.query['previousStreamId'],
    );
    const telemetryContext = captureDaemonTelemetryContext();
    const telemetryBaseAttributes: Record<string, string | number | boolean> = {
      'session.id': sessionId,
      'qwen-code.daemon.sse.stream_id': streamId,
      'qwen-code.daemon.sse.client_reported_connect_reason': connectReason,
      ...(clientId ? { 'qwen-code.client_id': clientId } : {}),
      ...(previousStreamId
        ? {
            'qwen-code.daemon.sse.client_reported_previous_stream_id':
              previousStreamId,
          }
        : {}),
    };
    const emitLifecycleLog = (
      eventName: string,
      body: string,
      attributes: Record<string, string | number | boolean> = {},
    ) => {
      void runWithDaemonTelemetryContext(telemetryContext, async () => {
        emitDaemonLog(
          body,
          { ...telemetryBaseAttributes, ...attributes },
          { eventName },
        );
      }).catch(() => {});
    };
    let slowWarningCount = 0;
    let eventBusEvictionReason: string | undefined;
    const onSubscriberDiagnostic = (
      diagnostic: EventBusSubscriberDiagnostic,
    ): boolean => {
      const triggerEventType = boundedDiagnosticString(
        diagnostic.data.triggerEventType,
      );
      const common = {
        queueSize: diagnostic.data.queueSize,
        maxQueued: diagnostic.data.maxQueued,
        queuedBytes: diagnostic.data.queuedBytes,
        maxQueuedBytes: diagnostic.data.maxQueuedBytes,
        triggerEventType,
        triggerEventBytes: diagnostic.data.triggerEventBytes,
      };
      const telemetryCommon = {
        'qwen-code.daemon.sse.queue_size': common.queueSize,
        'qwen-code.daemon.sse.max_queued': common.maxQueued,
        'qwen-code.daemon.sse.queued_bytes': common.queuedBytes,
        'qwen-code.daemon.sse.max_queued_bytes': common.maxQueuedBytes,
        'qwen-code.daemon.sse.trigger_event_type': common.triggerEventType,
        'qwen-code.daemon.sse.trigger_event_bytes': common.triggerEventBytes,
      };
      let handled = false;
      if (diagnostic.type === 'slow_client_warning') {
        slowWarningCount += 1;
        const context = {
          sessionId: diagnosticSessionId,
          clientId,
          streamId,
          connectReason,
          previousStreamId,
          ...common,
          threshold: diagnostic.data.threshold,
          lastEventId: diagnostic.data.lastEventId,
        };
        try {
          if (daemonLog) {
            daemonLog.warn('SSE slow client warning', context);
          } else {
            writeStderrLine(
              `qwen serve: SSE slow client warning ${JSON.stringify(context)}`,
            );
          }
          handled = true;
        } catch {
          handled = false;
        }
        emitLifecycleLog(
          'qwen-code.daemon.sse.slow_client_warning',
          'Daemon SSE slow client warning.',
          {
            ...telemetryCommon,
            'qwen-code.daemon.sse.threshold': diagnostic.data.threshold,
            'qwen-code.daemon.sse.last_event_id': diagnostic.data.lastEventId,
          },
        );
      } else {
        eventBusEvictionReason = boundedDiagnosticString(
          diagnostic.data.reason,
        );
        const threshold =
          diagnostic.data.reason === 'queue_bytes_overflow'
            ? 'bytes'
            : 'frames';
        const context = {
          sessionId: diagnosticSessionId,
          clientId,
          streamId,
          connectReason,
          previousStreamId,
          ...common,
          threshold,
          reason: eventBusEvictionReason,
          droppedAfter: diagnostic.data.droppedAfter,
          ...(diagnostic.data.eventBytes !== undefined
            ? { eventBytes: diagnostic.data.eventBytes }
            : {}),
        };
        try {
          if (daemonLog) {
            daemonLog.warn('SSE client evicted', context);
          } else {
            writeStderrLine(
              `qwen serve: SSE client evicted ${JSON.stringify(context)}`,
            );
          }
          handled = true;
        } catch {
          handled = false;
        }
        emitLifecycleLog(
          'qwen-code.daemon.sse.client_evicted',
          'Daemon SSE client evicted.',
          {
            ...telemetryCommon,
            'qwen-code.daemon.sse.threshold': threshold,
            'qwen-code.daemon.sse.event_bus_eviction_reason':
              eventBusEvictionReason,
            'qwen-code.daemon.sse.dropped_after_event_id':
              diagnostic.data.droppedAfter,
            ...(diagnostic.data.eventBytes !== undefined
              ? {
                  'qwen-code.daemon.sse.rejected_event_bytes':
                    diagnostic.data.eventBytes,
                }
              : {}),
          },
        );
      }
      return handled;
    };
    const lastEventId = parseLastEventId(req.headers['last-event-id']);
    // Epoch token accompanying the resume cursor (DAEMON-001). Invalid
    // values degrade to "not provided" so the bus falls back to the
    // numeric stale-cursor heuristic.
    const eventEpoch = parseEventEpochHeader(req.headers['x-qwen-event-epoch']);
    const maxQueued = parseMaxQueuedQuery(req.query['maxQueued'], res);
    // `parseMaxQueuedQuery` sends its own 400 + JSON body on rejection
    // (returns `null`) so the SSE handshake doesn't get half-written.
    // `undefined` means "client didn't ask for an override; use bus
    // default 256" — proceed as before.
    if (maxQueued === null) return;

    let iter: AsyncIterator<BridgeEvent> | undefined;
    let busEpoch: string | undefined;
    const abort = new AbortController();
    try {
      const virtualKey = parseVirtualSubagentSessionId(sessionId);
      const runtime = requireSessionRuntime({
        sessionId: virtualKey?.parentSessionId ?? sessionId,
        route: 'GET /session/:id/events',
        res,
        workspaceRegistry,
        daemonLog,
      });
      if (!runtime) return;
      const snapshot = req.query['snapshot'] === '1';
      const iterable = virtualKey
        ? await deps.virtualSubagentSessions?.subscribe(runtime, sessionId, {
            signal: abort.signal,
            lastEventId,
            ...(maxQueued !== undefined ? { maxQueued } : {}),
            onSubscriberDiagnostic,
          })
        : runtime.bridge.subscribeEvents(sessionId, {
            signal: abort.signal,
            lastEventId,
            ...(eventEpoch !== undefined ? { epoch: eventEpoch } : {}),
            ...(maxQueued !== undefined ? { maxQueued } : {}),
            ...(snapshot ? { snapshot: true } : {}),
            onSubscriberDiagnostic,
          });
      if (!iterable) {
        res.status(404).json({
          error: 'Subagent session not found',
          code: 'session_not_found',
          sessionId,
        });
        return;
      }
      iter = iterable[Symbol.asyncIterator]();
      // Captured while the session entry is known to exist so the header
      // block below can advertise the current epoch without a throwing
      // lookup after the stream is already committed. Virtual subagent
      // sessions ride their own bus with no epoch/resume mechanism (same
      // rationale the WS transport documents for ignoring the epoch), and
      // their compound ids are not in the bridge's byId map — a direct
      // lookup would throw and abort the subscription. A real session torn
      // down between subscribeEvents and this lookup degrades to a
      // headerless stream rather than an error (mirrors the /acp route).
      if (!virtualKey) {
        try {
          busEpoch = runtime.bridge.getSessionEventEpoch(sessionId);
        } catch {
          busEpoch = undefined;
        }
      }
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
          `qwen serve: subscriber limit reached for session ${diagnosticSessionId} (limit=${err.limit}); rejecting new SSE client with 429`,
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

    const openedAt = performance.now();
    let closeReason: SseCloseReason | undefined;
    let terminalCandidate: SseCloseReason | undefined;
    let terminalEventType: string | undefined;
    let eventFramesWriteSettled = 0;
    let lastEventIdWritten: number | undefined;
    let backpressureCount = 0;
    let maxDrainWaitMs = 0;
    let activeDrainStartedAt: number | undefined;
    let maxLivePublishToWriteSettledMs = 0;
    let liveTimingEnabled = lastEventId === undefined;
    let finalized = false;
    let sseCounted = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      if (activeDrainStartedAt !== undefined) {
        maxDrainWaitMs = Math.max(
          maxDrainWaitMs,
          performance.now() - activeDrainStartedAt,
        );
      }
      const durationMs = Math.max(0, performance.now() - openedAt);
      const resolvedCloseReason =
        closeReason ?? terminalCandidate ?? 'client_disconnect';
      const closeAttributes: Record<string, string | number | boolean> = {
        'qwen-code.daemon.sse.duration_ms': durationMs,
        'qwen-code.daemon.sse.event_frames_write_settled':
          eventFramesWriteSettled,
        'qwen-code.daemon.sse.backpressure_count': backpressureCount,
        'qwen-code.daemon.sse.max_drain_wait_ms': maxDrainWaitMs,
        'qwen-code.daemon.sse.max_live_publish_to_write_settled_ms':
          maxLivePublishToWriteSettledMs,
        'qwen-code.daemon.sse.slow_warning_count': slowWarningCount,
        'qwen-code.daemon.sse.close_reason': resolvedCloseReason,
        ...(lastEventIdWritten !== undefined
          ? {
              'qwen-code.daemon.sse.last_event_id_written': lastEventIdWritten,
            }
          : {}),
        ...(eventBusEvictionReason
          ? {
              'qwen-code.daemon.sse.event_bus_eviction_reason':
                eventBusEvictionReason,
            }
          : {}),
        ...(terminalEventType
          ? {
              'qwen-code.daemon.sse.terminal_event_type': terminalEventType,
            }
          : {}),
      };
      void runWithDaemonTelemetryContext(telemetryContext, async () => {
        for (const [key, value] of Object.entries(closeAttributes)) {
          addDaemonRequestAttribute(key, value);
        }
        emitDaemonLog(
          'Daemon SSE stream closed.',
          { ...telemetryBaseAttributes, ...closeAttributes },
          { eventName: 'qwen-code.daemon.sse.closed' },
        );
      }).catch(() => {});
      try {
        daemonLog?.info('SSE stream closed', {
          sessionId: diagnosticSessionId,
          clientId,
          streamId,
          connectReason,
          previousStreamId,
          closeReason: resolvedCloseReason,
          durationMs,
          eventFramesWriteSettled,
          lastEventIdWritten,
          backpressureCount,
          maxDrainWaitMs,
          maxLivePublishToWriteSettledMs,
          slowWarningCount,
          eventBusEvictionReason,
          terminalEventType,
        });
      } catch {
        // Diagnostics must not interfere with stream cleanup.
      }
      if (sseCounted) {
        sseCounted = false;
        activeSseCount--;
      }
    };

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable proxy buffering (nginx); event-stream content type alone
    // doesn't always reach the client through every proxy.
    res.setHeader('X-Accel-Buffering', 'no');
    // Advertise the bus epoch on EVERY subscription (including the first,
    // cursor-less one) so clients can pair it with their resume cursor and
    // detect a daemon restart on reconnect (DAEMON-001).
    if (busEpoch !== undefined) {
      res.setHeader('X-Qwen-Event-Epoch', busEpoch);
    }
    res.setHeader(SSE_STREAM_ID_HEADER, streamId);
    res.prependOnceListener('finish', finalize);
    res.prependOnceListener('close', finalize);
    activeSseCount++;
    sseCounted = true;
    for (const [key, value] of Object.entries(telemetryBaseAttributes)) {
      addDaemonRequestAttribute(key, value);
    }
    try {
      daemonLog?.info('SSE stream opened', {
        sessionId: diagnosticSessionId,
        clientId,
        streamId,
        connectReason,
        previousStreamId,
        lastEventId,
      });
    } catch {
      // Diagnostics must not interfere with the stream handshake.
    }
    emitLifecycleLog(
      'qwen-code.daemon.sse.opened',
      'Daemon SSE stream opened.',
      {
        ...(lastEventId !== undefined
          ? { 'qwen-code.daemon.sse.resume_from_event_id': lastEventId }
          : {}),
      },
    );
    // Always present on the supported Node versions (engines.node >=22).
    try {
      res.flushHeaders();
    } catch {
      closeReason = 'socket_error';
      abort.abort();
      finalize();
      try {
        if (!res.writableEnded) res.end();
      } catch {
        // The handshake socket is already unusable.
      }
      return;
    }

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
    type WriteOutcome = 'settled' | 'closed';
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
    const settleDrainMeasurement = () => {
      if (activeDrainStartedAt === undefined) return;
      maxDrainWaitMs = Math.max(
        maxDrainWaitMs,
        performance.now() - activeDrainStartedAt,
      );
      activeDrainStartedAt = undefined;
    };
    const doWrite = (chunk: string): Promise<WriteOutcome> =>
      new Promise((resolve, reject) => {
        if (res.writableEnded) {
          resolve('closed');
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
          if (!closeReason) closeReason = 'socket_error';
          reject(err);
          return;
        }
        if (ok) {
          if (trackWriterIdle) lastWriteAt = Date.now();
          resolve('settled');
          return;
        }
        backpressureCount += 1;
        activeDrainStartedAt = performance.now();
        const onDrain = () => {
          res.off('close', onClose);
          res.off('error', onError);
          settleDrainMeasurement();
          if (trackWriterIdle) lastWriteAt = Date.now();
          resolve('settled');
        };
        const onClose = () => {
          res.off('drain', onDrain);
          res.off('error', onError);
          settleDrainMeasurement();
          resolve('closed');
        };
        const onError = (err: Error) => {
          res.off('drain', onDrain);
          res.off('close', onClose);
          settleDrainMeasurement();
          reject(err);
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
        res.once('error', onError);
      });
    const writeWithBackpressure = (chunk: string): Promise<WriteOutcome> => {
      const next = writeChain.then(() => doWrite(chunk));
      // Tail-swallow rejections on the chain itself so a single failed
      // write doesn't poison every subsequent call. The CALLER's
      // returned promise still rejects — chain-internal failures are
      // someone else's problem, not blockers for queueing.
      writeChain = next.then(
        () => undefined,
        () => undefined,
      );
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
        closeReason = 'writer_idle_timeout';
        terminalEventType = 'client_evicted';
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
          const settled = res.write(
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
          if (settled) eventFramesWriteSettled += 1;
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
        const idleContext = {
          sessionId: diagnosticSessionId,
          clientId,
          streamId,
          connectReason,
          previousStreamId,
          idleForMs,
          timeoutMs: writerIdleTimeoutMsValue,
        };
        try {
          if (daemonLog) {
            daemonLog.warn('SSE writer idle timeout', idleContext);
          } else {
            writeStderrLine(
              `qwen serve: evicting SSE client (session ${diagnosticSessionId}) — ` +
                `writer idle for ${idleForMs}ms > ${writerIdleTimeoutMsValue}ms timeout ` +
                `(streamId=${streamId}${clientId ? `, clientId=${clientId}` : ''})`,
            );
          }
        } catch {
          /* stderr pipe closed; eviction is still happening. */
        }
        emitLifecycleLog(
          'qwen-code.daemon.sse.client_evicted',
          'Daemon SSE client evicted by writer idle timeout.',
          {
            'qwen-code.daemon.sse.writer_idle_for_ms': idleForMs,
            'qwen-code.daemon.sse.writer_idle_timeout_ms':
              writerIdleTimeoutMsValue,
            'qwen-code.daemon.sse.eviction_reason': 'writer_idle_timeout',
          },
        );
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
      if (!closeReason) closeReason = 'socket_error';
      // Without this log the daemon side is blind to SSE disconnects
      // (RST, mid-flight kill -9, network blip). Cleanup still runs —
      // the listener exists primarily so Node doesn't crash on EPIPE
      // — but operators get a breadcrumb when chasing flaky clients.
      try {
        if (daemonLog) {
          daemonLog.error('SSE socket error', err, {
            sessionId: diagnosticSessionId,
            clientId,
            streamId,
            connectReason,
            previousStreamId,
          });
        } else {
          writeStderrLine(
            `qwen serve: SSE socket error (session ${diagnosticSessionId}): ${err.message} ` +
              `(streamId=${streamId}${clientId ? `, clientId=${clientId}` : ''})`,
          );
        }
      } catch {
        // Socket cleanup must proceed even when diagnostics fail.
      }
      cleanup();
    });

    void (async () => {
      try {
        while (true) {
          const next = await iter!.next();
          if (next.done) {
            if (!closeReason) {
              closeReason = terminalCandidate ?? 'source_complete';
            }
            break;
          }
          if (res.writableEnded) break;
          if (next.value.type === 'client_evicted') {
            terminalCandidate = 'event_bus_evicted';
            terminalEventType = next.value.type;
            const reason = (next.value.data as { reason?: unknown } | null)
              ?.reason;
            if (typeof reason === 'string') {
              eventBusEvictionReason = boundedDiagnosticString(reason);
            }
          } else if (
            next.value.type === 'session_died' ||
            next.value.type === 'session_closed'
          ) {
            terminalCandidate = 'session_terminal';
            terminalEventType = next.value.type;
          }
          // Log ring eviction events for operator observability.
          if (next.value.type === 'state_resync_required') {
            const data = next.value.data as {
              lastDeliveredId?: number;
              earliestAvailableId?: number;
              reason?: string;
              detail?: string;
            };
            const gap =
              typeof data.earliestAvailableId === 'number' &&
              typeof data.lastDeliveredId === 'number'
                ? data.earliestAvailableId - data.lastDeliveredId - 1
                : undefined;
            const reason =
              typeof data.reason === 'string'
                ? boundedDiagnosticString(data.reason)
                : 'unknown';
            const detail =
              typeof data.detail === 'string'
                ? boundedDiagnosticString(data.detail)
                : undefined;
            const context = {
              sessionId: diagnosticSessionId,
              clientId,
              streamId,
              connectReason,
              previousStreamId,
              lastEventId: data.lastDeliveredId,
              earliestInRing: data.earliestAvailableId,
              gap,
              reason,
              detail,
            };
            try {
              if (daemonLog) {
                daemonLog.warn(
                  'SSE ring eviction detected; consumer must call loadSession to recover',
                  context,
                );
              } else {
                writeStderrLine(
                  `qwen serve: SSE ring eviction detected (session ${diagnosticSessionId}): ` +
                    `lastEventId=${data.lastDeliveredId ?? '?'}, ` +
                    `earliestInRing=${data.earliestAvailableId ?? '?'}, ` +
                    `gap=${gap ?? '?'} events, ` +
                    `reason=${typeof data.reason === 'string' ? reason : '?'}` +
                    (detail ? `, detail=${detail}` : '') +
                    `, streamId=${streamId}` +
                    (clientId ? `, clientId=${clientId}` : '') +
                    `. Consumer must call loadSession to recover.`,
                );
              }
            } catch {
              // The recovery frame must still reach the client.
            }
            emitLifecycleLog(
              'qwen-code.daemon.sse.state_resync_required',
              'Daemon SSE state resync required.',
              {
                'qwen-code.daemon.sse.resync_reason': reason,
                ...(detail
                  ? { 'qwen-code.daemon.sse.resync_detail': detail }
                  : {}),
                ...(typeof data.lastDeliveredId === 'number'
                  ? {
                      'qwen-code.daemon.sse.resync_last_delivered_id':
                        data.lastDeliveredId,
                    }
                  : {}),
                ...(typeof data.earliestAvailableId === 'number'
                  ? {
                      'qwen-code.daemon.sse.resync_earliest_available_id':
                        data.earliestAvailableId,
                    }
                  : {}),
                ...(gap !== undefined
                  ? { 'qwen-code.daemon.sse.resync_gap_events': gap }
                  : {}),
              },
            );
          }
          const liveEvent = liveTimingEnabled;
          const serverTimestamp = next.value._meta?.['serverTimestamp'];
          const outcome = await writeWithBackpressure(
            formatSseFrame(next.value),
          );
          if (outcome === 'closed') break;
          eventFramesWriteSettled += 1;
          if (typeof next.value.id === 'number') {
            lastEventIdWritten = next.value.id;
          }
          if (
            liveEvent &&
            typeof serverTimestamp === 'number' &&
            Number.isFinite(serverTimestamp)
          ) {
            maxLivePublishToWriteSettledMs = Math.max(
              maxLivePublishToWriteSettledMs,
              Math.max(0, Date.now() - serverTimestamp),
            );
          }
          if (next.value.type === 'replay_complete') {
            liveTimingEnabled = true;
          }
        }
      } catch (err) {
        if (!closeReason) {
          closeReason = 'iterator_error';
        }
        if (!res.writableEnded && closeReason !== 'socket_error') {
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
            `qwen serve: bridge iterator error (session ${diagnosticSessionId}): ` +
              `${errorMessage(err)}` +
              (errorKind ? ` [${errorKind}]` : ''),
          );
          const outcome = await writeWithBackpressure(
            formatSseFrame({
              v: 1,
              type: 'stream_error',
              data: {
                error: errorMessage(err),
                ...(errorKind ? { errorKind } : {}),
              },
            }),
          ).catch(() => 'closed' as const);
          if (outcome === 'settled') eventFramesWriteSettled += 1;
        }
      } finally {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    })();
  });
}
