/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler } from 'express';
import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';
import { normalizeReasoningEffort } from '@qwen-code/qwen-code-core/core/reasoning-effort.js';
import {
  readModelPreference,
  type ModelPreference,
} from '@qwen-code/qwen-code-core/models/model-preferences.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import {
  readSettingsSnapshot,
  SettingScope,
  type LoadedSettings,
} from '../../config/settings.js';
import {
  sanitizeDaemonLogLine,
  writeStderrLine,
} from '../../utils/stdioHelpers.js';
import { parseAndValidateWorkspaceClientId } from '../server/request-helpers.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
  sendGenerationClosedError,
  sendWorkspaceRuntimeUnavailable,
} from '../workspace-route-runtime.js';
import { isInternalWorkspaceRuntime } from '../workspace-runtime-visibility.js';
import type { WorkspaceSettingsWrites } from '../workspace-service/types.js';
import {
  listWorkspacePreferenceModels,
  type WorkspacePreferenceModel,
} from '../workspace-providers-status.js';

const SETTING_KEY = 'model.preferences';
type Scope = 'user' | 'workspace';
type Source = Scope | 'system' | 'model';
type Field = 'contextWindow' | 'enabled' | 'effort';

interface PreferencesPatch {
  key: string;
  contextWindow?: number | null;
  reasoning?: {
    enabled?: boolean | null;
    effort?: NonNullable<ModelPreference['reasoning']>['effort'] | null;
  };
}

class PreferenceUpdateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseChanges(value: unknown): PreferencesPatch[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PreferenceUpdateError('changes must contain at least one model');
  }
  const keys = new Set<string>();
  return value.map((entry: unknown) => {
    if (
      !isObject(entry) ||
      typeof entry['key'] !== 'string' ||
      keys.has(entry['key']) ||
      Object.keys(entry).some(
        (key) => !['key', 'contextWindow', 'reasoning'].includes(key),
      )
    ) {
      throw new PreferenceUpdateError('Expected one change per model key');
    }
    const { contextWindow, reasoning } = entry;
    if (
      (contextWindow === undefined && reasoning === undefined) ||
      (contextWindow !== undefined &&
        contextWindow !== null &&
        (typeof contextWindow !== 'number' ||
          !Number.isSafeInteger(contextWindow) ||
          contextWindow < 1))
    ) {
      throw new PreferenceUpdateError(
        'contextWindow must be a positive integer or null',
      );
    }
    if (
      reasoning !== undefined &&
      (!isObject(reasoning) ||
        Object.keys(reasoning).length === 0 ||
        Object.keys(reasoning).some(
          (field) => field !== 'enabled' && field !== 'effort',
        ) ||
        (reasoning['enabled'] !== undefined &&
          reasoning['enabled'] !== null &&
          typeof reasoning['enabled'] !== 'boolean') ||
        (reasoning['effort'] !== undefined &&
          reasoning['effort'] !== null &&
          (typeof reasoning['effort'] !== 'string' ||
            normalizeReasoningEffort(reasoning['effort']) !==
              reasoning['effort'])))
    ) {
      throw new PreferenceUpdateError('Invalid reasoning preference');
    }
    keys.add(entry['key']);
    return entry as unknown as PreferencesPatch;
  });
}

function mergePreferences(
  ...values: Array<ModelPreference | undefined>
): ModelPreference {
  return values.reduce<ModelPreference>(
    (merged, value) => ({
      ...merged,
      ...value,
      ...(value?.reasoning
        ? { reasoning: { ...merged.reasoning, ...value.reasoning } }
        : {}),
    }),
    {},
  );
}

function effectivePreference(
  model: WorkspacePreferenceModel,
  value: ModelPreference,
  fallback: string | undefined,
): ModelPreference {
  const window = value.contextWindow;
  const reasoning = model.resolveReasoning(value.reasoning, fallback);
  return {
    contextWindow:
      window &&
      Number.isSafeInteger(window) &&
      window > 0 &&
      window <= model.contextLimit
        ? window
        : model.contextLimit,
    ...(reasoning ? { reasoning } : {}),
  };
}

function configuredValue(
  settings: LoadedSettings,
  scope: SettingScope,
  key: string,
) {
  return readModelPreference(
    settings.forScope(scope).settings.model?.preferences?.[key],
  );
}

function lockedFields(settings: LoadedSettings, key: string): Field[] {
  const system = configuredValue(settings, SettingScope.System, key);
  return [
    ...(system?.contextWindow !== undefined ? ['contextWindow' as const] : []),
    ...(system?.reasoning?.enabled !== undefined ? ['enabled' as const] : []),
    ...(system?.reasoning?.effort !== undefined ? ['effort' as const] : []),
  ];
}

function serializeModel(
  settings: LoadedSettings,
  model: WorkspacePreferenceModel,
) {
  const { resolveReasoning: _resolveReasoning, ...descriptor } = model;
  const { key } = model;
  const user = configuredValue(settings, SettingScope.User, key) ?? {};
  const workspace = settings.workspaceSettingsActive
    ? (configuredValue(settings, SettingScope.Workspace, key) ?? {})
    : {};
  const system = configuredValue(settings, SettingScope.System, key);
  const systemDefaults = configuredValue(
    settings,
    SettingScope.SystemDefaults,
    key,
  );
  const baseEffort =
    settings.system.settings.model?.reasoningEffort ??
    settings.systemDefaults.settings.model?.reasoningEffort;
  const userEffort =
    settings.system.settings.model?.reasoningEffort ??
    settings.user.settings.model?.reasoningEffort ??
    settings.systemDefaults.settings.model?.reasoningEffort;
  const locked = lockedFields(settings, key);
  const sources = (
    includeUser: boolean,
    includeWorkspace = false,
  ): Record<Field, Source> => {
    const source = (field: Field): Source => {
      const has = (value: ModelPreference | undefined) =>
        field === 'contextWindow'
          ? value?.contextWindow !== undefined
          : value?.reasoning?.[field] !== undefined;
      if (has(system)) return 'system';
      if (includeWorkspace && has(workspace)) return 'workspace';
      if (includeUser && has(user)) return 'user';
      return has(systemDefaults) ? 'system' : 'model';
    };
    return {
      contextWindow: source('contextWindow'),
      enabled: source('enabled'),
      effort: source('effort'),
    };
  };
  return {
    ...descriptor,
    locked,
    values: {
      user,
      workspace,
      userEffective: effectivePreference(
        model,
        mergePreferences(systemDefaults, user, system),
        userEffort,
      ),
      effective: effectivePreference(
        model,
        settings.merged.model?.preferences?.[key] ?? {},
        settings.merged.model?.reasoningEffort,
      ),
      inherited: {
        user: effectivePreference(
          model,
          mergePreferences(systemDefaults, system),
          baseEffort,
        ),
        workspace: effectivePreference(
          model,
          mergePreferences(systemDefaults, user, system),
          userEffort,
        ),
      },
    },
    sources: sources(true, true),
    inheritedSources: { user: sources(false), workspace: sources(true) },
  };
}

function patchPreference(
  model: WorkspacePreferenceModel,
  previous: ModelPreference | undefined,
  patch: PreferencesPatch,
  locked: Field[],
): ModelPreference {
  const { contextWindow, reasoning } = patch;
  const enabled = reasoning?.enabled;
  const effort = reasoning?.effort;
  const edited = { contextWindow, enabled, effort };
  if (locked.some((field) => edited[field] !== undefined)) {
    throw new PreferenceUpdateError(
      'This model preference is managed by policy',
      403,
    );
  }
  if (contextWindow != null && contextWindow > model.contextLimit) {
    throw new PreferenceUpdateError('Context window exceeds the model limit');
  }
  if (
    enabled != null &&
    !(enabled ? model.reasoning?.canEnable : model.reasoning?.canDisable)
  ) {
    throw new PreferenceUpdateError(
      'The model does not support this thinking setting',
    );
  }
  if (effort != null && !model.reasoning?.efforts.includes(effort)) {
    throw new PreferenceUpdateError('The model does not support this effort');
  }
  const next = { ...previous, reasoning: { ...previous?.reasoning } };
  if (contextWindow === null) delete next.contextWindow;
  else if (contextWindow !== undefined) next.contextWindow = contextWindow;
  if (enabled === null) delete next.reasoning.enabled;
  else if (enabled !== undefined) next.reasoning.enabled = enabled;
  if (effort === null) delete next.reasoning.effort;
  else if (effort !== undefined) next.reasoning.effort = effort;
  const { reasoning: nextReasoning, ...other } = next;
  return Object.keys(nextReasoning).length ? next : other;
}

export function registerWorkspaceModelPreferencesRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
    getEnv: (
      runtime: WorkspaceRuntime,
    ) => Readonly<Record<string, string | undefined>>;
    persistSettings: (
      workspace: string,
      writes: WorkspaceSettingsWrites,
      assertOpen?: () => void,
      snapshotEnvironment?: Readonly<NodeJS.ProcessEnv>,
    ) => Promise<void>;
    broadcast: (
      runtime: WorkspaceRuntime,
      scope: Scope,
      clientId?: string,
    ) => void;
  },
): void {
  for (const qualified of [false, true]) {
    const route = qualified
      ? '/workspaces/:workspace/model-preferences'
      : '/workspace/model-preferences';
    const handle =
      (method: 'GET' | 'PATCH'): RequestHandler =>
      async (req, res) => {
        const primary = deps.workspaceRegistry.primaryEntry;
        const runtime = qualified
          ? resolveWorkspaceRuntimeFromParam(deps.workspaceRegistry, req, res)
          : primary.state === 'active'
            ? primary.current?.runtime
            : undefined;
        if (!runtime) {
          if (!qualified) sendWorkspaceRuntimeUnavailable(res, primary);
          return;
        }
        if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
        if (
          isInternalWorkspaceRuntime(runtime) ||
          runtime.routeFileSystemFactory.sshWorkspace
        ) {
          res.status(404).json({ code: 'model_preferences_unavailable' });
          return;
        }

        const requireOpen = () => runtime.generationGuard?.assertOpen();
        const { workspaceCwd } = runtime;
        try {
          requireOpen();
          const env = deps.getEnv(runtime);
          const catalog = (settings: LoadedSettings) =>
            listWorkspacePreferenceModels(workspaceCwd, settings, env);
          if (method === 'PATCH') {
            const clientId = parseAndValidateWorkspaceClientId(
              req,
              res,
              runtime.bridge,
            );
            if (clientId === null) return;
            const scope: unknown = req.body?.scope;
            if (scope !== 'workspace' && scope !== 'user') {
              throw new PreferenceUpdateError(
                'scope must be user or workspace',
              );
            }
            const changes = parseChanges(req.body?.changes);
            await deps.persistSettings(
              workspaceCwd,
              (settings) => {
                if (
                  scope === 'workspace' &&
                  (!settings.isTrusted || !settings.workspaceSettingsActive)
                ) {
                  throw new PreferenceUpdateError(
                    'Workspace settings cannot be edited',
                    403,
                  );
                }
                const target =
                  scope === 'user' ? SettingScope.User : SettingScope.Workspace;
                const models = new Map(
                  catalog(settings).map((model) => [model.key, model]),
                );
                const next: Record<string, ModelPreference | undefined> = {
                  ...settings.forScope(target).originalSettings.model
                    ?.preferences,
                };
                for (const patch of changes) {
                  const model = models.get(patch.key);
                  if (!model)
                    throw new PreferenceUpdateError(
                      'Model catalog changed. Reload settings and retry.',
                      409,
                    );
                  const value = patchPreference(
                    model,
                    next[patch.key],
                    patch,
                    lockedFields(settings, patch.key),
                  );
                  if (Object.keys(value).length) next[patch.key] = value;
                  else delete next[patch.key];
                }
                return [
                  {
                    scope: target,
                    key: SETTING_KEY,
                    value: next,
                  },
                ];
              },
              requireOpen,
              env,
            );
            requireOpen();
            deps.broadcast(runtime, scope, clientId);
          }

          const settings = readSettingsSnapshot(workspaceCwd, {
            environment: env,
            workspaceTrusted: true,
          });
          res.json({
            workspaceWritable: settings.workspaceSettingsActive,
            models: catalog(settings).map((model) =>
              serializeModel(settings, model),
            ),
          });
        } catch (error) {
          if (sendGenerationClosedError(res, error)) return;
          if (error instanceof PreferenceUpdateError) {
            res.status(error.status).json({
              error: error.message,
              code: 'invalid_model_preferences',
            });
            return;
          }
          const detail = sanitizeDaemonLogLine(
            redactLogCredentials(
              stripAnsiAndControl(
                error instanceof Error ? error.message : String(error),
              ),
            ),
          ).slice(0, 500);
          writeStderrLine(`qwen serve: ${method} ${route} failed: ${detail}`);
          res.status(500).json({
            error:
              method === 'GET'
                ? 'Unable to load model preferences'
                : 'Unable to update model preferences',
          });
        }
      };
    app.get(route, handle('GET'));
    app.patch(route, deps.mutate({ strict: true }), handle('PATCH'));
  }
}
