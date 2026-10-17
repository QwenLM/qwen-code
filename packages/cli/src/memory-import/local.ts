/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';
import { proposeMemoryImport } from '@qwen-code/qwen-code-core/memory/import-model.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import { loadSettings } from '../config/settings.js';
import { getAuthTypeFromEnv } from '../utils/modelConfigUtils.js';
import { MemoryImportService } from './service.js';

export async function createLocalMemoryImportService(): Promise<MemoryImportService> {
  const settings = loadSettings(process.cwd());
  const config = await loadCliConfig(
    settings.merged,
    {
      _: [],
      $0: 'qwen',
      sessionId: randomUUID(),
      chatRecording: false,
      debug: false,
      interactive: false,
    } as unknown as CliArgs,
    process.cwd(),
  );
  if (!config.isTrustedFolder() || !config.isManagedMemoryAvailable())
    throw new Error(
      'Memory import requires a trusted workspace with managed memory enabled.',
    );
  const authType =
    getAuthTypeFromEnv() ?? settings.merged.security?.auth?.selectedType;
  if (!authType)
    throw new Error(
      'Configure Qwen model authentication before confirmed import. Offline preview does not require authentication.',
    );
  await config.refreshAuth(authType, true);
  return new MemoryImportService({
    projectRoot: config.getProjectRoot(),
    assertActive: () => {
      if (!config.isTrustedFolder())
        throw new Error('Workspace is no longer trusted.');
    },
    propose: (input, signal) => proposeMemoryImport(config, input, signal),
  });
}
