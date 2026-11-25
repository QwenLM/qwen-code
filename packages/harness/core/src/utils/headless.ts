/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import {
  readBrandEnv,
  ENV_INTEGRATION_TEST,
  ENV_AGENT_SDK_ENTRYPOINT,
  ENV_REMOTE_WORKER,
} from '../config/brand.js';

/**
 * Options for headless mode detection.
 */
export interface HeadlessModeOptions {
  /** Explicit prompt string or flag. */
  prompt?: string | boolean;
  /**
   * @deprecated No longer affects headless detection. Will be removed in a
   * future version.
   */
  query?: string | boolean;
  /** Input format flag (e.g., 'stream-json'). */
  inputFormat?: string;
  /** Print flag (SDK mode). */
  print?: boolean;
}

/**
 * Detects if the CLI is running in a "headless" (non-interactive) mode.
 *
 * Headless mode is triggered by:
 * 1. process.env.CI being set to 'true'.
 * 2. process.stdin or process.stdout not being a TTY.
 * 3. Presence of an explicit prompt flag.
 * 4. SDK-style input/output flags.
 *
 * @param options - Optional flags and arguments from the CLI.
 * @returns true if the environment is considered headless.
 */
export function isHeadlessMode(options?: HeadlessModeOptions): boolean {
  if (readBrandEnv(ENV_INTEGRATION_TEST) !== 'true') {
    const isCI =
      process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
    if (isCI) {
      return true;
    }
  }

  const isNotTTY =
    (!!process.stdin && !process.stdin.isTTY) ||
    (!!process.stdout && !process.stdout.isTTY);

  if (isNotTTY || !!options?.prompt) {
    return true;
  }

  // --input-format stream-json or --print implies SDK-driven headless mode
  if (options?.inputFormat === 'stream-json' || options?.print) {
    return true;
  }

  // Fallback: check process.argv for flags that imply headless mode.
  return process.argv.some(
    (arg, i, arr) =>
      arg === '-p' ||
      arg === '--prompt' ||
      arg.startsWith('--prompt=') ||
      arg === '--print' ||
      arg === '--input-format=stream-json' ||
      (arg === '--input-format' && arr[i + 1] === 'stream-json'),
  );
}

/**
 * The env var set by the Agent SDK's ProcessTransport to signal SDK mode.
 */
/**
 * Returns true when the CLI is running as a child process of the Agent SDK.
 * Centralises the env-var check so callers don't need to hardcode the name.
 */
export function isSDKMode(): boolean {
  return !!process.env[ENV_AGENT_SDK_ENTRYPOINT];
}

const REMOTE_WORKER_ENV = ENV_REMOTE_WORKER;

/**
 * Returns true when the CLI is running as a headless remote worker driven by
 * a remote controller. The entrypoint sets this env var before any other
 * module reads classification. Worker mode is headless but delegates tool
 * confirmations and `ask_user` to the remote controller.
 */
export function isRemoteWorkerMode(): boolean {
  return !!process.env[REMOTE_WORKER_ENV];
}
