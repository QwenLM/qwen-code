/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  context as otelContext,
  createContextKey,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

vi.mock('./sdk.js', () => ({
  isTelemetrySdkInitialized: () => true,
}));
import {
  DAEMON_TRACEPARENT_META_KEY,
  DAEMON_TRACESTATE_META_KEY,
  addDaemonRequestAttribute,
  captureDaemonTelemetryContext,
  createDaemonBridgeTelemetry,
  extractDaemonHttpTraceContext,
  extractDaemonTraceContext,
  extractInboundTraceId,
  hashDaemonWorkspace,
  injectDaemonTraceContext,
  runWithDaemonTelemetryContext,
  setDaemonFallbackPropagator,
  withDaemonSpan,
  withDaemonRequestSpan,
  type DaemonRequestSpanOptions,
} from './daemon-tracing.js';
import { getSessionIdFromContext } from './session-context.js';

// Mirror the post-init state: `sdk-impl.ts` injects the W3C fallback
// propagator once the lazy SDK chunk assembles successfully (this suite
// mocks `isTelemetrySdkInitialized` as true above, so the holder must be
// populated the same way the real SDK would).
setDaemonFallbackPropagator(new W3CTraceContextPropagator());

// vitest transpiles without type-checking: this compile-time assertion keeps
// the optional parentContext field from silently disappearing (only `tsc`
// would notice), while the runtime suite guards the behavior it enables.
type DaemonRequestSpanOptionsExposesParentContext =
  DaemonRequestSpanOptions extends { parentContext?: Context } ? true : false;
const daemonRequestSpanOptionsExposesParentContext: DaemonRequestSpanOptionsExposesParentContext = true;

describe('daemon-tracing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('injects traceparent from the active span without the global propagator', () => {
    const traceId = '1234567890abcdef1234567890abcdef';
    const spanId = 'abcdef1234567890';
    const activeSpan = {
      spanContext: () => ({
        traceId,
        spanId,
        traceFlags: 1,
      }),
    } as Span;
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(activeSpan);
    const injectSpy = vi.spyOn(propagation, 'inject');

    const injected = injectDaemonTraceContext({
      prompt: [],
      _meta: {
        keep: true,
        [DAEMON_TRACEPARENT_META_KEY]: 'client-spoof',
        [DAEMON_TRACESTATE_META_KEY]: 'client-state',
      },
    });

    expect(injectSpy).not.toHaveBeenCalled();
    expect((injected._meta as Record<string, unknown>)['keep']).toBe(true);
    expect(
      (injected._meta as Record<string, unknown>)[DAEMON_TRACEPARENT_META_KEY],
    ).toBe(`00-${traceId}-${spanId}-01`);
    expect(
      (injected._meta as Record<string, unknown>)[DAEMON_TRACESTATE_META_KEY],
    ).toBeUndefined();
  });

  it('injects the active bridge span context through the bridge telemetry seam', async () => {
    const traceId = 'fedcba0987654321fedcba0987654321';
    const daemonSpan = {
      spanContext: () => ({
        traceId,
        spanId: '1111111111111111',
        traceFlags: 1,
      }),
    } as Span;
    const bridgeSpan = {
      spanContext: () => ({
        traceId,
        spanId: '2222222222222222',
        traceFlags: 1,
      }),
      setStatus: vi.fn(),
      end: vi.fn(),
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      recordException: vi.fn(),
    } as unknown as Span;
    let activeSpan: Span | undefined = daemonSpan;
    vi.spyOn(trace, 'getActiveSpan').mockImplementation(() => activeSpan);
    const startActiveSpan = vi.fn(
      async (
        _name: string,
        _opts: unknown,
        fn: (span: Span) => Promise<unknown>,
      ) => {
        activeSpan = bridgeSpan;
        try {
          return await fn(bridgeSpan);
        } finally {
          activeSpan = daemonSpan;
        }
      },
    );
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan,
    } as unknown as Tracer);

    const telemetry = createDaemonBridgeTelemetry();
    const captured = telemetry.captureContext();
    let injected: { _meta?: Record<string, unknown> } | undefined;
    await telemetry.runWithContext(captured, async () => {
      await telemetry.withSpan(
        'prompt.dispatch',
        { 'session.id': 'session-A' },
        async () => {
          injected = telemetry.injectPromptContext({
            prompt: [],
            _meta: {},
          });
        },
      );
    });

    const extracted = extractDaemonTraceContext(injected);
    expect(trace.getSpanContext(extracted!)?.traceId).toBe(traceId);
    expect(trace.getSpanContext(extracted!)?.spanId).toBe('2222222222222222');
    expect(startActiveSpan).toHaveBeenCalledWith(
      'qwen-code.daemon.bridge',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'qwen-code.daemon.operation': 'prompt.dispatch',
          'session.id': 'session-A',
        }),
      }),
      expect.any(Function),
    );
  });

  it('extracts daemon trace context from reserved prompt metadata keys', () => {
    const traceId = '1'.repeat(32);
    const spanId = '2'.repeat(16);
    const extracted = extractDaemonTraceContext({
      _meta: {
        [DAEMON_TRACEPARENT_META_KEY]: `00-${traceId}-${spanId}-01`,
        [DAEMON_TRACESTATE_META_KEY]: 'vendor=value',
      },
    });

    expect(extracted).toBeDefined();
    expect(trace.getSpanContext(extracted!)?.traceId).toBe(traceId);
    expect(trace.getSpanContext(extracted!)?.spanId).toBe(spanId);
    expect(trace.getSpanContext(extracted!)?.traceState?.get('vendor')).toBe(
      'value',
    );
  });

  it('extracts trace context from inbound HTTP traceparent headers', () => {
    const traceId = '3'.repeat(32);
    const spanId = '4'.repeat(16);
    const extracted = extractDaemonHttpTraceContext({
      traceparent: `00-${traceId}-${spanId}-01`,
    });

    expect(extracted).toBeDefined();
    expect(trace.getSpanContext(extracted!)?.traceId).toBe(traceId);
    expect(trace.getSpanContext(extracted!)?.spanId).toBe(spanId);
    expect(trace.getSpanContext(extracted!)?.isRemote).toBe(true);
  });

  it('rejects invalid inbound HTTP traceparent headers', () => {
    expect(extractDaemonHttpTraceContext(undefined)).toBeUndefined();
    expect(extractDaemonHttpTraceContext({})).toBeUndefined();
    expect(
      extractDaemonHttpTraceContext({ traceparent: 'not-a-traceparent' }),
    ).toBeUndefined();
    expect(
      extractDaemonHttpTraceContext({
        traceparent: `00-${'0'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
    ).toBeUndefined();
    expect(
      extractDaemonHttpTraceContext({
        traceparent: [`00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`],
      }),
    ).toBeUndefined();
  });

  it('rejects traceparent headers the W3C propagator rejects', () => {
    // version ff is reserved for future use and always invalid
    expect(
      extractDaemonHttpTraceContext({
        traceparent: `ff-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
    ).toBeUndefined();
    // version 00 must not carry the optional future-extension field
    expect(
      extractDaemonHttpTraceContext({
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01-extra`,
      }),
    ).toBeUndefined();
  });

  it('extracts only the trace id for the telemetry-off log join', () => {
    expect(
      extractInboundTraceId({
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
    ).toBe('3'.repeat(32));
    expect(
      extractInboundTraceId({
        traceparent: `01-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
    ).toBe('3'.repeat(32));
    // Acceptance mirrors the vendored W3C propagator: a single optional
    // whitespace on either edge, and trailing extension fields above
    // version 00 — so a header joins on both paths or neither.
    expect(
      extractInboundTraceId({
        traceparent: ` 00-${'3'.repeat(32)}-${'4'.repeat(16)}-01 `,
      }),
    ).toBe('3'.repeat(32));
    expect(
      extractInboundTraceId({
        traceparent: `01-${'3'.repeat(32)}-${'4'.repeat(16)}-01-future-field`,
      }),
    ).toBe('3'.repeat(32));
  });

  it('rejects invalid headers on the telemetry-off trace id path', () => {
    expect(extractInboundTraceId(undefined)).toBeUndefined();
    expect(extractInboundTraceId({})).toBeUndefined();
    expect(
      extractInboundTraceId({ traceparent: 'not-a-traceparent' }),
    ).toBeUndefined();
    expect(
      extractInboundTraceId({
        traceparent: `00-${'0'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
    ).toBeUndefined();
    expect(
      extractInboundTraceId({
        traceparent: `00-${'3'.repeat(32)}-${'0'.repeat(16)}-01`,
      }),
    ).toBeUndefined();
    expect(
      extractInboundTraceId({
        traceparent: `ff-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
    ).toBeUndefined();
    // version 00 must not carry extension fields — same as the propagator
    expect(
      extractInboundTraceId({
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01-extra`,
      }),
    ).toBeUndefined();
    expect(
      extractInboundTraceId({
        traceparent: [`00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`],
      }),
    ).toBeUndefined();
  });

  it('yields no parent context until the SDK chunk injects the fallback propagator', async () => {
    // Fresh module registry: daemon-tracing without the sdk-impl injection.
    // The global propagator stays a no-op in tests (nothing registers one),
    // so a valid traceparent resolves to nothing while the fallback holder
    // is empty — the telemetry-off / SDK-chunk-not-loaded state.
    vi.resetModules();
    const fresh = await import('./daemon-tracing.js');

    expect(
      fresh.extractDaemonHttpTraceContext({
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
    ).toBeUndefined();
    // The telemetry-off trace id path needs no propagator — that is the
    // whole point of the plain regex parse.
    expect(
      fresh.extractInboundTraceId({
        traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      }),
    ).toBe('3'.repeat(32));
    expect(
      fresh.extractDaemonTraceContext({
        _meta: {
          [DAEMON_TRACEPARENT_META_KEY]: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
        },
      }),
    ).toBeUndefined();
  });

  it('accepts future traceparent versions like the registered W3C propagator', () => {
    const traceId = '3'.repeat(32);
    const spanId = '4'.repeat(16);
    const extracted = extractDaemonHttpTraceContext({
      traceparent: `01-${traceId}-${spanId}-01`,
    });

    expect(trace.getSpanContext(extracted!)?.traceId).toBe(traceId);
    expect(trace.getSpanContext(extracted!)?.spanId).toBe(spanId);
    expect(trace.getSpanContext(extracted!)?.isRemote).toBe(true);
  });

  it('preserves inbound tracestate on the extracted HTTP context', () => {
    const extracted = extractDaemonHttpTraceContext({
      traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
      tracestate: 'vendor=value',
    });

    expect(trace.getSpanContext(extracted!)?.traceState?.get('vendor')).toBe(
      'value',
    );
  });

  it('forces the sampled flag on inbound HTTP parents under the default sampler', () => {
    vi.stubEnv('OTEL_TRACES_SAMPLER', '');
    const forced = extractDaemonHttpTraceContext({
      traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-00`,
    });
    const forcedContext = trace.getSpanContext(forced!);
    expect(forcedContext).toBeDefined();
    expect((forcedContext?.traceFlags ?? 0) & TraceFlags.SAMPLED).toBe(
      TraceFlags.SAMPLED,
    );
    expect(forcedContext?.isRemote).toBe(true);
    // already-sampled parents keep their flags
    const sampled = extractDaemonHttpTraceContext({
      traceparent: `00-${'5'.repeat(32)}-${'6'.repeat(16)}-01`,
    });
    const sampledFlags = trace.getSpanContext(sampled!)?.traceFlags ?? 0;
    expect(sampledFlags & TraceFlags.SAMPLED).toBe(TraceFlags.SAMPLED);
  });

  it('keeps the caller flags when the sampler config opts out of forcing', () => {
    vi.stubEnv('OTEL_TRACES_SAMPLER', 'parentbased_always_off');
    const alwaysOff = extractDaemonHttpTraceContext({
      traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-00`,
    });
    expect(trace.getSpanContext(alwaysOff!)?.traceFlags).toBe(0);

    vi.stubEnv('OTEL_TRACES_SAMPLER', 'traceidratio');
    const ratio = extractDaemonHttpTraceContext({
      traceparent: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-00`,
    });
    expect(trace.getSpanContext(ratio!)?.traceFlags).toBe(0);
  });

  it('forces the sampled flag on _meta parents under the default sampler', () => {
    vi.stubEnv('OTEL_TRACES_SAMPLER', '');
    const extracted = extractDaemonTraceContext({
      _meta: {
        [DAEMON_TRACEPARENT_META_KEY]: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00`,
      },
    });
    expect(
      (trace.getSpanContext(extracted!)?.traceFlags ?? 0) & TraceFlags.SAMPLED,
    ).toBe(TraceFlags.SAMPLED);
  });

  it('keeps the caller flags on the _meta path when the sampler opts out', () => {
    vi.stubEnv('OTEL_TRACES_SAMPLER', 'parentbased_always_off');
    const extracted = extractDaemonTraceContext({
      _meta: {
        [DAEMON_TRACEPARENT_META_KEY]: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00`,
      },
    });
    expect(trace.getSpanContext(extracted!)?.traceFlags).toBe(0);
  });

  it('keeps parentContext on DaemonRequestSpanOptions (type-level guard)', () => {
    expect(daemonRequestSpanOptionsExposesParentContext).toBe(true);
  });

  it('starts a daemon span under an explicit remote parent context', async () => {
    const parentContext = extractDaemonTraceContext({
      _meta: {
        [DAEMON_TRACEPARENT_META_KEY]: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
      },
    });
    const span = {
      setStatus: vi.fn(),
      end: vi.fn(),
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      recordException: vi.fn(),
    } as unknown as Span;
    const startActiveSpan = vi.fn(
      async (
        _name: string,
        _options: unknown,
        _parent: unknown,
        fn: (span: Span) => Promise<string>,
      ) => await fn(span),
    );
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan,
    } as unknown as Tracer);

    await expect(
      withDaemonSpan('child', {}, async () => 'ok', {
        parentContext: parentContext!,
      }),
    ).resolves.toBe('ok');

    expect(startActiveSpan).toHaveBeenCalledWith(
      'child',
      expect.objectContaining({ kind: expect.any(Number) }),
      parentContext!,
      expect.any(Function),
    );
    expect(span.end).toHaveBeenCalledOnce();
  });

  it('starts a daemon request span under an extracted HTTP parent context', async () => {
    const parentContext = extractDaemonHttpTraceContext({
      traceparent: `00-${'5'.repeat(32)}-${'6'.repeat(16)}-01`,
    });
    const span = {
      setStatus: vi.fn(),
      end: vi.fn(),
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      recordException: vi.fn(),
    } as unknown as Span;
    const startActiveSpan = vi.fn(
      async (
        _name: string,
        _options: unknown,
        _parent: unknown,
        fn: (span: Span) => Promise<string>,
      ) => await fn(span),
    );
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan,
    } as unknown as Tracer);

    await expect(
      withDaemonRequestSpan(
        {
          method: 'GET',
          route: 'GET /daemon/status',
          parentContext,
        },
        async () => 'ok',
      ),
    ).resolves.toBe('ok');

    expect(startActiveSpan).toHaveBeenCalledWith(
      'qwen-code.daemon.request',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'http.request.method': 'GET',
        }),
      }),
      parentContext!,
      expect.any(Function),
    );
    expect(span.end).toHaveBeenCalledOnce();
  });

  it('binds an explicit daemon session to the callback context', async () => {
    const span = {
      setStatus: vi.fn(),
      end: vi.fn(),
    } as unknown as Span;
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan: vi.fn(
        async (
          _name: string,
          _options: unknown,
          fn: (span: Span) => Promise<string>,
        ) => await fn(span),
      ),
    } as unknown as Tracer);
    let scopedSessionId: string | undefined;
    vi.spyOn(otelContext, 'with').mockImplementation(
      (ctx, fn: () => Promise<string>) => {
        scopedSessionId = getSessionIdFromContext(ctx);
        return fn();
      },
    );

    await withDaemonSpan(
      'daemon-session',
      { 'session.id': 'daemon-session-B' },
      async () => 'ok',
    );

    expect(scopedSessionId).toBe('daemon-session-B');
  });

  it('strips reserved metadata when no active daemon span exists', () => {
    const injected = injectDaemonTraceContext({
      prompt: [],
      _meta: {
        keep: true,
        [DAEMON_TRACEPARENT_META_KEY]: 'client-spoof',
      },
    });

    const meta = injected._meta as Record<string, unknown>;
    expect(meta['keep']).toBe(true);
    expect(meta[DAEMON_TRACEPARENT_META_KEY]).toBeUndefined();
    expect(meta[DAEMON_TRACESTATE_META_KEY]).toBeUndefined();
    expect(extractDaemonTraceContext(injected)).toBeUndefined();
  });

  it('hashes workspace paths without exposing the raw path', () => {
    const hash = hashDaemonWorkspace('/tmp/project');

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain('project');
  });

  it('emits bridge events as standalone spans without an active span', () => {
    const addEvent = vi.fn();
    const setStatus = vi.fn();
    const end = vi.fn();
    const startSpan = vi.fn(
      () => ({ addEvent, setStatus, end }) as unknown as Span,
    );
    vi.spyOn(trace, 'getSpan').mockReturnValue(undefined);
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan,
    } as unknown as Tracer);

    createDaemonBridgeTelemetry().event('channel.exited', {
      'qwen-code.daemon.channel.session_count': 2,
    });

    expect(startSpan).toHaveBeenCalledWith(
      'qwen-code.daemon.bridge',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'event.name': 'channel.exited',
          'qwen-code.daemon.operation': 'event.channel.exited',
          'qwen-code.daemon.channel.session_count': 2,
        }),
      }),
    );
    expect(addEvent).toHaveBeenCalledWith('channel.exited', {
      'qwen-code.daemon.channel.session_count': 2,
    });
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(end).toHaveBeenCalled();
  });

  function mockTracerStartActiveSpan() {
    const startActiveSpan = vi.fn(
      (_name: string, _opts: unknown, fn: (span: Span) => Promise<void>) =>
        fn({
          setStatus: vi.fn(),
          end: vi.fn(),
          setAttribute: vi.fn(),
          setAttributes: vi.fn(),
          recordException: vi.fn(),
        } as unknown as Span),
    );
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan,
    } as unknown as Tracer);
    return startActiveSpan;
  }

  it('includes clientId and permissionRequestId in request span attributes', async () => {
    const startActiveSpan = mockTracerStartActiveSpan();
    const startTime = new Date('2026-07-15T00:00:00.000Z');

    await withDaemonRequestSpan(
      {
        method: 'POST',
        route: 'POST /session/:id/permission/:requestId',
        startTime,
        deferredRuntimeWaitMs: 42.5,
        deferredRuntimePath: 'joined',
        workspaceHash: 'abc123',
        sessionId: 'sess-1',
        clientId: 'client-42',
        permissionRequestId: 'perm-99',
      },
      async () => {},
    );

    expect(startActiveSpan).toHaveBeenCalledWith(
      'qwen-code.daemon.request',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'http.request.method': 'POST',
          'http.route': 'POST /session/:id/permission/:requestId',
          'session.id': 'sess-1',
          'qwen-code.client_id': 'client-42',
          'qwen-code.daemon.permission.request_id': 'perm-99',
          'qwen-code.daemon.runtime.wait_ms': 42.5,
          'qwen-code.daemon.runtime.path': 'joined',
        }),
        startTime,
      }),
      expect.any(Function),
    );
  });

  it('omits clientId and permissionRequestId when not provided', async () => {
    const startActiveSpan = mockTracerStartActiveSpan();

    await withDaemonRequestSpan(
      { method: 'POST', route: 'POST /session' },
      async () => {},
    );

    const attrs = (
      startActiveSpan.mock.calls[0]![1] as {
        attributes: Record<string, unknown>;
      }
    ).attributes;
    expect(attrs).not.toHaveProperty('qwen-code.client_id');
    expect(attrs).not.toHaveProperty('qwen-code.daemon.permission.request_id');
    expect(attrs).not.toHaveProperty('qwen-code.daemon.runtime.wait_ms');
    expect(attrs).not.toHaveProperty('qwen-code.daemon.runtime.path');
  });

  it('addDaemonRequestAttribute sets attribute on the active span', () => {
    const setAttribute = vi.fn();
    vi.spyOn(trace, 'getSpan').mockReturnValue({
      setAttribute,
    } as unknown as Span);

    addDaemonRequestAttribute('qwen-code.prompt_id', 'test-prompt-id');

    expect(setAttribute).toHaveBeenCalledWith(
      'qwen-code.prompt_id',
      'test-prompt-id',
    );
  });

  it('addDaemonRequestAttribute is a no-op without an active span', () => {
    vi.spyOn(trace, 'getSpan').mockReturnValue(undefined);
    expect(() =>
      addDaemonRequestAttribute('qwen-code.prompt_id', 'orphan'),
    ).not.toThrow();
  });

  it('runs deferred telemetry under the context captured by the request', async () => {
    const requestContext = ROOT_CONTEXT.setValue(
      createContextKey('daemon-sse-request'),
      'request',
    );
    const publisherContext = ROOT_CONTEXT.setValue(
      createContextKey('daemon-publisher'),
      'publisher',
    );
    let activeContext = requestContext;
    vi.spyOn(otelContext, 'active').mockImplementation(() => activeContext);
    const withSpy = vi.spyOn(otelContext, 'with');

    const captured = captureDaemonTelemetryContext();
    activeContext = publisherContext;
    await runWithDaemonTelemetryContext(captured, async () => undefined);

    expect(withSpy).toHaveBeenCalledWith(requestContext, expect.any(Function));
  });

  it('bridge telemetry sets attributes on the active span', () => {
    const setAttributes = vi.fn();
    vi.spyOn(trace, 'getSpan').mockReturnValue({
      setAttributes,
    } as unknown as Span);

    createDaemonBridgeTelemetry().setActiveSpanAttributes?.({
      'qwen-code.daemon.acp_startup.profile.version': 1,
    });

    expect(setAttributes).toHaveBeenCalledWith({
      'qwen-code.daemon.acp_startup.profile.version': 1,
    });
  });
});
