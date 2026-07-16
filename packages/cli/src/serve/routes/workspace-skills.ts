/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
  MAX_SKILL_NAME_LENGTH,
  parseAndValidateWorkspaceClientId,
} from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

interface RegisterWorkspaceSkillsRoutesDeps {
  workspaceRuntime: WorkspaceRuntime;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
}

function parseSkillToggleRequest(
  req: Request,
  res: Response,
  safeBody: (req: Request) => Record<string, unknown>,
): { skillName: string; enabled: boolean } | undefined {
  const rawSkillName = req.params['name'];
  if (!rawSkillName || typeof rawSkillName !== 'string') {
    res.status(400).json({
      error: 'Skill name path parameter is required',
      code: 'invalid_skill_name',
    });
    return undefined;
  }
  const skillName = rawSkillName.trim();
  if (skillName.length === 0) {
    res.status(400).json({
      error: 'Skill name path parameter is required',
      code: 'invalid_skill_name',
    });
    return undefined;
  }
  if (skillName.length > MAX_SKILL_NAME_LENGTH) {
    res.status(400).json({
      error: `Skill name exceeds ${MAX_SKILL_NAME_LENGTH}-character limit`,
      code: 'invalid_skill_name',
    });
    return undefined;
  }
  const enabled = safeBody(req)['enabled'];
  if (typeof enabled !== 'boolean') {
    res.status(400).json({
      error: '`enabled` is required and must be a boolean',
      code: 'invalid_enabled_flag',
    });
    return undefined;
  }
  return { skillName, enabled };
}

export function registerWorkspaceSkillsRoutes(
  app: Application,
  deps: RegisterWorkspaceSkillsRoutesDeps,
): void {
  const buildWorkspaceCtx = createBuildWorkspaceCtx(
    deps.workspaceRuntime.workspaceCwd,
  );
  const route = 'POST /workspace/skills/:name/enable';
  app.post(
    '/workspace/skills/:name/enable',
    deps.mutate({ strict: true }),
    async (req, res) => {
      if (!requireTrustedWorkspaceRuntime(deps.workspaceRuntime, res)) return;
      const input = parseSkillToggleRequest(req, res, deps.safeBody);
      if (!input) return;
      const clientId = deps.parseAndValidateClientId(req, res);
      if (clientId === null) return;
      try {
        const result =
          await deps.workspaceRuntime.workspaceService.setWorkspaceSkillEnabled(
            buildWorkspaceCtx(route, clientId),
            input.skillName,
            input.enabled,
          );
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );
}

export function registerWorkspaceQualifiedSkillsRoutes(
  app: Application,
  deps: Pick<
    RegisterWorkspaceSkillsRoutesDeps,
    'mutate' | 'safeBody' | 'sendBridgeError'
  > & { workspaceRegistry: WorkspaceRegistry },
): void {
  const route = 'POST /workspaces/:workspace/skills/:name/enable';
  app.post(
    '/workspaces/:workspace/skills/:name/enable',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const input = parseSkillToggleRequest(req, res, deps.safeBody);
      if (!input) return;
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      try {
        const result = await runtime.workspaceService.setWorkspaceSkillEnabled(
          createBuildWorkspaceCtx(runtime.workspaceCwd)(route, clientId),
          input.skillName,
          input.enabled,
        );
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );
}
