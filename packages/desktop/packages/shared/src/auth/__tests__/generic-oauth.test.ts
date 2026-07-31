import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { exchangeGenericOAuth, refreshGenericOAuthToken } from '../generic-oauth.ts';
import type { OAuthExchangeParams } from '../oauth-flow-types.ts';

const exchangeParams: OAuthExchangeParams = {
  code: 'code-123',
  codeVerifier: 'verifier-123',
  tokenEndpoint: 'https://auth.example.com/oauth/token',
  clientId: 'client-123',
  clientSecret: 'secret-123',
  redirectUri: 'https://app.example.com/callback',
};

function mockTokenResponse(body: unknown, contentType = 'application/json') {
  globalThis.fetch = (async () =>
    new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status: 200, headers: { 'Content-Type': contentType } },
    )) as unknown as typeof globalThis.fetch;
}

describe('generic OAuth token responses', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('exchanges JSON token responses with numeric expires_in', async () => {
    mockTokenResponse({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    });

    const result = await exchangeGenericOAuth(exchangeParams);

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('exchanges form-encoded token responses with string expires_in', async () => {
    mockTokenResponse(
      'access_token=access-token&refresh_token=refresh-token&expires_in=3600',
      'application/x-www-form-urlencoded',
    );

    const result = await exchangeGenericOAuth(exchangeParams);

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects exchange responses without access_token', async () => {
    mockTokenResponse({ refresh_token: 'refresh-token', expires_in: 3600 });

    const result = await exchangeGenericOAuth(exchangeParams);

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing access_token');
  });

  it('rejects exchange responses with malformed expires_in', async () => {
    mockTokenResponse({ access_token: 'access-token', expires_in: '3600abc' });

    const result = await exchangeGenericOAuth(exchangeParams);

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid expires_in');
  });

  it('rejects unsafe JSON number expires_in values', async () => {
    mockTokenResponse({ access_token: 'access-token', expires_in: Number.MAX_SAFE_INTEGER + 1 });

    const result = await exchangeGenericOAuth(exchangeParams);

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid expires_in');
  });

  it('preserves zero-second expiries instead of treating them as missing', async () => {
    mockTokenResponse({ access_token: 'access-token', expires_in: 0 });
    const before = Date.now();

    const result = await exchangeGenericOAuth(exchangeParams);

    expect(result.success).toBe(true);
    expect(result.expiresAt).toBeGreaterThanOrEqual(before);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now());
  });

  it('rejects refresh responses without access_token', async () => {
    mockTokenResponse({ refresh_token: 'refresh-token', expires_in: 3600 });

    await expect(
      refreshGenericOAuthToken(
        'refresh-token',
        'https://auth.example.com/oauth/token',
        'client-123',
        'secret-123',
      ),
    ).rejects.toThrow('missing access_token');
  });

  it('refreshes JSON token responses with refresh_token and numeric expires_in', async () => {
    mockTokenResponse({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3600,
    });

    const result = await refreshGenericOAuthToken(
      'old-refresh-token',
      'https://auth.example.com/oauth/token',
      'client-123',
      'secret-123',
    );

    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('preserves zero-second expiries on refresh responses', async () => {
    mockTokenResponse({ access_token: 'new-access-token', expires_in: 0 });
    const before = Date.now();

    const result = await refreshGenericOAuthToken(
      'old-refresh-token',
      'https://auth.example.com/oauth/token',
      'client-123',
      'secret-123',
    );

    expect(result.accessToken).toBe('new-access-token');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now());
  });

  it('rejects refresh responses with malformed expires_in', async () => {
    mockTokenResponse({ access_token: 'access-token', expires_in: '1e3' });

    await expect(
      refreshGenericOAuthToken(
        'refresh-token',
        'https://auth.example.com/oauth/token',
        'client-123',
        'secret-123',
      ),
    ).rejects.toThrow('invalid expires_in');
  });
});
