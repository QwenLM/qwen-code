/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { internalGitArgs, internalGitEnv } from '../utils/gitCommandPolicy.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ENV_PLUGIN_GIT_TIMEOUT_MS } from '../config/brand.js';

const execFileAsync = promisify(execFile);

let cachedResult: boolean | null = null;

export const PLUGIN_GIT_SSH_COMMAND =
  'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes';

export const DEFAULT_PLUGIN_GIT_TIMEOUT_MS = 120_000;

export function getPluginGitTimeoutMs(): number {
  const raw = process.env[ENV_PLUGIN_GIT_TIMEOUT_MS];
  if (!raw) return DEFAULT_PLUGIN_GIT_TIMEOUT_MS;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_PLUGIN_GIT_TIMEOUT_MS;
}

export function getPluginTimeoutSeconds(
  timeoutMs = getPluginGitTimeoutMs(),
): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

export function formatPluginTimeoutDuration(
  timeoutMs = getPluginGitTimeoutMs(),
): string {
  return `${getPluginTimeoutSeconds(timeoutMs)}s`;
}

/**
 * Check if git is available on the system.
 *
 * Memoized so repeated calls within a session return the cached result.
 * Git availability is unlikely to change during a single CLI session.
 *
 * Only checks PATH via `git --version`.
 */
export async function checkGitAvailable(): Promise<boolean> {
  if (cachedResult !== null) return cachedResult;

  try {
    await execFileAsync('git', ['--version'], {
      timeout: 5000,
      windowsHide: true,
    });
    cachedResult = true;
  } catch {
    cachedResult = false;
  }

  return cachedResult;
}

/** Clear the git availability cache. Used for testing purposes. */
export function clearGitAvailabilityCache(): void {
  cachedResult = null;
}

/**
 * Build git arguments that prevent SSH from opening an interactive prompt on
 * the controlling terminal. The SSH command still honors the user's ssh_config
 * and agent, but unknown host keys and missing credentials fail immediately.
 * An explicit GIT_SSH_COMMAND remains an intentional user override, matching
 * Git's normal precedence rules.
 */
export function buildPluginGitArgs(args: string[]): string[] {
  return [
    ...internalGitArgs(),
    '-c',
    'credential.interactive=false',
    '-c',
    `core.sshCommand=${PLUGIN_GIT_SSH_COMMAND}`,
    ...args,
  ];
}

/**
 * Build an environment that prevents Git and common credential helpers from
 * prompting while plugin maintenance runs behind the interactive TUI.
 */
export function buildPluginGitEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...internalGitEnv(env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
  };
}

export async function execPluginGit(
  args: string[],
  options: {
    cwd?: string;
    timeout: number;
  },
): Promise<void> {
  await execFileAsync('git', buildPluginGitArgs(args), {
    ...options,
    env: buildPluginGitEnv(),
    windowsHide: true,
  });
}
