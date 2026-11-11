/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { internalGitArgs } from '../utils/gitCommandPolicy.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENV_PLUGIN_GIT_TIMEOUT_MS } from '../config/brand.js';

import {
  buildPluginGitArgs,
  buildPluginGitEnv,
  clearGitAvailabilityCache,
  DEFAULT_PLUGIN_GIT_TIMEOUT_MS,
  formatPluginTimeoutDuration,
  getPluginGitTimeoutMs,
  getPluginTimeoutSeconds,
  PLUGIN_GIT_SSH_COMMAND,
} from './pluginGit.js';

describe('pluginGit', () => {
  afterEach(() => {
    clearGitAvailabilityCache();
    vi.unstubAllEnvs();
  });

  it('forces SSH and credential handling to be non-interactive', () => {
    expect(
      buildPluginGitArgs(['clone', 'git@github.com:owner/repo.git']),
    ).toEqual([
      ...internalGitArgs(),
      '-c',
      'credential.interactive=false',
      '-c',
      `core.sshCommand=${PLUGIN_GIT_SSH_COMMAND}`,
      'clone',
      'git@github.com:owner/repo.git',
    ]);
  });

  it('disables Git and credential-manager prompts', () => {
    expect(
      buildPluginGitEnv({
        PATH: '/usr/bin',
        GIT_TERMINAL_PROMPT: '1',
        GIT_ASKPASS: '/tmp/askpass',
        GCM_INTERACTIVE: 'always',
      }),
    ).toMatchObject({
      PATH: '/usr/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
    });
  });

  it('preserves an explicit SSH command for compatibility', () => {
    expect(
      buildPluginGitEnv({
        GIT_SSH_COMMAND: 'ssh -i /tmp/plugin-key',
      }),
    ).toMatchObject({
      GIT_SSH_COMMAND: 'ssh -i /tmp/plugin-key',
    });
  });

  it('uses one timeout policy for execution and progress display', () => {
    vi.stubEnv(ENV_PLUGIN_GIT_TIMEOUT_MS, '1501');

    expect(getPluginGitTimeoutMs()).toBe(1501);
    expect(getPluginTimeoutSeconds()).toBe(2);
    expect(formatPluginTimeoutDuration()).toBe('2s');
  });

  it('falls back to the default timeout for invalid configuration', () => {
    vi.stubEnv(ENV_PLUGIN_GIT_TIMEOUT_MS, 'invalid');

    expect(getPluginGitTimeoutMs()).toBe(DEFAULT_PLUGIN_GIT_TIMEOUT_MS);
  });
});
