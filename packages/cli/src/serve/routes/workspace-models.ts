/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { loadSettings, SettingScope } from '../../config/settings.js';
import {
  getModelProvidersOwnerScope,
  getOwnKeyScope,
  getWritableScopes,
} from '../../config/modelProvidersScope.js';
import { getSettingDefinition } from '../../utils/settingsUtils.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  isActiveModelSelection,
  removeModelFromProviders,
  type RemoveModelTarget,
} from '../model-providers-edit.js';
import {
  WorkspaceSettingsPartialPersistError,
  type WorkspaceSettingsWrite,
} from '../workspace-service/types.js';
import { sendGenerationClosedError } from '../workspace-route-runtime.js';

type PersistSettings = (
  workspace: string,
  writes: WorkspaceSettingsWrite[],
  assertGenerationOpen?: () => void,
) => Promise<void>;

const MAX_MODEL_FIELD_LENGTH = 1024;

function scopeToWire(scope: SettingScope): string {
  // Writes are only ever Workspace/User (the scope helpers never return others),
  // so reject anything else loudly rather than silently reporting it as 'user'.
  if (scope === SettingScope.Workspace) return 'workspace';
  if (scope === SettingScope.User) return 'user';
  throw new Error(`unexpected settings scope for wire mapping: ${scope}`);
}

export interface WorkspaceModelsRouteDeps {
  boundWorkspace: string;
  isWorkspaceTrusted?: () => boolean;
  captureGenerationAssertion?: () => (() => void) | undefined;
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
  if (baseUrl !== undefined && typeof baseUrl !== 'string') {
    return { error: '`baseUrl` must be a string', code: 'invalid_base_url' };
  }
  if (typeof baseUrl === 'string' && baseUrl.length > MAX_MODEL_FIELD_LENGTH) {
    return {
      error: '`baseUrl` exceeds length limit',
      code: 'invalid_base_url',
    };
  }
  if (
    authType.length > MAX_MODEL_FIELD_LENGTH ||
    modelId.length > MAX_MODEL_FIELD_LENGTH
  ) {
    return { error: 'field exceeds length limit', code: 'invalid_field' };
  }
  // Return trimmed values — validation trims, so raw padding would otherwise
  // fail the exact string match in removeModelFromProviders (misleading 404).
  const trimmedBaseUrl = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  return {
    authType: authType.trim(),
    modelId: modelId.trim(),
    ...(trimmedBaseUrl ? { baseUrl: trimmedBaseUrl } : {}),
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
      const assertGenerationOpen =
        deps.captureGenerationAssertion?.() ?? (() => {});
      assertGenerationOpen();
      const parsed = parseTarget(safeBody(req));
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error, code: parsed.code });
        return;
      }

      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;

      const broadcastWrite = (write: WorkspaceSettingsWrite) => {
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
      };

      let writes: WorkspaceSettingsWrite[];
      try {
        const loaded = loadSettings(boundWorkspace, {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: deps.isWorkspaceTrusted?.() === false,
        });
        const scope = getModelProvidersOwnerScope(loaded) ?? SettingScope.User;
        const modelProviders =
          loaded.forScope(scope).settings.modelProviders ?? {};
        const { next, removed, removedBaseUrl } = removeModelFromProviders(
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

        // `model.name`/`model.baseUrl` are scoped independently of
        // `modelProviders`, so clear the active selection in EVERY writable
        // scope whose own selection points at the removed model — a tombstone
        // written only to the providers-owner scope wouldn't override a
        // higher-precedence scope that still names the deleted model. Compare
        // against the removed entry's stored (unsanitized) baseUrl, since the
        // request's baseUrl is sanitized and would miss a credential-bearing
        // stored URL.
        const activeTarget: RemoveModelTarget = {
          authType: parsed.authType,
          modelId: parsed.modelId,
          ...(removedBaseUrl ? { baseUrl: removedBaseUrl } : {}),
        };
        for (const activeScope of getWritableScopes(loaded)) {
          const scopeModel = loaded.forScope(activeScope).settings.model;
          if (
            isActiveModelSelection(
              scopeModel?.name,
              scopeModel?.baseUrl,
              activeTarget,
            )
          ) {
            writes.push({ scope: activeScope, key: 'model.name', value: '' });
            writes.push({
              scope: activeScope,
              key: 'model.baseUrl',
              value: '',
            });
          }
        }

        // Drop the deleted model from modelFallbacks so it doesn't linger as a
        // dangling fallback reference the runtime/UI would show as unavailable.
        // Fallbacks store bare model ids, so only scrub when no other provider
        // still configures a model with the same id (else the fallback may have
        // been intended for that other provider's variant). `modelFallbacks` is
        // scoped independently of `modelProviders`, so resolve and rewrite it in
        // its own owning scope.
        const stillConfigured = Object.values(next).some(
          (models) =>
            Array.isArray(models) &&
            models.some((model) => model.id === parsed.modelId),
        );
        const fallbacksScope = getOwnKeyScope(loaded, 'modelFallbacks');
        const fallbacks = fallbacksScope
          ? loaded.forScope(fallbacksScope).settings.modelFallbacks
          : undefined;
        if (
          !stillConfigured &&
          fallbacksScope &&
          typeof fallbacks === 'string' &&
          fallbacks.length > 0
        ) {
          const original = fallbacks
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
          const kept = original.filter((id) => id !== parsed.modelId);
          if (kept.length !== original.length) {
            writes.push({
              scope: fallbacksScope,
              key: 'modelFallbacks',
              value: kept.join(','),
            });
          }
        }

        try {
          if (deps.captureGenerationAssertion) {
            await persistSettings(boundWorkspace, writes, assertGenerationOpen);
          } else {
            await persistSettings(boundWorkspace, writes);
          }
        } catch (err) {
          // A multi-key write can fail after committing some keys — surface the
          // committed ones to live clients before reporting the failure.
          if (err instanceof WorkspaceSettingsPartialPersistError) {
            assertGenerationOpen();
            for (const write of err.committedWrites) broadcastWrite(write);
          }
          throw err;
        }
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        writeStderrLine(
          `qwen serve: DELETE /workspace/models error (authType=${parsed.authType}, modelId=${parsed.modelId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // On a partial persist, tell the caller which keys committed so it can
        // reconcile (e.g. modelProviders removed but model.name not cleared).
        if (err instanceof WorkspaceSettingsPartialPersistError) {
          res.status(500).json({
            error: 'Model removal only partially persisted',
            code: 'partial_persist_error',
            committedKeys: err.committedWrites.map((write) => write.key),
          });
          return;
        }
        res.status(500).json({
          error: 'Failed to remove model',
          code: 'internal_error',
        });
        return;
      }

      try {
        assertGenerationOpen();
      } catch (err) {
        if (sendGenerationClosedError(res, err)) return;
        throw err;
      }
      for (const write of writes) broadcastWrite(write);

      const clearedActiveModel = writes.some((w) => w.key === 'model.name');
      // Surface restart-required so the UI can prompt (e.g. modelFallbacks).
      const requiresRestart = writes.some(
        (w) => getSettingDefinition(w.key)?.requiresRestart === true,
      );
      res
        .status(200)
        .json({ removed: true, clearedActiveModel, requiresRestart });
    },
  );
}
