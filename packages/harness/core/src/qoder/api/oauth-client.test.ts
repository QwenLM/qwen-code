/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { QoderOAuthClient, QoderOAuthError } from './oauth-client.js';
import {
  QODER_ENV_AUTH_BASE_URL,
  QODER_ENV_OPENAPI_BASE_URL,
} from './regions.js';

const ENV = {
  [QODER_ENV_AUTH_BASE_URL]: 'https://auth.test',
  [QODER_ENV_OPENAPI_BASE_URL]: 'https://openapi.test',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('QoderOAuthClient', () => {
  it('builds a PKCE authorization URL without machine identity', () => {
    const client = new QoderOAuthClient({ region: 'global', env: ENV });
    const authorization = client.createAuthorization();

    expect(authorization.authUrl).toMatch(
      /^https:\/\/auth\.test\/device\/selectAccounts\?/,
    );
    const url = new URL(authorization.authUrl);
    expect(url.searchParams.get('sourceType')).toBe('QwenCode');
    expect(url.searchParams.get('challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_id')).toBeTruthy();
    expect(url.searchParams.get('challenge')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBe(authorization.nonce);
    expect(authorization.authUrl).not.toContain('machine_id');
    expect(authorization.verifier).not.toBe('');
  });

  it('builds a PKCE authorization URL for the cn region', () => {
    const client = new QoderOAuthClient({ region: 'cn' });
    const authorization = client.createAuthorization();

    expect(authorization.authUrl).toMatch(
      /^https:\/\/qoder\.cn\/device\/selectAccounts\?/,
    );
    expect(authorization.region).toBe('cn');
  });

  it('treats HTTP 404 as a pending poll', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('', { status: 404 }));
    const client = new QoderOAuthClient({
      region: 'global',
      env: ENV,
      fetchImpl,
    });

    await expect(
      client.pollToken({ nonce: 'nonce', verifier: 'verifier' }),
    ).resolves.toEqual({ kind: 'pending' });

    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain('/api/v1/deviceToken/poll?');
    expect(url).toContain('nonce=nonce');
    expect(url).toContain('verifier=verifier');
  });

  it('maps a successful poll into a token response', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        token: 'access-token',
        refresh_token: 'refresh-token',
        user_id: 'user-1',
        user_name: 'Ada',
        expires_in: 3600,
      }),
    );
    const client = new QoderOAuthClient({
      region: 'global',
      env: ENV,
      fetchImpl,
    });

    const result = await client.pollToken({
      nonce: 'nonce',
      verifier: 'verifier',
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.token.accessToken).toBe('access-token');
    expect(result.token.refreshToken).toBe('refresh-token');
    expect(result.token.userId).toBe('user-1');
    expect(result.token.expiresAt).toBeGreaterThan(Date.now());
  });

  it('maps the refreshed access token from device_token', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        device_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 60,
      }),
    );
    const client = new QoderOAuthClient({
      region: 'global',
      env: ENV,
      fetchImpl,
    });

    const token = await client.refresh('old-refresh');

    expect(token.accessToken).toBe('new-access');
    expect(token.refreshToken).toBe('new-refresh');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      refresh_token: 'old-refresh',
    });
  });

  it('classifies a rejected refresh as invalid_grant', async () => {
    const client = new QoderOAuthClient({
      region: 'global',
      env: ENV,
      fetchImpl: async () => new Response('', { status: 401 }),
    });

    await expect(client.refresh('expired')).rejects.toMatchObject({
      code: 'invalid_grant',
      status: 401,
    });
  });

  it('maps userinfo with a nested organization', async () => {
    const client = new QoderOAuthClient({
      region: 'global',
      env: ENV,
      fetchImpl: async () =>
        jsonResponse({
          id: 'user-1',
          nick_name: 'Ada',
          email: 'ada@example.com',
          organization: { org_id: 'org-1', org_name: 'Analytical Engines' },
        }),
    });

    await expect(client.fetchUserInfo('token')).resolves.toEqual({
      uid: 'user-1',
      nickName: 'Ada',
      email: 'ada@example.com',
      organizationId: 'org-1',
      organizationName: 'Analytical Engines',
    });
  });

  it('wraps network failures without losing the original error', async () => {
    const networkError = new Error('socket hang up');
    const client = new QoderOAuthClient({
      region: 'global',
      env: ENV,
      fetchImpl: async () => {
        throw networkError;
      },
    });

    await expect(
      client.pollToken({ nonce: 'n', verifier: 'v' }),
    ).rejects.toBe(networkError);
  });

  it('throws an invalid_response error for malformed JSON', async () => {
    const client = new QoderOAuthClient({
      region: 'global',
      env: ENV,
      fetchImpl: async () =>
        new Response('not json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await expect(
      client.pollToken({ nonce: 'n', verifier: 'v' }),
    ).rejects.toBeInstanceOf(QoderOAuthError);
  });
});
