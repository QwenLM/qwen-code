/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import type { CredentialStore } from '@qwen-code/qwen-code-core';
import { loadSettings, SettingScope } from '../../config/settings.js';
import {
  redactMcpServersSetting,
  restoreRedactedMcpServersSetting,
} from '../../config/mcp-server-secrets.js';
import type {
  SettingEnumOption,
  SettingsType,
  SettingsValue,
} from '../../config/settingsSchema.js';
import {
  getDialogSettingKeys,
  getNestedProperty,
  getSettingDefinition,
  validateSettingValue,
} from '../../utils/settingsUtils.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { parseAndValidateWorkspaceClientId } from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

const TUI_ONLY_SETTINGS = new Set([
  'general.vimMode',
  'general.terminalBell',
  'general.notificationMode',
  'general.preferredEditor',
  'general.outputLanguage',
  'ide.enabled',
  'ui.showLineNumbers',
  'ui.renderMode',
  'ui.useTerminalBuffer',
  'ui.hideBanner',
  'ui.accessibility.enableLoadingPhrases',
  'ui.enableWelcomeBack',
]);

// `voiceModel` is `showInDialog: false` (so not in the dialog allowlist), but
// the Web Shell `/model --voice` picker needs to read + persist it; the daemon
// `/voice/stream` then reads it back via `loadSettings`.
const WEB_SHELL_SETTINGS = new Set([
  'ui.compactMode',
  'voiceModel',
  'mcpServers',
]);

// The primary /workspace/settings route may write the global user scope
// (~/.qwen/settings.json). The trust-gated workspace-qualified route stays
// workspace-only by design.
const VALID_WRITE_SCOPES = new Set(['workspace', 'user']);
const QUALIFIED_WRITE_SCOPES = new Set(['workspace']);
const mcpServerMutationQueues = new Map<string, Promise<void>>();

interface McpServerSettingMutation {
  operation: 'set' | 'remove';
  name: string;
}

interface SettingDescriptor {
  key: string;
  type: SettingsType;
  label: string;
  category: string;
  description?: string;
  requiresRestart: boolean;
  default: SettingsValue;
  options?: readonly SettingEnumOption[];
  values: {
    effective: unknown;
    user?: unknown;
    workspace?: unknown;
  };
}

interface SettingsResponse {
  v: 1;
  warnings?: Array<{
    type: 'corrupted';
    recovered: boolean;
  }>;
  settings: SettingDescriptor[];
}

const SECURITY_SENSITIVE_SETTINGS = new Set(['tools.approvalMode']);

function getAllowedKeys(): Set<string> {
  const keys = new Set(
    getDialogSettingKeys().filter(
      (k) => !TUI_ONLY_SETTINGS.has(k) && !SECURITY_SENSITIVE_SETTINGS.has(k),
    ),
  );
  for (const key of WEB_SHELL_SETTINGS) {
    keys.add(key);
  }
  return keys;
}

function buildSettingsResponse(
  boundWorkspace: string,
  keys: ReadonlySet<string>,
  credentialStore?: CredentialStore,
): SettingsResponse {
  const loaded = loadSettings(boundWorkspace, { credentialStore });

  const settings: SettingDescriptor[] = [];
  for (const key of keys) {
    const def = getSettingDefinition(key);
    if (!def) continue;

    const effective = getNestedProperty(
      loaded.merged as Record<string, unknown>,
      key,
    );
    const userVal = getNestedProperty(
      loaded.user.settings as Record<string, unknown>,
      key,
    );
    const wsVal = getNestedProperty(
      loaded.workspace.settings as Record<string, unknown>,
      key,
    );

    const publicValue = (value: unknown) =>
      key === 'mcpServers' ? redactMcpServersSetting(value) : value;
    const values: SettingDescriptor['values'] = {
      effective: publicValue(effective !== undefined ? effective : def.default),
    };
    if (userVal !== undefined) values.user = publicValue(userVal);
    if (wsVal !== undefined) values.workspace = publicValue(wsVal);

    settings.push({
      key,
      type: def.type,
      label: def.label,
      category: def.category,
      ...(def.description ? { description: def.description } : {}),
      requiresRestart: def.requiresRestart,
      default: def.default,
      ...(def.options?.length ? { options: def.options } : {}),
      values,
    });
  }

  const warnings: SettingsResponse['warnings'] = [];
  if (loaded.corruptedPath) {
    warnings.push({
      type: 'corrupted',
      recovered: loaded.wasRecovered,
    });
  }

  return {
    v: 1,
    ...(warnings.length ? { warnings } : {}),
    settings,
  };
}

const SCOPE_MAP: Record<string, SettingScope> = {
  user: SettingScope.User,
  workspace: SettingScope.Workspace,
};

function prepareSettingWrite(
  workspace: string,
  scope: SettingScope,
  key: string,
  value: unknown,
  mcpServerMutation?: McpServerSettingMutation,
  credentialStore?: CredentialStore,
): { persistedValue: unknown; publicValue: unknown } {
  if (key !== 'mcpServers') {
    return { persistedValue: value, publicValue: value };
  }
  const existing =
    loadSettings(workspace, { credentialStore }).forScope(scope).settings
      .mcpServers ?? {};
  let nextValue = value;
  if (mcpServerMutation) {
    const servers = { ...existing };
    if (mcpServerMutation.operation === 'set') {
      servers[mcpServerMutation.name] = value as (typeof servers)[string];
    } else {
      delete servers[mcpServerMutation.name];
    }
    nextValue = servers;
  }
  const persistedValue = restoreRedactedMcpServersSetting(nextValue, existing);
  return {
    persistedValue,
    publicValue: redactMcpServersSetting(persistedValue),
  };
}

function parseMcpServerMutation(
  key: string,
  value: unknown,
): McpServerSettingMutation | undefined {
  if (value === undefined) return undefined;
  if (key !== 'mcpServers' || typeof value !== 'object' || value === null) {
    throw new Error('mcpServerMutation is only valid for mcpServers');
  }
  const operation = (value as Record<string, unknown>)['operation'];
  const name = (value as Record<string, unknown>)['name'];
  if (
    (operation !== 'set' && operation !== 'remove') ||
    typeof name !== 'string' ||
    !name.trim()
  ) {
    throw new Error('mcpServerMutation requires a valid operation and name');
  }
  return { operation, name };
}

async function withMcpServerMutationLock<T>(
  workspace: string,
  scope: SettingScope,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${workspace}\0${scope}`;
  const previous = mcpServerMutationQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  mcpServerMutationQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (mcpServerMutationQueues.get(key) === tail) {
      mcpServerMutationQueues.delete(key);
    }
  }
}

export interface WorkspaceSettingsRouteDeps {
  boundWorkspace: string;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  persistSetting: (
    workspace: string,
    scope: SettingScope,
    key: string,
    value: unknown,
  ) => Promise<void>;
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
  credentialStore?: CredentialStore;
}

export function registerWorkspaceSettingsRoutes(
  app: Application,
  deps: WorkspaceSettingsRouteDeps,
): void {
  const {
    boundWorkspace,
    mutate,
    safeBody,
    persistSetting,
    broadcastSettingsChanged,
    parseAndValidateClientId,
    credentialStore,
  } = deps;

  const allowedKeys = getAllowedKeys();

  app.get('/workspace/settings', (_req: Request, res: Response) => {
    try {
      const response = buildSettingsResponse(
        boundWorkspace,
        allowedKeys,
        credentialStore,
      );
      res.status(200).json(response);
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /workspace/settings error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to load settings',
        code: 'internal_error',
      });
    }
  });

  app.post(
    '/workspace/settings',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const body = safeBody(req);
      const scope = body['scope'];
      const key = body['key'];
      const value = body['value'];
      let mcpServerMutation: McpServerSettingMutation | undefined;
      try {
        mcpServerMutation = parseMcpServerMutation(
          typeof key === 'string' ? key : '',
          body['mcpServerMutation'],
        );
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
          code: 'invalid_mcp_server_mutation',
        });
        return;
      }

      if (typeof scope !== 'string' || !VALID_WRITE_SCOPES.has(scope)) {
        res.status(400).json({
          error: `scope must be one of: ${[...VALID_WRITE_SCOPES].join(', ')}`,
          code: 'invalid_scope',
        });
        return;
      }

      if (typeof key !== 'string' || !key) {
        res.status(400).json({
          error: 'key is required and must be a string',
          code: 'invalid_key',
        });
        return;
      }

      if (!allowedKeys.has(key)) {
        res.status(400).json({
          error: `Setting "${key}" is not modifiable via this API`,
          code: 'disallowed_key',
        });
        return;
      }

      if (value === undefined || value === null) {
        res.status(400).json({
          error: 'value is required',
          code: 'missing_value',
        });
        return;
      }

      const def = getSettingDefinition(key);
      if (!def) {
        res.status(400).json({
          error: `Unknown setting: ${key}`,
          code: 'unknown_key',
        });
        return;
      }

      const validationError = validateSettingValue(def, value);
      if (validationError) {
        res.status(400).json({
          error: validationError,
          code: 'invalid_value',
        });
        return;
      }

      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;

      const settingScope = SCOPE_MAP[scope];
      if (!settingScope) {
        res.status(400).json({
          error: `scope must be one of: ${[...VALID_WRITE_SCOPES].join(', ')}`,
          code: 'invalid_scope',
        });
        return;
      }
      let publicValue: unknown = value;
      try {
        const persist = async () => {
          const prepared = prepareSettingWrite(
            boundWorkspace,
            settingScope,
            key,
            value,
            mcpServerMutation,
            credentialStore,
          );
          publicValue = prepared.publicValue;
          await persistSetting(
            boundWorkspace,
            settingScope,
            key,
            prepared.persistedValue,
          );
        };
        if (mcpServerMutation) {
          await withMcpServerMutationLock(
            boundWorkspace,
            settingScope,
            persist,
          );
        } else {
          await persist();
        }
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/settings persist error (key=${key}, scope=${scope}, workspace=${boundWorkspace}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to persist setting',
          code: 'persist_error',
        });
        return;
      }

      try {
        broadcastSettingsChanged(key, publicValue, scope, clientId);
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/settings broadcast error (key=${key}, scope=${scope}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      res.status(200).json({
        key,
        scope,
        value: publicValue,
        requiresRestart: def.requiresRestart,
      });
    },
  );
}

export function registerWorkspaceQualifiedSettingsRoutes(
  app: Application,
  deps: Pick<
    WorkspaceSettingsRouteDeps,
    'mutate' | 'safeBody' | 'persistSetting' | 'credentialStore'
  > & {
    workspaceRegistry: WorkspaceRegistry;
    invalidateServeFeaturesCache: () => void;
  },
): void {
  const allowedKeys = getAllowedKeys();

  app.get('/workspaces/:workspace/settings', (req: Request, res: Response) => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    // Legacy /workspace/settings remains primary-only and pre-trust for
    // compatibility; plural workspace-qualified settings intentionally follow
    // the Phase 3 core-route trust gate.
    if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
    try {
      const response = buildSettingsResponse(
        runtime.workspaceCwd,
        allowedKeys,
        deps.credentialStore,
      );
      res.status(200).json(response);
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /workspaces/:workspace/settings error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to load settings',
        code: 'internal_error',
      });
    }
  });

  app.post(
    '/workspaces/:workspace/settings',
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const body = deps.safeBody(req);
      const scope = body['scope'];
      const key = body['key'];
      const value = body['value'];
      let mcpServerMutation: McpServerSettingMutation | undefined;
      try {
        mcpServerMutation = parseMcpServerMutation(
          typeof key === 'string' ? key : '',
          body['mcpServerMutation'],
        );
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
          code: 'invalid_mcp_server_mutation',
        });
        return;
      }

      if (typeof scope !== 'string' || !QUALIFIED_WRITE_SCOPES.has(scope)) {
        res.status(400).json({
          error: `scope must be one of: ${[...QUALIFIED_WRITE_SCOPES].join(', ')}`,
          code: 'invalid_scope',
        });
        return;
      }
      if (typeof key !== 'string' || !key) {
        res.status(400).json({
          error: 'key is required and must be a string',
          code: 'invalid_key',
        });
        return;
      }
      if (!allowedKeys.has(key)) {
        res.status(400).json({
          error: `Setting "${key}" is not modifiable via this API`,
          code: 'disallowed_key',
        });
        return;
      }
      if (value === undefined || value === null) {
        res.status(400).json({
          error: 'value is required',
          code: 'missing_value',
        });
        return;
      }
      const def = getSettingDefinition(key);
      if (!def) {
        res.status(400).json({
          error: `Unknown setting: ${key}`,
          code: 'unknown_key',
        });
        return;
      }
      const validationError = validateSettingValue(def, value);
      if (validationError) {
        res.status(400).json({
          error: validationError,
          code: 'invalid_value',
        });
        return;
      }
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;

      // The guard above already rejected any scope outside QUALIFIED_WRITE_SCOPES.
      const settingScope = SCOPE_MAP[scope];
      if (!settingScope) {
        res.status(400).json({
          error: `scope must be one of: ${[...QUALIFIED_WRITE_SCOPES].join(', ')}`,
          code: 'invalid_scope',
        });
        return;
      }
      let publicValue: unknown = value;
      try {
        const persist = async () => {
          const prepared = prepareSettingWrite(
            runtime.workspaceCwd,
            settingScope,
            key,
            value,
            mcpServerMutation,
            deps.credentialStore,
          );
          publicValue = prepared.publicValue;
          await deps.persistSetting(
            runtime.workspaceCwd,
            settingScope,
            key,
            prepared.persistedValue,
          );
        };
        if (mcpServerMutation) {
          await withMcpServerMutationLock(
            runtime.workspaceCwd,
            settingScope,
            persist,
          );
        } else {
          await persist();
        }
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspaces/:workspace/settings persist error (key=${key}, scope=${scope}, workspace=${runtime.workspaceCwd}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to persist setting',
          code: 'persist_error',
        });
        return;
      }

      deps.invalidateServeFeaturesCache();
      runtime.bridge.publishWorkspaceEvent({
        type: 'settings_changed',
        data: { key, value: publicValue, scope },
        ...(clientId ? { originatorClientId: clientId } : {}),
      });
      res.status(200).json({
        key,
        scope,
        value: publicValue,
        requiresRestart: def.requiresRestart,
      });
    },
  );
}
