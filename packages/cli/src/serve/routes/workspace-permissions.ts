/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import type { CredentialStore } from '@qwen-code/qwen-code-core';
import {
  buildPermissionSettings,
  isPermissionRuleType,
  normalizePermissionRules,
  PermissionRulesValidationError,
  readPermissionRuleSet,
  type PermissionSettingsScope,
  type QwenPermissionSettings,
} from '../../config/permission-settings.js';
import { loadSettings } from '../../config/settings.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { WorkspacePermissionRulesSessionRequiredError } from '../workspace-service/types.js';
import { parseAndValidateWorkspaceClientId } from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

export interface WorkspacePermissionsRouteDeps {
  boundWorkspace: string;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  workspace: DaemonWorkspaceService;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
  credentialStore?: CredentialStore;
}

export function registerWorkspacePermissionsRoutes(
  app: Application,
  deps: WorkspacePermissionsRouteDeps,
): void {
  const {
    boundWorkspace,
    mutate,
    safeBody,
    workspace,
    parseAndValidateClientId,
    credentialStore,
  } = deps;

  app.get('/workspace/permissions', (_req: Request, res: Response) => {
    try {
      res
        .status(200)
        .json(
          buildPermissionSettings(
            loadSettings(boundWorkspace, { credentialStore }),
          ),
        );
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

      if (scope !== 'user' && scope !== 'workspace') {
        res.status(400).json({
          error: 'scope must be "user" or "workspace"',
          code: 'invalid_scope',
        });
        return;
      }
      const permissionScope: PermissionSettingsScope = scope;

      if (!isPermissionRuleType(ruleType)) {
        res.status(400).json({
          error: 'ruleType must be "allow", "ask", or "deny"',
          code: 'invalid_rule_type',
        });
        return;
      }

      let rules: string[];
      try {
        const settings = loadSettings(boundWorkspace, { credentialStore });
        const scopeSettings =
          permissionScope === 'workspace'
            ? settings.workspace.settings
            : settings.user.settings;
        const existingRules = readPermissionRuleSet(scopeSettings)[ruleType];
        rules = normalizePermissionRules(body['rules'], { existingRules });
      } catch (err) {
        if (err instanceof PermissionRulesValidationError) {
          res.status(400).json({
            error: err.message,
            code: err.code,
          });
          return;
        }
        throw err;
      }

      const clientId = parseAndValidateClientId(req, res);
      if (clientId === null) return;

      const key = `permissions.${ruleType}`;
      let liveResponse: QwenPermissionSettings;
      try {
        liveResponse = await workspace.setWorkspacePermissionRules(
          {
            route: 'POST /workspace/permissions',
            workspaceCwd: boundWorkspace,
            ...(clientId ? { originatorClientId: clientId } : {}),
          },
          { scope: permissionScope, ruleType, rules },
        );
      } catch (err) {
        if (err instanceof WorkspacePermissionRulesSessionRequiredError) {
          res.status(409).json({
            error:
              'A live ACP session is required to update active permission rules.',
            code: 'permission_session_required',
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

      res.status(200).json(liveResponse);
    },
  );
}

export function registerWorkspaceQualifiedPermissionsRoutes(
  app: Application,
  deps: Pick<
    WorkspacePermissionsRouteDeps,
    'mutate' | 'safeBody' | 'credentialStore'
  > & {
    workspaceRegistry: WorkspaceRegistry;
  },
): void {
  app.get('/workspaces/:workspace/permissions', (req, res) => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
    try {
      res.status(200).json(
        buildPermissionSettings(
          loadSettings(runtime.workspaceCwd, {
            credentialStore: deps.credentialStore,
          }),
        ),
      );
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /workspaces/:workspace/permissions error: ${
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
    '/workspaces/:workspace/permissions',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const body = deps.safeBody(req);
      const scope = body['scope'];
      const ruleType = body['ruleType'];

      if (scope !== 'workspace') {
        res.status(400).json({
          error:
            'workspace-qualified permissions routes only support "workspace" scope',
          code: 'global_scope_not_supported_for_workspace_route',
        });
        return;
      }
      const permissionScope: PermissionSettingsScope = 'workspace';

      if (!isPermissionRuleType(ruleType)) {
        res.status(400).json({
          error: 'ruleType must be "allow", "ask", or "deny"',
          code: 'invalid_rule_type',
        });
        return;
      }

      let rules: string[];
      try {
        const settings = loadSettings(runtime.workspaceCwd, {
          credentialStore: deps.credentialStore,
        });
        const existingRules = readPermissionRuleSet(
          settings.workspace.settings,
        )[ruleType];
        rules = normalizePermissionRules(body['rules'], { existingRules });
      } catch (err) {
        if (err instanceof PermissionRulesValidationError) {
          res.status(400).json({
            error: err.message,
            code: err.code,
          });
          return;
        }
        throw err;
      }

      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;

      try {
        const liveResponse =
          await runtime.workspaceService.setWorkspacePermissionRules(
            {
              route: 'POST /workspaces/:workspace/permissions',
              workspaceCwd: runtime.workspaceCwd,
              ...(clientId ? { originatorClientId: clientId } : {}),
            },
            { scope: permissionScope, ruleType, rules },
          );
        res.status(200).json(liveResponse);
      } catch (err) {
        if (err instanceof WorkspacePermissionRulesSessionRequiredError) {
          res.status(409).json({
            error:
              'A live ACP session is required to update active permission rules.',
            code: 'permission_session_required',
          });
          return;
        }
        writeStderrLine(
          `qwen serve: POST /workspaces/:workspace/permissions ACP error (ruleType=${ruleType}, workspace=${runtime.workspaceCwd}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to update permission rules',
          code: 'permission_update_failed',
        });
      }
    },
  );
}
