/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import type { SimpleGit, SimpleGitFactory } from 'simple-git';
import type { ExtensionInstallMetadata } from '../config/config.js';
import type { GitCredential } from './extension-git-credentials.js';

interface ExtensionGitAuthentication {
  source: string;
  credential: GitCredential;
}

interface ExtensionGitClientOptions {
  baseDir: string;
  signal?: AbortSignal;
  networkPolicy?: ExtensionInstallMetadata['networkPolicy'];
  networkConfig?: string[];
  authentication?: ExtensionGitAuthentication;
}

export function createExtensionGitClient(
  simpleGit: SimpleGitFactory,
  {
    baseDir,
    signal,
    networkPolicy,
    networkConfig = [],
    authentication,
  }: ExtensionGitClientOptions,
): SimpleGit {
  const restrictEnvironment =
    networkPolicy === 'public' || authentication !== undefined;
  const hasNetworkConfig = networkConfig.length > 0;
  const git = simpleGit(baseDir, {
    ...(signal ? { abort: signal } : {}),
    ...(hasNetworkConfig ? { config: networkConfig } : {}),
    ...(restrictEnvironment || hasNetworkConfig
      ? {
          unsafe: {
            ...(restrictEnvironment ? { allowUnsafeConfigPaths: true } : {}),
            ...(hasNetworkConfig ? { allowUnsafeProtocolOverride: true } : {}),
            ...(authentication ? { allowUnsafeConfigEnvCount: true } : {}),
          },
        }
      : {}),
  });
  if (!restrictEnvironment) return git;

  const environment: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
  };
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (authentication) {
    const value = Buffer.from(
      `${authentication.credential.username}:${authentication.credential.password}`,
      'utf8',
    ).toString('base64');
    environment['GIT_CONFIG_COUNT'] = '1';
    environment['GIT_CONFIG_KEY_0'] =
      `http.${authentication.source}.extraHeader`;
    environment['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${value}`;
  }
  return git.env(environment);
}
