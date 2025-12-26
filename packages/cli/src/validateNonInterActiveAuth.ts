/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { AuthType, OutputFormat } from '@qwen-code/qwen-code-core';
import { USER_SETTINGS_PATH } from './config/settings.js';
import { validateAuthMethod } from './config/auth.js';
import { type LoadedSettings } from './config/settings.js';
import { JsonOutputAdapter } from './nonInteractive/io/JsonOutputAdapter.js';
import { StreamJsonOutputAdapter } from './nonInteractive/io/StreamJsonOutputAdapter.js';
import { runExitCleanup } from './utils/cleanup.js';

function getAuthTypeFromEnv(): AuthType | undefined {
  if (process.env['OPENAI_API_KEY']) {
    return AuthType.USE_OPENAI;
  }
  if (process.env['QWEN_OAUTH']) {
    return AuthType.QWEN_OAUTH;
  }

  if (process.env['GEMINI_API_KEY']) {
    return AuthType.USE_GEMINI;
  }
  if (process.env['GOOGLE_API_KEY']) {
    return AuthType.USE_VERTEX_AI;
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    return AuthType.USE_ANTHROPIC;
  }

  return undefined;
}

export async function validateNonInteractiveAuth(
  configuredAuthType: AuthType | undefined,
  useExternalAuth: boolean | undefined,
  nonInteractiveConfig: Config,
  settings: LoadedSettings,
): Promise<Config> {
  try {
    const enforcedType = settings.merged.security?.auth?.enforcedType;
    if (enforcedType) {
      const currentAuthType = getAuthTypeFromEnv();
      if (currentAuthType !== enforcedType) {
        const message = `The configured auth type is ${enforcedType}, but the current auth type is ${currentAuthType}. Please re-authenticate with the correct type.`;
        throw new Error(message);
      }
    }

    const effectiveAuthType =
      enforcedType || configuredAuthType || getAuthTypeFromEnv();

    if (!effectiveAuthType) {
      const message = `Please set an Auth method in your ${USER_SETTINGS_PATH} or specify one of the following environment variables before running: QWEN_OAUTH, OPENAI_API_KEY`;
      throw new Error(message);
    }

    const authType: AuthType = effectiveAuthType as AuthType;

    if (!useExternalAuth) {
      const err = validateAuthMethod(String(authType));
      if (err != null) {
        throw new Error(err);
      }
    }

    await nonInteractiveConfig.refreshAuth(authType);
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
