/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import {
  clearGoogleOAuthCredentials,
  getGoogleOAuthCredentialPath,
  getGoogleOauthClient,
  readGoogleAccount,
  resetGoogleOauthForTesting,
  withGoogleOAuthLoginLock,
} from './oauth2.js';

vi.mock('../utils/secure-browser-launcher.js', () => ({
  openBrowserSecurely: vi.fn().mockResolvedValue(undefined),
}));

let tempHome: string;

function config(
  overrides: {
    interactive?: boolean;
    browserSuppressed?: boolean;
    proxy?: string;
  } = {},
): Config {
  return {
    getProxy: () => overrides.proxy,
    isInteractive: () => overrides.interactive ?? false,
    isBrowserLaunchSuppressed: () => overrides.browserSuppressed ?? true,
  } as Config;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), { mode: 0o600 });
}

describe('Google OAuth', () => {
  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'google-oauth-test-'));
    vi.stubEnv('QWEN_HOME', tempHome);
    resetGoogleOauthForTesting();
  });

  afterEach(async () => {
    resetGoogleOauthForTesting();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('fails cached-only startup without opening an interactive login', async () => {
    await expect(getGoogleOauthClient(config())).rejects.toThrow(
      'Run /auth and select Sign in with Google.',
    );
  });

  it('loads cached credentials and merges refreshed tokens with 0600 mode', async () => {
    await writeJson(getGoogleOAuthCredentialPath(), {
      access_token: 'cached-token',
      refresh_token: 'keep-refresh',
      expiry_date: Date.UTC(2099, 0, 1),
    });
    await writeJson(Storage.getGoogleAccountsPath(), {
      email: 'cached@example.test',
    });
    await writeJson(Storage.getOAuthCredsPath(), {
      provider: 'qwen-sentinel',
    });
    if (process.platform !== 'win32') {
      await fs.chmod(getGoogleOAuthCredentialPath(), 0o644);
    }

    const client = await getGoogleOauthClient(config());
    expect(client.credentials.access_token).toBe('cached-token');

    client.emit('tokens', {
      access_token: 'rotated-token',
      expiry_date: Date.UTC(2099, 0, 2),
    });
    await vi.waitFor(async () => {
      const saved = JSON.parse(
        await fs.readFile(getGoogleOAuthCredentialPath(), 'utf-8'),
      );
      expect(saved).toMatchObject({
        access_token: 'rotated-token',
        refresh_token: 'keep-refresh',
      });
    });

    if (process.platform !== 'win32') {
      const stat = await fs.stat(getGoogleOAuthCredentialPath());
      expect(stat.mode & 0o777).toBe(0o600);
    }
    await clearGoogleOAuthCredentials();
    await expect(fs.stat(getGoogleOAuthCredentialPath())).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect(await readGoogleAccount()).toBeUndefined();
    expect(
      JSON.parse(await fs.readFile(Storage.getOAuthCredsPath(), 'utf-8')),
    ).toEqual({ provider: 'qwen-sentinel' });
  });

  it('rejects a loopback callback with the wrong state', async () => {
    let authorizationUrl = '';
    const pending = getGoogleOauthClient(
      config({ interactive: true, browserSuppressed: false }),
      {
        interactive: true,
        onAuthorizationUrl: (url) => {
          authorizationUrl = url;
        },
      },
    );
    const rejection = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(authorizationUrl).not.toBe(''));

    const parsed = new URL(authorizationUrl);
    const callback = new URL(parsed.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('state', 'wrong-state');
    callback.searchParams.set('code', 'synthetic-code');
    const response = await fetch(callback);

    expect(response.status).toBe(400);
    expect(await rejection).toMatchObject({
      message: 'Google OAuth state mismatch.',
    });
  });

  it('uses PKCE for the no-browser authorization-code flow', async () => {
    const getToken = vi
      .spyOn(OAuth2Client.prototype, 'getToken')
      .mockResolvedValue({
        tokens: {
          access_token: 'manual-token',
          refresh_token: 'manual-refresh',
          expiry_date: Date.UTC(2099, 0, 1),
        },
      } as never);
    vi.spyOn(OAuth2Client.prototype, 'request').mockResolvedValue({
      data: { email: 'manual@example.test' },
    } as never);
    let authorizationUrl = '';
    let requestedCode = false;

    const client = await getGoogleOauthClient(
      config({ interactive: true, browserSuppressed: true }),
      {
        interactive: true,
        onAuthorizationUrl: (url) => {
          authorizationUrl = url;
        },
        requestAuthorizationCode: async (url) => {
          expect(url).toBe(authorizationUrl);
          requestedCode = true;
          return 'manual-code';
        },
      },
    );

    expect(requestedCode).toBe(true);
    expect(client.credentials.access_token).toBe('manual-token');
    const parsed = new URL(authorizationUrl);
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    const verifier = getToken.mock.calls[0]?.[0]?.codeVerifier;
    expect(typeof verifier).toBe('string');
    expect(
      createHash('sha256')
        .update(verifier ?? '')
        .digest('base64url'),
    ).toBe(parsed.searchParams.get('code_challenge'));
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(getToken).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'manual-code',
        redirect_uri: 'https://codeassist.google.com/authcode',
      }),
    );
    expect(await readGoogleAccount()).toBe('manual@example.test');
  });

  it('allows an external daemon host to complete manual login without a TTY', async () => {
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: {
        access_token: 'external-token',
        refresh_token: 'external-refresh',
        expiry_date: Date.UTC(2099, 0, 1),
      },
    } as never);
    vi.spyOn(OAuth2Client.prototype, 'request').mockResolvedValue({
      data: { email: 'external@example.test' },
    } as never);

    const requestCode = vi.fn().mockResolvedValue('external-code');
    const client = await getGoogleOauthClient(
      config({ interactive: false, browserSuppressed: false }),
      {
        interactive: true,
        browser: 'manual',
        requestAuthorizationCode: requestCode,
      },
    );

    expect(client.credentials.access_token).toBe('external-token');
    expect(requestCode).toHaveBeenCalledOnce();
    expect(OAuth2Client.prototype.getToken).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'external-code' }),
    );
  });

  it('rejects a competing interactive login without mixing credentials', async () => {
    await withGoogleOAuthLoginLock(async () => {
      await expect(
        withGoogleOAuthLoginLock(async () => undefined),
      ).rejects.toThrow('Another Google OAuth login is already in progress.');
    });
    await expect(
      withGoogleOAuthLoginLock(async () => {
        throw new Error('cancelled');
      }),
    ).rejects.toThrow('cancelled');
    await expect(
      withGoogleOAuthLoginLock(async () => 'reacquired'),
    ).resolves.toBe('reacquired');
  });

  it('replaces rather than merges credentials for a fresh account grant', async () => {
    vi.spyOn(OAuth2Client.prototype, 'getAccessToken').mockRejectedValue(
      new Error('expired'),
    );
    await writeJson(getGoogleOAuthCredentialPath(), {
      access_token: 'expired-a',
      refresh_token: 'refresh-a',
    });
    const getToken = vi
      .spyOn(OAuth2Client.prototype, 'getToken')
      .mockImplementation(async function (this: OAuth2Client) {
        const tokens = { access_token: 'access-b', refresh_token: 'refresh-b' };
        this.emit('tokens', tokens);
        return { tokens } as never;
      });
    vi.spyOn(OAuth2Client.prototype, 'request').mockRejectedValue(
      new Error('userinfo unavailable'),
    );

    const client = await getGoogleOauthClient(config({ interactive: true }), {
      interactive: true,
      onAuthorizationUrl: (url) => {
        expect(new URL(url).searchParams.get('prompt')).toBe('consent');
      },
      requestAuthorizationCode: async () => 'fresh-code',
    });

    expect(getToken).toHaveBeenCalledOnce();
    expect(
      JSON.parse(await fs.readFile(getGoogleOAuthCredentialPath(), 'utf8')),
    ).toEqual({ access_token: 'access-b', refresh_token: 'refresh-b' });
    expect(client.credentials.access_token).toBe('access-b');
    expect(await readGoogleAccount()).toBeUndefined();
  });

  it('rejects an access-only fresh grant without reviving the old refresh token', async () => {
    vi.spyOn(OAuth2Client.prototype, 'getAccessToken').mockRejectedValue(
      new Error('expired'),
    );
    await writeJson(getGoogleOAuthCredentialPath(), {
      access_token: 'expired-a',
      refresh_token: 'refresh-a',
    });
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation(
      async function (this: OAuth2Client) {
        const tokens = { access_token: 'access-b' };
        this.emit('tokens', tokens);
        return { tokens } as never;
      },
    );
    vi.spyOn(OAuth2Client.prototype, 'request').mockResolvedValue({
      data: {},
    } as never);

    await expect(
      getGoogleOauthClient(config({ interactive: true }), {
        interactive: true,
        requestAuthorizationCode: async () => 'access-only-code',
      }),
    ).rejects.toThrow('did not return a refresh token');
    expect(
      JSON.parse(await fs.readFile(getGoogleOAuthCredentialPath(), 'utf8')),
    ).toEqual({ access_token: 'expired-a', refresh_token: 'refresh-a' });
    expect(await readGoogleAccount()).toBeUndefined();
  });

  it('recovers self-healing and disk writes after malformed credentials and a failed write', async () => {
    await writeJson(getGoogleOAuthCredentialPath(), []);
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation(
      async function (this: OAuth2Client) {
        const tokens = {
          access_token: 'recovered-access',
          refresh_token: 'recovered-refresh',
          expiry_date: Date.UTC(2099, 0, 1),
        };
        this.emit('tokens', tokens);
        return { tokens } as never;
      },
    );
    vi.spyOn(OAuth2Client.prototype, 'request').mockResolvedValue({
      data: { email: 'recovered@example.test' },
    } as never);
    await getGoogleOauthClient(config({ interactive: true }), {
      interactive: true,
      requestAuthorizationCode: async () => 'good-code',
    });
    expect(await readGoogleAccount()).toBe('recovered@example.test');

    const client = await getGoogleOauthClient(config());
    await fs.rm(getGoogleOAuthCredentialPath());
    await fs.mkdir(getGoogleOAuthCredentialPath());
    client.emit('tokens', { access_token: 'first-failure' });
    await vi.waitFor(async () => {
      await expect(
        fs.readFile(getGoogleOAuthCredentialPath(), 'utf8'),
      ).rejects.toMatchObject({ code: 'EISDIR' });
    });
    await fs.rmdir(getGoogleOAuthCredentialPath());
    client.emit('tokens', {
      access_token: 'second-success',
      refresh_token: 'new-refresh',
    });
    await vi.waitFor(async () => {
      expect(
        JSON.parse(await fs.readFile(getGoogleOAuthCredentialPath(), 'utf8')),
      ).toMatchObject({
        access_token: 'second-success',
        refresh_token: 'new-refresh',
      });
    });
  });

  it('does not persist tokens completing after a manual cancellation', async () => {
    const exchange = deferred<{
      tokens: { access_token: string; refresh_token: string };
    }>();
    const getToken = vi
      .spyOn(OAuth2Client.prototype, 'getToken')
      .mockImplementation(async function (this: OAuth2Client) {
        const result = await exchange.promise;
        this.emit('tokens', result.tokens);
        return result;
      });
    const controller = new AbortController();
    const pending = getGoogleOauthClient(config({ interactive: true }), {
      interactive: true,
      signal: controller.signal,
      requestAuthorizationCode: async () => 'deferred-code',
    });
    const outcome = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledOnce());
    controller.abort(new Error('manual-cancelled'));
    expect(await outcome).toMatchObject({ message: 'manual-cancelled' });
    exchange.resolve({
      tokens: { access_token: 'late-access', refresh_token: 'late-refresh' },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(fs.stat(getGoogleOAuthCredentialPath())).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it('invalidates cached clients during logout and rejects later cached-only use', async () => {
    await writeJson(getGoogleOAuthCredentialPath(), {
      access_token: 'cached-access',
      refresh_token: 'cached-refresh',
      expiry_date: Date.UTC(2099, 0, 1),
    });
    await writeJson(Storage.getGoogleAccountsPath(), {
      email: 'cached@example.test',
    });
    await writeJson(Storage.getOAuthCredsPath(), {
      provider: 'qwen-sentinel',
    });
    const client = await getGoogleOauthClient(config());
    await clearGoogleOAuthCredentials();
    client.emit('tokens', {
      access_token: 'resurrected-access',
      refresh_token: 'resurrected-refresh',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(getGoogleOauthClient(config())).rejects.toThrow(
      'Run /auth and select Sign in with Google.',
    );
    await expect(fs.stat(getGoogleOAuthCredentialPath())).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect(await readGoogleAccount()).toBeUndefined();
    expect(
      JSON.parse(await fs.readFile(Storage.getOAuthCredsPath(), 'utf8')),
    ).toEqual({ provider: 'qwen-sentinel' });

    if (process.platform !== 'win32') {
      await fs.writeFile(
        getGoogleOAuthCredentialPath(),
        JSON.stringify({
          access_token: 'cached-for-mode',
          refresh_token: 'offline',
          expiry_date: Date.UTC(2099, 0, 1),
        }),
        { mode: 0o644 },
      );
      const next = await getGoogleOauthClient(config());
      next.emit('tokens', { access_token: 'tighten-mode' });
      await vi.waitFor(async () => {
        expect(
          (await fs.stat(getGoogleOAuthCredentialPath())).mode & 0o777,
        ).toBe(0o600);
      });
    }
  });

  it('separates client promise caches by transport proxy', async () => {
    await writeJson(getGoogleOAuthCredentialPath(), {
      access_token: 'cached',
      expiry_date: Date.UTC(2099, 0, 1),
    });
    await writeJson(Storage.getGoogleAccountsPath(), {
      email: 'cached@example.test',
    });
    const a = await getGoogleOauthClient(
      config({ proxy: 'http://proxy-a.test:8080' }),
    );
    const b = await getGoogleOauthClient(
      config({ proxy: 'http://proxy-b.test:8080' }),
    );
    expect(a).not.toBe(b);
    expect(a.transporter.defaults.proxy).toBe('http://proxy-a.test:8080');
    expect(b.transporter.defaults.proxy).toBe('http://proxy-b.test:8080');
  });

  it('validates state before error, ignores unrelated paths, and completes a valid callback', async () => {
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation(
      async function (this: OAuth2Client) {
        const tokens = {
          access_token: 'web-access',
          refresh_token: 'web-refresh',
        };
        this.emit('tokens', tokens);
        return { tokens } as never;
      },
    );
    vi.spyOn(OAuth2Client.prototype, 'request').mockResolvedValue({
      data: { email: 'web@example.test' },
    } as never);
    let authorizationUrl = '';
    const pending = getGoogleOauthClient(
      config({ interactive: true, browserSuppressed: false }),
      {
        interactive: true,
        onAuthorizationUrl: (url) => {
          authorizationUrl = url;
        },
      },
    );
    const outcome = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(authorizationUrl).not.toBe(''));
    expect(
      await Promise.race([
        outcome,
        new Promise((resolve) => setTimeout(() => resolve('running'), 20)),
      ]),
    ).toBe('running');
    const callback =
      new URL(authorizationUrl).searchParams.get('redirect_uri') ?? '';
    const stray = new URL(callback);
    stray.pathname = '/favicon.ico';
    expect((await fetch(stray)).status).toBe(404);

    const parsed = new URL(authorizationUrl);
    const valid = new URL(callback);
    valid.searchParams.set('state', parsed.searchParams.get('state') ?? '');
    valid.searchParams.set('code', 'valid-code');
    const response = await fetch(valid, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('auth_success_gemini');
    expect(await outcome).not.toBeInstanceOf(Error);
    expect(((await outcome) as OAuth2Client).credentials.access_token).toBe(
      'web-access',
    );
    expect(await readGoogleAccount()).toBe('web@example.test');
    await clearGoogleOAuthCredentials();
  });

  it('rejects an OAuth error callback without accepting an invalid state', async () => {
    let retryUrl = '';
    const retry = getGoogleOauthClient(
      config({ interactive: true, browserSuppressed: false }),
      {
        interactive: true,
        onAuthorizationUrl: (url) => {
          retryUrl = url;
        },
      },
    );
    const retryOutcome = retry.catch((error: unknown) => error);
    await vi.waitFor(() => expect(retryUrl).not.toBe(''));
    const bad = new URL(
      new URL(retryUrl).searchParams.get('redirect_uri') ?? '',
    );
    bad.searchParams.set('state', 'wrong');
    bad.searchParams.set('error', 'access_denied');
    expect((await fetch(bad)).status).toBe(400);
    expect(await retryOutcome).toMatchObject({
      message: 'Google OAuth state mismatch.',
    });
  });

  it('aborts a hanging URL publication and permits an independent retry', async () => {
    const controller = new AbortController();
    const pending = getGoogleOauthClient(config({ interactive: true }), {
      interactive: true,
      signal: controller.signal,
      onAuthorizationUrl: () => new Promise<void>(() => undefined),
    });
    const outcome = pending.catch((error: unknown) => error);
    controller.abort(new Error('url-cancelled'));
    expect(await outcome).toMatchObject({ message: 'url-cancelled' });
    await expect(
      withGoogleOAuthLoginLock(async () => 'reacquired'),
    ).resolves.toBe('reacquired');
  });

  it('aborts cached token refresh instead of retaining an interactive lock', async () => {
    await writeJson(getGoogleOAuthCredentialPath(), {
      access_token: 'expired',
      refresh_token: 'refresh',
      expiry_date: 1,
    });
    vi.spyOn(OAuth2Client.prototype, 'getAccessToken').mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    const controller = new AbortController();
    const pending = getGoogleOauthClient(config({ interactive: true }), {
      interactive: true,
      signal: controller.signal,
    });
    const outcome = pending.catch((error: unknown) => error);
    controller.abort(new Error('refresh-cancelled'));
    expect(await outcome).toMatchObject({ message: 'refresh-cancelled' });
  });

  it('cancels a hanging platform browser launch and closes the loopback server', async () => {
    const { openBrowserSecurely } = await import(
      '../utils/secure-browser-launcher.js'
    );
    vi.mocked(openBrowserSecurely).mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    const controller = new AbortController();
    let callbackUrl = '';
    const pending = getGoogleOauthClient(
      config({ interactive: true, browserSuppressed: false }),
      {
        interactive: true,
        signal: controller.signal,
        onAuthorizationUrl: (url) => {
          callbackUrl = new URL(url).searchParams.get('redirect_uri') ?? '';
        },
      },
    );
    const outcome = pending.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(openBrowserSecurely).toHaveBeenCalled();
      expect(callbackUrl).not.toBe('');
    });
    controller.abort(new Error('browser-cancelled'));
    expect(await outcome).toMatchObject({ message: 'browser-cancelled' });
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });

  it('allows an external loopback login without opening the daemon host browser', async () => {
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation(
      async function (this: OAuth2Client) {
        const tokens = { access_token: 'external', refresh_token: 'offline' };
        this.emit('tokens', tokens);
        return { tokens } as never;
      },
    );
    vi.spyOn(OAuth2Client.prototype, 'request').mockResolvedValue({
      data: { email: 'external@example.test' },
    } as never);
    const { openBrowserSecurely } = await import(
      '../utils/secure-browser-launcher.js'
    );
    let callbackUrl = '';
    let state = '';
    const pending = getGoogleOauthClient(config({ browserSuppressed: false }), {
      interactive: true,
      browser: 'external',
      onAuthorizationUrl: (url) => {
        const parsed = new URL(url);
        callbackUrl = parsed.searchParams.get('redirect_uri') ?? '';
        state = parsed.searchParams.get('state') ?? '';
      },
    });
    const outcome = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(callbackUrl).not.toBe(''));
    const callback = new URL(callbackUrl);
    callback.searchParams.set('state', state);
    callback.searchParams.set('code', 'external');
    await fetch(callback, { redirect: 'manual' });
    expect(await outcome).not.toBeInstanceOf(Error);
    expect(openBrowserSecurely).not.toHaveBeenCalled();
  });

  it('rejects manual input EOF instead of waiting for the authorization timeout', async () => {
    const input = Object.assign(new EventEmitter(), {
      question: vi.fn(),
      close: vi.fn(),
    });
    Object.assign(input, {
      question: vi.fn(),
      close: vi.fn(() => input.emit('close')),
    });
    vi.spyOn(readline, 'createInterface').mockReturnValue(input as never);
    const outcome = getGoogleOauthClient(config({ interactive: true }), {
      interactive: true,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => {
      const question = input.question as ReturnType<typeof vi.fn>;
      expect(question).toHaveBeenCalled();
    });
    input.emit('close');
    expect(await outcome).toMatchObject({
      message:
        'Google OAuth authorization input closed before a code was entered.',
    });
  });
});
