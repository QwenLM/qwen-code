/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { readAgentixMemorySnapshot } from './agentixMemoryContext.js';

const AGENTIX_AUTO_TRAIN_ENV = 'QWEN_AGENTIX_AUTO_TRAIN';
const AGENTIX_BINARY_ENV = 'QWEN_AGENTIX_BINARY';
const AGENTIX_EXTRACT_SCRIPT_ENV = 'QWEN_AGENTIX_EXTRACT_SCRIPT';
const AGENTIX_TRAINING_TIMEOUT_ENV = 'QWEN_AGENTIX_TRAINING_TIMEOUT_MS';
const DEFAULT_TRAINING_TIMEOUT_MS = 10 * 60 * 1000;
const debugLogger = createDebugLogger('AGENTIX_MEMORY_TRAINER');

const activeTrainingBySession = new Map<string, Promise<string>>();

export function isAgentixAutoTrainingEnabled(): boolean {
  return process.env[AGENTIX_AUTO_TRAIN_ENV]?.trim() === '1';
}

function getTrainingTimeout(): number {
  const configuredTimeout = Number.parseInt(
    process.env[AGENTIX_TRAINING_TIMEOUT_ENV] ?? '',
    10,
  );
  return Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TRAINING_TIMEOUT_MS;
}

function runExternalCommand(
  binary: string,
  args: string[],
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        signal,
        timeout: getTrainingTimeout(),
        maxBuffer: 1024 * 1024,
      },
      (error) => {
        if (error) {
          reject(
            new Error(`Agentix '${label}' command failed: ${error.message}`, {
              cause: error,
            }),
          );
          return;
        }
        resolve();
      },
    );
  });
}

function runAgentixCommand(
  command: 'train' | 'snapshot',
  signal?: AbortSignal,
): Promise<void> {
  const binary = process.env[AGENTIX_BINARY_ENV]?.trim() || 'qwen-agentix';
  return runExternalCommand(binary, [command], command, signal);
}

function runQwenConversationExtraction(signal?: AbortSignal): Promise<void> {
  const extractScript =
    process.env[AGENTIX_EXTRACT_SCRIPT_ENV]?.trim() ||
    path.join(
      os.homedir(),
      '.qwen',
      'agentix-memory',
      'scripts',
      'extract-qwen.js',
    );
  return runExternalCommand(
    process.execPath,
    [extractScript],
    'extract-qwen',
    signal,
  );
}

async function trainAndSnapshot(
  sessionId: string,
  signal?: AbortSignal,
): Promise<string> {
  // These are the documented Qwen/Agentix commands. Qwen treats the
  // implementation as opaque and never imports sidecar code.
  await runQwenConversationExtraction(signal);
  await runAgentixCommand('train', signal);
  await runAgentixCommand('snapshot', signal);

  const snapshot = readAgentixMemorySnapshot(sessionId);
  if (!snapshot) {
    throw new Error(
      'Agentix completed training but did not publish a readable snapshot.',
    );
  }
  return snapshot;
}

/**
 * Refresh Agentix memory, coalescing concurrent compression requests into one
 * training pass.
 */
export async function refreshAgentixMemory(
  sessionId: string,
  signal?: AbortSignal,
): Promise<string> {
  const activeTraining = activeTrainingBySession.get(sessionId);
  if (activeTraining) {
    debugLogger.debug(
      `Reusing the active Agentix training pass for ${sessionId}.`,
    );
    return activeTraining;
  }

  const training = trainAndSnapshot(sessionId, signal).finally(() => {
    activeTrainingBySession.delete(sessionId);
  });
  activeTrainingBySession.set(sessionId, training);
  return training;
}
