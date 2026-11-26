/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { runLogger } from '@qwen-code/core';
import {
  mutateSettingsFile as mutateResourceSettingsFile,
  type SettingsFileMutation,
  type SettingsMutationOptions,
  type SettingsWriteResult,
} from '@qwen-code/resource';

export type { SettingsFileMutation, SettingsMutationOptions, SettingsWriteResult };

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as NodeJS.ErrnoException).code ?? 'UNKNOWN');
  }
  return 'UNKNOWN';
}

export function logInfrastructureFailure(
  stage: 'lock-compromised' | 'unlock',
  logicalPath: string,
  error: unknown,
): void {
  runLogger.warn(
    `[SettingsPersistence] ${stage} (${path.basename(logicalPath)}, ${errorCode(error)})`,
  );
}

function withDiagnostics(
  options: SettingsMutationOptions,
): SettingsMutationOptions {
  return {
    ...options,
    onInfrastructureError: (stage, filePath, error) => {
      logInfrastructureFailure(stage, filePath, error);
      options.onInfrastructureError?.(stage, filePath, error);
    },
  };
}

/** Keep the CLI entry point while Resource owns the file transaction. */
export function mutateSettingsFile(
  logicalPath: string,
  mutation: SettingsFileMutation,
  options: SettingsMutationOptions = {},
): SettingsWriteResult {
  const normalizedPath = path.normalize(path.resolve(logicalPath));
  return mutateResourceSettingsFile(
    normalizedPath,
    mutation,
    withDiagnostics(options),
  );
}
