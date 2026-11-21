/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OAuth2Client } from 'google-auth-library';
import type { Config } from '../config/config.js';
import { AuthType } from '../utils/auth-type.js';
import { Storage } from '../config/storage.js';
import {
  createCodeAssistContentGenerator,
  setupGoogleOAuthForUser,
  signOutGoogleOAuth,
} from './code-assist.js';
import { CodeAssistServer } from './server.js';
import {
  getGoogleOauthClient,
  getGoogleOAuthTrackedClientCountForTesting,
  resetGoogleOauthForTesting,
} from './oauth2.js';
import { resetUserDataCacheForTesting } from './setup.js';

vi.mock('./oauth2.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./oauth2.js')>()),
  getGoogleOauthClient: vi.fn(),
}));

let home: string;
let currentAuth: AuthType | undefined;

function fakeConfig(): Config {
  return {
    getProxy: () => undefined,
    getSessionId: () => 'session-1',
    isInteractive: () => false,
    isBrowserLaunchSuppressed: () => true,
    getAuthType: () => currentAuth,
    getCurrentAuthType: () => currentAuth,
    clearAuth: () => {
      currentAuth = undefined;
    },
  } as Config;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('Code Assist entry points', () => {
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'code-assist-entry-'));
    vi.stubEnv('QWEN_HOME', home);
    currentAuth = AuthType.GOOGLE_OAUTH;
    resetGoogleOauthForTesting();
    resetUserDataCacheForTesting();
  });

  afterEach(async () => {
    resetGoogleOauthForTesting();
    resetUserDataCacheForTesting();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('passes generator sampling parameters into the Gemini generation config', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { response: { candidates: [] } },
    });
    vi.mocked(getGoogleOauthClient).mockResolvedValue({
      request,
    } as unknown as OAuth2Client);
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      cloudaicompanionProject: 'project-1',
      currentTier: { id: 'free-tier', name: 'Free' },
    });
    const config = fakeConfig();
    const generator = await createCodeAssistContentGenerator(
      { model: 'gemini-4-carbon', samplingParams: { temperature: 0.125 } },
      config,
    );

    await generator.generateContent(
      { model: 'gemini-4-carbon', contents: 'hello' },
      'prompt-1',
    );
    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(request.mock.calls[0][0].body);
    expect(body.request.generationConfig).toMatchObject({ temperature: 0.125 });
    expect(body.project).toBe('project-1');
  });

  it('runs the real single-flight wrapper around interactive setup', async () => {
    const gate = deferred<OAuth2Client>();
    vi.mocked(getGoogleOauthClient).mockReturnValue(gate.promise);
    vi.spyOn(CodeAssistServer.prototype, 'loadCodeAssist').mockResolvedValue({
      cloudaicompanionProject: 'project-shared',
      currentTier: { id: 'free-tier', name: 'Free' },
    });
    const config = fakeConfig();
    const first = setupGoogleOAuthForUser(config, {
      requestAuthorizationCode: async () => 'synthetic-code',
    });
    const outcome = first.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(vi.mocked(getGoogleOauthClient)).toHaveBeenCalledOnce(),
    );
    await expect(setupGoogleOAuthForUser(config)).rejects.toThrow(
      'Another Google OAuth login is already in progress.',
    );

    gate.resolve({ request: vi.fn() } as unknown as OAuth2Client);
    await expect(outcome).resolves.toMatchObject({
      projectId: 'project-shared',
    });
  });

  it('signs out Google state without changing Qwen credentials', async () => {
    const googleCredentials = path.join(home, 'google_oauth_creds.json');
    const googleAccounts = Storage.getGoogleAccountsPath();
    await fs.writeFile(
      googleCredentials,
      JSON.stringify({
        access_token: 'offline-test-token',
        refresh_token: 'offline-test-refresh',
        expiry_date: 4_102_444_800_000,
      }),
    );
    await fs.writeFile(
      googleAccounts,
      JSON.stringify({ email: 'fixture@test' }),
    );
    await fs.writeFile(
      Storage.getOAuthCredsPath(),
      JSON.stringify({ provider: 'qwen-sentinel' }),
    );
    const config = fakeConfig();
    const actualOauth =
      await vi.importActual<typeof import('./oauth2.js')>('./oauth2.js');
    vi.mocked(getGoogleOauthClient).mockImplementationOnce(
      actualOauth.getGoogleOauthClient,
    );
    await getGoogleOauthClient(config);
    expect(getGoogleOAuthTrackedClientCountForTesting()).toBe(1);

    await expect(signOutGoogleOAuth(config)).resolves.toBe(true);
    expect(getGoogleOAuthTrackedClientCountForTesting()).toBe(0);
    await expect(fs.stat(googleCredentials)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(googleAccounts)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      JSON.parse(await fs.readFile(Storage.getOAuthCredsPath(), 'utf8')),
    ).toEqual({ provider: 'qwen-sentinel' });
    expect(currentAuth).toBeUndefined();
  });

  it('does not clear another provider when Google is not selected', async () => {
    currentAuth = AuthType.USE_OPENAI;
    await expect(signOutGoogleOAuth(fakeConfig())).resolves.toBe(false);
    expect(currentAuth).toBe(AuthType.USE_OPENAI);
  });
});
