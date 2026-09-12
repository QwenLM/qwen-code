/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  findModelConfiguration,
  findModelConfigurationForDeletion,
  isConversationModelConfiguration,
  isImageModelConfiguration,
  listModelConfigurations,
} from '../model-configuration.js';
import type { Application, Request, Response } from 'express';
import {
  resolveModelId,
  resolveProviderProtocol,
} from '@qwen-code/qwen-code-core';
import { loadSettings, SettingScope } from '../../config/settings.js';
import {
  getOwnKeyScope,
  getWritableScopes,
} from '../../config/modelProvidersScope.js';
import { getSettingDefinition } from '../../config/settingsUtils.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  isActiveModelSelection,
  type RemoveModelTarget,
} from '../model-providers-edit.js';
import {
  WorkspaceSettingsPartialPersistError,
  type WorkspaceSettingsWrite,
} from '../workspace-service/types.js';
import type { ServeModelProviderRuntimeSyncResult } from '../types.js';
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
  updateModelContextWindow?: (
    workspace: string,
    key: string,
    size: number | null,
    assertGenerationOpen: () => void,
  ) => Promise<'user' | 'workspace' | undefined>;
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
  syncModelProvidersRuntime?: (
    writeScope: SettingScope,
    method: 'PATCH' | 'DELETE',
  ) => Promise<ServeModelProviderRuntimeSyncResult>;
}

function parseTarget(
  body: Record<string, unknown>,
): (RemoveModelTarget & { key?: string }) | { error: string; code: string } {
  const key = body['key'];
  if (
    key !== undefined &&
    (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))
  ) {
    return {
      error: 'Invalid model configuration key',
      code: 'invalid_model_key',
    };
  }
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
    ...(key ? { key } : {}),
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

  app.get('/workspace/models', (_req, res) => {
    try {
      deps.captureGenerationAssertion?.()?.();
      const trusted = deps.isWorkspaceTrusted?.();
      const loaded = loadSettings(boundWorkspace, {
        skipLoadEnvironment: true,
        skipWorkspaceSettings: trusted === false,
        workspaceTrusted: trusted,
      });
      res.json({ models: listModelConfigurations(loaded) });
    } catch (error) {
      if (sendGenerationClosedError(res, error)) return;
      writeStderrLine('qwen serve: GET /workspace/models failed');
      res.status(500).json({ error: 'Unable to load model configurations' });
    }
  });

  app.patch('/workspace/models', mutate({ strict: true }), async (req, res) => {
    const assertGenerationOpen =
      deps.captureGenerationAssertion?.() ?? (() => {});
    try {
      assertGenerationOpen();
      const body = safeBody(req);
      const key = body['key'];
      const size = body['contextWindowSize'];
      if (
        typeof key !== 'string' ||
        !/^[a-f0-9]{64}$/.test(key) ||
        (size !== null &&
          (typeof size !== 'number' ||
            !Number.isInteger(size) ||
            size < 1 ||
            size > 10_000_000))
      ) {
        res
          .status(400)
          .json({ error: 'Invalid model key or context window size' });
        return;
      }
      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;
      if (!deps.updateModelContextWindow) {
        res
          .status(501)
          .json({ error: 'Model configuration editing is unavailable' });
        return;
      }
      const scope = await deps.updateModelContextWindow(
        boundWorkspace,
        key,
        size,
        assertGenerationOpen,
      );
      assertGenerationOpen();
      if (!scope) {
        res.status(409).json({
          error:
            'Model configuration changed or is ambiguous. Reload and try again.',
        });
        return;
      }
      try {
        broadcastSettingsChanged('modelProviders', undefined, scope, clientId);
      } catch {
        writeStderrLine('qwen serve: model configuration broadcast failed');
      }
      let runtimeSync: ServeModelProviderRuntimeSyncResult | undefined;
      try {
        runtimeSync = await deps.syncModelProvidersRuntime?.(
          scope === 'user' ? SettingScope.User : SettingScope.Workspace,
          'PATCH',
        );
      } catch (error) {
        if (sendGenerationClosedError(res, error)) return;
        runtimeSync = { status: 'failed' };
      }
      assertGenerationOpen();
      res.json({
        updated: true,
        requiresRestart: true,
        ...(runtimeSync ? { runtimeSync } : {}),
      });
    } catch (error) {
      if (sendGenerationClosedError(res, error)) return;
      writeStderrLine('qwen serve: PATCH /workspace/models failed');
      res.status(500).json({ error: 'Unable to update model configuration' });
    }
  });

  app.delete(
    '/workspace/models',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const assertGenerationOpen =
        deps.captureGenerationAssertion?.() ?? (() => {});
      try {
        assertGenerationOpen();
      } catch {
        res.set('Retry-After', '1');
        res.status(503).json({
          error: 'Workspace runtime is not active.',
          code: 'workspace_runtime_unavailable',
        });
        return;
      }
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

      const conflict = new Error(
        'Model settings changed. Reload and try again.',
      );
      let writes: WorkspaceSettingsWrite[];
      try {
        const workspaceTrusted = deps.isWorkspaceTrusted?.();
        const loaded = loadSettings(boundWorkspace, {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: workspaceTrusted === false,
          workspaceTrusted,
        });
        const configuration = parsed.key
          ? findModelConfiguration(loaded, parsed.key)
          : findModelConfigurationForDeletion(loaded, parsed);
        if (
          configuration === 'ambiguous' ||
          (parsed.key && !configuration) ||
          (configuration && configuration.authType !== parsed.authType)
        ) {
          res.status(409).json({
            error:
              'Model configuration changed or is ambiguous. Reload and try again.',
          });
          return;
        }
        if (!configuration) {
          res.status(404).json({
            error: 'Model not found in configured providers',
            code: 'model_not_found',
          });
          return;
        }
        const scope = configuration.scope;
        const modelProviders =
          loaded.forScope(scope).originalSettings.modelProviders ?? {};
        const resolvedProviders =
          loaded.forScope(scope).settings.modelProviders ?? {};
        const removedBaseUrl = configuration.model.baseUrl;
        const next = { ...modelProviders };
        const remainingProviders = { ...loaded.merged.modelProviders };
        next[configuration.provider] = modelProviders[
          configuration.provider
        ]!.filter((_, index) => index !== configuration.index);
        remainingProviders[configuration.provider] = resolvedProviders[
          configuration.provider
        ]!.filter((_, index) => index !== configuration.index);
        const removedModelId = configuration.model.id;
        const seenRoutes = new Set<string>();
        const remaining = Object.entries(remainingProviders).flatMap(
          ([provider, models]) => {
            const authType = resolveProviderProtocol(
              provider,
              loaded.merged.providerProtocol,
            );
            if (
              !authType ||
              authType === 'qwen-oauth' ||
              !Array.isArray(models)
            )
              return [];
            return models
              .filter((model) => model?.id === removedModelId)
              .filter((model) => {
                const route = JSON.stringify([authType, model.baseUrl ?? '']);
                if (seenRoutes.has(route)) return false;
                seenRoutes.add(route);
                return true;
              })
              .map((model) => ({ model, authType }));
          },
        );

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
          modelId: removedModelId,
          ...(removedBaseUrl ? { baseUrl: removedBaseUrl } : {}),
        };
        const remainingRoute = remaining.find(
          ({ model, authType }) =>
            authType === parsed.authType &&
            (model.baseUrl ?? '') === (removedBaseUrl ?? ''),
        )?.model;
        for (const activeScope of getWritableScopes(loaded)) {
          const scopeModel = loaded.forScope(activeScope).settings.model;
          if (
            (!remainingRoute ||
              !isConversationModelConfiguration(remainingRoute)) &&
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
        const stillConfigured = remaining.length > 0;
        for (const selectionScope of getWritableScopes(loaded)) {
          const settings = loaded.forScope(selectionScope).settings;
          if (
            typeof settings.voiceModel === 'string' &&
            settings.voiceModel.trim() === removedModelId &&
            !stillConfigured
          ) {
            writes.push({
              scope: selectionScope,
              key: 'voiceModel',
              value: '',
            });
          }
          for (const key of [
            'imageModel',
            'advisorModel',
            'visionModel',
            'fastModel',
            'compactionModel',
          ] as const) {
            const value = settings[key];
            if (typeof value !== 'string' || !value) continue;
            const separator = value.indexOf('\0');
            let selector: ReturnType<typeof resolveModelId>;
            try {
              selector = resolveModelId(
                separator < 0 ? value : value.slice(0, separator),
              );
            } catch {
              continue;
            }
            const endpoint =
              separator < 0 ? undefined : value.slice(separator + 1);
            if (
              selector?.modelId === removedModelId &&
              (!selector.authType || selector.authType === parsed.authType) &&
              (endpoint === undefined || endpoint === (removedBaseUrl ?? '')) &&
              !remaining.some(
                ({ model, authType }) =>
                  (!selector.authType || authType === selector.authType) &&
                  (endpoint === undefined ||
                    endpoint === (model.baseUrl ?? '')) &&
                  (key === 'imageModel'
                    ? isImageModelConfiguration(model)
                    : key === 'fastModel'
                      ? !model.imageOnly &&
                        !model.voiceOnly &&
                        !model.visionOnly
                      : key === 'visionModel'
                        ? !model.imageOnly &&
                          !model.voiceOnly &&
                          !model.fastOnly
                        : isConversationModelConfiguration(model)),
              )
            ) {
              writes.push({ scope: selectionScope, key, value: '' });
            }
          }
        }
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
          const kept = original.filter((id) => id !== removedModelId);
          if (kept.length !== original.length) {
            writes.push({
              scope: fallbacksScope,
              key: 'modelFallbacks',
              value: kept.join(','),
            });
          }
        }

        const snapshots = getWritableScopes(loaded).map((scope) => ({
          scope,
          value: JSON.stringify(loaded.forScope(scope).originalSettings),
        }));
        let checked = false;
        const assertCanPersist = () => {
          assertGenerationOpen();
          if (checked) return;
          // The writer calls this inside its settings lock, before any scope commits.
          const fresh = loadSettings(boundWorkspace, {
            skipLoadEnvironment: true,
            skipWorkspaceSettings: workspaceTrusted === false,
            workspaceTrusted,
          });
          if (
            snapshots.some(
              ({ scope, value }) =>
                JSON.stringify(fresh.forScope(scope).originalSettings) !==
                value,
            )
          )
            throw conflict;
          checked = true;
        };
        try {
          await persistSettings(boundWorkspace, writes, assertCanPersist);
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
        if (
          err === conflict ||
          (err instanceof WorkspaceSettingsPartialPersistError &&
            err.committedWrites.length === 0 &&
            err.cause === conflict)
        ) {
          res.status(409).json({ error: conflict.message });
          return;
        }
        if (sendGenerationClosedError(res, err)) return;
        writeStderrLine(
          `qwen serve: DELETE /workspace/models error (authType=${parsed.authType}, modelId=${parsed.modelId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // On a partial persist, tell the caller which keys committed so it can
        // reconcile (e.g. modelProviders removed but model.name not cleared).
        if (err instanceof WorkspaceSettingsPartialPersistError) {
          const providerWrite = err.committedWrites.find(
            (write) => write.key === 'modelProviders',
          );
          if (providerWrite && deps.syncModelProvidersRuntime) {
            try {
              await deps.syncModelProvidersRuntime(
                err.committedWrites.some(
                  (write) => write.scope === SettingScope.User,
                )
                  ? SettingScope.User
                  : providerWrite.scope,
                'DELETE',
              );
            } catch (syncError) {
              if (sendGenerationClosedError(res, syncError)) return;
              writeStderrLine(
                'qwen serve: DELETE /workspace/models runtime sync failed after partial persistence',
              );
            }
            try {
              assertGenerationOpen();
            } catch (generationError) {
              if (sendGenerationClosedError(res, generationError)) return;
              throw generationError;
            }
          }
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
      let runtimeSync: ServeModelProviderRuntimeSyncResult | undefined;
      if (deps.syncModelProvidersRuntime) {
        try {
          runtimeSync = await deps.syncModelProvidersRuntime(
            writes.some((write) => write.scope === SettingScope.User)
              ? SettingScope.User
              : writes[0]!.scope,
            'DELETE',
          );
        } catch (err) {
          if (sendGenerationClosedError(res, err)) return;
          writeStderrLine(
            'qwen serve: DELETE /workspace/models runtime sync failed after persistence',
          );
          runtimeSync = { status: 'failed' };
        }
        try {
          assertGenerationOpen();
        } catch (err) {
          if (sendGenerationClosedError(res, err)) return;
          throw err;
        }
      }

      const clearedActiveModel = writes.some((w) => w.key === 'model.name');
      // Surface restart-required so the UI can prompt (e.g. modelFallbacks).
      const requiresRestart = writes.some(
        (w) => getSettingDefinition(w.key)?.requiresRestart === true,
      );
      res.status(200).json({
        removed: true,
        clearedActiveModel,
        requiresRestart,
        ...(runtimeSync ? { runtimeSync } : {}),
      });
    },
  );
}
