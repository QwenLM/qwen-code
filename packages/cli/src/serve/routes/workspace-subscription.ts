/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler } from 'express';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { QWEN_SUBSCRIPTION_BASE_URL } from '@qwen-code/qwen-code-core/qwen/oauth-config.js';
import {
  selectSubscriptionModel,
  SubscriptionModelSelectionError,
  SUBSCRIPTION_MODELS_UNAVAILABLE,
} from '@qwen-code/qwen-code-core/qwen/subscription-models.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { SettingScope, loadSettings } from '../../config/settings.js';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
  parseAndValidateWorkspaceClientId,
} from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

// Account credentials are global; model selection belongs to the resolved runtime.
export function registerWorkspaceSubscriptionRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
    persistSettings?: (
      workspace: string,
      writes: Array<{ scope: SettingScope; key: string; value: unknown }>,
      assertGenerationOpen?: () => void,
    ) => Promise<void>;
    sendBridgeError: SendBridgeError;
  },
): void {
  const activate =
    (route: string, workspace: boolean): RequestHandler =>
    async (req, res) => {
      const runtime = workspace
        ? resolveWorkspaceRuntimeFromParam(deps.workspaceRegistry, req, res)
        : undefined;
      if (
        workspace &&
        (!runtime || !requireTrustedWorkspaceRuntime(runtime, res))
      )
        return;
      const { persistSettings } = deps;
      const target = runtime && persistSettings && { runtime, persistSettings };
      if (workspace && !target) {
        res.status(501).json({ code: 'not_implemented' });
        return;
      }
      const clientId = runtime
        ? parseAndValidateWorkspaceClientId(req, res, runtime.bridge)
        : undefined;
      if (clientId === null) return;
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on('close', disconnect);
      const assertActive = () => {
        controller.signal.throwIfAborted();
        runtime?.generationGuard?.assertOpen();
      };
      try {
        assertActive();
        if (runtime) {
          const settings = loadSettings(runtime.workspaceCwd, {
            skipLoadEnvironment: true,
            workspaceTrusted: true,
          });
          if (!settings.workspaceSettingsActive) {
            res.status(409).json({
              code: 'workspace_settings_unavailable',
              message: 'Open a project folder to activate Qwen Subscription.',
            });
            return;
          }
          const enforced = settings.merged.security?.auth?.enforcedType;
          if (enforced && enforced !== AuthType.QWEN_SUBSCRIPTION) {
            res.status(403).json({ code: 'auth_type_enforced' });
            return;
          }
        }
        const session = new QwenSubscriptionSession();
        const info = await session.getUserInfo(controller.signal);
        assertActive();
        if (
          !info ||
          !['plus', 'pro'].includes(info.member_type.toLowerCase())
        ) {
          res.status(403).json({ code: 'subscription_required' });
          return;
        }
        const { models } = await session.getModels(controller.signal);
        assertActive();
        const modelId = selectSubscriptionModel(models);
        if (!target) {
          res.status(200).json({ modelId });
          return;
        }
        const { workspaceCwd, workspaceService } = target.runtime;
        await target.persistSettings(
          workspaceCwd,
          [
            {
              scope: SettingScope.Workspace,
              key: 'security.auth.selectedType',
              value: AuthType.QWEN_SUBSCRIPTION,
            },
            {
              scope: SettingScope.Workspace,
              key: 'model.name',
              value: modelId,
            },
            {
              scope: SettingScope.Workspace,
              key: 'model.baseUrl',
              value: QWEN_SUBSCRIPTION_BASE_URL,
            },
          ],
          assertActive,
        );
        assertActive();
        const runtimeSync = await workspaceService.reloadModelProviders(
          createBuildWorkspaceCtx(workspaceCwd)(route, clientId),
        );
        assertActive();
        res.status(200).json({
          authType: AuthType.QWEN_SUBSCRIPTION,
          modelId,
          runtimeSync,
        });
      } catch (error) {
        if (!res.destroyed && error instanceof SubscriptionOAuthError) {
          if (error.retryAfterMs)
            res.setHeader('Retry-After', Math.ceil(error.retryAfterMs / 1000));
          res
            .status(error.status && error.status >= 400 ? error.status : 502)
            .json({
              code: error.code,
              message:
                error.status && error.status >= 400
                  ? error.description
                  : undefined,
              errorStage: error.stage ?? 'models',
              errorStatus: error.status,
              retryAfterMs: error.retryAfterMs,
            });
          return;
        }
        if (
          !res.destroyed &&
          error instanceof SubscriptionModelSelectionError
        ) {
          res.status(409).json({
            code: 'subscription_model_unavailable',
          });
          return;
        }
        if (
          !res.destroyed &&
          error instanceof Error &&
          error.message.includes(SUBSCRIPTION_MODELS_UNAVAILABLE)
        ) {
          res.status(502).json({ code: 'subscription_models_unavailable' });
          return;
        }
        if (!res.destroyed) deps.sendBridgeError(res, error, { route });
      } finally {
        res.off('close', disconnect);
      }
    };
  app.post(
    '/auth/subscription/model',
    deps.mutate({ strict: true }),
    activate('POST /auth/subscription/model', false),
  );
  app.post(
    '/workspaces/:workspace/auth/subscription',
    deps.mutate({ strict: true }),
    activate('POST /workspaces/:workspace/auth/subscription', true),
  );
}
