/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import {
  buildPermissionSettings,
  isPermissionRuleType,
  normalizePermissionRuleInputs,
  normalizePermissionRules,
  type PermissionRuleSet,
  PermissionRulesValidationError,
  readPermissionRuleSet,
} from '../../config/permission-settings.js';
import {
  loadSettings as defaultLoadSettings,
  SettingScope,
  type LoadedSettings,
} from '../../config/settings.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { SessionNotFoundError } from '../acp-session-bridge.js';

function getInvalidParamsMessage(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const { code, message } = err as {
      code?: unknown;
      message?: unknown;
    };
    if (code === -32602 && typeof message === 'string') {
      return message.replace(/^Invalid params:\s*/, '');
    }
  }
  return undefined;
}

interface WorkspacePermissionsRestResponse {
  v: 1;
  user: { rules: PermissionRuleSet };
  workspace: { rules: PermissionRuleSet };
  merged: PermissionRuleSet;
  isTrusted: boolean;
}

function buildRestPermissionSettings(
  settings: LoadedSettings,
): WorkspacePermissionsRestResponse {
  const full = buildPermissionSettings(settings);
  return {
    v: full.v,
    user: { rules: full.user.rules },
    workspace: { rules: full.workspace.rules },
    merged: full.merged,
    isTrusted: full.isTrusted,
  };
}

export interface WorkspacePermissionsRouteDeps {
  boundWorkspace: string;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  persistSetting: (
    workspace: string,
    scope: SettingScope,
    key: string,
    value: unknown,
  ) => Promise<LoadedSettings | void>;
  loadSettings?: (workspace: string) => LoadedSettings;
  invokeWorkspaceCommand: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
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

export function registerWorkspacePermissionsRoutes(
  app: Application,
  deps: WorkspacePermissionsRouteDeps,
): void {
  const {
    boundWorkspace,
    mutate,
    safeBody,
    persistSetting,
    loadSettings = defaultLoadSettings,
    invokeWorkspaceCommand,
    broadcastSettingsChanged,
    parseAndValidateClientId,
  } = deps;

  app.get('/workspace/permissions', (_req: Request, res: Response) => {
    try {
      res
        .status(200)
        .json(buildRestPermissionSettings(loadSettings(boundWorkspace)));
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /workspace/permissions error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to load permission rules',
        code: 'internal_error',
      });
    }
  });

  app.post(
    '/workspace/permissions',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const body = safeBody(req);
      const scope = body['scope'];
      const ruleType = body['ruleType'];

      if (scope !== 'workspace') {
        res.status(400).json({
          error: 'scope must be "workspace"',
          code: 'invalid_scope',
        });
        return;
      }
      const permissionScope = scope;

      if (!isPermissionRuleType(ruleType)) {
        res.status(400).json({
          error: 'ruleType must be "allow", "ask", or "deny"',
          code: 'invalid_rule_type',
        });
        return;
      }

      let rules: string[];
      try {
        rules = normalizePermissionRuleInputs(body['rules']);
      } catch (err) {
        if (err instanceof PermissionRulesValidationError) {
          res.status(400).json({
            error: err.message,
            code: err.code,
          });
          return;
        }
        writeStderrLine(
          `qwen serve: POST /workspace/permissions load error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to load permission rules',
          code: 'internal_error',
        });
        return;
      }

      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;

      const key = `permissions.${ruleType}`;
      let updatedThroughLiveChild = false;
      try {
        await invokeWorkspaceCommand('qwen/permissions/setRules', {
          cwd: boundWorkspace,
          scope: permissionScope,
          ruleType,
          rules,
        });
        updatedThroughLiveChild = true;
      } catch (err) {
        if (!(err instanceof SessionNotFoundError)) {
          const invalidParamsMessage = getInvalidParamsMessage(err);
          if (invalidParamsMessage) {
            res.status(400).json({
              error: invalidParamsMessage,
              code: 'invalid_rules',
            });
            return;
          }
          writeStderrLine(
            `qwen serve: POST /workspace/permissions ACP error (key=${key}, scope=${permissionScope}, workspace=${boundWorkspace}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          res.status(500).json({
            error: 'Failed to update permission rules',
            code: 'permission_update_failed',
          });
          return;
        }
      }

      if (updatedThroughLiveChild) {
        let response;
        try {
          response = buildRestPermissionSettings(loadSettings(boundWorkspace));
        } catch (err) {
          writeStderrLine(
            `qwen serve: POST /workspace/permissions response error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          res.status(500).json({
            error: 'Permission rules updated but response could not be loaded',
            code: 'response_build_error',
          });
          return;
        }
        const updatedRules = response.workspace.rules[ruleType];
        try {
          broadcastSettingsChanged(
            key,
            updatedRules,
            permissionScope,
            clientId,
          );
        } catch (err) {
          writeStderrLine(
            `qwen serve: POST /workspace/permissions broadcast error (key=${key}, scope=${permissionScope}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        res.status(200).json({ ...response, appliedVia: 'live-child' });
        return;
      }

      try {
        const settings = loadSettings(boundWorkspace);
        rules = normalizePermissionRules(rules, {
          existingRules: readPermissionRuleSet(settings.workspace.settings)[
            ruleType
          ],
        });
      } catch (err) {
        if (err instanceof PermissionRulesValidationError) {
          res.status(400).json({
            error: err.message,
            code: err.code,
          });
          return;
        }
        writeStderrLine(
          `qwen serve: POST /workspace/permissions load error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to load permission rules',
          code: 'internal_error',
        });
        return;
      }

      let updatedSettings: LoadedSettings | void;
      try {
        updatedSettings = await persistSetting(
          boundWorkspace,
          SettingScope.Workspace,
          key,
          rules,
        );
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/permissions persist error (key=${key}, scope=${permissionScope}, workspace=${boundWorkspace}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to persist permission rules',
          code: 'persist_error',
        });
        return;
      }

      let response;
      try {
        response = buildRestPermissionSettings(
          updatedSettings ?? loadSettings(boundWorkspace),
        );
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/permissions response error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Permission rules updated but response could not be loaded',
          code: 'response_build_error',
        });
        return;
      }

      try {
        broadcastSettingsChanged(key, rules, permissionScope, clientId);
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/permissions broadcast error (key=${key}, scope=${permissionScope}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      res.status(200).json({ ...response, appliedVia: 'persist-fallback' });
    },
  );
}
