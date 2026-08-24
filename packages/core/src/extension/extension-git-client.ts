/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import type { SimpleGit, SimpleGitFactory, SimpleGitOptions } from 'simple-git';
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

type UnsafeOptions = NonNullable<SimpleGitOptions['unsafe']>;

const generatedConfigKeyAllowances = [
  [/alias/, 'allowUnsafeAlias'],
  [/core.askpass/, 'allowUnsafeAskPass'],
  [/core.editor/, 'allowUnsafeEditor'],
  [/core.fsmonitor/, 'allowUnsafeFsMonitor'],
  [/core.gitproxy/, 'allowUnsafeGitProxy'],
  [/core.hookspath/, 'allowUnsafeHooksPath'],
  [/core.pager/, 'allowUnsafePager'],
  [/core.sshcommand/, 'allowUnsafeSshCommand'],
  [/credential(..+)?.helper/, 'allowUnsafeCredentialHelper'],
  [/diff(..+)?.command/, 'allowUnsafeDiffExternal'],
  [/diff.external/, 'allowUnsafeDiffExternal'],
  [/diff(..+)?.textconv/, 'allowUnsafeDiffTextConv'],
  [/filter(..+)?.clean/, 'allowUnsafeFilter'],
  [/filter(..+)?.smudge/, 'allowUnsafeFilter'],
  [/gpg(..+)?.program/, 'allowUnsafeGpgProgram'],
  [/init.templatedir/, 'allowUnsafeTemplateDir'],
  [/merge(..+)?.driver/, 'allowUnsafeMergeDriver'],
  [/mergetool(..+)?.path/, 'allowUnsafeMergeDriver'],
  [/mergetool(..+)?.cmd/, 'allowUnsafeMergeDriver'],
  [/protocol(..+)?.allow/, 'allowUnsafeProtocolOverride'],
  [/remote(..+)?.receivepack/, 'allowUnsafePack'],
  [/remote(..+)?.uploadpack/, 'allowUnsafePack'],
  [/sequence.editor/, 'allowUnsafeEditor'],
] as const satisfies ReadonlyArray<readonly [RegExp, keyof UnsafeOptions]>;

function allowGeneratedConfigKeyFalsePositives(
  unsafe: UnsafeOptions,
  key: string,
): void {
  const normalizedKey = key.toLowerCase().trim();
  for (const [pattern, category] of generatedConfigKeyAllowances) {
    if (pattern.test(normalizedKey)) {
      unsafe[category] = true;
    }
  }
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
  const unsafe: UnsafeOptions = {};
  if (restrictEnvironment) unsafe.allowUnsafeConfigPaths = true;
  if (hasNetworkConfig) unsafe.allowUnsafeProtocolOverride = true;
  const credentialConfigKey = authentication
    ? `http.${authentication.source}.extraHeader`
    : undefined;
  if (credentialConfigKey) {
    unsafe.allowUnsafeConfigEnvCount = true;
    // @simple-git/argv-parser scans the whole key with unanchored matchers.
    // Enable only categories matched by this product-generated key.
    // The child environment below remains allowlisted.
    allowGeneratedConfigKeyFalsePositives(unsafe, credentialConfigKey);
  }
  const git = simpleGit(baseDir, {
    ...(signal ? { abort: signal } : {}),
    ...(hasNetworkConfig ? { config: networkConfig } : {}),
    ...(restrictEnvironment || hasNetworkConfig ? { unsafe } : {}),
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
  if (authentication && credentialConfigKey) {
    const value = Buffer.from(
      `${authentication.credential.username}:${authentication.credential.password}`,
      'utf8',
    ).toString('base64');
    environment['GIT_CONFIG_COUNT'] = '1';
    environment['GIT_CONFIG_KEY_0'] = credentialConfigKey;
    environment['GIT_CONFIG_VALUE_0'] = `Authorization: Basic ${value}`;
  }
  return git.env(environment);
}
