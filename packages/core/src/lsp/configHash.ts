/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { LspServerConfig } from './types.js';

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function lspServerConfigHash(config: LspServerConfig): string {
  const hashInput = {
    name: config.name,
    languages: config.languages,
    transport: config.transport,
    command: config.command,
    args: config.args,
    env: config.env,
    initializationOptions: config.initializationOptions,
    settings: config.settings,
    extensionToLanguage: config.extensionToLanguage,
    workspaceFolder: config.workspaceFolder,
    rootUri: config.rootUri,
    startupTimeout: config.startupTimeout,
    shutdownTimeout: config.shutdownTimeout,
    restartOnCrash: config.restartOnCrash,
    maxRestarts: config.maxRestarts,
    trustRequired: config.trustRequired,
    socket: config.socket,
  } satisfies Record<keyof LspServerConfig, unknown>;
  const stableConfig = sortJsonValue(hashInput);
  return createHash('sha256')
    .update(JSON.stringify(stableConfig))
    .digest('hex');
}
