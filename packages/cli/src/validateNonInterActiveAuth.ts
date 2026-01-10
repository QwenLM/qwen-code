/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { OutputFormat } from '@qwen-code/qwen-code-core';
import { validateAuthMethod } from './config/auth.js';
import { type LoadedSettings } from './config/settings.js';
import { JsonOutputAdapter } from './nonInteractive/io/JsonOutputAdapter.js';
import { StreamJsonOutputAdapter } from './nonInteractive/io/StreamJsonOutputAdapter.js';
import { runExitCleanup } from './utils/cleanup.js';

export async function validateNonInteractiveAuth(
  useExternalAuth: boolean | undefined,
  nonInteractiveConfig: Config,
  settings: LoadedSettings,
): Promise<Config> {
  try {
    // Get the actual authType from config which has already resolved CLI args, env vars, and settings
    const authType = nonInteractiveConfig.modelsConfig.getCurrentAuthType();
    if (!authType) {
      throw new Error(
        'No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode.',
      );
    }
    const resolvedAuthType: NonNullable<typeof authType> = authType;

    const enforcedType = settings.merged.security?.auth?.enforcedType;
    if (enforcedType && enforcedType !== resolvedAuthType) {
      const message = `The configured auth type is ${enforcedType}, but the current auth type is ${resolvedAuthType}. Please re-authenticate with the correct type.`;
      throw new Error(message);
    }

    if (!useExternalAuth) {
      const err = validateAuthMethod(resolvedAuthType, nonInteractiveConfig);
      if (err != null) {
        throw new Error(err);
      }
    }

    await nonInteractiveConfig.refreshAuth(resolvedAuthType);
    return nonInteractiveConfig;
  } catch (error) {
    const outputFormat = nonInteractiveConfig.getOutputFormat();

    // In JSON and STREAM_JSON modes, emit error result and exit
    if (
      outputFormat === OutputFormat.JSON ||
      outputFormat === OutputFormat.STREAM_JSON
    ) {
      let adapter;
      if (outputFormat === OutputFormat.JSON) {
        adapter = new JsonOutputAdapter(nonInteractiveConfig);
      } else {
        adapter = new StreamJsonOutputAdapter(
          nonInteractiveConfig,
          nonInteractiveConfig.getIncludePartialMessages(),
        );
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      adapter.emitResult({
        isError: true,
        errorMessage,
        durationMs: 0,
        apiDurationMs: 0,
        numTurns: 0,
        usage: undefined,
      });
      await runExitCleanup();
      process.exit(1);
    }

    // For other modes (text), use existing error handling
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
