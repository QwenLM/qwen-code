/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { loadSettings, SettingScope } from '../../config/settings.js';
import type {
  SettingDefinition,
  SettingEnumOption,
  SettingsType,
  SettingsValue,
} from '../../config/settingsSchema.js';
import {
  getDialogSettingKeys,
  getNestedProperty,
  getSettingDefinition,
} from '../../utils/settingsUtils.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

const TUI_ONLY_SETTINGS = new Set([
  'general.vimMode',
  'general.terminalBell',
  'general.preferredEditor',
  'general.outputLanguage',
  'ide.enabled',
  'ui.showLineNumbers',
  'ui.renderMode',
  'ui.compactMode',
  'ui.useTerminalBuffer',
  'ui.hideBanner',
  'ui.accessibility.enableLoadingPhrases',
]);

const VALID_WRITE_SCOPES = new Set(['workspace']);

const MAX_STRING_VALUE_LENGTH = 1024;


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

function getAllowedKeys(): Set<string> {
  return new Set(
    getDialogSettingKeys().filter((k) => !TUI_ONLY_SETTINGS.has(k)),
  );
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

function validateSettingValue(
  def: SettingDefinition,
  value: unknown,
): string | undefined {
  switch (def.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return 'Value must be a boolean';
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return 'Value must be a finite number';
      break;
    case 'string':
      if (typeof value !== 'string') return 'Value must be a string';
      if (value.length > MAX_STRING_VALUE_LENGTH)
        return `Value exceeds ${MAX_STRING_VALUE_LENGTH}-character limit`;
      break;
    case 'enum':
      if (
        !def.options?.some(
          (opt) => opt.value === value,
        )
      ) {
        const allowed = def.options?.map((o) => o.value).join(', ') ?? '';
        return `Value must be one of: ${allowed}`;
      }
      break;
    default:
      return `Settings of type '${def.type}' cannot be modified via this API`;
  }
  return undefined;
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
        await persistSetting(boundWorkspace, SCOPE_MAP[scope]!, key, value);
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/settings persist error: ${
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
          `qwen serve: POST /workspace/settings broadcast error: ${
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
