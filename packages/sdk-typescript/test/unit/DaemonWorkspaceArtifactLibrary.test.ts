/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DaemonClient,
  DaemonHttpError,
} from '../../src/daemon/DaemonClient.js';
import { SseFramingError } from '../../src/daemon/sse.js';
import type { DaemonWorkspaceArtifactLibraryStreamEvent } from '../../src/daemon/types.js';

function createSseStream(
  chunks: readonly string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('WorkspaceDaemonClient artifactLibrary', () => {
  it('requests JSON GET /workspaces/:workspace/artifact-library and parses the envelope result', async () => {
    const payload = {
      v: 1 as const,
      sessions: [
        {
          v: 1 as const,
          sessionId: 'sess-1',
          generatedAt: '2026-11-21T10:00:00.000Z',
          limits: { maxArtifacts: 100 },
          session: {
            displayName: 'Audit run',
            createdAt: '2026-11-21T09:00:00.000Z',
            archiveState: 'active' as const,
            sourceType: 'cli',
          },
          artifacts: [
            {
              id: 'art-1',
              title: 'report.md',
              kind: 'document',
              storage: 'workspace',
              workspacePath: 'docs/report.md',
              status: 'available',
              source: 'tool',
              createdAt: '2026-11-21T09:30:00.000Z',
              updatedAt: '2026-11-21T09:45:00.000Z',
            },
          ],
        },
      ],
      errors: [
        {
          sessionId: 'sess-bad',
          status: 413,
          code: 'transcript_too_large',
          message: 'Transcript exceeds size limit.',
          snapshotSize: 300,
          maxBytes: 200,
          dimension: 'artifact_library',
          measuredBytes: 300,
          retryable: true,
        },
      ],
    };
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      token: 'tok-1',
      fetch,
    });

    const result = await client
      .workspaceByCwd('/work/proj')
      .artifactLibrary({ clientId: 'c-1' });

    expect(result).toEqual(payload);
    expect(result.errors[0]).toMatchObject({
      snapshotSize: 300,
      maxBytes: 200,
      dimension: 'artifact_library',
      measuredBytes: 300,
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://daemon/workspaces/%2Fwork%2Fproj/artifact-library',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer tok-1',
          'X-Qwen-Client-Id': 'c-1',
        }),
      }),
    );
  });

  it('streams start, session, session_error, complete, and error events with Accept: text/event-stream', async () => {
    const sseBody = [
      ': heartbeat\n\n',
      'event: start\ndata: {"v":1,"total":3}\n\n',
      'event: session\ndata: {"v":1,"sessionId":"sess-archived","generatedAt":"2026-11-21T10:00:00.000Z","limits":{"maxArtifacts":100},"session":{"createdAt":"2026-11-20T00:00:00.000Z","archiveState":"archived","sourceType":"web"},"artifacts":[]}\n\n',
      'event: session_error\ndata: {"v":1,"sessionId":"sess-err","status":413,"code":"transcript_too_large","message":"Too large"}\n\n',
      'event: complete\ndata: {"v":1,"total":3,"succeeded":1,"failed":1,"skipped":1}\n\n',
      'event: error\ndata: {"v":1,"status":503,"code":"workspace_runtime_unavailable","message":"Runtime unavailable"}\n\n',
    ];
    const fetch = vi.fn().mockResolvedValue(
      new Response(createSseStream(sseBody), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const events: DaemonWorkspaceArtifactLibraryStreamEvent[] = [];
    for await (const event of client
      .workspaceById('ws-1')
      .artifactLibraryStream()) {
      events.push(event);
    }

    expect(fetch).toHaveBeenCalledWith(
      'http://daemon/workspaces/ws-1/artifact-library',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'text/event-stream',
        }),
      }),
    );
    expect(events).toEqual([
      { type: 'start', v: 1, total: 3 },
      {
        type: 'session',
        v: 1,
        sessionId: 'sess-archived',
        generatedAt: '2026-11-21T10:00:00.000Z',
        limits: { maxArtifacts: 100 },
        session: {
          createdAt: '2026-11-20T00:00:00.000Z',
          archiveState: 'archived',
          sourceType: 'web',
        },
        artifacts: [],
      },
      {
        type: 'session_error',
        v: 1,
        sessionId: 'sess-err',
        status: 413,
        code: 'transcript_too_large',
        message: 'Too large',
      },
      {
        type: 'complete',
        v: 1,
        total: 3,
        succeeded: 1,
        failed: 1,
        skipped: 1,
      },
      {
        type: 'error',
        v: 1,
        status: 503,
        code: 'workspace_runtime_unavailable',
        message: 'Runtime unavailable',
      },
    ]);
  });

  it('rejects a non-SSE 200 response on artifactLibraryStream with SseFramingError', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ v: 1, sessions: [], errors: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(async () => {
      for await (const _ of client
        .workspaceById('ws-1')
        .artifactLibraryStream()) {
        // unreachable
      }
    }).rejects.toThrow(SseFramingError);
  });

  it('maps pre-stream 503 sse_connection_limit_exceeded and 409 artifact_library_unavailable to DaemonHttpError', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'SSE connection limit exceeded',
            code: 'sse_connection_limit_exceeded',
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '5',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'Artifact library is unavailable',
            code: 'artifact_library_unavailable',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(async () => {
      for await (const _ of client
        .workspaceById('ws-1')
        .artifactLibraryStream()) {
        // unreachable
      }
    }).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DaemonHttpError &&
        err.status === 503 &&
        err.retryAfter === '5' &&
        (err.body as { code?: string })?.code ===
          'sse_connection_limit_exceeded'
      );
    });

    await expect(
      client.workspaceById('ws-1').artifactLibrary(),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof DaemonHttpError &&
        err.status === 409 &&
        (err.body as { code?: string })?.code === 'artifact_library_unavailable'
      );
    });
  });
});
