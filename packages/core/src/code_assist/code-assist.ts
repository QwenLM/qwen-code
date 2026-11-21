/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { AuthType } from '../utils/auth-type.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import {
  clearGoogleOAuthCredentials,
  getGoogleOauthClient,
  withGoogleOAuthLoginLock,
  type GoogleOAuthInteractiveOptions,
} from './oauth2.js';
import { setupUser, type UserData } from './setup.js';
import { CodeAssistServer, type HttpOptions } from './server.js';

function buildHttpOptions(config: ContentGeneratorConfig): HttpOptions {
  const version = process.env['CLI_VERSION'] || process.version;
  const userAgent =
    config.userAgent ||
    `QwenCode/${version} (${process.platform}; ${process.arch})`;
  return { headers: { 'User-Agent': userAgent } };
}

export async function createCodeAssistContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
): Promise<ContentGenerator> {
  const client = await getGoogleOauthClient(gcConfig);
  const httpOptions = buildHttpOptions(config);
  const userData = await setupUser(client, gcConfig, httpOptions);
  return new CodeAssistServer(
    client,
    userData.projectId,
    httpOptions,
    gcConfig,
    undefined,
    config.samplingParams,
  );
}

export async function setupGoogleOAuthForUser(
  gcConfig: Config,
  options: GoogleOAuthInteractiveOptions = {},
): Promise<UserData> {
  return withGoogleOAuthLoginLock(async () => {
    const client = await getGoogleOauthClient(gcConfig, {
      ...options,
      interactive: true,
    });
    return setupUser(client, gcConfig, {}, options.signal);
  });
}

export async function signOutGoogleOAuth(config: Config): Promise<boolean> {
  if (
    (config.getCurrentAuthType() ?? config.getAuthType()) !==
    AuthType.GOOGLE_OAUTH
  ) {
    return false;
  }
  await clearGoogleOAuthCredentials();
  config.clearAuth();
  return true;
}
