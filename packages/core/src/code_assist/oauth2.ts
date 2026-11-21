/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeChallengeMethod,
  OAuth2Client,
  type Credentials,
} from 'google-auth-library';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import readline from 'node:readline';
import lockfile from 'proper-lockfile';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { openBrowserSecurely } from '../utils/secure-browser-launcher.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';

const debugLogger = createDebugLogger('GOOGLE_OAUTH');
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;
const USERINFO_TIMEOUT_MS = 30_000;
const SIGN_IN_SUCCESS_URL =
  'https://developers.google.com/gemini-code-assist/auth_success_gemini';
const SIGN_IN_FAILURE_URL =
  'https://developers.google.com/gemini-code-assist/auth_failure_gemini';
const GOOGLE_OAUTH_CREDENTIAL_FILENAME = 'google_oauth_creds.json';
const GOOGLE_OAUTH_LOCK_FILENAME = 'google_oauth_creds';

// Installed-application configuration from the public Gemini CLI implementation.
const OAUTH_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
// This value is intentionally embedded by installed applications and is not an account secret.
const OAUTH_CLIENT_SECRET = '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';

const OAUTH_SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export interface GoogleOAuthInteractiveOptions {
  interactive?: boolean;
  signal?: AbortSignal;
  /** Manual is for a browser located on a different host than the daemon. */
  browser?: 'auto' | 'external' | 'manual';
  onAuthorizationUrl?: (url: string) => void | Promise<void>;
  requestAuthorizationCode?: (
    authorizationUrl: string,
    signal?: AbortSignal,
  ) => Promise<string>;
}

type ClientState = {
  epoch: number;
  fresh: boolean;
  controller: AbortController;
  writes: Promise<void>;
};

type AuthorizationScope = {
  cancelled: Promise<never>;
  cleanup: (action: () => void) => void;
  finish: () => void;
};

const oauthClientPromises = new Map<string, Promise<OAuth2Client>>();
const clientStates = new Map<OAuth2Client, ClientState>();
let credentialEpoch = 0;

class InvalidCredentialFormatError extends Error {}

export function getGoogleOAuthCredentialPath(): string {
  return path.join(
    Storage.getGlobalQwenDir(),
    GOOGLE_OAUTH_CREDENTIAL_FILENAME,
  );
}

function getGoogleOAuthLockPath(directory: string): string {
  return path.join(directory, GOOGLE_OAUTH_LOCK_FILENAME);
}

async function withCredentialLock<T>(run: () => Promise<T>): Promise<T> {
  const credentialDirectory = path.dirname(getGoogleOAuthCredentialPath());
  await fs.mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  const lockTarget = getGoogleOAuthLockPath(
    await fs.realpath(credentialDirectory),
  );
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 35_000,
    retries: {
      retries: 350,
      factor: 1,
      minTimeout: 100,
      maxTimeout: 100,
    },
  });
  try {
    return await run();
  } finally {
    await release().catch(() => undefined);
  }
}

export async function readGoogleAccount(): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(Storage.getGoogleAccountsPath(), 'utf-8'),
    ) as { email?: unknown };
    return typeof parsed.email === 'string' && parsed.email
      ? parsed.email
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeGoogleAccount(
  email: string,
  state: ClientState,
): Promise<void> {
  const filePath = Storage.getGoogleAccountsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await withCredentialLock(async () => {
    if (state.epoch !== credentialEpoch || state.controller.signal.aborted) {
      return;
    }
    await atomicWriteFile(filePath, `${JSON.stringify({ email }, null, 2)}\n`, {
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
  });
}

async function readStoredCredentials(): Promise<Credentials | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(getGoogleOAuthCredentialPath(), 'utf-8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidCredentialFormatError(
        'Invalid Google OAuth credential format.',
      );
    }
    return parsed as Credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function persistCredentials(
  tokens: Credentials,
  state: ClientState,
): Promise<void> {
  const filePath = getGoogleOAuthCredentialPath();
  await withCredentialLock(async () => {
    if (state.epoch !== credentialEpoch) return;
    state.controller.signal.throwIfAborted();
    if (state.fresh && !tokens.refresh_token) {
      throw new Error(
        'Google OAuth did not return a refresh token. Grant offline access and sign in again.',
      );
    }
    let existing: Credentials = {};
    if (!state.fresh) {
      try {
        existing = (await readStoredCredentials()) ?? {};
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(error instanceof InvalidCredentialFormatError)
        ) {
          throw error;
        }
      }
    }
    const updates = Object.fromEntries(
      Object.entries(tokens).filter(
        ([, value]) => value !== null && value !== undefined,
      ),
    );
    const credentials = state.fresh ? updates : { ...existing, ...updates };
    await atomicWriteFile(
      filePath,
      `${JSON.stringify(credentials, null, 2)}\n`,
      { mode: 0o600, forceMode: true, noFollow: true },
    );
    state.fresh = false;
  });
}

function createBaseOAuth2Client(
  config: Config,
  fresh: boolean,
  signal?: AbortSignal,
): OAuth2Client {
  const client = new OAuth2Client({
    clientId: OAUTH_CLIENT_ID,
    clientSecret: OAUTH_CLIENT_SECRET,
    transporterOptions: {
      proxy: config.getProxy(),
      timeout: AUTHORIZATION_TIMEOUT_MS,
    },
  });
  const state: ClientState = {
    epoch: credentialEpoch,
    fresh,
    controller: new AbortController(),
    writes: Promise.resolve(),
  };
  clientStates.set(client, state);
  const request = client.transporter.request.bind(client.transporter);
  client.transporter.request = (options = {}) =>
    request({
      ...options,
      signal: options.signal ?? signal ?? state.controller.signal,
      timeout: options.timeout ?? AUTHORIZATION_TIMEOUT_MS,
    });
  client.on('tokens', (tokens: Credentials) => {
    const write = state.writes
      .catch(() => undefined)
      .then(() => persistCredentials(tokens, state));
    state.writes = write;
    write.catch((error) => {
      if (state.epoch === credentialEpoch && !state.controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.error(
          `Failed to persist Google OAuth credentials: ${message}`,
        );
      }
    });
  });
  return client;
}

async function flushTokenWrites(client: OAuth2Client): Promise<void> {
  const state = clientStates.get(client);
  state?.controller.signal.throwIfAborted();
  await state?.writes;
  if (state?.epoch !== credentialEpoch) {
    throw new Error('Google OAuth was signed out.');
  }
}

async function fetchAndCacheUserInfo(client: OAuth2Client): Promise<void> {
  try {
    const state = clientStates.get(client);
    const response = await client.request<{ email?: string }>({
      url: 'https://www.googleapis.com/oauth2/v2/userinfo',
      responseType: 'json',
      retry: false,
      timeout: USERINFO_TIMEOUT_MS,
    });
    if (response.data.email && state) {
      await writeGoogleAccount(response.data.email, state);
    }
  } catch (error) {
    if (clientStates.get(client)?.controller.signal.aborted) throw error;
    debugLogger.warn('Failed to fetch the Google account identity.');
  }
}

async function tryCachedClient(
  config: Config,
  signal?: AbortSignal,
): Promise<OAuth2Client | undefined> {
  const credentials = await readStoredCredentials();
  if (!credentials) return undefined;

  const client = createBaseOAuth2Client(config, false, signal);
  client.setCredentials(credentials);
  const { token } = await withTimeoutAndAbort(
    client.getAccessToken(),
    signal,
    () => undefined,
  );
  if (!token) throw new Error('Google OAuth returned no access token.');
  await flushTokenWrites(client);
  if (!(await readGoogleAccount())) {
    await fetchAndCacheUserInfo(client);
  }
  return client;
}

export async function getGoogleOauthClient(
  config: Config,
  options: GoogleOAuthInteractiveOptions = {},
): Promise<OAuth2Client> {
  const mode = options.interactive ? 'interactive' : 'cached';
  const key = `${getGoogleOAuthCredentialPath()}\0${mode}\0${config.getProxy() ?? ''}`;
  const cachedPromise = oauthClientPromises.get(key);
  if (cachedPromise) return cachedPromise;

  const pending = (async (): Promise<OAuth2Client> => {
    try {
      const cachedClient = await tryCachedClient(config, options.signal);
      if (cachedClient) return cachedClient;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (!options.interactive) {
        throw new Error(
          'Cached Google OAuth credentials are missing or invalid. Run /auth and select Sign in with Google.',
          { cause: error },
        );
      }
      debugLogger.debug('Cached Google OAuth credentials were not usable.');
    }

    if (!options.interactive) {
      throw new Error(
        'Google OAuth is not configured. Run /auth and select Sign in with Google.',
      );
    }
    const externalHost =
      options.browser === 'external' || options.browser === 'manual';
    if (!externalHost && !config.isInteractive()) {
      throw new Error(
        'Google OAuth requires an interactive login. Run /auth in an interactive terminal first.',
      );
    }
    return authorizeGoogleOAuth(config, options);
  })();

  oauthClientPromises.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    oauthClientPromises.delete(key);
    throw error;
  }
}

function startAuthorizationScope(
  client: OAuth2Client,
  signal?: AbortSignal,
): AuthorizationScope {
  const state = clientStates.get(client);
  if (!state) throw new Error('Google OAuth client state is missing.');
  let cleanup: () => void = () => undefined;
  let rejectCancellation: (reason: unknown) => void;
  let failed = false;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  // A callback can fail before the race below attaches its handler.
  cancelled.catch(() => undefined);
  const fail = (reason: unknown) => {
    if (failed) return;
    failed = true;
    cleanup();
    state.controller.abort(reason);
    rejectCancellation(reason);
  };
  const onAbort = () => fail(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(
    () => fail(new Error('Google OAuth timed out after 5 minutes.')),
    AUTHORIZATION_TIMEOUT_MS,
  );
  timer.unref();
  return {
    cancelled,
    cleanup: (action) => {
      cleanup = action;
      if (failed) action();
    },
    finish: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function authorizeGoogleOAuth(
  config: Config,
  options: GoogleOAuthInteractiveOptions,
): Promise<OAuth2Client> {
  options.signal?.throwIfAborted();
  await fs.rm(Storage.getGoogleAccountsPath(), { force: true });
  const client = createBaseOAuth2Client(config, true, options.signal);
  const scope = startAuthorizationScope(client, options.signal);
  try {
    await Promise.race([
      (async () => {
        if (
          options.browser === 'manual' ||
          config.isBrowserLaunchSuppressed()
        ) {
          await authorizeWithUserCode(client, options, scope.cleanup);
        } else {
          await authorizeWithWeb(client, options, scope.cleanup);
        }
        await flushTokenWrites(client);
        await fetchAndCacheUserInfo(client);
      })(),
      scope.cancelled,
    ]);
    return client;
  } finally {
    scope.finish();
  }
}

async function authorizeWithUserCode(
  client: OAuth2Client,
  options: GoogleOAuthInteractiveOptions,
  cleanup: (action: () => void) => void,
): Promise<void> {
  const redirectUri = 'https://codeassist.google.com/authcode';
  const codeVerifier = await client.generateCodeVerifierAsync();
  const authUrl = client.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPE,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeVerifier.codeChallenge,
    state: crypto.randomBytes(32).toString('hex'),
  });
  cleanup(() => undefined);
  await options.onAuthorizationUrl?.(authUrl);

  const prompt = options.requestAuthorizationCode
    ? {
        promise: options.requestAuthorizationCode(authUrl, options.signal),
        cancel: () => undefined,
      }
    : promptForAuthorizationCode(authUrl);
  cleanup(prompt.cancel);
  const code = (
    await withTimeoutAndAbort(prompt.promise, options.signal, prompt.cancel)
  ).trim();
  cleanup(() => undefined);
  if (!code) throw new Error('An authorization code is required.');

  const { tokens } = await client.getToken({
    code,
    codeVerifier: codeVerifier.codeVerifier,
    redirect_uri: redirectUri,
  });
  options.signal?.throwIfAborted();
  client.setCredentials(tokens);
}

function promptForAuthorizationCode(authUrl: string): {
  promise: Promise<string>;
  cancel: () => void;
} {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  let answered = false;
  let expectedClose = false;
  return {
    promise: new Promise<string>((resolve, reject) => {
      rl.once('close', () => {
        if (!answered && !expectedClose) {
          reject(
            new Error(
              'Google OAuth authorization input closed before a code was entered.',
            ),
          );
        }
      });
      rl.question(
        `Visit this URL to authorize Qwen Code:\n\n${authUrl}\n\nEnter the authorization code: `,
        (code) => {
          answered = true;
          rl.close();
          resolve(code);
        },
      );
    }),
    cancel: () => {
      expectedClose = true;
      rl.close();
    },
  };
}

interface WebLogin {
  authUrl: string;
  completion: Promise<void>;
  close: () => void;
}

async function startWebLogin(client: OAuth2Client): Promise<WebLogin> {
  const state = crypto.randomBytes(32).toString('hex');
  let redirectUri = '';
  let resolveLogin: () => void;
  let rejectLogin: (error: Error) => void;
  let exchangeClaimed = false;
  let settled = false;
  const completion = new Promise<void>((resolve, reject) => {
    resolveLogin = resolve;
    rejectLogin = reject;
  });
  completion.catch(() => undefined);

  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    server.close();
    if (error) rejectLogin(error);
    else resolveLogin();
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname !== '/oauth2callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (requestUrl.searchParams.get('state') !== state) {
        res.writeHead(400);
        res.end('State mismatch. Possible CSRF attack.');
        finish(new Error('Google OAuth state mismatch.'));
        return;
      }
      if (requestUrl.searchParams.get('error')) {
        res.writeHead(302, { Location: SIGN_IN_FAILURE_URL });
        res.end();
        finish(
          new Error(
            `Google OAuth failed: ${requestUrl.searchParams.get('error')}.`,
          ),
        );
        return;
      }
      const code = requestUrl.searchParams.get('code');
      if (!code) {
        res.writeHead(302, { Location: SIGN_IN_FAILURE_URL });
        res.end();
        finish(new Error('Google OAuth returned no authorization code.'));
        return;
      }
      if (exchangeClaimed) {
        res.writeHead(409);
        res.end('Google OAuth code exchange already in progress.');
        return;
      }
      exchangeClaimed = true;
      try {
        const { tokens } = await client.getToken({
          code,
          redirect_uri: redirectUri,
        });
        if (clientStates.get(client)?.controller.signal.aborted) {
          throw new Error('Google OAuth was cancelled.');
        }
        client.setCredentials(tokens);
        await flushTokenWrites(client);
        res.writeHead(302, { Location: SIGN_IN_SUCCESS_URL });
        res.end();
        finish();
      } catch {
        if (!res.writableEnded) {
          res.writeHead(302, { Location: SIGN_IN_FAILURE_URL });
          res.end();
        }
        finish(new Error('Failed to exchange the Google authorization code.'));
      }
    })().catch((error: unknown) => {
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end();
      }
      finish(
        error instanceof Error
          ? error
          : new Error('Unexpected Google OAuth callback failure.'),
      );
    });
  });
  server.on('error', (error) => rejectLogin(error));

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a Google OAuth callback port.');
  }
  redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const authUrl = client.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPE,
    state,
  });

  return {
    authUrl,
    completion,
    close: () => server.close(),
  };
}

async function authorizeWithWeb(
  client: OAuth2Client,
  options: GoogleOAuthInteractiveOptions,
  cleanup: (action: () => void) => void,
): Promise<void> {
  const login = await startWebLogin(client);
  try {
    cleanup(login.close);
    await options.onAuthorizationUrl?.(login.authUrl);
    if (options.browser !== 'external') {
      await openBrowserSecurely(login.authUrl);
    }
    await withTimeoutAndAbort(login.completion, options.signal, login.close);
  } finally {
    login.close();
  }
}

async function withTimeoutAndAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  cleanup: () => void,
): Promise<T> {
  if (signal?.aborted) {
    cleanup();
    signal.throwIfAborted();
  }
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Google OAuth timed out after 5 minutes.'));
    }, AUTHORIZATION_TIMEOUT_MS);
    timer.unref();
  });
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error('Google OAuth was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, timeout, cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export function clearGoogleOauthClientCache(): void {
  oauthClientPromises.clear();
}

/** @internal */
export function getGoogleOAuthTrackedClientCountForTesting(): number {
  return clientStates.size;
}

/** @internal */
export function resetGoogleOauthForTesting(): void {
  clearGoogleOauthClientCache();
  credentialEpoch += 1;
  for (const state of clientStates.values()) {
    state.controller.abort(new Error('Google OAuth test fixtures were reset.'));
  }
  clientStates.clear();
}

export async function withGoogleOAuthLoginLock<T>(
  run: () => Promise<T>,
): Promise<T> {
  const credentialDirectory = path.dirname(getGoogleOAuthCredentialPath());
  await fs.mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  const lockTarget = path.join(
    await fs.realpath(credentialDirectory),
    'google_oauth_login',
  );
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: 60_000,
      retries: 0,
    });
  } catch (error) {
    throw new Error(
      'Another Google OAuth login is already in progress. Try after it finishes or is cancelled.',
      { cause: error },
    );
  }
  try {
    return await run();
  } finally {
    await release().catch(() => undefined);
  }
}

export async function clearGoogleOAuthCredentials(): Promise<void> {
  credentialEpoch += 1;
  for (const state of clientStates.values()) {
    state.controller.abort(new Error('Google OAuth was signed out.'));
  }
  clearGoogleOauthClientCache();
  await withGoogleOAuthLoginLock(async () => {
    await Promise.allSettled(
      [...clientStates.values()].map((state) => state.writes),
    );
    await withCredentialLock(async () => {
      await Promise.all([
        fs.rm(getGoogleOAuthCredentialPath(), { force: true }),
        fs.rm(Storage.getGoogleAccountsPath(), { force: true }),
      ]);
    });
  });
  clientStates.clear();
}
