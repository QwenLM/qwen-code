/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import os from 'node:os';
import { execSync } from 'node:child_process';
import type { CommandContext } from '../ui/commands/types.js';
import { getCliVersion } from './version.js';
import { IdeClient, AuthType } from '@qwen-code/qwen-code-core';
import { formatMemoryUsage } from '../ui/utils/formatters.js';
import { GIT_COMMIT_INFO } from '../generated/git-commit.js';

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
}

/**
 * Additional system information for bug reports
 */
export interface ExtendedSystemInfo extends SystemInfo {
  memoryUsage: string;
  baseUrl?: string;
  gitCommit?: string;
}

/**
 * Gets the NPM version, handling cases where npm might not be available.
 * Returns 'unknown' if npm command fails or is not found.
 */
export async function getNpmVersion(): Promise<string> {
  try {
    return execSync('npm --version', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
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
  const selectedAuthType =
    context.services.settings.merged.security?.auth?.selectedType || '';
  const ideClient = await getIdeClientName(context);
  const sessionId = context.services.config?.getSessionId() || 'unknown';

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

  // Get base URL if using OpenAI auth
  const baseUrl =
    baseInfo.selectedAuthType === AuthType.USE_OPENAI ||
    baseInfo.selectedAuthType === AuthType.USE_ANTHROPIC
      ? context.services.config?.getContentGeneratorConfig()?.baseUrl
      : undefined;

  // Get git commit info
  const gitCommit =
    GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO)
      ? GIT_COMMIT_INFO
      : undefined;

  return {
    ...baseInfo,
    sandboxEnv,
    memoryUsage,
    baseUrl,
    gitCommit,
  };
}
