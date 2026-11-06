/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createManagedMcpAuthorizedFetch,
  createManagedMcpLeaseTokenProvider,
  parseManagedMcpTokenAuthority,
  type ManagedMcpTokenContext,
} from './managed-mcp-oauth.js';

const context: ManagedMcpTokenContext = {
  sessionKey: {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: 'public-session',
  },
  serverId: 'extension:tools',
  configRevision: 3,
  oauth: {
    resourceUri: 'https://mcp.example.test/mcp',
    credentialId: 'credential',
    credentialGeneration: 2,
    configRevision: 3,
    executionActorKey: 'a'.repeat(64),
  },
};

describe('Managed MCP per-request OAuth', () => {
  it('obtains a current bearer token on every request and forbids redirects', async () => {
    let revision = 0;
    const token = vi.fn(async () => `access-${++revision}`);
    const sent: string[] = [];
    const wire: typeof fetch = vi.fn(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      sent.push(new Headers(init?.headers).get('Authorization')!);
      return new Response('{}', { status: 200 });
    });
    const request = createManagedMcpAuthorizedFetch(
      context.oauth.resourceUri,
      context,
      () => true,
      token,
      wire,
    );
    await request(context.oauth.resourceUri, {
      method: 'POST',
      headers: { Authorization: 'Bearer stale' },
    });
    await request(context.oauth.resourceUri, { method: 'GET' });
    expect(token).toHaveBeenCalledTimes(2);
    expect(sent).toEqual(['Bearer access-1', 'Bearer access-2']);
  });

  it('refuses cross-origin requests before issuing a token and does not retry 401', async () => {
    const token = vi.fn(async () => 'access');
    const wire: typeof fetch = vi.fn(
      async () => new Response('{}', { status: 401 }),
    );
    const request = createManagedMcpAuthorizedFetch(
      context.oauth.resourceUri,
      context,
      () => true,
      token,
      wire,
    );
    await expect(request('https://other.example.test/mcp')).rejects.toThrow(
      'authorization_unavailable',
    );
    expect(token).not.toHaveBeenCalled();
    await expect(request(context.oauth.resourceUri)).rejects.toThrow(
      'authentication_required',
    );
    expect(wire).toHaveBeenCalledTimes(1);
    await expect(
      request(context.oauth.resourceUri, {
        headers: { Host: 'other.example.test' },
      }),
    ).rejects.toThrow();
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it('does not send a tool request after token lookup is drained or aborted', async () => {
    let active = true;
    let complete!: (value: string) => void;
    const wire: typeof fetch = vi.fn(async () => new Response('{}'));
    const request = createManagedMcpAuthorizedFetch(
      context.oauth.resourceUri,
      context,
      () => active,
      async () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
      wire,
    );
    const pending = request(context.oauth.resourceUri);
    active = false;
    complete('access');
    await expect(pending).rejects.toThrow('authorization_unavailable');
    expect(wire).not.toHaveBeenCalled();
    active = true;
    const abort = new AbortController();
    const cancelled = request(context.oauth.resourceUri, {
      signal: abort.signal,
    });
    abort.abort();
    complete('access');
    await expect(cancelled).rejects.toThrow();
    expect(wire).not.toHaveBeenCalled();
  });

  it('uses only the current Runtime lease credentials and exact committed configuration at the proxy', async () => {
    const url =
      'https://broker.example.test/internal/runtime-broker/v1/runtime-leases/lease/mcp/token';
    const authority = parseManagedMcpTokenAuthority(
      { url, bindingId: 'binding', generation: '4' },
      'lease',
    );
    const proxy: typeof fetch = vi.fn(async (destination, init) => {
      expect(destination).toBe(url);
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer lease-secret',
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        protocolVersion: 1,
        bindingId: 'binding',
        generation: '4',
        epoch: 8,
        harnessSessionId: 'public-session',
        configRevision: 3,
        serverId: 'extension:tools',
        credentialId: 'credential',
        credentialGeneration: 2,
        executionActorKey: 'a'.repeat(64),
        resourceUri: context.oauth.resourceUri,
      });
      return Response.json({ protocolVersion: 1, accessToken: 'access-token' });
    });
    const provider = createManagedMcpLeaseTokenProvider(
      {
        token: 'lease-secret',
        leaseId: 'lease',
        epoch: 8,
        tenantId: 'tenant',
        workspaceId: 'workspace',
        isolationClass: 'session',
      },
      () => authority,
      proxy,
    );
    expect(await provider(context, new AbortController().signal)).toBe(
      'access-token',
    );
    await expect(
      provider({ ...context, configRevision: 4 }, new AbortController().signal),
    ).rejects.toThrow();
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(() =>
      parseManagedMcpTokenAuthority(
        { ...authority, url: 'https://other.test/arbitrary' },
        'lease',
      ),
    ).toThrow();
  });

  it('satisfies the token proxy HTTP header contract over a real connection', async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader('Cache-Control', 'no-store');
      if (
        request.method !== 'POST' ||
        request.url !==
          '/internal/runtime-broker/v1/runtime-leases/lease/mcp/token' ||
        request.headers['content-type'] !== 'application/json' ||
        request.headers['cache-control'] !== 'no-store'
      ) {
        response.writeHead(400).end();
        return;
      }
      if (request.headers.authorization !== 'Bearer lease-secret') {
        response.writeHead(401).end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({ protocolVersion: 1, accessToken: 'from-proxy' }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const { port } = server.address() as AddressInfo;
      const provider = createManagedMcpLeaseTokenProvider(
        {
          token: 'lease-secret',
          leaseId: 'lease',
          epoch: 8,
          tenantId: 'tenant',
          workspaceId: 'workspace',
          isolationClass: 'session',
        },
        () => ({
          url: `http://127.0.0.1:${port}/internal/runtime-broker/v1/runtime-leases/lease/mcp/token`,
          bindingId: 'binding',
          generation: '4',
        }),
      );
      await expect(
        provider(context, new AbortController().signal),
      ).resolves.toBe('from-proxy');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('refuses shared workers, unavailable authorities and refresh-token-bearing proxy responses', async () => {
    const boot = {
      token: 'lease-secret',
      leaseId: 'lease',
      epoch: 8,
      tenantId: 'tenant',
      workspaceId: 'workspace',
      isolationClass: 'workspace',
    };
    const authority = {
      url: 'http://localhost/internal/runtime-broker/v1/runtime-leases/lease/mcp/token',
      bindingId: 'binding',
      generation: '1',
    };
    const proxy: typeof fetch = vi.fn(async () =>
      Response.json({
        protocolVersion: 1,
        accessToken: 'access',
        refreshToken: 'never-forward',
      }),
    );
    await expect(
      createManagedMcpLeaseTokenProvider(
        boot,
        () => authority,
        proxy,
      )(context, new AbortController().signal),
    ).rejects.toThrow();
    expect(proxy).not.toHaveBeenCalled();
    await expect(
      createManagedMcpLeaseTokenProvider(
        { ...boot, isolationClass: 'session' },
        () => undefined,
        proxy,
      )(context, new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      createManagedMcpLeaseTokenProvider(
        { ...boot, isolationClass: 'session' },
        () => authority,
        proxy,
      )(context, new AbortController().signal),
    ).rejects.toThrow();
  });
});
