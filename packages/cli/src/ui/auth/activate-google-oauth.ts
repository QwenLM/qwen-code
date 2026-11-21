/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { applyProviderInstallPlan } from '@qwen-code/qwen-code-core/providers/install.js';
import {
  setupGoogleOAuthForUser,
  readGoogleAccount,
} from '@qwen-code/qwen-code-core/code_assist/index.js';
import type { GoogleOAuthInteractiveOptions } from '@qwen-code/qwen-code-core/code_assist/oauth2.js';
import type { UserData } from '@qwen-code/qwen-code-core/code_assist/setup.js';
import {
  CODE_ASSIST_ENDPOINT,
  DEFAULT_GOOGLE_OAUTH_MODEL,
} from '@qwen-code/qwen-code-core/code_assist/constants.js';
import { GOOGLE_OAUTH_ALLOWED_MODELS } from '@qwen-code/qwen-code-core/models/constants.js';
import type { LoadedSettings } from '../../config/settings.js';
import { createLoadedSettingsAdapter } from '../../config/loadedSettingsAdapter.js';

export async function activateGoogleOAuth(
  settings: LoadedSettings,
  config: Config,
  signal: AbortSignal,
  callbacks: Omit<GoogleOAuthInteractiveOptions, 'interactive' | 'signal'> = {},
): Promise<UserData & { email?: string }> {
  signal.throwIfAborted();
  if (!settings.isTrusted) {
    throw new Error('Workspace is not trusted.');
  }
  const enforced = settings.merged.security?.auth?.enforcedType;
  if (enforced && enforced !== AuthType.GOOGLE_OAUTH) {
    throw new Error('Authentication is restricted by policy.');
  }

  const userData = await setupGoogleOAuthForUser(config, {
    ...callbacks,
    signal,
  });
  signal.throwIfAborted();
  const previousAuth = config.getCurrentAuthType() ?? config.getAuthType();
  const previousModel = config.getModel();
  const previousBaseUrl = config.getContentGeneratorConfig().baseUrl;
  const keepCurrentModel =
    previousAuth === AuthType.GOOGLE_OAUTH &&
    GOOGLE_OAUTH_ALLOWED_MODELS.includes(previousModel);
  await applyProviderInstallPlan(
    {
      providerId: 'google-oauth',
      authType: AuthType.GOOGLE_OAUTH,
      ...(keepCurrentModel
        ? {}
        : {
            modelSelection: {
              modelId: DEFAULT_GOOGLE_OAUTH_MODEL,
              baseUrl: CODE_ASSIST_ENDPOINT,
            },
          }),
    },
    {
      settings: createLoadedSettingsAdapter(settings),
      syncAuthState: (authType, modelId, baseUrl) => {
        config.syncModelSelection(authType, modelId, baseUrl);
      },
      refreshAuth: async (authType) => {
        try {
          await config.refreshAuth(authType);
        } catch (error) {
          if (previousAuth) {
            config.syncModelSelection(
              previousAuth,
              previousModel,
              previousBaseUrl,
            );
          } else {
            config.clearAuth();
          }
          throw error;
        }
      },
    },
  );
  return { ...userData, email: await readGoogleAccount() };
}
