/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { getModelProvidersOwnerScope } from '../../config/modelProvidersScope.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  isActiveModelSelection,
  removeModelFromProviders,
  type RemoveModelTarget,
} from '../model-providers-edit.js';
import type { WorkspaceSettingsWrite } from '../workspace-service/types.js';

type PersistSettings = (
  workspace: string,
  writes: WorkspaceSettingsWrite[],
) => Promise<void>;

const MAX_MODEL_FIELD_LENGTH = 1024;

function scopeToWire(scope: SettingScope): string {
  return scope === SettingScope.Workspace ? 'workspace' : 'user';
}

export interface WorkspaceModelsRouteDeps {
  boundWorkspace: string;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  persistSettings: PersistSettings;
  broadcastSettingsChanged: (
    key: string,
    value: unknown,
    scope: string,
    clientId: string | undefined,
  ) => void;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
}

function parseTarget(
  body: Record<string, unknown>,
): RemoveModelTarget | { error: string; code: string } {
  const authType = body['authType'];
  const modelId = body['modelId'];
  const baseUrl = body['baseUrl'];
  if (typeof authType !== 'string' || !authType.trim()) {
    return { error: '`authType` is required', code: 'invalid_auth_type' };
  }
  if (typeof modelId !== 'string' || !modelId.trim()) {
    return { error: '`modelId` is required', code: 'invalid_model_id' };
  }
  if (
    baseUrl !== undefined &&
    (typeof baseUrl !== 'string' || baseUrl.length > MAX_MODEL_FIELD_LENGTH)
  ) {
    return { error: '`baseUrl` must be a string', code: 'invalid_base_url' };
  }
  if (
    authType.length > MAX_MODEL_FIELD_LENGTH ||
    modelId.length > MAX_MODEL_FIELD_LENGTH
  ) {
    return { error: 'field exceeds length limit', code: 'invalid_field' };
  }
  return {
    authType,
    modelId,
    ...(typeof baseUrl === 'string' && baseUrl.length > 0 ? { baseUrl } : {}),
  };
}

/**
 * Removes a configured model from `modelProviders` in the scope that owns the
 * effective model-provider config. When the removed model was the active
 * selection, `model.name`/`model.baseUrl` are cleared in the same write so the
 * runtime doesn't keep pointing at a model that no longer exists.
 */
export function registerWorkspaceModelsRoutes(
  app: Application,
  deps: WorkspaceModelsRouteDeps,
): void {
  const {
    boundWorkspace,
    mutate,
    safeBody,
    persistSettings,
    broadcastSettingsChanged,
    parseAndValidateClientId,
  } = deps;

  app.delete(
    '/workspace/models',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const parsed = parseTarget(safeBody(req));
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error, code: parsed.code });
        return;
      }

      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;

      let writes: WorkspaceSettingsWrite[];
      try {
        const loaded = loadSettings(boundWorkspace);
        const scope = getModelProvidersOwnerScope(loaded) ?? SettingScope.User;
        const scopeSettings = loaded.forScope(scope).settings;
        const modelProviders = scopeSettings.modelProviders ?? {};
        const { next, removed } = removeModelFromProviders(
          modelProviders,
          loaded.merged.providerProtocol,
          parsed,
        );
        if (!removed) {
          res.status(404).json({
            error: 'Model not found in configured providers',
            code: 'model_not_found',
          });
          return;
        }

        writes = [{ scope, key: 'modelProviders', value: next }];

        const active = isActiveModelSelection(
          loaded.merged.model?.name,
          loaded.merged.model?.baseUrl,
          parsed,
        );
        if (active) {
          writes.push({ scope, key: 'model.name', value: '' });
          writes.push({ scope, key: 'model.baseUrl', value: '' });
        }

        await persistSettings(boundWorkspace, writes);
      } catch (err) {
        writeStderrLine(
          `qwen serve: DELETE /workspace/models error (authType=${parsed.authType}, modelId=${parsed.modelId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to remove model',
          code: 'internal_error',
        });
        return;
      }

      for (const write of writes) {
        try {
          broadcastSettingsChanged(
            write.key,
            write.value,
            scopeToWire(write.scope),
            clientId,
          );
        } catch (err) {
          writeStderrLine(
            `qwen serve: DELETE /workspace/models broadcast error (key=${write.key}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      const clearedActiveModel = writes.some((w) => w.key === 'model.name');
      res.status(200).json({ removed: true, clearedActiveModel });
    },
  );
}
