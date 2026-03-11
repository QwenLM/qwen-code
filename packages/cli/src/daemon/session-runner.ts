/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { loadSettings } from '../config/settings.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import { runNonInteractive } from '../nonInteractiveCli.js';

export interface DaemonSessionOptions {
  cwd: string;
  prompt: string;
  sessionId: string;
  abortSignal: AbortSignal;
  onOutput: (text: string) => void;
  onToolCall: (toolName: string) => void;
  onError: (error: string) => void;
}

/**
 * Runs a single prompt through the Qwen Code engine in daemon mode.
 * Leverages the existing non-interactive pipeline with stdout/stderr intercepted.
 */
export async function runDaemonSession(
  options: DaemonSessionOptions,
): Promise<void> {
  const { cwd, prompt, sessionId, abortSignal, onOutput, onError } = options;

  const settings = loadSettings();

  // Build minimal argv for config loading
  const argv: Partial<CliArgs> = {
    query: prompt,
    prompt,
    sessionId,
    outputFormat: 'text',
  };

  let config;
  try {
    config = await loadCliConfig(settings.merged, argv as CliArgs, cwd);
  } catch (err) {
    onError(
      `Failed to initialize config: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const abortController = new AbortController();

  // Link external abort signal
  const abortHandler = () => abortController.abort();
  abortSignal.addEventListener('abort', abortHandler, { once: true });

  // Intercept stdout to capture output
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const captureWrite =
    (callback: (text: string) => void) =>
    (
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
      cb?: (error?: Error | null) => void,
    ): boolean => {
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk).toString('utf-8');
      if (text.trim()) {
        callback(text);
      }
      // Call the callback if provided
      const callback_ = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      if (callback_) callback_();
      return true;
    };

  // Temporarily redirect stdout/stderr
  process.stdout.write = captureWrite(onOutput) as typeof process.stdout.write;
  process.stderr.write = captureWrite(onError) as typeof process.stderr.write;

  try {
    await runNonInteractive(config, settings, prompt, randomUUID(), {
      abortController,
    });
  } catch (err) {
    if (!abortController.signal.aborted) {
      onError(err instanceof Error ? err.message : 'Session error');
    }
  } finally {
    // Restore stdout/stderr
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    abortSignal.removeEventListener('abort', abortHandler);
  }
}
