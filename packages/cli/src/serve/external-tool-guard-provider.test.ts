/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION,
  RequiredExternalToolGuard,
} from './external-tool-guard-provider.js';

interface RecordedRequest {
  path: string;
  authorization?: string;
  body: Record<string, unknown>;
}

const openServers = new Set<http.Server>();

async function startFakeGuard(
  respond: (request: RecordedRequest, response: http.ServerResponse) => void,
): Promise<{ endpoint: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded: RecordedRequest = {
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >,
      };
      requests.push(recorded);
      respond(recorded, response);
    });
  });
  openServers.add(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
  };
}

function sendJson(response: http.ServerResponse, value: unknown): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  openServers.clear();
});

describe('RequiredExternalToolGuard', () => {
  it('performs one authenticated handshake and one correlated allow request', async () => {
    const fake = await startFakeGuard((request, response) => {
      if (request.path === '/v1/handshake') {
        sendJson(response, {
          protocolVersion: EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION,
          nonce: request.body['nonce'],
          capabilities: { prepare: true },
        });
        return;
      }
      sendJson(response, {
        protocolVersion: EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION,
        requestId: request.body['requestId'],
        allowed: true,
      });
    });
    const provider = new RequiredExternalToolGuard({
      endpoint: fake.endpoint,
      token: 'local-secret',
    });

    await provider.initialize();
    await expect(
      provider.prepare({
        sessionId: 'session-1',
        promptId: 'prompt-1',
        toolCallId: 'call-1',
        toolName: 'run_shell_command',
        arguments: { command: 'pwd' },
      }),
    ).resolves.toEqual({ allowed: true });

    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map((request) => request.path)).toEqual([
      '/v1/handshake',
      '/v1/prepare',
    ]);
    expect(
      fake.requests.every(
        (request) => request.authorization === 'Bearer local-secret',
      ),
    ).toBe(true);
    expect(fake.requests[1]?.body).toMatchObject({
      sessionId: 'session-1',
      promptId: 'prompt-1',
      toolCallId: 'call-1',
      toolName: 'run_shell_command',
      arguments: { command: 'pwd' },
    });
  });

  it('preserves a validated explicit denial', async () => {
    const fake = await startFakeGuard((request, response) => {
      sendJson(
        response,
        request.path === '/v1/handshake'
          ? {
              protocolVersion: 1,
              nonce: request.body['nonce'],
              capabilities: { prepare: true },
            }
          : {
              protocolVersion: 1,
              requestId: request.body['requestId'],
              allowed: false,
              reason: 'Change ticket is not approved',
            },
      );
    });
    const provider = new RequiredExternalToolGuard({
      endpoint: fake.endpoint,
      token: 'secret',
    });
    await provider.initialize();

    await expect(
      provider.prepare({
        sessionId: 'session-1',
        promptId: 'prompt-1',
        toolCallId: 'call-1',
        toolName: 'write_file',
        arguments: { path: '/tmp/x' },
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'Change ticket is not approved',
    });
  });

  it.each(['denied\r\nforged-log-line', 'denied\u2028forged-log-line'])(
    'rejects denial reasons containing control characters',
    async (unsafeReason) => {
      const fake = await startFakeGuard((request, response) => {
        sendJson(
          response,
          request.path === '/v1/handshake'
            ? {
                protocolVersion: 1,
                nonce: request.body['nonce'],
                capabilities: { prepare: true },
              }
            : {
                protocolVersion: 1,
                requestId: request.body['requestId'],
                allowed: false,
                reason: unsafeReason,
              },
        );
      });
      const provider = new RequiredExternalToolGuard({
        endpoint: fake.endpoint,
        token: 'secret',
      });
      await provider.initialize();

      await expect(
        provider.prepare({
          sessionId: 'session-1',
          promptId: 'prompt-1',
          toolCallId: 'call-1',
          toolName: 'write_file',
          arguments: {},
        }),
      ).rejects.toThrow('unsafe reason');
    },
  );

  it('rejects an incompatible handshake before prepare is available', async () => {
    const fake = await startFakeGuard((request, response) => {
      sendJson(response, {
        protocolVersion: 1,
        nonce: `${String(request.body['nonce'])}-wrong`,
        capabilities: { prepare: true },
      });
    });
    const provider = new RequiredExternalToolGuard({
      endpoint: fake.endpoint,
      token: 'secret',
    });

    await expect(provider.initialize()).rejects.toThrow('incompatible');
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects a prepare reply with a mismatched request id or unknown field', async () => {
    const fake = await startFakeGuard((request, response) => {
      sendJson(
        response,
        request.path === '/v1/handshake'
          ? {
              protocolVersion: 1,
              nonce: request.body['nonce'],
              capabilities: { prepare: true },
            }
          : {
              protocolVersion: 1,
              requestId: 'different-request',
              allowed: true,
              extra: true,
            },
      );
    });
    const provider = new RequiredExternalToolGuard({
      endpoint: fake.endpoint,
      token: 'secret',
    });
    await provider.initialize();

    await expect(
      provider.prepare({
        sessionId: 'session-1',
        promptId: 'prompt-1',
        toolCallId: 'call-1',
        toolName: 'write_file',
        arguments: {},
      }),
    ).rejects.toThrow('invalid');
  });

  it('rejects malformed JSON and JSON-like content types', async () => {
    let prepareCount = 0;
    const fake = await startFakeGuard((request, response) => {
      if (request.path === '/v1/handshake') {
        sendJson(response, {
          protocolVersion: 1,
          nonce: request.body['nonce'],
          capabilities: { prepare: true },
        });
        return;
      }
      prepareCount++;
      response.statusCode = 200;
      response.setHeader(
        'content-type',
        prepareCount === 1 ? 'application/json' : 'application/jsonly',
      );
      response.end(
        prepareCount === 1
          ? '{'
          : JSON.stringify({
              protocolVersion: 1,
              requestId: request.body['requestId'],
              allowed: true,
            }),
      );
    });
    const provider = new RequiredExternalToolGuard({
      endpoint: fake.endpoint,
      token: 'secret',
    });
    await provider.initialize();
    const request = {
      sessionId: 'session-1',
      promptId: 'prompt-1',
      toolCallId: 'call-1',
      toolName: 'write_file',
      arguments: {},
    };

    await expect(provider.prepare(request)).rejects.toThrow('malformed JSON');
    await expect(provider.prepare(request)).rejects.toThrow(
      'non-JSON content type',
    );
  });

  it('bounds response bodies before parsing', async () => {
    const fake = await startFakeGuard((request, response) => {
      if (request.path === '/v1/handshake') {
        sendJson(response, {
          protocolVersion: 1,
          nonce: request.body['nonce'],
          capabilities: { prepare: true },
        });
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(' '.repeat(64 * 1024 + 1));
    });
    const provider = new RequiredExternalToolGuard({
      endpoint: fake.endpoint,
      token: 'secret',
    });
    await provider.initialize();

    await expect(
      provider.prepare({
        sessionId: 'session-1',
        promptId: 'prompt-1',
        toolCallId: 'call-1',
        toolName: 'write_file',
        arguments: {},
      }),
    ).rejects.toThrow('size limit');
  });

  it('bounds request bodies before opening a prepare request', async () => {
    const fake = await startFakeGuard((request, response) => {
      sendJson(response, {
        protocolVersion: 1,
        nonce: request.body['nonce'],
        capabilities: { prepare: true },
      });
    });
    const provider = new RequiredExternalToolGuard({
      endpoint: fake.endpoint,
      token: 'secret',
    });
    await provider.initialize();

    await expect(
      provider.prepare({
        sessionId: 'session-1',
        promptId: 'prompt-1',
        toolCallId: 'call-1',
        toolName: 'write_file',
        arguments: { content: 'x'.repeat(1024 * 1024) },
      }),
    ).rejects.toThrow('request exceeds the size limit');
    expect(fake.requests).toHaveLength(1);
  });

  it('pins localhost to the numeric loopback transport', async () => {
    const fake = await startFakeGuard((request, response) => {
      sendJson(response, {
        protocolVersion: 1,
        nonce: request.body['nonce'],
        capabilities: { prepare: true },
      });
    });
    const provider = new RequiredExternalToolGuard({
      endpoint: fake.endpoint.replace('127.0.0.1', 'localhost'),
      token: 'secret',
    });

    await expect(provider.initialize()).resolves.toBeUndefined();
    expect(fake.requests).toHaveLength(1);
  });

  it('times out without retrying', async () => {
    const fake = await startFakeGuard((request, response) => {
      if (request.path === '/v1/handshake') {
        sendJson(response, {
          protocolVersion: 1,
          nonce: request.body['nonce'],
          capabilities: { prepare: true },
        });
      }
      // Intentionally leave prepare open until the client timeout.
    });
    const provider = new RequiredExternalToolGuard({
      endpoint: fake.endpoint,
      token: 'secret',
      timeoutMs: 100,
    });
    await provider.initialize();

    await expect(
      provider.prepare({
        sessionId: 'session-1',
        promptId: 'prompt-1',
        toolCallId: 'call-1',
        toolName: 'write_file',
        arguments: {},
      }),
    ).rejects.toThrow('timed out');
    expect(
      fake.requests.filter((request) => request.path === '/v1/prepare'),
    ).toHaveLength(1);
  });

  it('unrefs the request timeout timer so a pending request cannot hold the event loop', async () => {
    const timeoutMs = 4321;
    const fake = await startFakeGuard((request, response) => {
      sendJson(response, {
        protocolVersion: EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION,
        nonce: request.body['nonce'],
        capabilities: { prepare: true },
      });
    });

    const unrefSpies: MockInstance[] = [];
    const nativeSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        const timer = nativeSetTimeout(callback, delay, ...args);
        if (delay === timeoutMs) {
          unrefSpies.push(vi.spyOn(timer, 'unref'));
        }
        return timer;
      }) as typeof setTimeout);

    try {
      const provider = new RequiredExternalToolGuard({
        endpoint: fake.endpoint,
        token: 'secret',
        timeoutMs,
      });
      await provider.initialize();
    } finally {
      setTimeoutSpy.mockRestore();
    }

    expect(unrefSpies).toHaveLength(1);
    expect(unrefSpies[0]).toHaveBeenCalledOnce();
  });

  it('fails a broken connection without retrying', async () => {
    const fake = await startFakeGuard((_request, response) => {
      response.destroy();
    });
    const provider = new RequiredExternalToolGuard({
      endpoint: fake.endpoint,
      token: 'secret',
    });

    await expect(provider.initialize()).rejects.toThrow(/failed|aborted/);
    expect(fake.requests).toHaveLength(1);
  });

  it.each([
    'http://example.com',
    'http://127.0.0.1:8787/base',
    'http://user:secret@127.0.0.1:8787',
    'file:///tmp/guard.sock',
  ])('rejects unsafe endpoint %s', (endpoint) => {
    expect(
      () =>
        new RequiredExternalToolGuard({
          endpoint,
          token: 'secret',
        }),
    ).toThrow('loopback');
  });

  it.each(['', 'secret\r\nforged', 'secret\u2028forged'])(
    'rejects an unsafe provider token',
    (token) => {
      expect(
        () =>
          new RequiredExternalToolGuard({
            endpoint: 'http://127.0.0.1:8787',
            token,
          }),
      ).toThrow(/non-blank token without control characters/);
    },
  );

  it('rejects non-string provider inputs deterministically', () => {
    expect(
      () =>
        new RequiredExternalToolGuard({
          endpoint: 42,
          token: 'secret',
        } as never),
    ).toThrow(/endpoint/);
    expect(
      () =>
        new RequiredExternalToolGuard({
          endpoint: 'http://127.0.0.1:8787',
          token: {},
        } as never),
    ).toThrow(/TOKEN/);
    expect(
      () =>
        new RequiredExternalToolGuard({
          endpoint: 'http://127.0.0.1:8787',
          token: 'secret',
          timeoutMs: '3000',
        } as never),
    ).toThrow(/timeout/);
  });
});
