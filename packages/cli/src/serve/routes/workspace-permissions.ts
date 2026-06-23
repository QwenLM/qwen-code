/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import {
  buildPermissionSettings,
  isPermissionRuleType,
  normalizePermissionRules,
  PermissionRulesValidationError,
  readPermissionRuleSet,
  type QwenPermissionSettings,
} from '../../config/permission-settings.js';
import {
  loadSettings as defaultLoadSettings,
  SettingScope,
  type LoadedSettings,
} from '../../config/settings.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { SessionNotFoundError } from '../acp-session-bridge.js';

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
        .json(buildPermissionSettings(loadSettings(boundWorkspace)));
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
        const settings = loadSettings(boundWorkspace);
        rules = normalizePermissionRules(body['rules'], {
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

      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;

      const key = `permissions.${ruleType}`;
      let liveResponse: unknown;
      let updatedThroughLiveChild = false;
      try {
        liveResponse = await invokeWorkspaceCommand(
          'qwen/permissions/setRules',
          {
            scope: permissionScope,
            ruleType,
            rules,
          },
        );
        updatedThroughLiveChild = true;
      } catch (err) {
        if (!(err instanceof SessionNotFoundError)) {
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
        try {
          broadcastSettingsChanged(key, rules, permissionScope, clientId);
        } catch (err) {
          writeStderrLine(
            `qwen serve: POST /workspace/permissions broadcast error (key=${key}, scope=${permissionScope}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        res.status(200).json(liveResponse as QwenPermissionSettings);
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

      try {
        broadcastSettingsChanged(key, rules, permissionScope, clientId);
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/permissions broadcast error (key=${key}, scope=${permissionScope}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      try {
        res
          .status(200)
          .json(
            buildPermissionSettings(
              updatedSettings ?? loadSettings(boundWorkspace),
            ),
          );
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/permissions response error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to load permission rules',
          code: 'internal_error',
        });
      }
    },
  );
}
