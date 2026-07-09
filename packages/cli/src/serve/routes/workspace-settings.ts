/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { loadSettings, SettingScope } from '../../config/settings.js';
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
const WEB_SHELL_SETTINGS = new Set(['ui.compactMode', 'voiceModel']);

const VALID_WRITE_SCOPES = new Set(['workspace']);

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
): SettingsResponse {
  const loaded = loadSettings(boundWorkspace);

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

    const values: SettingDescriptor['values'] = {
      effective: effective !== undefined ? effective : def.default,
    };
    if (userVal !== undefined) values.user = userVal;
    if (wsVal !== undefined) values.workspace = wsVal;

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
  workspace: SettingScope.Workspace,
};

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
  } = deps;

  const allowedKeys = getAllowedKeys();

  app.get('/workspace/settings', (_req: Request, res: Response) => {
    try {
      const response = buildSettingsResponse(boundWorkspace, allowedKeys);
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

      try {
        const settingScope = SCOPE_MAP[scope];
        if (!settingScope) {
          res.status(400).json({
            error: `scope must be one of: ${[...VALID_WRITE_SCOPES].join(', ')}`,
            code: 'invalid_scope',
          });
          return;
        }
        await persistSetting(boundWorkspace, settingScope, key, value);
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
        broadcastSettingsChanged(key, value, scope, clientId);
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
        value,
        requiresRestart: def.requiresRestart,
      });
    },
  );
}

export function registerWorkspaceQualifiedSettingsRoutes(
  app: Application,
  deps: Pick<
    WorkspaceSettingsRouteDeps,
    'mutate' | 'safeBody' | 'persistSetting'
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
    if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
    try {
      const response = buildSettingsResponse(runtime.workspaceCwd, allowedKeys);
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
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;

      const settingScope = SCOPE_MAP[scope];
      if (!settingScope) {
        res.status(400).json({
          error: `scope must be one of: ${[...VALID_WRITE_SCOPES].join(', ')}`,
          code: 'invalid_scope',
        });
        return;
      }
      try {
        await deps.persistSetting(
          runtime.workspaceCwd,
          settingScope,
          key,
          value,
        );
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
        data: { key, value, scope },
        ...(clientId ? { originatorClientId: clientId } : {}),
      });
      res.status(200).json({
        key,
        scope,
        value,
        requiresRestart: def.requiresRestart,
      });
    },
  );
}
