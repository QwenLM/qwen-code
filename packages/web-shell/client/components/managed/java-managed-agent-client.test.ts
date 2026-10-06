import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isJavaAgentResyncRequired,
  JavaManagedAgentClient,
  SKIP_ON_CORRUPT,
} from './java-managed-agent-client';
import type { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { projectJavaAgentEvent } from './java-managed-agent-event-projector';
import {
  corruptFrame as corrupt,
  validEventFrame as valid,
} from './managed-agent-sse.test-fixtures';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('JavaManagedAgentClient', () => {
  it('binds the default browser fetch to the global object', async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(jsonResponse({ data: [], hasMore: false }));
    });
    vi.stubGlobal('fetch', fetchImpl);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
    });

    await client.listSessions({ limit: 20 });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('uses the private gateway with product credentials and headers', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [], hasMore: false }));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example/',
      fetch: fetchImpl,
      getHeaders: () => ({ authorization: 'Bearer short-lived' }),
    });

    await client.listSessions({ limit: 20 });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://product.example/api/agent/web-shell/v1/sessions/query',
    );
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer short-lived',
    );
    expect(JSON.parse(String(init?.body))).toEqual({ limit: 20 });
  });

  it('parses chunked CRLF SSE frames and ignores heartbeats', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      ': keepalive\r\n\r\nid: 7\r\nevent: item.output_text.delta\r\ndata: {"sequence":7,"eventId":"evt_7",',
      '"sessionId":"session-1","turnId":"turn-1","type":"item.output_text.delta","createdAt":7,"data":{"text":"hi"},"terminal":false}\r\n\r\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 6,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ sequence: 7, data: { text: 'hi' } }),
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      sessionId: 'session-1',
      afterSequence: 6,
    });
  });

  it('decodes the resync frame that ends an expired stream', async () => {
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            'event:agent.session.resync_required\ndata:{"type":"agent.session.resync_required","sessionId":"session-1","replayFloorSequence":40,"snapshotThroughSequence":42,"action":"reload_snapshot"}\n\n',
            { status: 200 },
          ),
        ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 3,
    })) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      {
        type: 'agent.session.resync_required',
        sessionId: 'session-1',
        replayFloorSequence: 40,
        snapshotThroughSequence: 42,
        action: 'reload_snapshot',
      },
    ]);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
  });

  it('skips one corrupt frame and delivers the frames behind it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // The persisted frame at sequence 2 has a truncated JSON payload.
          'id: 2\r\nevent: item.output_text.delta\r\ndata: {"sequence":2,"eventId":"evt_2"\r\n\r\n' +
            'id: 3\r\nevent: item.output_text.delta\r\ndata: {"sequence":3,"eventId":"evt_3","sessionId":"session-1","turnId":"turn-1","type":"item.output_text.delta","createdAt":3,"data":{"text":"after"},"terminal":false}\r\n\r\n',
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ sequence: 3, data: { text: 'after' } }),
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('resyncs past a run of only corrupt frames instead of aborting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // The valid frame behind the corrupt run disables the end-of-stream
        // fallback, so only the budget trip can produce the first frame.
        new Response(
          corrupt(2) + corrupt(3) + corrupt(4) + corrupt(5) + valid(6),
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 6 }));
    // Rate-limited skip warning for the first frame, plus the resync warning.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('resyncs when a connection delivers nothing but skipped corrupt frames', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // Two corrupt frames stay under the resync budget, but nothing valid
        // was delivered before the stream ended: retrying the same cursor
        // would replay them identically, so the stream ends with a resync.
        new Response(corrupt(2) + corrupt(3), { status: 200 }),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(1);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
  });

  it('resyncs when a connection delivers nothing but a single skipped frame', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // One skip is already one too many: nothing valid was delivered, so
        // retrying the same cursor replays this frame identically. The stream
        // ends normally here, so without the resync the hook reconnects every
        // 3s forever with a frozen transcript and no visible error.
        new Response(corrupt(2), { status: 200 }),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(1);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    // The skip warning plus the end-of-stream resync warning: a resync from
    // the fail-closed name check would log once instead, so this pins which
    // guard produced the frame.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('resyncs on a corrupt action update frame instead of skipping it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // A skipped action update leaves a pending approval unreachable.
          // The valid frame behind it disables the end-of-stream fallback,
          // so only the name-based resync can produce the first frame.
          'id: 2\r\nevent: action.updated\r\ndata: {"sequence":2,"eventId":"evt_2"\r\n\r\n' +
            valid(3),
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 3 }));
  });

  it.each([
    'stream.reconciled',
    'turn.accepted',
    'turn.completed',
    'turn.failed',
    'turn.cancelled',
    'item.tool_call.updated',
    'item.tool_result.updated',
  ])('resyncs on a corrupt %s frame instead of skipping it', async (name) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(corrupt(2, name) + valid(3), { status: 200 }),
        ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 3 }));
  });

  it.each([...SKIP_ON_CORRUPT])(
    'skips a corrupt %s frame and delivers what is behind it',
    async (name) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const client = new JavaManagedAgentClient({
        baseUrl: 'https://product.example',
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(corrupt(2, name) + valid(3), { status: 200 }),
          ),
      });

      const frames = [];
      for await (const frame of client.streamEvents({
        sessionId: 'session-1',
        afterSequence: 1,
      })) {
        frames.push(frame);
      }

      expect(frames).toEqual([expect.objectContaining({ sequence: 3 })]);
    },
  );

  it('resyncs on a corrupt frame with an unknown event name', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(corrupt(2, 'item.brand.new') + valid(3), {
          status: 200,
        }),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 3 }));
  });

  it('resyncs on a corrupt frame with no event name at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            'id: 2\r\ndata: {"sequence":2,"eventId":"evt_2"\r\n\r\n' + valid(3),
            { status: 200 },
          ),
        ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 3 }));
  });

  it('only allows skipping names that project to a UI event', () => {
    for (const name of SKIP_ON_CORRUPT) {
      expect(
        projectJavaAgentEvent({
          sequence: 2,
          eventId: 'evt_2',
          sessionId: 'session-1',
          turnId: 'turn-1',
          type: name,
          createdAt: 2,
          data: {},
          terminal: false,
        }),
      ).toBeDefined();
    }
  });

  it('accumulates the corrupt budget across read chunks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const encoder = new TextEncoder();
    const chunks = [
      corrupt(2) + corrupt(3),
      corrupt(4) + corrupt(5) + valid(6),
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    });
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 200 })),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    // The corrupt run straddles two reads: the fourth corrupt frame still
    // trips the budget.
    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 6 }));
  });

  it('tolerates three consecutive corrupt frames when a valid frame resets the count', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // A run of exactly three consecutive corrupt frames (4-6) stays under
        // the budget, and the valid frame at 3 resets an earlier count.
        new Response(
          corrupt(2) +
            valid(3) +
            corrupt(4) +
            corrupt(5) +
            corrupt(6) +
            valid(7),
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ sequence: 3 }),
      expect.objectContaining({ sequence: 7 }),
    ]);
    // Skip warnings are rate-limited: only the first skip logs.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rate-limits skip warnings when corruption alternates with valid frames', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let stream = '';
    for (let index = 2; index <= 41; index += 1) {
      stream += index % 2 === 0 ? corrupt(index) : valid(index);
    }
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(stream, { status: 200 })),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(20);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logs a mid-frame close distinctly and spares the budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          'id: 2\r\nevent: item.output_text.delta\r\ndata: {"sequence":2,"eventId":"evt_2","sessionId":"session-1","turnId":"turn-1","type":"item.output_text.delta","createdAt":2,"data":{},"terminal":true}\r\n\r\n' +
            // Truncated final frame without the terminating blank line.
            'id: 3\r\nevent: item.output_text.delta\r\ndata: {"sequence":3,"ev',
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([expect.objectContaining({ sequence: 2 })]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('closed mid-frame'),
    );
  });

  it('warns when the stream closes before the trailing frame even reaches its data line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          valid(2) +
            // The tear lands before the data: line: no payload at all.
            'id: 3\r\nevent: item.output_text.delta\r\n',
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([expect.objectContaining({ sequence: 2 })]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('closed mid-frame'),
    );
  });

  it('charges the budget for corrupt frames but not for a mid-frame close', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // Three corrupt frames stay under the budget; the torn tail must
          // not take the fourth slot. With nothing delivered at all, the end
          // of the stream still surfaces the loss.
          corrupt(2) +
            corrupt(3) +
            corrupt(4) +
            'id: 5\r\nevent: item.output_text.delta\r\ndata: {"sequence":5,"ev',
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(1);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('closed mid-frame'),
    );
  });

  it('counts a mid-stream frame without a data line as corrupt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // A complete frame with id/event lines but no data line is
          // malformed server output, not a heartbeat.
          'id: 2\r\nevent: item.output_text.delta\r\n\r\n' + valid(3),
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([expect.objectContaining({ sequence: 3 })]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('charges the budget for mid-stream frames without a data line', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const noData = (sequence: number) =>
      `id: ${sequence}\r\nevent: item.output_text.delta\r\n\r\n`;
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // Four no-data frames trip the budget; the valid frame behind them
        // disables the end-of-stream fallback.
        new Response(noData(2) + noData(3) + noData(4) + noData(5) + valid(6), {
          status: 200,
        }),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 6 }));
  });

  it('does not count heartbeats toward the corrupt-frame budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            ': keepalive\r\n\r\n'.repeat(5) +
              'id: 2\r\nevent: item.output_text.delta\r\ndata: {"sequence":2,"eventId":"evt_2","sessionId":"session-1","turnId":"turn-1","type":"item.output_text.delta","createdAt":2,"data":{},"terminal":false}\r\n\r\n',
            { status: 200 },
          ),
        ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([expect.objectContaining({ sequence: 2 })]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not let heartbeats dilute the corrupt-frame budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const heartbeat = ': keepalive\r\n\r\n';
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // The valid frame behind the corrupt run disables the
          // end-of-stream fallback, so only the budget trip can produce the
          // first frame.
          corrupt(2) +
            heartbeat +
            corrupt(3) +
            heartbeat +
            corrupt(4) +
            heartbeat +
            corrupt(5) +
            valid(6),
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 6 }));
  });

  it('counts data frames without a string event type as corrupt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // Valid JSON, but none of these is an event object (the schema
          // requires a string `type`): as corrupt as broken JSON.
          'id: 2\r\nevent: item.output_text.delta\r\ndata: null\r\n\r\n' +
            valid(3) +
            'id: 4\r\nevent: item.output_text.delta\r\ndata: []\r\n\r\n' +
            valid(5) +
            'id: 6\r\nevent: item.output_text.delta\r\ndata: {}\r\n\r\n' +
            valid(7),
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ sequence: 3 }),
      expect.objectContaining({ sequence: 5 }),
      expect.objectContaining({ sequence: 7 }),
    ]);
    // Rate-limited: only the first skip logs.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats a corrupt id-less resync frame as a resync request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          'event:agent.session.resync_required\r\ndata:{"type":"agent.session.resync_required","sessionId":"sess\r\n\r\n' +
            // The valid frame behind it disables the end-of-stream fallback,
            // so only the fail-closed resync rule can produce the first
            // frame.
            valid(4),
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 3,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 4 }));
  });

  it('maps the stable Java error envelope', async () => {
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'agent_api_idempotency_conflict',
              message: 'conflict',
            },
          },
          409,
        ),
      ),
    });

    await expect(
      client.createSession({
        requestId: 'r1',
        idempotencyKey: 'key-1',
        agentId: 'dataworks_data_agent',
        input: [{ type: 'input_text', text: 'hello' }],
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<JavaManagedAgentHttpError>>({
        status: 409,
        code: 'agent_api_idempotency_conflict',
        message: 'conflict',
      }),
    );
  });

  it('sends the cancel-critical fields verbatim', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        sessionId: 's1',
        turnId: 'p1',
        status: 'accepted',
        replayed: false,
      }),
    );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    await client.cancelTurn({
      requestId: 'rid-1',
      idempotencyKey: 'key-cancel',
      sessionId: 's1',
      turnId: 'p1',
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://product.example/api/agent/web-shell/v1/turns/cancel',
    );
    // A dropped turnId or idempotencyKey cancels nothing and dedupe-breaks.
    expect(JSON.parse(String(init?.body))).toEqual({
      requestId: 'rid-1',
      idempotencyKey: 'key-cancel',
      sessionId: 's1',
      turnId: 'p1',
    });
  });

  it('sends getSession, transcript and submit surfaces verbatim', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({}));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    await client.getSession('s1');
    await client.getTranscript({
      sessionId: 's1',
      cursor: 'before-1',
      limit: 50,
    });
    await client.submitTurn({
      requestId: 'rid-2',
      idempotencyKey: 'key-submit',
      sessionId: 's1',
      input: [{ type: 'input_text', text: 'go' }],
    });

    const getCall = fetchImpl.mock.calls[0]!;
    const txCall = fetchImpl.mock.calls[1]!;
    const submitCall = fetchImpl.mock.calls[2]!;
    expect(String(getCall[0])).toBe(
      'https://product.example/api/agent/web-shell/v1/sessions/get',
    );
    expect(JSON.parse(String(getCall[1]?.body))).toEqual({ sessionId: 's1' });
    expect(String(txCall[0])).toBe(
      'https://product.example/api/agent/web-shell/v1/transcript/query',
    );
    expect(JSON.parse(String(txCall[1]?.body))).toEqual({
      sessionId: 's1',
      cursor: 'before-1',
      limit: 50,
    });
    expect(String(submitCall[0])).toBe(
      'https://product.example/api/agent/web-shell/v1/turns/submit',
    );
    expect(JSON.parse(String(submitCall[1]?.body))).toEqual({
      requestId: 'rid-2',
      idempotencyKey: 'key-submit',
      sessionId: 's1',
      input: [{ type: 'input_text', text: 'go' }],
    });
  });

  it('falls back to the stable http error code for a non-JSON gateway error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    // A gateway's HTML 502 must not escape as a raw SyntaxError.
    await expect(client.getSession('s1')).rejects.toEqual(
      expect.objectContaining<Partial<JavaManagedAgentHttpError>>({
        status: 502,
        code: 'http_502',
      }),
    );
  });

  it('rejects a null event-stream body as unavailable', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    await expect(
      client.streamEvents({ sessionId: 's1' }).next(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<JavaManagedAgentHttpError>>({
        code: 'agent_api_stream_unavailable',
      }),
    );
  });
});
