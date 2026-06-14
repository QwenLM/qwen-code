/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DaemonClient,
  DaemonHttpError,
  DaemonPendingPromptLimitError,
  abortTimeout,
  composeAbortSignals,
  normalizePendingPromptLimit,
} from '../../src/daemon/DaemonClient.js';
import {
  DaemonCapabilityMissingError,
  isDaemonContentHash,
  requireWorkspaceCwd,
} from '../../src/daemon/types.js';
import type {
  DaemonCapabilities,
  DaemonSessionContextStatus,
  DaemonSessionSupportedCommandsStatus,
  DaemonSessionTasksStatus,
  DaemonWorkspaceEnvStatus,
  DaemonWorkspaceMcpStatus,
  DaemonWorkspacePreflightStatus,
  DaemonWorkspaceProvidersStatus,
  DaemonWorkspaceSkillsStatus,
} from '../../src/daemon/types.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function pendingSseResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': keepalive\n\n'));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal?: AbortSignal | null;
}

function recordingFetch(
  reply: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      }
      const body = typeof init?.body === 'string' ? init.body : null;
      const captured: CapturedRequest = {
        url,
        method,
        headers,
        body,
        signal: init?.signal ?? null,
      };
      calls.push(captured);
      return reply(captured);
    },
  ) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

describe('DaemonClient', () => {
  describe('normalizePendingPromptLimit', () => {
    it('defaults undefined to 5', () => {
      expect(normalizePendingPromptLimit(undefined)).toBe(5);
    });

    it.each([[null], [0], [Infinity]])('disables cap for %s', (value) => {
      expect(normalizePendingPromptLimit(value)).toBe(Infinity);
    });

    it('passes through positive integers', () => {
      expect(normalizePendingPromptLimit(7)).toBe(7);
    });

    it.each([[-1], [1.5], [Number.NaN]])('throws for %s', (value) => {
      expect(() => normalizePendingPromptLimit(value)).toThrow(
        /bad maxPendingPromptsPerSession/,
      );
    });
  });

  describe('health', () => {
    it('GETs /health and returns the body', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { status: 'ok' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const res = await client.health();
      expect(res).toEqual({ status: 'ok' });
      expect(calls[0]?.url).toBe('http://daemon/health');
      expect(calls[0]?.method).toBe('GET');
    });

    it('throws DaemonHttpError on non-2xx', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(503, { error: 'down' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.health()).rejects.toBeInstanceOf(DaemonHttpError);
    });
  });

  describe('capabilities', () => {
    it('GETs /capabilities and returns the v1 envelope', async () => {
      const envelope = {
        v: 1 as const,
        protocolVersions: {
          current: 'v1',
          supported: ['v1'],
        },
        mode: 'http-bridge' as const,
        features: ['health', 'capabilities'],
        modelServices: [],
        workspaceCwd: '/work/bound',
      };
      const { fetch } = recordingFetch(() => jsonResponse(200, envelope));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const caps = await client.capabilities();
      expect(caps).toEqual(envelope);
      // #3803 §02: clients use `workspaceCwd` to pre-flight check +
      // omit `cwd` from `POST /session` (route falls back).
      expect(caps.workspaceCwd).toBe('/work/bound');
    });

    it('accepts old v1 envelopes without protocolVersions', async () => {
      const envelope: DaemonCapabilities = {
        v: 1,
        mode: 'http-bridge',
        features: ['health', 'capabilities'],
        modelServices: [],
        workspaceCwd: '/work/bound',
      };
      const { fetch } = recordingFetch(() => jsonResponse(200, envelope));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.capabilities()).resolves.toEqual(envelope);
    });
  });

  describe('workspace file helpers', () => {
    it('validates daemon content hashes with the daemon regex', () => {
      expect(isDaemonContentHash(`sha256:${'a'.repeat(64)}`)).toBe(true);
      expect(isDaemonContentHash(`sha256:${'A'.repeat(64)}`)).toBe(false);
      expect(isDaemonContentHash(`sha256:${'a'.repeat(63)}`)).toBe(false);
      expect(isDaemonContentHash('md5:' + 'a'.repeat(64))).toBe(false);
      expect(isDaemonContentHash(undefined)).toBe(false);
    });

    it('reads text files with query params and client identity', async () => {
      const payload = {
        kind: 'file',
        path: 'src/a.ts',
        content: 'export {}\n',
        encoding: 'utf-8',
        bom: false,
        lineEnding: 'lf',
        sizeBytes: 10,
        returnedBytes: 10,
        truncated: false,
        hash: 'sha256:' + 'a'.repeat(64),
        matchedIgnore: null,
        originalLineCount: null,
      };
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, payload));
      const client = new DaemonClient({ baseUrl: 'http://daemon/', fetch });
      await expect(
        client.readWorkspaceFile('src/a.ts', { line: 2, limit: 3 }, 'client-1'),
      ).resolves.toEqual(payload);
      expect(calls[0]?.method).toBe('GET');
      expect(calls[0]?.url).toBe(
        'http://daemon/file?path=src%2Fa.ts&line=2&limit=3',
      );
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('reads raw bytes as base64 payloads', async () => {
      const payload = {
        kind: 'file_bytes',
        path: 'bin.dat',
        offset: 4,
        sizeBytes: 9,
        returnedBytes: 2,
        truncated: true,
        contentBase64: Buffer.from([5, 6]).toString('base64'),
      };
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, payload));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.readWorkspaceFileBytes('bin.dat', {
          offset: 4,
          maxBytes: 2,
        }),
      ).resolves.toEqual(payload);
      expect(calls[0]?.url).toBe(
        'http://daemon/file/bytes?path=bin.dat&offset=4&maxBytes=2',
      );
    });

    it('writes and edits files with JSON bodies and client identity', async () => {
      const writeResult = {
        kind: 'file_write',
        path: 'a.txt',
        mode: 'replace',
        created: false,
        sizeBytes: 3,
        hash: 'sha256:' + 'b'.repeat(64),
        encoding: 'utf-8',
        bom: false,
        lineEnding: 'lf',
        matchedIgnore: null,
      };
      const editResult = {
        kind: 'file_edit',
        path: 'a.txt',
        replacements: 1,
        sizeBytes: 4,
        hash: 'sha256:' + 'c'.repeat(64),
        encoding: 'utf-8',
        bom: false,
        lineEnding: 'lf',
        matchedIgnore: null,
      };
      const { fetch, calls } = recordingFetch((req) => {
        if (req.url.endsWith('/file/write')) {
          return jsonResponse(200, writeResult);
        }
        if (req.url.endsWith('/file/edit')) {
          return jsonResponse(200, editResult);
        }
        return jsonResponse(500, { error: 'unexpected' });
      });
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.writeWorkspaceFile(
          {
            path: 'a.txt',
            content: 'new',
            mode: 'replace',
            expectedHash: `sha256:${'a'.repeat(64)}`,
          },
          'client-1',
        ),
      ).resolves.toEqual(writeResult);
      await expect(
        client.editWorkspaceFile(
          {
            path: 'a.txt',
            oldText: 'new',
            newText: 'next',
            expectedHash: `sha256:${'b'.repeat(64)}`,
          },
          'client-1',
        ),
      ).resolves.toEqual(editResult);
      expect(calls[0]).toMatchObject({
        method: 'POST',
        url: 'http://daemon/file/write',
        body: JSON.stringify({
          path: 'a.txt',
          content: 'new',
          mode: 'replace',
          expectedHash: `sha256:${'a'.repeat(64)}`,
        }),
      });
      expect(calls[0]?.headers['content-type']).toBe('application/json');
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
      expect(calls[1]).toMatchObject({
        method: 'POST',
        url: 'http://daemon/file/edit',
      });
    });

    it('preserves structured error bodies for hash conflicts', async () => {
      const body = {
        errorKind: 'hash_mismatch',
        error: 'expected stale, found current',
        status: 409,
      };
      const { fetch } = recordingFetch(() => jsonResponse(409, body));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const err = await client
        .writeWorkspaceFile({
          path: 'a.txt',
          content: 'new',
          mode: 'replace',
          expectedHash: `sha256:${'a'.repeat(64)}`,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DaemonHttpError);
      expect((err as DaemonHttpError).status).toBe(409);
      expect((err as DaemonHttpError).body).toEqual(body);
    });
  });

  describe('read-only status routes', () => {
    it('GETs workspace status routes and returns payloads unchanged', async () => {
      const mcp: DaemonWorkspaceMcpStatus = {
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        discoveryState: 'completed',
        servers: [
          {
            kind: 'mcp_server',
            status: 'ok',
            name: 'docs',
            mcpStatus: 'connected',
            transport: 'stdio',
            disabled: false,
          },
        ],
      };
      const skills: DaemonWorkspaceSkillsStatus = {
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        skills: [
          {
            kind: 'skill',
            status: 'ok',
            name: 'review',
            description: 'Review code',
            level: 'project',
            modelInvocable: true,
          },
        ],
      };
      const providers: DaemonWorkspaceProvidersStatus = {
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        current: { authType: 'qwen', modelId: 'qwen3(qwen)' },
        providers: [
          {
            kind: 'model_provider',
            status: 'ok',
            authType: 'qwen',
            current: true,
            models: [
              {
                modelId: 'qwen3(qwen)',
                baseModelId: 'qwen3',
                name: 'Qwen 3',
                description: null,
                contextLimit: 4096,
                isCurrent: true,
                isRuntime: false,
              },
            ],
          },
        ],
      };
      const { fetch, calls } = recordingFetch((req) => {
        if (req.url.endsWith('/workspace/mcp')) return jsonResponse(200, mcp);
        if (req.url.endsWith('/workspace/skills')) {
          return jsonResponse(200, skills);
        }
        if (req.url.endsWith('/workspace/providers')) {
          return jsonResponse(200, providers);
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

      await expect(client.workspaceMcp()).resolves.toEqual(mcp);
      await expect(client.workspaceSkills()).resolves.toEqual(skills);
      await expect(client.workspaceProviders()).resolves.toEqual(providers);
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ['GET', 'http://daemon/workspace/mcp'],
        ['GET', 'http://daemon/workspace/skills'],
        ['GET', 'http://daemon/workspace/providers'],
      ]);
    });

    it('GETs /workspace/preflight and returns the preflight envelope unchanged', async () => {
      const preflight: DaemonWorkspacePreflightStatus = {
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        acpChannelLive: false,
        cells: [
          {
            kind: 'node_version',
            status: 'ok',
            locality: 'daemon',
            detail: { version: '22.4.0', required: '>=22' },
          },
          {
            kind: 'auth',
            status: 'not_started',
            locality: 'acp',
            hint: 'spawn a session to populate',
          },
        ],
      };
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, preflight),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

      await expect(client.workspacePreflight()).resolves.toEqual(preflight);
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ['GET', 'http://daemon/workspace/preflight'],
      ]);
    });

    it('GETs /workspace/env and returns the env envelope unchanged', async () => {
      const env: DaemonWorkspaceEnvStatus = {
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        acpChannelLive: false,
        cells: [
          { kind: 'runtime', name: 'node', status: 'ok', value: '22.4.0' },
          {
            kind: 'env_var',
            name: 'OPENAI_API_KEY',
            status: 'ok',
            present: true,
          },
        ],
      };
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, env));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

      await expect(client.workspaceEnv()).resolves.toEqual(env);
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ['GET', 'http://daemon/workspace/env'],
      ]);
    });

    it('GETs /workspace/mcp/:server/tools with URL encoding', async () => {
      const toolsStatus = {
        v: 1,
        serverName: 'my server',
        tools: [{ name: 'tool-a', description: 'A tool' }],
      };
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, toolsStatus),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

      await expect(client.workspaceMcpTools('my server')).resolves.toEqual(
        toolsStatus,
      );
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ['GET', 'http://daemon/workspace/mcp/my%20server/tools'],
      ]);
    });

    it('GETs /workspace/tools and returns the tools envelope', async () => {
      const toolsStatus = {
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        acpChannelLive: false,
        tools: [{ name: 'Bash', enabled: true }],
      };
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, toolsStatus),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

      await expect(client.workspaceTools()).resolves.toEqual(toolsStatus);
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ['GET', 'http://daemon/workspace/tools'],
      ]);
    });

    it('GETs session status routes with encoded session ids', async () => {
      const context: DaemonSessionContextStatus = {
        v: 1,
        sessionId: 'with/slash',
        workspaceCwd: '/work/a',
        state: { models: { currentModelId: 'qwen3' } },
      };
      const supportedCommands: DaemonSessionSupportedCommandsStatus = {
        v: 1,
        sessionId: 'with/slash',
        availableCommands: [
          {
            name: 'init',
            description: 'Initialize',
            input: null,
          },
        ],
        availableSkills: ['review'],
      };
      const tasks: DaemonSessionTasksStatus = {
        v: 1,
        sessionId: 'with/slash',
        now: 1_700_000_000_000,
        tasks: [],
      };
      const { fetch, calls } = recordingFetch((req) => {
        if (req.url.endsWith('/session/with%2Fslash/context')) {
          return jsonResponse(200, context);
        }
        if (req.url.endsWith('/session/with%2Fslash/supported-commands')) {
          return jsonResponse(200, supportedCommands);
        }
        if (req.url.endsWith('/session/with%2Fslash/tasks')) {
          return jsonResponse(200, tasks);
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

      await expect(
        client.sessionContext('with/slash', 'client-1'),
      ).resolves.toEqual(context);
      await expect(
        client.sessionSupportedCommands('with/slash', 'client-1'),
      ).resolves.toEqual(supportedCommands);
      await expect(
        client.sessionTasks('with/slash', 'client-1'),
      ).resolves.toEqual(tasks);
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ['GET', 'http://daemon/session/with%2Fslash/context'],
        ['GET', 'http://daemon/session/with%2Fslash/supported-commands'],
        ['GET', 'http://daemon/session/with%2Fslash/tasks'],
      ]);
      expect(calls.map((c) => c.headers['x-qwen-client-id'])).toEqual([
        'client-1',
        'client-1',
        'client-1',
      ]);
    });
  });

  describe('bearer auth', () => {
    it('attaches Authorization: Bearer when token is set', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { status: 'ok' }),
      );
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        token: 'secret',
        fetch,
      });
      await client.health();
      expect(calls[0]?.headers['authorization']).toBe('Bearer secret');
    });

    it('omits Authorization when no token', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { status: 'ok' }),
      );
      // Defensive: an inherited test-runner export of QWEN_SERVER_TOKEN
      // would otherwise activate the PR 27 env fallback and turn this
      // assertion into a false positive ("got Bearer <leaked-value>"
      // instead of the expected `undefined`). Snapshot + restore in a
      // try/finally so the rest of the suite sees the same env state.
      const ORIGINAL = process.env['QWEN_SERVER_TOKEN'];
      delete process.env['QWEN_SERVER_TOKEN'];
      try {
        const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
        await client.health();
        expect(calls[0]?.headers['authorization']).toBeUndefined();
      } finally {
        if (ORIGINAL === undefined) delete process.env['QWEN_SERVER_TOKEN'];
        else process.env['QWEN_SERVER_TOKEN'] = ORIGINAL;
      }
    });

    describe('QWEN_SERVER_TOKEN env fallback (PR 27 / #4175 v0.16-alpha)', () => {
      const ORIGINAL = process.env['QWEN_SERVER_TOKEN'];
      afterEach(() => {
        if (ORIGINAL === undefined) delete process.env['QWEN_SERVER_TOKEN'];
        else process.env['QWEN_SERVER_TOKEN'] = ORIGINAL;
      });

      it('uses QWEN_SERVER_TOKEN when no explicit token is passed', async () => {
        process.env['QWEN_SERVER_TOKEN'] = 'env-token-abc';
        const { fetch, calls } = recordingFetch(() =>
          jsonResponse(200, { status: 'ok' }),
        );
        const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
        await client.health();
        expect(calls[0]?.headers['authorization']).toBe('Bearer env-token-abc');
      });

      it('explicit opts.token wins over env', async () => {
        process.env['QWEN_SERVER_TOKEN'] = 'env-token-loses';
        const { fetch, calls } = recordingFetch(() =>
          jsonResponse(200, { status: 'ok' }),
        );
        const client = new DaemonClient({
          baseUrl: 'http://daemon',
          token: 'explicit-wins',
          fetch,
        });
        await client.health();
        expect(calls[0]?.headers['authorization']).toBe('Bearer explicit-wins');
      });

      it('treats empty / whitespace-only env var as unset', async () => {
        // A stale `export QWEN_SERVER_TOKEN=""` would otherwise let the
        // Authorization header through as `Bearer ` (no token), which
        // the daemon rejects but is confusing to debug. PR 27 collapses
        // empty / whitespace-only onto the same "unset" branch as
        // truly-unset; verify both shapes here.
        process.env['QWEN_SERVER_TOKEN'] = '   ';
        const { fetch, calls } = recordingFetch(() =>
          jsonResponse(200, { status: 'ok' }),
        );
        const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
        await client.health();
        expect(calls[0]?.headers['authorization']).toBeUndefined();
      });

      it('strips leading/trailing whitespace from env var', async () => {
        // Matches the daemon-side `--token` trim behavior — handy for
        // `export QWEN_SERVER_TOKEN="$(cat token.txt)"` where `cat`
        // produces a trailing newline that would otherwise corrupt
        // the Authorization header value.
        process.env['QWEN_SERVER_TOKEN'] = '  trimmed-value  \n';
        const { fetch, calls } = recordingFetch(() =>
          jsonResponse(200, { status: 'ok' }),
        );
        const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
        await client.health();
        expect(calls[0]?.headers['authorization']).toBe('Bearer trimmed-value');
      });
    });
  });

  describe('createOrAttachSession', () => {
    it('POSTs cwd in the body', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const session = await client.createOrAttachSession({
        workspaceCwd: '/work/a',
      });
      expect(session.sessionId).toBe('s-1');
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.url).toBe('http://daemon/session');
      expect(JSON.parse(calls[0]!.body!)).toEqual({ cwd: '/work/a' });
    });

    it('omits cwd when workspaceCwd is not provided (#3803 §02)', async () => {
      // Per #3803 §02 the daemon route falls back to its bound
      // workspace when `cwd` is absent. The SDK relies on
      // JSON.stringify stripping `undefined` values, so an
      // omitted `workspaceCwd` ends up as "no `cwd` key" on the
      // wire — exactly the fallback shape the server expects.
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/bound',
          attached: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.createOrAttachSession({});
      expect(JSON.parse(calls[0]!.body!)).toEqual({});
    });

    it('forwards empty-string workspaceCwd verbatim so the server can 400 it', async () => {
      // `workspaceCwd: ""` is a likely client-side bug shape. A
      // truthy-guard SDK would silently drop the field and let the
      // server's fallback bind the session — masking the bug. We
      // forward it verbatim so the server's
      // `cwd must be an absolute path when provided` 400 surfaces.
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(400, { error: 'bad cwd' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.createOrAttachSession({ workspaceCwd: '' }),
      ).rejects.toMatchObject({ status: 400 });
      expect(JSON.parse(calls[0]!.body!)).toEqual({ cwd: '' });
    });

    it('forwards modelServiceId when supplied', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.createOrAttachSession({
        workspaceCwd: '/work/a',
        modelServiceId: 'qwen-prod',
      });
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        cwd: '/work/a',
        modelServiceId: 'qwen-prod',
      });
    });

    it('sends client identity in a header, not the request body', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const session = await client.createOrAttachSession(
        { workspaceCwd: '/work/a' },
        'client-1',
      );
      expect(session.clientId).toBe('client-1');
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
      expect(JSON.parse(calls[0]!.body!)).toEqual({ cwd: '/work/a' });
    });

    it('forwards sessionScope when supplied (#4175 PR 5)', async () => {
      // Per-request scope override: clients pre-flight
      // `caps.features.session_scope_override` and pass `'single'` /
      // `'thread'` here when they want to override the daemon-wide
      // default. Symmetric SDK shape with `modelServiceId`.
      for (const sessionScope of ['single', 'thread'] as const) {
        const { fetch, calls } = recordingFetch(() =>
          jsonResponse(200, {
            sessionId: 's-1',
            workspaceCwd: '/work/a',
            attached: false,
          }),
        );
        const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
        await client.createOrAttachSession({
          workspaceCwd: '/work/a',
          sessionScope,
        });
        expect(JSON.parse(calls[0]!.body!)).toEqual({
          cwd: '/work/a',
          sessionScope,
        });
      }
    });

    it('omits sessionScope from the body when the field is absent', async () => {
      // Backward-compat: a caller that doesn't set the field must not
      // surface a `sessionScope` key on the wire — old daemons reading
      // an unknown body key is fine, but the omitted-key shape is what
      // we tested before #4175 PR 5 and what every existing caller
      // observes.
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.createOrAttachSession({ workspaceCwd: '/work/a' });
      const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
      expect(body).not.toHaveProperty('sessionScope');
    });

    it('throws on 400', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(400, { error: 'bad cwd' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.createOrAttachSession({ workspaceCwd: 'relative' }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('prompt', () => {
    it('POSTs the prompt body and returns the agent response', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { stopReason: 'end_turn' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const res = await client.prompt('s-1', {
        prompt: [{ type: 'text', text: 'hi' }],
      });
      expect(res.stopReason).toBe('end_turn');
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/prompt');
      expect(calls[0]?.method).toBe('POST');
      const body = JSON.parse(calls[0]!.body!);
      expect(body.prompt).toEqual([{ type: 'text', text: 'hi' }]);
    });

    it('url-encodes the sessionId', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { stopReason: 'end_turn' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.prompt('with/slash', {
        prompt: [{ type: 'text', text: 'x' }],
      });
      expect(calls[0]?.url).toBe('http://daemon/session/with%2Fslash/prompt');
    });

    it('sends client identity header on prompts', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { stopReason: 'end_turn' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.prompt(
        's-1',
        { prompt: [{ type: 'text', text: 'hi' }] },
        undefined,
        'client-1',
      );
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('forwards a caller AbortSignal through to fetch (A-UsQ)', async () => {
      // The bridge already supports per-prompt cancellation via the
      // signal arg on `sendPrompt`; the SDK had the parameter wired
      // but no test, so a regression that dropped it on the floor
      // would silently leave callers unable to cancel.
      const fetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            );
          }),
      ) as unknown as typeof globalThis.fetch;
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 30);
      await expect(
        client.prompt(
          's-1',
          { prompt: [{ type: 'text', text: 'hi' }] },
          ctrl.signal,
        ),
      ).rejects.toThrow();
    });

    it('rejects locally when a session reaches the pending prompt cap', async () => {
      const { fetch, calls } = recordingFetch((req) => {
        if (req.url.endsWith('/session/s-1/prompt')) {
          return jsonResponse(202, { promptId: 'p-1', lastEventId: 0 });
        }
        if (req.url.endsWith('/session/s-1/events')) {
          return pendingSseResponse();
        }
        if (req.url.endsWith('/session/s-1/cancel')) {
          return new Response(null, { status: 204 });
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        maxPendingPromptsPerSession: 1,
      });
      const ctrl = new AbortController();
      const first = client
        .prompt(
          's-1',
          { prompt: [{ type: 'text', text: 'first' }] },
          ctrl.signal,
        )
        .catch((err: unknown) => err);

      await vi.waitFor(() => {
        expect(calls.filter((c) => c.url.endsWith('/events'))).toHaveLength(1);
      });
      const secondCtrl = new AbortController();
      const second = client
        .prompt(
          's-1',
          { prompt: [{ type: 'text', text: 'second' }] },
          secondCtrl.signal,
        )
        .catch((err: unknown) => err);
      try {
        const secondResult = await Promise.race<unknown>([
          second,
          new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
        ]);
        expect(secondResult).toBeInstanceOf(DaemonPendingPromptLimitError);
        expect((secondResult as Error).message).toContain('"s-1"');
        expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(1);
      } finally {
        ctrl.abort();
        secondCtrl.abort();
        await first;
        await second;
      }
    });

    it('maps server prompt queue full responses to the pending prompt limit error', async () => {
      const { fetch } = recordingFetch((req) => {
        if (req.url.endsWith('/session/s-1/prompt')) {
          return jsonResponse(503, {
            code: 'prompt_queue_full',
            error: 'queue full',
            sessionId: 's-1',
            limit: 5,
            pendingCount: 5,
          });
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        maxPendingPromptsPerSession: 0,
      });

      const result = await client
        .prompt('s-1', { prompt: [{ type: 'text', text: 'hi' }] })
        .catch((err: unknown) => err);

      expect(result).toBeInstanceOf(DaemonPendingPromptLimitError);
      expect(result).toMatchObject({
        sessionId: 's-1',
        limit: 5,
        pendingCount: 5,
      });
    });

    it('maps server prompt queue full responses on non-blocking prompts', async () => {
      const { fetch } = recordingFetch((req) => {
        if (req.url.endsWith('/session/s-1/prompt')) {
          return jsonResponse(503, {
            code: 'prompt_queue_full',
            error: 'queue full',
            sessionId: 's-1',
            limit: 7,
            pendingCount: 7,
          });
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
      });

      const result = await client
        .promptNonBlocking('s-1', {
          prompt: [{ type: 'text', text: 'hi' }],
        })
        .catch((err: unknown) => err);

      expect(result).toBeInstanceOf(DaemonPendingPromptLimitError);
      expect(result).toMatchObject({
        sessionId: 's-1',
        limit: 7,
        pendingCount: 7,
      });
    });

    it('does not reserve a local prompt slot for a pre-aborted signal', async () => {
      const { fetch, calls } = recordingFetch((req) => {
        if (req.url.endsWith('/session/s-1/prompt')) {
          return jsonResponse(202, { promptId: 'p-1', lastEventId: 0 });
        }
        if (req.url.endsWith('/session/s-1/events')) {
          return pendingSseResponse();
        }
        if (req.url.endsWith('/session/s-1/cancel')) {
          return new Response(null, { status: 204 });
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        maxPendingPromptsPerSession: 1,
      });
      const aborted = new AbortController();
      aborted.abort();

      await expect(
        client.prompt(
          's-1',
          { prompt: [{ type: 'text', text: 'pre-aborted' }] },
          aborted.signal,
        ),
      ).rejects.toThrow();
      expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(0);

      const activeAbort = new AbortController();
      const active = client
        .prompt(
          's-1',
          { prompt: [{ type: 'text', text: 'active' }] },
          activeAbort.signal,
        )
        .catch((err: unknown) => err);
      await vi.waitFor(() => {
        expect(calls.filter((c) => c.url.endsWith('/events'))).toHaveLength(1);
      });
      expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(1);

      activeAbort.abort();
      await active;
    });

    it('releases the local pending prompt slot after turn completion', async () => {
      let nextPromptId = 0;
      const { fetch, calls } = recordingFetch((req) => {
        if (req.url.endsWith('/session/s-1/prompt')) {
          nextPromptId += 1;
          return jsonResponse(202, {
            promptId: `p-${nextPromptId}`,
            lastEventId: 0,
          });
        }
        if (req.url.endsWith('/session/s-1/events')) {
          const promptId = `p-${nextPromptId}`;
          return sseResponse(
            `id: 1\nevent: turn_complete\ndata: {"id":1,"v":1,"type":"turn_complete","data":{"promptId":"${promptId}","stopReason":"end_turn"}}\n\n`,
          );
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        maxPendingPromptsPerSession: 1,
      });

      await expect(
        client.prompt('s-1', { prompt: [{ type: 'text', text: 'first' }] }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      await expect(
        client.prompt('s-1', { prompt: [{ type: 'text', text: 'second' }] }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(2);
    });

    it('releases the local pending prompt slot after turn_error', async () => {
      let nextPromptId = 0;
      const { fetch, calls } = recordingFetch((req) => {
        if (req.url.endsWith('/session/s-1/prompt')) {
          nextPromptId += 1;
          return jsonResponse(202, {
            promptId: `p-${nextPromptId}`,
            lastEventId: 0,
          });
        }
        if (req.url.endsWith('/session/s-1/events')) {
          const promptId = `p-${nextPromptId}`;
          const eventType = promptId === 'p-1' ? 'turn_error' : 'turn_complete';
          const data =
            promptId === 'p-1'
              ? { promptId, message: 'failed', code: 'turn_failed' }
              : { promptId, stopReason: 'end_turn' };
          return sseResponse(
            `id: 1\nevent: ${eventType}\ndata: ${JSON.stringify({
              id: 1,
              v: 1,
              type: eventType,
              data,
            })}\n\n`,
          );
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        maxPendingPromptsPerSession: 1,
      });

      await expect(
        client.prompt('s-1', { prompt: [{ type: 'text', text: 'first' }] }),
      ).rejects.toThrow('failed');
      await expect(
        client.prompt('s-1', { prompt: [{ type: 'text', text: 'second' }] }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(2);
    });

    it('releases the local pending prompt slot when SSE ends', async () => {
      let nextPromptId = 0;
      const { fetch, calls } = recordingFetch((req) => {
        if (req.url.endsWith('/session/s-1/prompt')) {
          nextPromptId += 1;
          return jsonResponse(202, {
            promptId: `p-${nextPromptId}`,
            lastEventId: 0,
          });
        }
        if (req.url.endsWith('/session/s-1/events')) {
          if (nextPromptId === 1) return sseResponse('');
          return sseResponse(
            'id: 1\nevent: turn_complete\ndata: {"id":1,"v":1,"type":"turn_complete","data":{"promptId":"p-2","stopReason":"end_turn"}}\n\n',
          );
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        maxPendingPromptsPerSession: 1,
      });

      await expect(
        client.prompt('s-1', { prompt: [{ type: 'text', text: 'first' }] }),
      ).rejects.toThrow('SSE stream ended');
      await expect(
        client.prompt('s-1', { prompt: [{ type: 'text', text: 'second' }] }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(2);
    });

    it('releases the local pending prompt slot after caller abort', async () => {
      let nextPromptId = 0;
      const { fetch, calls } = recordingFetch((req) => {
        if (req.url.endsWith('/session/s-1/prompt')) {
          nextPromptId += 1;
          return jsonResponse(202, {
            promptId: `p-${nextPromptId}`,
            lastEventId: 0,
          });
        }
        if (req.url.endsWith('/session/s-1/events')) {
          if (nextPromptId === 1) return pendingSseResponse();
          return sseResponse(
            'id: 1\nevent: turn_complete\ndata: {"id":1,"v":1,"type":"turn_complete","data":{"promptId":"p-2","stopReason":"end_turn"}}\n\n',
          );
        }
        if (req.url.endsWith('/session/s-1/cancel')) {
          return new Response(null, { status: 204 });
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        maxPendingPromptsPerSession: 1,
      });
      const ctrl = new AbortController();
      const first = client.prompt(
        's-1',
        { prompt: [{ type: 'text', text: 'first' }] },
        ctrl.signal,
      );
      await vi.waitFor(() => {
        expect(calls.filter((c) => c.url.endsWith('/events'))).toHaveLength(1);
      });

      ctrl.abort();
      await expect(first).rejects.toThrow();
      await expect(
        client.prompt('s-1', { prompt: [{ type: 'text', text: 'second' }] }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(2);
    });
  });

  describe('loadSession / resumeSession', () => {
    it('POSTs /session/:id/load with optional cwd', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
          state: { configOptions: [] },
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const session = await client.loadSession('s-1', {
        workspaceCwd: '/work/a',
      });

      expect(session.state).toEqual({ configOptions: [] });
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/load');
      expect(calls[0]?.method).toBe('POST');
      expect(JSON.parse(calls[0]!.body!)).toEqual({ cwd: '/work/a' });
    });

    it('sends client identity headers on restore requests', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: {},
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.loadSession('s-1', {}, 'client-1');
      await client.resumeSession('s-1', {}, 'client-1');

      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
      expect(calls[1]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('POSTs /session/:id/resume and omits cwd when absent', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/bound',
          attached: false,
          state: {},
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.resumeSession('with/slash');

      expect(calls[0]?.url).toBe('http://daemon/session/with%2Fslash/resume');
      expect(JSON.parse(calls[0]!.body!)).toEqual({});
    });

    it('throws DaemonHttpError on restore failures', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'missing' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.loadSession('missing')).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('cancel', () => {
    it('POSTs /cancel and tolerates 204', async () => {
      const { fetch, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.cancel('s-1');
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/cancel');
      expect(calls[0]?.method).toBe('POST');
    });

    it('sends client identity header on cancel', async () => {
      const { fetch, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.cancel('s-1', 'client-1');
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('throws on 404', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'unknown', sessionId: 's-1' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.cancel('s-1')).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('heartbeat', () => {
    it('POSTs /heartbeat with an empty JSON body and returns the result', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          lastSeenAt: 1_700_000_000_000,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.heartbeat('s-1');
      expect(result).toEqual({
        sessionId: 's-1',
        lastSeenAt: 1_700_000_000_000,
      });
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/heartbeat');
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.body).toBe('{}');
    });

    it('sends the client identity header when provided', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          clientId: 'client-1',
          lastSeenAt: 1_700_000_000_001,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.heartbeat('s-1', 'client-1');
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
      expect(result.clientId).toBe('client-1');
    });

    it('throws DaemonHttpError on 404 (unknown session)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'unknown', sessionId: 's-1' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.heartbeat('s-1')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('throws DaemonHttpError on 400 invalid_client_id', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(400, {
          error: 'unknown client',
          code: 'invalid_client_id',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.heartbeat('s-1', 'forged')).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('respondToPermission', () => {
    it('returns true on 200', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const accepted = await client.respondToPermission('req-1', {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
      expect(accepted).toBe(true);
      expect(calls[0]?.url).toBe('http://daemon/permission/req-1');
    });

    it('sends client identity header on permission votes', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.respondToPermission(
        'req-1',
        { outcome: { outcome: 'cancelled' } },
        'client-1',
      );
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('returns false on 404 (lost the race)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'unknown', requestId: 'req-1' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const accepted = await client.respondToPermission('req-1', {
        outcome: { outcome: 'cancelled' },
      });
      expect(accepted).toBe(false);
    });

    it('throws on 400 (malformed outcome)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(400, { error: 'bad outcome' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.respondToPermission('req-1', {
          outcome: { outcome: 'cancelled' },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('POSTs session-scoped permission votes', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const accepted = await client.respondToSessionPermission(
        's-1',
        'req/1',
        { outcome: { outcome: 'cancelled' } },
        'client-1',
      );
      expect(accepted).toBe(true);
      expect(calls[0]?.url).toBe(
        'http://daemon/session/s-1/permission/req%2F1',
      );
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('returns false on session-scoped permission 404', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'missing' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.respondToSessionPermission('s-1', 'missing', {
          outcome: { outcome: 'cancelled' },
        }),
      ).resolves.toBe(false);
    });

    it('respondToSessionPermission throws on non-200/non-404 responses', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(400, {
          error: 'bad option',
          code: 'invalid_option_id',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.respondToSessionPermission('s-1', 'req-1', {
          outcome: { outcome: 'cancelled' },
        }),
      ).rejects.toMatchObject({
        status: 400,
        body: { error: 'bad option', code: 'invalid_option_id' },
      });
    });
  });

  describe('closeSession', () => {
    it('sends DELETE to /session/:id and returns void on 204', async () => {
      const { fetch, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.closeSession('s-1');
      expect(calls[0]?.url).toBe('http://daemon/session/s-1');
      expect(calls[0]?.method).toBe('DELETE');
    });

    it('returns void on 404 (idempotent — session already gone)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'not found' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.closeSession('s-1')).resolves.toBeUndefined();
    });

    it('sends client identity header', async () => {
      const { fetch, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.closeSession('s-1', 'client-1');
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('throws on 500', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(500, { error: 'boom' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.closeSession('s-1')).rejects.toMatchObject({
        status: 500,
      });
    });
  });

  describe('deleteSessionsData', () => {
    it('POSTs to /sessions/delete with sessionIds in body and returns result', async () => {
      const result = {
        removed: ['s-1', 's-2'],
        notFound: ['s-3'],
        errors: [],
      };
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, result));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const res = await client.deleteSessionsData(['s-1', 's-2', 's-3']);
      expect(res).toEqual(result);
      expect(calls[0]?.url).toBe('http://daemon/sessions/delete');
      expect(calls[0]?.method).toBe('POST');
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        sessionIds: ['s-1', 's-2', 's-3'],
      });
    });

    it('sends client identity header', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { removed: [], notFound: [], errors: [] }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.deleteSessionsData(['s-1'], 'client-1');
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('sends Content-Type application/json', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { removed: [], notFound: [], errors: [] }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.deleteSessionsData(['s-1']);
      expect(calls[0]?.headers['content-type']).toBe('application/json');
    });

    it('throws DaemonHttpError on non-2xx', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(500, { error: 'boom' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.deleteSessionsData(['s-1'])).rejects.toBeInstanceOf(
        DaemonHttpError,
      );
    });
  });

  describe('updateSessionMetadata', () => {
    it('sends PATCH to /session/:id/metadata and returns effective metadata', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          displayName: 'My Session',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.updateSessionMetadata('s-1', {
        displayName: 'My Session',
      });
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/metadata');
      expect(calls[0]?.method).toBe('PATCH');
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        displayName: 'My Session',
      });
      expect(result).toEqual({ displayName: 'My Session' });
    });

    it('sends client identity header', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.updateSessionMetadata(
        's-1',
        { displayName: 'test' },
        'client-1',
      );
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('throws on 404', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'not found' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.updateSessionMetadata('s-1', { displayName: 'test' }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('subscribeEvents', () => {
    it('GETs /events and yields parsed frames', async () => {
      const { fetch, calls } = recordingFetch(() =>
        sseResponse(
          'id: 1\nevent: session_update\ndata: {"id":1,"v":1,"type":"session_update","data":"a"}\n\n' +
            'id: 2\nevent: session_update\ndata: {"id":2,"v":1,"type":"session_update","data":"b"}\n\n',
        ),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const events = [];
      for await (const e of client.subscribeEvents('s-1')) events.push(e);
      expect(events.map((e) => e.id)).toEqual([1, 2]);
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/events');
      expect(calls[0]?.headers['accept']).toBe('text/event-stream');
    });

    it('forwards Last-Event-ID', async () => {
      const { fetch, calls } = recordingFetch(() => sseResponse(''));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      // Drain immediately — empty stream.
      for await (const _ of client.subscribeEvents('s-1', {
        lastEventId: 42,
      })) {
        /* unreachable */
      }
      expect(calls[0]?.headers['last-event-id']).toBe('42');
    });

    it('throws DaemonHttpError when the daemon returns a non-2xx for events', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'unknown', sessionId: 'missing' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const iter = client.subscribeEvents('missing');
      await expect(iter.next()).rejects.toMatchObject({ status: 404 });
    });

    it('appends ?maxQueued=N when SubscribeOptions.maxQueued is set', async () => {
      const { fetch, calls } = recordingFetch(() => sseResponse(''));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      for await (const _ of client.subscribeEvents('s-1', {
        maxQueued: 512,
      })) {
        /* unreachable */
      }
      expect(calls[0]?.url).toBe(
        'http://daemon/session/s-1/events?maxQueued=512',
      );
    });

    it('omits the query string when maxQueued is undefined', async () => {
      const { fetch, calls } = recordingFetch(() => sseResponse(''));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      for await (const _ of client.subscribeEvents('s-1', {
        lastEventId: 7,
      })) {
        /* unreachable */
      }
      // Bare events URL — no `?` introduced when the caller didn't ask.
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/events');
      expect(calls[0]?.headers['last-event-id']).toBe('7');
    });

    it('propagates a server 400 invalid_max_queued unchanged', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(400, {
          error: '`maxQueued` must be in [16, 2048]',
          code: 'invalid_max_queued',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const iter = client.subscribeEvents('s-1', { maxQueued: 9999 });
      await expect(iter.next()).rejects.toMatchObject({
        status: 400,
        body: { code: 'invalid_max_queued' },
      });
    });
  });

  describe('listWorkspaceSessions', () => {
    it('GETs /workspace/:id/sessions and returns the array', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessions: [
            { sessionId: 's-1', workspaceCwd: '/work/a' },
            { sessionId: 's-2', workspaceCwd: '/work/a' },
          ],
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const sessions = await client.listWorkspaceSessions('/work/a');
      expect(sessions).toHaveLength(2);
      // The cwd must be URL-encoded so the slashes don't collide with the
      // route segments.
      expect(calls[0]?.url).toBe(
        'http://daemon/workspace/%2Fwork%2Fa/sessions',
      );
    });

    it('throws on non-2xx (e.g. 400 from a relative path)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(400, { error: 'must be absolute' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.listWorkspaceSessions('relative'),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('setSessionModel', () => {
    it('POSTs the modelId in the body and returns the agent response', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.setSessionModel('s-1', 'qwen3-coder');
      expect(result).toEqual({});
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/model');
      expect(calls[0]?.method).toBe('POST');
      expect(JSON.parse(calls[0]!.body!)).toEqual({ modelId: 'qwen3-coder' });
    });

    it('sends client identity header on model switches', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.setSessionModel('s-1', 'qwen3-coder', 'client-1');
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('throws on 404 (unknown session)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'unknown', sessionId: 's-1' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.setSessionModel('s-1', 'qwen3-coder'),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('setSessionApprovalMode (#4175 Wave 4 PR 17)', () => {
    it('POSTs the mode and returns the typed result', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          mode: 'yolo',
          previous: 'default',
          persisted: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.setSessionApprovalMode('s-1', 'yolo');
      expect(result).toEqual({
        sessionId: 's-1',
        mode: 'yolo',
        previous: 'default',
        persisted: false,
      });
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/approval-mode');
      expect(calls[0]?.method).toBe('POST');
      expect(JSON.parse(calls[0]!.body!)).toEqual({ mode: 'yolo' });
    });

    it('forwards persist:true in the body when requested', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          mode: 'auto-edit',
          previous: 'default',
          persisted: true,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.setSessionApprovalMode('s-1', 'auto-edit', {
        persist: true,
      });
      expect(result.persisted).toBe(true);
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        mode: 'auto-edit',
        persist: true,
      });
    });

    it('omits persist field when persist is undefined or false', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          mode: 'yolo',
          previous: 'default',
          persisted: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.setSessionApprovalMode('s-1', 'yolo', { persist: false });
      expect(JSON.parse(calls[0]!.body!)).toEqual({ mode: 'yolo' });
    });

    it('sends X-Qwen-Client-Id when supplied', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          mode: 'plan',
          previous: 'default',
          persisted: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.setSessionApprovalMode('s-1', 'plan', {
        clientId: 'client-1',
      });
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('throws on 403 trust-gate rejection', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(403, {
          error: 'untrusted folder',
          code: 'trust_gate',
          errorKind: 'auth_env_error',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.setSessionApprovalMode('s-1', 'yolo'),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('recapSession (#4175 follow-up)', () => {
    it('POSTs an empty body and returns the typed recap', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          sessionId: 's-1',
          recap:
            'Debugging the auth retry race. Next: add deterministic timing.',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.recapSession('s-1');
      expect(result).toEqual({
        sessionId: 's-1',
        recap: 'Debugging the auth retry race. Next: add deterministic timing.',
      });
      expect(calls[0]?.url).toBe('http://daemon/session/s-1/recap');
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.body).toBe('{}');
    });

    it('returns recap:null verbatim when the daemon reports best-effort failure', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(200, { sessionId: 's-1', recap: null }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.recapSession('s-1');
      expect(result.recap).toBeNull();
    });

    it('URL-encodes the session id', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { sessionId: 's/1', recap: 'x' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.recapSession('s/1');
      expect(calls[0]?.url).toBe('http://daemon/session/s%2F1/recap');
    });

    it('forwards X-Qwen-Client-Id when supplied', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { sessionId: 's-1', recap: 'x' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.recapSession('s-1', { clientId: 'client-1' });
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('forwards the AbortSignal so callers can cancel mid-flight', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { sessionId: 's-1', recap: 'x' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const ctrl = new AbortController();
      await client.recapSession('s-1', { signal: ctrl.signal });
      expect(calls[0]?.signal).toBe(ctrl.signal);
    });

    it('throws on 404 when session is unknown', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, {
          error: 'session not found',
          code: 'session_not_found',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.recapSession('s-1')).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('setWorkspaceToolEnabled (#4175 Wave 4 PR 17)', () => {
    it('POSTs the enabled flag and URL-encodes the tool name', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { toolName: 'Bash', enabled: false }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.setWorkspaceToolEnabled('Bash', false);
      expect(result).toEqual({ toolName: 'Bash', enabled: false });
      expect(calls[0]?.url).toBe('http://daemon/workspace/tools/Bash/enable');
      expect(calls[0]?.method).toBe('POST');
      expect(JSON.parse(calls[0]!.body!)).toEqual({ enabled: false });
    });

    it('encodes MCP-qualified tool names with double underscores', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          toolName: 'mcp__github__create_issue',
          enabled: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.setWorkspaceToolEnabled('mcp__github__create_issue', false);
      // `encodeURIComponent` does NOT encode `_`, so the path stays
      // readable; the assertion pins this so a well-meaning future
      // refactor that double-encodes accidentally is caught.
      expect(calls[0]?.url).toBe(
        'http://daemon/workspace/tools/mcp__github__create_issue/enable',
      );
    });

    it('forwards X-Qwen-Client-Id when supplied', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { toolName: 'Bash', enabled: false }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.setWorkspaceToolEnabled('Bash', false, {
        clientId: 'client-1',
      });
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('throws on 401 when daemon strict-gates the route', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(401, { error: 'token required', code: 'token_required' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.setWorkspaceToolEnabled('Bash', false),
      ).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('initWorkspace (#4175 Wave 4 PR 17)', () => {
    it('POSTs an empty body when force is omitted', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { path: '/work/QWEN.md', action: 'created' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.initWorkspace();
      expect(result).toEqual({ path: '/work/QWEN.md', action: 'created' });
      expect(calls[0]?.url).toBe('http://daemon/workspace/init');
      expect(calls[0]?.method).toBe('POST');
      expect(JSON.parse(calls[0]!.body!)).toEqual({});
    });

    it('forwards force:true in the body', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { path: '/work/QWEN.md', action: 'overwrote' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.initWorkspace({ force: true });
      expect(result.action).toBe('overwrote');
      expect(JSON.parse(calls[0]!.body!)).toEqual({ force: true });
    });

    it('omits force when explicitly false (default-empty body)', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { path: '/work/QWEN.md', action: 'created' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.initWorkspace({ force: false });
      expect(JSON.parse(calls[0]!.body!)).toEqual({});
    });

    it('throws on 409 conflict', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(409, {
          error: 'file exists',
          code: 'workspace_init_conflict',
          path: '/work/QWEN.md',
          existingSize: 1234,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.initWorkspace()).rejects.toMatchObject({
        status: 409,
      });
    });
  });

  describe('MCP restart timeout coupling (#4330)', () => {
    it('SDK default timeout equals server deadline + client headroom', async () => {
      const { MCP_RESTART_SERVER_DEADLINE_MS, MCP_RESTART_CLIENT_HEADROOM_MS } =
        await import('@qwen-code/acp-bridge/mcpTimeouts');
      const expected =
        MCP_RESTART_SERVER_DEADLINE_MS + MCP_RESTART_CLIENT_HEADROOM_MS;
      expect(expected).toBe(330_000);
      expect(MCP_RESTART_SERVER_DEADLINE_MS).toBe(300_000);
      expect(MCP_RESTART_CLIENT_HEADROOM_MS).toBeGreaterThanOrEqual(10_000);
    });
  });

  describe('restartMcpServer (#4175 Wave 4 PR 17)', () => {
    it('POSTs an empty body and returns the typed result on success', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          serverName: 'docs',
          restarted: true,
          durationMs: 1234,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.restartMcpServer('docs');
      expect(result).toEqual({
        serverName: 'docs',
        restarted: true,
        durationMs: 1234,
      });
      expect(calls[0]?.url).toBe('http://daemon/workspace/mcp/docs/restart');
      expect(calls[0]?.method).toBe('POST');
      expect(JSON.parse(calls[0]!.body!)).toEqual({});
    });

    it('returns the soft-skip discriminated shape unchanged', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(200, {
          serverName: 'docs',
          restarted: false,
          skipped: true,
          reason: 'in_flight',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.restartMcpServer('docs');
      expect(result).toEqual({
        serverName: 'docs',
        restarted: false,
        skipped: true,
        reason: 'in_flight',
      });
    });

    it('URL-encodes the server name', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          serverName: 'foo bar',
          restarted: true,
          durationMs: 0,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.restartMcpServer('foo bar');
      expect(calls[0]?.url).toBe(
        'http://daemon/workspace/mcp/foo%20bar/restart',
      );
    });

    it('forwards X-Qwen-Client-Id when supplied', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          serverName: 'docs',
          restarted: true,
          durationMs: 0,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.restartMcpServer('docs', { clientId: 'client-1' });
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('forwards entryIndex and returns pool entry results', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          serverName: 'docs',
          entries: [
            { entryIndex: 3, restarted: true, durationMs: 42 },
            { entryIndex: 4, restarted: false, reason: 'in_flight' },
          ],
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.restartMcpServer('docs', { entryIndex: 3 });
      expect(calls[0]?.url).toBe(
        'http://daemon/workspace/mcp/docs/restart?entryIndex=3',
      );
      expect('entries' in result).toBe(true);
      if (!('entries' in result)) throw new Error('expected entry results');
      expect(result.entries).toEqual([
        { entryIndex: 3, restarted: true, durationMs: 42 },
        { entryIndex: 4, restarted: false, reason: 'in_flight' },
      ]);
    });

    it('forwards wildcard entryIndex unchanged', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          serverName: 'docs',
          entries: [],
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

      await client.restartMcpServer('docs', { entryIndex: '*' });

      expect(calls[0]?.url).toBe(
        'http://daemon/workspace/mcp/docs/restart?entryIndex=*',
      );
    });

    it('throws on 404 when the daemon reports an unknown server', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, { error: 'no such server' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.restartMcpServer('ghost')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('survives a slow daemon response longer than the client default timeout (#4282 fold-in 5 P2-3)', async () => {
      // The daemon-side restart waits up to 300s for stdio MCP
      // discovery. The client-wide `fetchTimeoutMs` defaults to 30s,
      // so without the per-call override, a valid 60s+ restart would
      // be aborted client-side while the daemon kept working.
      // Simulate a 1.2s response with the default 1s `fetchTimeoutMs`
      // — without the override the call would timeout; with it the
      // call resolves successfully.
      //
      // #4297 fold-in 2 (copilot, wenshao C2): the stub must
      // observe `init.signal` so a regression that removes the
      // per-call override (and thus the 1s default fires) actually
      // rejects the in-flight promise. The previous version resolved
      // the response unconditionally and the test passed even when
      // the abort signal had already fired — false-negative coverage.
      let resolveResponse: ((v: Response) => void) | undefined;
      let rejectResponse: ((reason: unknown) => void) | undefined;
      const slowFetch = vi.fn(
        (_input: RequestInfo | URL, init?: { signal?: AbortSignal | null }) =>
          new Promise<Response>((resolve, reject) => {
            resolveResponse = resolve;
            rejectResponse = reject;
            init?.signal?.addEventListener('abort', () => {
              reject(
                init.signal!.reason ??
                  new DOMException('aborted', 'AbortError'),
              );
            });
          }),
      );
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch: slowFetch as unknown as typeof globalThis.fetch,
        fetchTimeoutMs: 1_000,
      });
      const inflight = client.restartMcpServer('docs');
      // Resolve the promise after the client default would have timed
      // out — proving the per-call override extends the budget. The
      // abort listener above guarantees that if the override is ever
      // removed, this resolve never fires (the abort rejects first).
      void rejectResponse;
      setTimeout(() => {
        resolveResponse?.(
          jsonResponse(200, {
            serverName: 'docs',
            restarted: true,
            durationMs: 1200,
          }),
        );
      }, 1_200);
      await expect(inflight).resolves.toMatchObject({
        serverName: 'docs',
        restarted: true,
      });
    });

    it('honors a caller-provided `timeoutMs` override (#4282 fold-in 5 P2-3)', async () => {
      // When the caller sets a tighter cap, the per-call override
      // wins over the 5-minute default. Verify by passing a 50ms
      // budget against a stub that rejects only when its
      // `init.signal` aborts — proving the abort actually fired
      // rather than relying on a sleep racing the timeout.
      const slowFetch = vi.fn(
        (_input: RequestInfo | URL, init?: { signal?: AbortSignal | null }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(
                init.signal!.reason ??
                  new DOMException('aborted', 'AbortError'),
              );
            });
          }),
      );
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch: slowFetch as unknown as typeof globalThis.fetch,
      });
      await expect(
        client.restartMcpServer('docs', { timeoutMs: 50 }),
      ).rejects.toThrow();
    });

    it('honors `timeoutMs: 0` as "disable the timeout" (#4297 fold-in 2 C1)', async () => {
      // The JSDoc on `restartMcpServer` documents `0` as "disable
      // the timeout entirely". Use a 1ms client-wide default so a
      // regression that ignores the 0 override would abort almost
      // immediately. The slow stub resolves after 50ms — well past
      // the 1ms default but only because 0 disables the timer.
      //
      // #4297 fold-in 4 (wenshao critical, addresses #3260810242):
      // the stub must observe `init.signal` and reject on abort.
      // Without the listener, a regression where the override is
      // ignored fires the AbortController at 1ms but the stub never
      // sees it — the promise stays pending until the 50ms
      // `resolveResponse` wins, leaving the test green and the
      // "0 disables timeout" contract unprotected. Mirrors the
      // listener pattern in the two sibling tests above.
      let resolveResponse: ((v: Response) => void) | undefined;
      const slowFetch = vi.fn(
        (_input: RequestInfo | URL, init?: { signal?: AbortSignal | null }) =>
          new Promise<Response>((resolve, reject) => {
            resolveResponse = resolve;
            init?.signal?.addEventListener('abort', () => {
              reject(
                init.signal!.reason ??
                  new DOMException('aborted', 'AbortError'),
              );
            });
          }),
      );
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch: slowFetch as unknown as typeof globalThis.fetch,
        fetchTimeoutMs: 1,
      });
      const inflight = client.restartMcpServer('docs', { timeoutMs: 0 });
      setTimeout(() => {
        resolveResponse?.(
          jsonResponse(200, {
            serverName: 'docs',
            restarted: true,
            durationMs: 50,
          }),
        );
      }, 50);
      await expect(inflight).resolves.toMatchObject({
        serverName: 'docs',
        restarted: true,
      });
    });
  });

  describe('error coercion', () => {
    it('falls back to text body when the response is not JSON', async () => {
      const { fetch } = recordingFetch(
        () =>
          new Response('plaintext error from upstream', {
            status: 502,
            headers: { 'content-type': 'text/plain' },
          }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const err = await client.health().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DaemonHttpError);
      expect((err as DaemonHttpError).status).toBe(502);
      expect((err as DaemonHttpError).body).toBe(
        'plaintext error from upstream',
      );
    });

    it('respondToPermission throws on 5xx', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(503, { error: 'agent crashed' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.respondToPermission('req-1', {
          outcome: { outcome: 'cancelled' },
        }),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('subscribeEvents edge cases', () => {
    it('throws when the response body is null', async () => {
      const { fetch } = recordingFetch(
        () =>
          new Response(null, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const iter = client.subscribeEvents('s-1');
      await expect(iter.next()).rejects.toThrow(/No SSE body/);
    });

    it('throws DaemonHttpError when content-type is not text/event-stream', async () => {
      // E.g. a misconfigured proxy returns 200 + JSON instead of SSE.
      // Without the content-type guard the parser would silently produce
      // zero events.
      const { fetch } = recordingFetch(
        () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const iter = client.subscribeEvents('s-1');
      await expect(iter.next()).rejects.toMatchObject({
        status: 200,
      });
    });

    it('applies fetchTimeoutMs to the connect phase only — never-resolving fetch aborts (A-UsS)', async () => {
      // The CONNECT phase (request → headers received) must respect
      // `fetchTimeoutMs`; the SSE body itself must NOT be timed out.
      // Verify the timer fires when headers never arrive.
      const fetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            );
          }),
      ) as unknown as typeof globalThis.fetch;
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        fetchTimeoutMs: 50,
      });
      const before = Date.now();
      const iter = client.subscribeEvents('s-1');
      await expect(iter.next()).rejects.toThrow();
      const elapsed = Date.now() - before;
      // Generous bound — just confirms the timer fired.
      expect(elapsed).toBeLessThan(2000);
    });

    it('clears the connect-timeout when headers arrive promptly (A-UsS)', async () => {
      // A fast-resolving fetch must NOT leave the timer pending,
      // otherwise vitest would see a dangling handle that keeps the
      // event loop alive past the test (flake on slow CI).
      const { fetch } = recordingFetch(() => sseResponse(''));
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        fetchTimeoutMs: 60_000, // long; if we don't clear it, the test would hang
      });
      const iter = client.subscribeEvents('s-1');
      const first = await iter.next();
      expect(first.done).toBe(true);
      // We reach this line in < a second; the 60s timer was cleared.
    });
  });

  describe('URL encoding of session-scoped endpoints', () => {
    it('cancel encodes a slash-bearing sessionId', async () => {
      const { fetch, calls } = recordingFetch(
        () => new Response(null, { status: 204 }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.cancel('weird/id');
      expect(calls[0]?.url).toBe('http://daemon/session/weird%2Fid/cancel');
    });

    it('respondToPermission encodes a slash-bearing requestId', async () => {
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, {}));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.respondToPermission('weird/req', {
        outcome: { outcome: 'cancelled' },
      });
      expect(calls[0]?.url).toBe('http://daemon/permission/weird%2Freq');
    });
  });

  describe('baseUrl normalization', () => {
    it('strips trailing slashes', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, { status: 'ok' }),
      );
      const client = new DaemonClient({
        baseUrl: 'http://daemon/////',
        fetch,
      });
      await client.health();
      expect(calls[0]?.url).toBe('http://daemon/health');
    });
  });

  describe('fetchWithTimeout', () => {
    it('aborts the underlying fetch when the configured timeout fires', async () => {
      // Fetch that *never* resolves on its own — only abort can end it.
      // This is what the polyfill paths (`abortTimeout` /
      // `composeAbortSignals`) need to actually exercise; the rest of
      // the suite uses synchronous-resolving fakes that never trigger
      // the timeout machinery.
      const fetch = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            );
          }),
      ) as unknown as typeof globalThis.fetch;
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        fetchTimeoutMs: 50,
      });
      const before = Date.now();
      await expect(client.health()).rejects.toThrow();
      const elapsed = Date.now() - before;
      // Generous upper bound — we just want to know the timer fired
      // (not that the test runner waited the full default 5s).
      expect(elapsed).toBeLessThan(2000);
    });

    it('aborts when the response BODY stalls after headers (BRN1o)', async () => {
      // Pre-fix bug: `fetchWithTimeout` cleared the timer the moment
      // `fetch` resolved (i.e. headers received). If the body then
      // stalled (proxy half-buffered, daemon hung mid-write), the
      // subsequent `await res.json()` had no deadline and could hang
      // indefinitely. Now the body-read happens INSIDE the timer
      // scope (via the `consume` callback), so this test exercises
      // the timer firing during body consumption.
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        // Build a Response whose body never delivers data and never
        // closes on its own — the only way `res.json()` ever
        // returns is if the timer aborts via the composed signal.
        // Wire the abort to `controller.error(...)` (NOT
        // `body.cancel()` — that throws on a locked stream once
        // `res.json()` has started reading) so the in-flight read
        // rejects naturally.
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              try {
                controller.error(
                  new DOMException('The operation timed out', 'TimeoutError'),
                );
              } catch {
                /* stream already errored / closed */
              }
            });
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as unknown as typeof globalThis.fetch;
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch,
        fetchTimeoutMs: 80,
      });
      const before = Date.now();
      await expect(client.health()).rejects.toThrow();
      const elapsed = Date.now() - before;
      // Pre-fix: this would hang for the test's outer timeout (5s+).
      // Post-fix: the timer fires ~80ms in, body read rejects.
      expect(elapsed).toBeLessThan(2000);
    });

    it('composeAbortSignals forwards the first abort, with or without native AbortSignal.any', async () => {
      // Direct-unit test on the helper — `subscribeEvents` bypasses
      // `fetchWithTimeout` entirely (it calls `_fetch` directly with
      // the caller's signal), so testing through subscribeEvents
      // never exercises the polyfill. Calling `composeAbortSignals`
      // here covers it on all Node versions: native (`>=20.3`) and
      // polyfill (`18.0`–`20.2`) take the same input shape.
      const a = new AbortController();
      const b = new AbortController();
      const composed = composeAbortSignals([a.signal, b.signal]);
      expect(composed.aborted).toBe(false);
      a.abort(new DOMException('first', 'AbortError'));
      // The composed signal should follow whichever input fires first.
      // Allow a microtask for native AbortSignal.any propagation.
      await Promise.resolve();
      expect(composed.aborted).toBe(true);
    });

    it('composeAbortSignals fires immediately if any input is already aborted', () => {
      const a = new AbortController();
      a.abort();
      const b = new AbortController();
      const composed = composeAbortSignals([a.signal, b.signal]);
      expect(composed.aborted).toBe(true);
    });

    it('abortTimeout fires after the configured delay', async () => {
      const t0 = Date.now();
      const sig = abortTimeout(40);
      await new Promise<void>((resolve) =>
        sig.addEventListener('abort', () => resolve(), { once: true }),
      );
      const elapsed = Date.now() - t0;
      // Generous tolerance — just checking the timer fires.
      expect(elapsed).toBeGreaterThanOrEqual(30);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe('requireWorkspaceCwd', () => {
    // Helper: build a `DaemonCapabilities`-shaped envelope without
    // having to spell out the unrelated fields on every call.
    const caps = (overrides: Partial<DaemonCapabilities>): DaemonCapabilities =>
      ({
        v: 1,
        mode: 'http-bridge',
        features: [],
        modelServices: [],
        ...overrides,
      }) as DaemonCapabilities;

    it('returns the workspaceCwd when populated', () => {
      expect(requireWorkspaceCwd(caps({ workspaceCwd: '/work/bound' }))).toBe(
        '/work/bound',
      );
    });

    it('throws DaemonCapabilityMissingError when the field is undefined (pre-§02 daemon)', () => {
      // Pre-§02 daemons emit v=1 envelopes without `workspaceCwd`.
      // The helper exists so SDK consumers get an actionable error
      // instead of a downstream `Cannot read properties of undefined`.
      expect(() => requireWorkspaceCwd(caps({}))).toThrow(
        DaemonCapabilityMissingError,
      );
      const err = (() => {
        try {
          requireWorkspaceCwd(caps({}));
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(DaemonCapabilityMissingError);
      expect((err as DaemonCapabilityMissingError).capability).toBe(
        'workspaceCwd',
      );
      expect((err as DaemonCapabilityMissingError).message).toMatch(
        /predates the feature|workspaceCwd/,
      );
    });

    it('treats empty-string as missing (defensive)', () => {
      // A daemon that erroneously sends `workspaceCwd: ""` would
      // otherwise satisfy `typeof === 'string'` while still being
      // useless to consumers. Treat it like a missing field so the
      // call site lands in the same error branch.
      expect(() => requireWorkspaceCwd(caps({ workspaceCwd: '' }))).toThrow(
        DaemonCapabilityMissingError,
      );
    });
  });

  describe('workspace memory + agents helpers (issue #4175 PR 16)', () => {
    it('GETs /workspace/memory and parses the snapshot', async () => {
      const snapshot = {
        v: 1,
        workspaceCwd: '/work/a',
        initialized: true,
        files: [
          {
            kind: 'memory_file' as const,
            path: '/work/a/QWEN.md',
            scope: 'workspace' as const,
            bytes: 42,
          },
        ],
        totalBytes: 42,
        fileCount: 1,
        ruleCount: 0,
      };
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, snapshot),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.workspaceMemory()).resolves.toEqual(snapshot);
      expect(calls[0]).toMatchObject({
        method: 'GET',
        url: 'http://daemon/workspace/memory',
      });
    });

    it('POSTs /workspace/memory and forwards X-Qwen-Client-Id', async () => {
      const reply = {
        ok: true,
        filePath: '/work/QWEN.md',
        bytesWritten: 17,
        mode: 'append',
        changed: true,
      };
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, reply));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.writeWorkspaceMemory(
        { scope: 'workspace', mode: 'append', content: '- entry' },
        'client-7',
      );
      expect(result).toEqual(reply);
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.url).toBe('http://daemon/workspace/memory');
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-7');
      const body = JSON.parse(calls[0]!.body!);
      expect(body).toEqual({
        scope: 'workspace',
        mode: 'append',
        content: '- entry',
      });
    });

    it('throws DaemonHttpError on non-2xx workspace memory writes', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(401, { error: 'token required', code: 'token_required' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.writeWorkspaceMemory({
          scope: 'workspace',
          mode: 'append',
          content: 'x',
        }),
      ).rejects.toBeInstanceOf(DaemonHttpError);
    });

    it('GETs /workspace/agents (list) and /workspace/agents/:id (detail)', async () => {
      const list = {
        v: 1,
        workspaceCwd: '/work/a',
        agents: [
          {
            kind: 'agent' as const,
            name: 'reviewer',
            description: 'reviews code',
            level: 'project' as const,
            isBuiltin: false,
            hasTools: false,
          },
        ],
      };
      const detail = {
        kind: 'agent' as const,
        name: 'reviewer',
        description: 'reviews code',
        level: 'project' as const,
        isBuiltin: false,
        hasTools: false,
        systemPrompt: 'you are a reviewer',
      };
      const { fetch, calls } = recordingFetch((req) => {
        if (req.url.endsWith('/workspace/agents'))
          return jsonResponse(200, list);
        if (req.url.endsWith('/workspace/agents/reviewer')) {
          return jsonResponse(200, detail);
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.listWorkspaceAgents()).resolves.toEqual(list);
      await expect(client.getWorkspaceAgent('reviewer')).resolves.toEqual(
        detail,
      );
      expect(calls.map((c) => [c.method, c.url])).toEqual([
        ['GET', 'http://daemon/workspace/agents'],
        ['GET', 'http://daemon/workspace/agents/reviewer'],
      ]);
    });

    it('encodes the agentType path segment', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(404, { error: 'not found', code: 'agent_not_found' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.getWorkspaceAgent('with/slash'),
      ).rejects.toBeInstanceOf(DaemonHttpError);
      expect(calls[0]?.url).toBe('http://daemon/workspace/agents/with%2Fslash');
    });

    it('createWorkspaceAgent POSTs the body with the client id', async () => {
      const reply = {
        ok: true,
        agent: {
          kind: 'agent' as const,
          name: 'tester',
          description: 'tests',
          level: 'project' as const,
          isBuiltin: false,
          hasTools: false,
          systemPrompt: 'run tests',
        },
      };
      const { fetch, calls } = recordingFetch(() => jsonResponse(201, reply));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const out = await client.createWorkspaceAgent(
        {
          name: 'tester',
          description: 'tests',
          systemPrompt: 'run tests',
          scope: 'workspace',
        },
        'client-1',
      );
      expect(out).toEqual(reply);
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    });

    it('updateWorkspaceAgent forwards the optional scope query', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          ok: true,
          agent: {
            kind: 'agent',
            name: 'x',
            description: 'd',
            level: 'user',
            isBuiltin: false,
            hasTools: false,
            systemPrompt: 'p',
          },
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await client.updateWorkspaceAgent(
        'x',
        { description: 'd' },
        { scope: 'global' },
      );
      expect(calls[0]?.url).toBe(
        'http://daemon/workspace/agents/x?scope=global',
      );
    });

    it('updateWorkspaceAgent surfaces the daemon `changed` flag on the typed result', async () => {
      // The route emits `changed: false` on no-op updates so adapters
      // can suppress redundant cache invalidation. The SDK type
      // exposes the field as optional so typed callers can branch.
      const { fetch } = recordingFetch(() =>
        jsonResponse(200, {
          ok: true,
          agent: {
            kind: 'agent',
            name: 'x',
            description: 'd',
            level: 'project',
            isBuiltin: false,
            hasTools: false,
            systemPrompt: 'p',
          },
          changed: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const result = await client.updateWorkspaceAgent('x', {
        description: 'd',
      });
      expect(result.changed).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.agent.name).toBe('x');
    });

    it('deleteWorkspaceAgent treats 204 as success and only swallows structured 404', async () => {
      // 204 → resolves silently
      {
        const { fetch } = recordingFetch(
          () => new Response(null, { status: 204 }),
        );
        const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
        await expect(client.deleteWorkspaceAgent('x')).resolves.toBeUndefined();
      }
      // 404 with `code: agent_not_found` → idempotent success
      {
        const { fetch } = recordingFetch(() =>
          jsonResponse(404, { error: 'not found', code: 'agent_not_found' }),
        );
        const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
        await expect(client.deleteWorkspaceAgent('x')).resolves.toBeUndefined();
      }
      // 404 WITHOUT structured code (proxy / older daemon / wrong route) → throws
      {
        const { fetch } = recordingFetch(
          () =>
            new Response('Not Found', {
              status: 404,
              headers: { 'content-type': 'text/plain' },
            }),
        );
        const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
        await expect(client.deleteWorkspaceAgent('x')).rejects.toBeInstanceOf(
          DaemonHttpError,
        );
      }
    });
  });

  describe('addRuntimeMcpServer (T2.8 #4514)', () => {
    it('POSTs /workspace/mcp/servers with JSON body and returns the typed result', async () => {
      const result = {
        name: 'my-server',
        transport: 'stdio',
        replaced: false,
        shadowedSettings: false,
        toolCount: 3,
        originatorClientId: 'client-1',
      };
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, result));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const res = await client.addRuntimeMcpServer({
        name: 'my-server',
        config: { command: 'node', args: ['server.js'] },
      });
      expect(res).toEqual(result);
      expect(calls[0]?.url).toBe('http://daemon/workspace/mcp/servers');
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(calls[0]!.body!)).toEqual({
        name: 'my-server',
        config: { command: 'node', args: ['server.js'] },
      });
    });

    it('throws DaemonHttpError on non-2xx', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(400, { error: 'invalid config' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.addRuntimeMcpServer({
          name: 'bad',
          config: { command: '' },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('removeRuntimeMcpServer (T2.8 #4514)', () => {
    it('DELETEs /workspace/mcp/servers/:name with URL-encoded name', async () => {
      const result = {
        name: 'my server',
        removed: true,
        wasShadowingSettings: false,
        originatorClientId: 'client-1',
      };
      const { fetch, calls } = recordingFetch(() => jsonResponse(200, result));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const res = await client.removeRuntimeMcpServer('my server');
      expect(res).toEqual(result);
      expect(calls[0]?.url).toBe(
        'http://daemon/workspace/mcp/servers/my%20server',
      );
      expect(calls[0]?.method).toBe('DELETE');
    });

    it('throws DaemonHttpError on non-2xx', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(500, { error: 'internal' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.removeRuntimeMcpServer('ghost'),
      ).rejects.toMatchObject({ status: 500 });
    });
  });

  // PR #4255 fold-in 10 #3 — device-flow HTTP method coverage. The
  // round-8 reviewer flagged that `startDeviceFlow` /
  // `getDeviceFlow` / `cancelDeviceFlow` / `getAuthStatus` plus the
  // `client.auth` lazy getter had zero unit tests; this block
  // exercises route paths, method codes, signal forwarding (fold-in
  // 7 #6), and the `failOnError` → `DaemonHttpError` mapping.
  describe('device-flow methods (fold-in 10 #3)', () => {
    it('startDeviceFlow POSTs /workspace/auth/device-flow + forwards body / clientId header', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(201, {
          deviceFlowId: 'flow-A',
          providerId: 'qwen-oauth',
          status: 'pending',
          userCode: 'USER-1',
          verificationUri: 'https://idp.example/verify',
          expiresAt: 1_700_000_000_000,
          intervalMs: 5_000,
          attached: false,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const res = await client.startDeviceFlow({
        providerId: 'qwen-oauth',
        clientId: 'sdk-X',
      });
      expect(res.deviceFlowId).toBe('flow-A');
      expect(res.attached).toBe(false);
      const call = calls[0];
      expect(call?.url).toBe('http://daemon/workspace/auth/device-flow');
      expect(call?.method).toBe('POST');
      expect(call?.headers['x-qwen-client-id']).toBe('sdk-X');
      expect(JSON.parse(call?.body ?? '{}')).toEqual({
        providerId: 'qwen-oauth',
      });
    });

    it('startDeviceFlow accepts 200 (take-over branch) and 201 (fresh) identically', async () => {
      const body = {
        deviceFlowId: 'flow-A',
        providerId: 'qwen-oauth',
        status: 'pending',
        userCode: 'USER-1',
        verificationUri: 'https://idp.example/verify',
        expiresAt: 1_700_000_000_000,
        intervalMs: 5_000,
        attached: true,
      };
      for (const status of [200, 201]) {
        const { fetch } = recordingFetch(() => jsonResponse(status, body));
        const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
        await expect(
          client.startDeviceFlow({ providerId: 'qwen-oauth' }),
        ).resolves.toMatchObject({ attached: true });
      }
    });

    it('startDeviceFlow throws DaemonHttpError on non-2xx (e.g. 502 upstream_error)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(502, { error: 'upstream', code: 'upstream_error' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.startDeviceFlow({ providerId: 'qwen-oauth' }),
      ).rejects.toBeInstanceOf(DaemonHttpError);
    });

    it('getDeviceFlow GETs /workspace/auth/device-flow/:id with URL-encoded id', async () => {
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, {
          deviceFlowId: 'flow with space',
          providerId: 'qwen-oauth',
          status: 'authorized',
          createdAt: 1_700_000_000_000,
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const res = await client.getDeviceFlow('flow with space');
      expect(res.status).toBe('authorized');
      // RFC 3986 / encodeURIComponent — `' '` → `%20`.
      expect(calls[0]?.url).toBe(
        'http://daemon/workspace/auth/device-flow/flow%20with%20space',
      );
      expect(calls[0]?.method).toBe('GET');
    });

    it('getDeviceFlow forwards opts.signal into fetch (fold-in 7 #6)', async () => {
      const ctrl = new AbortController();
      let observedSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          observedSignal = init?.signal ?? undefined;
          return jsonResponse(200, {
            deviceFlowId: 'flow-A',
            providerId: 'qwen-oauth',
            status: 'pending',
            createdAt: 1_700_000_000_000,
          });
        },
      ) as unknown as typeof globalThis.fetch;
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetch: fetchImpl,
      });
      await client.getDeviceFlow('flow-A', { signal: ctrl.signal });
      // The fetched signal is COMPOSED with the per-request timeout
      // controller (composeAbortSignals), so we can't assert
      // identity. Instead verify that aborting the caller's signal
      // propagates to fetch's signal.
      expect(observedSignal).toBeDefined();
      expect(observedSignal!.aborted).toBe(false);
      ctrl.abort(new Error('caller-cancel'));
      expect(observedSignal!.aborted).toBe(true);
    });

    it('getDeviceFlow throws DaemonHttpError(404) on missing/evicted id', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, {
          error: 'not found',
          code: 'device_flow_not_found',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const err = await client
        .getDeviceFlow('nonexistent')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DaemonHttpError);
      expect((err as DaemonHttpError).status).toBe(404);
    });

    it('cancelDeviceFlow DELETEs /workspace/auth/device-flow/:id and resolves on 204', async () => {
      const { fetch, calls } = recordingFetch(
        () =>
          new Response(null, {
            status: 204,
          }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(
        client.cancelDeviceFlow('flow-A', { clientId: 'sdk-Y' }),
      ).resolves.toBeUndefined();
      expect(calls[0]?.method).toBe('DELETE');
      expect(calls[0]?.headers['x-qwen-client-id']).toBe('sdk-Y');
    });

    it('cancelDeviceFlow swallows 404 idempotently (matches closeSession contract)', async () => {
      // Per `cancelDeviceFlow`'s JSDoc + the daemon's DELETE route:
      // both 204 (terminal-grace no-op) and 404 (unknown / evicted)
      // resolve to undefined so retries from a SDK that's lost track
      // are safe. Non-404/204 statuses are the only error envelope.
      const { fetch } = recordingFetch(() =>
        jsonResponse(404, {
          error: 'not found',
          code: 'device_flow_not_found',
        }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.cancelDeviceFlow('nope')).resolves.toBeUndefined();
    });

    it('cancelDeviceFlow throws DaemonHttpError on non-204/404 (e.g. 500)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(500, { error: 'daemon exploded' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      await expect(client.cancelDeviceFlow('flow-A')).rejects.toBeInstanceOf(
        DaemonHttpError,
      );
    });

    it('getAuthStatus GETs /workspace/auth/status and returns the snapshot', async () => {
      const snapshot = {
        v: 1 as const,
        workspaceCwd: '/work/bound',
        providers: [],
        pendingDeviceFlows: [],
        supportedDeviceFlowProviders: ['qwen-oauth' as const],
      };
      const { fetch, calls } = recordingFetch(() =>
        jsonResponse(200, snapshot),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const res = await client.getAuthStatus();
      expect(res).toEqual(snapshot);
      expect(calls[0]?.url).toBe('http://daemon/workspace/auth/status');
      expect(calls[0]?.method).toBe('GET');
    });

    it('client.auth is a lazy DaemonAuthFlow instance (constructed on first access, then cached)', async () => {
      const { fetch } = recordingFetch(() =>
        jsonResponse(200, { status: 'ok' }),
      );
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const a = client.auth;
      const b = client.auth;
      // Same instance on subsequent reads — singleton allocation.
      expect(a).toBe(b);
    });
  });
});
