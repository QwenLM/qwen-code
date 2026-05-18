/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { CommandContext } from '../ui/commands/types.js';
import { getCliVersion } from './version.js';
import {
  IdeClient,
  AuthType,
  createDebugLogger,
  type LspStatusSnapshot,
} from '@qwen-code/qwen-code-core';
import { formatMemoryUsage } from '../ui/utils/formatters.js';
import { GIT_COMMIT_INFO } from '../generated/git-commit.js';

const debugLogger = createDebugLogger('STATUS');

/**
 * System information interface containing all system-related details
 * that can be collected for debugging and reporting purposes.
 */
export interface SystemInfo {
  cliVersion: string;
  osPlatform: string;
  osArch: string;
  osRelease: string;
  nodeVersion: string;
  npmVersion: string;
  sandboxEnv: string;
  modelVersion: string;
  selectedAuthType: string;
  ideClient: string;
  sessionId: string;
  proxy?: string;
}

/**
 * Additional system information for bug reports
 */
export interface ExtendedSystemInfo extends SystemInfo {
  memoryUsage: string;
  baseUrl?: string;
  apiKeyEnvKey?: string;
  gitCommit?: string;
  proxy?: string;
  fastModel?: string;
  lspStatus?: string;
}

// `execFile` (not the shell-spawning `exec`) so a hostile binary on PATH
// can't inject shell metacharacters. The timeout protects the daemon's
// event loop from a hung `git` / `npm` (NFS stall, Gatekeeper prompt,
// broken install) — `execSync` would have blocked indefinitely.
const VERSION_PROBE_TIMEOUT_MS = 5_000;

/**
 * Run a tiny `<binary> --version` probe with a hard timeout, return stdout
 * trimmed, or `'unknown'` on any failure (including timeout). Helper kept
 * inline (rather than `const probeVersion = promisify(execFile)`) so a
 * `vi.mock('node:child_process', { execFile: vi.fn() })` test can override
 * each call individually — the promisified value would otherwise capture
 * the original `execFile` reference at module load.
 */
function probeVersion(binary: string): Promise<string> {
  return new Promise<string>((resolve) => {
    execFile(
      binary,
      ['--version'],
      { timeout: VERSION_PROBE_TIMEOUT_MS, encoding: 'utf-8' },
      (err, stdout) => {
        if (err) {
          resolve('unknown');
          return;
        }
        resolve(typeof stdout === 'string' ? stdout.trim() : 'unknown');
      },
    );
  });
}

/**
 * Gets the NPM version, handling cases where npm might not be available.
 * Returns 'unknown' if npm command fails, is not found, or exceeds the
 * version-probe timeout.
 */
export async function getNpmVersion(): Promise<string> {
  return probeVersion('npm');
}

/**
 * Gets the Git version, handling cases where git might not be available.
 * Returns 'unknown' if git command fails, is not found, or exceeds the
 * version-probe timeout.
 */
export async function getGitVersion(): Promise<string> {
  return probeVersion('git');
}

/**
 * Gets the IDE client name if IDE mode is enabled.
 * Returns empty string if IDE mode is disabled or IDE client is not detected.
 */
export async function getIdeClientName(
  context: CommandContext,
): Promise<string> {
  if (!context.services.config?.getIdeMode()) {
    return '';
  }
  try {
    const ideClient = await IdeClient.getInstance();
    return ideClient?.getDetectedIdeDisplayName() ?? '';
  } catch {
    return '';
  }
}

/**
 * Gets the sandbox environment information.
 * Handles different sandbox types including sandbox-exec and custom sandbox environments.
 * For bug reports, removes 'qwen-' or 'qwen-code-' prefixes from sandbox names.
 *
 * @param stripPrefix - Whether to strip 'qwen-' prefix (used for bug reports)
 */
export function getSandboxEnv(stripPrefix = false): string {
  const sandbox = process.env['SANDBOX'];

  if (!sandbox || sandbox === 'sandbox-exec') {
    if (sandbox === 'sandbox-exec') {
      const profile = process.env['SEATBELT_PROFILE'] || 'unknown';
      return `sandbox-exec (${profile})`;
    }
    return 'no sandbox';
  }

  // For bug reports, remove qwen- prefix
  if (stripPrefix) {
    return sandbox.replace(/^qwen-(?:code-)?/, '');
  }

  return sandbox;
}

/**
 * Collects comprehensive system information for debugging and reporting.
 * This function gathers all system-related details including OS, versions,
 * sandbox environment, authentication, and session information.
 *
 * @param context - Command context containing config and settings
 * @returns Promise resolving to SystemInfo object with all collected information
 */
export async function getSystemInfo(
  context: CommandContext,
): Promise<SystemInfo> {
  const osPlatform = process.platform;
  const osArch = process.arch;
  const osRelease = os.release();
  const nodeVersion = process.version;
  const npmVersion = await getNpmVersion();
  const sandboxEnv = getSandboxEnv();
  const modelVersion = context.services.config?.getModel() || 'Unknown';
  const cliVersion = await getCliVersion();
  const selectedAuthType = context.services.config?.getAuthType() || '';
  const ideClient = await getIdeClientName(context);
  const sessionId = context.services.config?.getSessionId() || 'unknown';
  const proxy = context.services.config?.getProxy();

  return {
    cliVersion,
    osPlatform,
    osArch,
    osRelease,
    nodeVersion,
    npmVersion,
    sandboxEnv,
    modelVersion,
    selectedAuthType,
    ideClient,
    sessionId,
    proxy,
  };
}

/**
 * Collects extended system information for bug reports.
 * Includes all standard system info plus memory usage and optional base URL.
 *
 * @param context - Command context containing config and settings
 * @returns Promise resolving to ExtendedSystemInfo object
 */
export async function getExtendedSystemInfo(
  context: CommandContext,
): Promise<ExtendedSystemInfo> {
  const baseInfo = await getSystemInfo(context);
  const memoryUsage = formatMemoryUsage(process.memoryUsage().rss);

  // For bug reports, use sandbox name without prefix
  const sandboxEnv = getSandboxEnv(true);

  // Get base URL and apiKeyEnvKey if using OpenAI or Anthropic auth
  const contentGeneratorConfig =
    baseInfo.selectedAuthType === AuthType.USE_OPENAI ||
    baseInfo.selectedAuthType === AuthType.USE_ANTHROPIC
      ? context.services.config?.getContentGeneratorConfig()
      : undefined;
  const baseUrl = contentGeneratorConfig?.baseUrl;
  const apiKeyEnvKey = contentGeneratorConfig?.apiKeyEnvKey;

  // Get git commit info
  const gitCommit =
    GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO)
      ? GIT_COMMIT_INFO
      : undefined;

  // Get fast model from settings
  const fastModel = context.services.settings?.merged?.fastModel || undefined;
  const lspStatus = getLspStatus(context);

  return {
    ...baseInfo,
    sandboxEnv,
    memoryUsage,
    baseUrl,
    apiKeyEnvKey,
    gitCommit,
    fastModel,
    lspStatus,
  };
}

function getLspStatus(context: CommandContext): string | undefined {
  try {
    const snapshot = context.services.config?.getLspStatusSnapshot?.();
    if (!snapshot) {
      return undefined;
    }

    if (context.services.config?.getDebugMode?.()) {
      debugLogger.debug('LSP status snapshot for /status:', snapshot);
    }

    return formatLspStatusSnapshot(snapshot);
  } catch (error) {
    if (context.services.config?.getDebugMode?.()) {
      debugLogger.debug(
        'Unable to read LSP status snapshot for /status:',
        error,
      );
    }
    return undefined;
  }
}

function formatLspStatusSnapshot(snapshot: LspStatusSnapshot): string {
  if (!snapshot.enabled) {
    return 'disabled';
  }

  if (snapshot.initializationError) {
    return `enabled, initialization failed: ${snapshot.initializationError}`;
  }

  if (snapshot.statusUnavailable) {
    return 'enabled, status unavailable';
  }

  if (snapshot.configuredServers === 0) {
    return 'enabled, no servers configured';
  }

  const details = [
    snapshot.failedServers > 0 ? `${snapshot.failedServers} failed` : '',
    snapshot.inProgressServers > 0
      ? `${snapshot.inProgressServers} starting`
      : '',
    snapshot.notStartedServers > 0
      ? `${snapshot.notStartedServers} not started`
      : '',
  ].filter(Boolean);

  const detailText = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `enabled, ${snapshot.readyServers}/${snapshot.configuredServers} ready${detailText}`;
}
