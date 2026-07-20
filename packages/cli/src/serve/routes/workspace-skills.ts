/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { SendBridgeError } from '../server/error-response.js';
import {
  createBuildWorkspaceCtx,
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
import { getWorkspaceRuntimeCoordinator } from '../workspace-runtime-coordinator.js';
import {
  MAX_WORKSPACE_SKILL_NAME_LENGTH,
  WorkspaceSkillManagementError,
  validateWorkspaceSkillName,
  type WorkspaceSkillInstallRequest,
  type WorkspaceSkillScope,
} from '../workspace-skill-management.js';

interface RegisterWorkspaceSkillsRoutesDeps {
  workspaceRuntime: WorkspaceRuntime;
  workspaceRegistry?: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
}

type WorkspaceSkillActivation = 'deferred' | 'reconciling';

function scheduleSkillsConfiguration(
  runtimes: readonly WorkspaceRuntime[],
): WorkspaceSkillActivation {
  let reconciling = false;
  for (const runtime of runtimes) {
    try {
      if (
        getWorkspaceRuntimeCoordinator(
          runtime,
        ).reconcileSkillsConfiguration() === 'reconciling'
      ) {
        reconciling = true;
      }
    } catch {
      // Durable configuration is already committed; activation is best-effort.
    }
  }
  return reconciling ? 'reconciling' : 'deferred';
}

function affectedSkillRuntimes(
  runtime: WorkspaceRuntime,
  scope: WorkspaceSkillScope,
  registry?: WorkspaceRegistry,
): readonly WorkspaceRuntime[] {
  return scope === 'global'
    ? (registry?.listManaged() ?? [runtime])
    : [runtime];
}

function invalidateSkillsInventory(
  runtimes: readonly WorkspaceRuntime[],
): void {
  for (const runtime of runtimes) {
    try {
      runtime.workspaceService.invalidateWorkspaceSkillsStatus();
    } catch {
      // Durable configuration is already committed; invalidation is best-effort.
    }
  }
}

function rejectQualifiedGlobalScope(
  scope: WorkspaceSkillScope,
  res: Response,
): boolean {
  if (scope !== 'global') return false;
  res.status(400).json({
    error:
      'Global Skill scope must be changed through /workspace/config/skills',
    code: 'global_scope_requires_singular_owner',
  });
  return true;
}

function rejectSingularWorkspaceScope(
  scope: WorkspaceSkillScope,
  res: Response,
): boolean {
  if (scope !== 'workspace') return false;
  res.status(400).json({
    error:
      'Workspace Skill scope must be changed through /workspaces/:workspace/config/skills',
    code: 'workspace_scope_requires_qualified_workspace',
  });
  return true;
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
  if (skillName.length > MAX_WORKSPACE_SKILL_NAME_LENGTH) {
    res.status(400).json({
      error: `Skill name exceeds ${MAX_WORKSPACE_SKILL_NAME_LENGTH}-character limit`,
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

function parseSkillScope(
  value: unknown,
  res: Response,
): WorkspaceSkillScope | undefined {
  if (value === 'workspace' || value === 'global') return value;
  res.status(400).json({
    error: '`scope` must be "workspace" or "global"',
    code: 'invalid_skill_scope',
  });
  return undefined;
}

function parseSkillInstallRequest(
  req: Request,
  res: Response,
  safeBody: (req: Request) => Record<string, unknown>,
): WorkspaceSkillInstallRequest | undefined {
  const body = safeBody(req);
  const name = body['name'];
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({
      error: '`name` is required and must be a string',
      code: 'invalid_skill_name',
    });
    return undefined;
  }
  if (name.trim().length > MAX_WORKSPACE_SKILL_NAME_LENGTH) {
    res.status(400).json({
      error: `Skill name exceeds ${MAX_WORKSPACE_SKILL_NAME_LENGTH}-character limit`,
      code: 'invalid_skill_name',
    });
    return undefined;
  }
  const scope = parseSkillScope(body['scope'], res);
  if (!scope) return undefined;
  const rawSource = body['source'];
  if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) {
    res.status(400).json({
      error: '`source` is required',
      code: 'invalid_skill_source',
    });
    return undefined;
  }
  const source = rawSource as Record<string, unknown>;
  if (source['type'] === 'github' && typeof source['url'] === 'string') {
    return { name, scope, source: { type: 'github', url: source['url'] } };
  }
  if (source['type'] === 'zip' && typeof source['contentBase64'] === 'string') {
    return {
      name,
      scope,
      source: { type: 'zip', contentBase64: source['contentBase64'] },
    };
  }
  if (source['type'] === 'folder' && typeof source['path'] === 'string') {
    return {
      name,
      scope,
      source: { type: 'folder', path: source['path'] },
    };
  }
  res.status(400).json({
    error: 'Invalid Skill install source',
    code: 'invalid_skill_source',
  });
  return undefined;
}

function parseDeleteScope(req: Request, res: Response) {
  return parseSkillScope(req.query['scope'], res);
}

function sendSkillManagementError(res: Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceSkillManagementError)) return false;
  res.status(error.statusCode).json({
    error: error.message,
    code: error.code,
  });
  return true;
}

export function registerWorkspaceSkillsRoutes(
  app: Application,
  deps: RegisterWorkspaceSkillsRoutesDeps,
): void {
  const buildWorkspaceCtx = createBuildWorkspaceCtx(
    deps.workspaceRuntime.workspaceCwd,
  );
  app.get('/workspace/config/skills', async (_req, res) => {
    const configRoute = 'GET /workspace/config/skills';
    try {
      res
        .status(200)
        .json(
          await deps.workspaceRuntime.workspaceService.getWorkspaceSkillsConfigStatus(
            buildWorkspaceCtx(configRoute),
          ),
        );
    } catch (error) {
      deps.sendBridgeError(res, error, { route: configRoute });
    }
  });
  const route = 'POST /workspace/skills/:name/enable';
  app.post(
    '/workspace/skills/install',
    deps.mutate({ strict: true }),
    async (req, res) => {
      if (!requireTrustedWorkspaceRuntime(deps.workspaceRuntime, res)) return;
      const input = parseSkillInstallRequest(req, res, deps.safeBody);
      if (!input) return;
      const clientId = deps.parseAndValidateClientId(req, res);
      if (clientId === null) return;
      const installRoute = 'POST /workspace/skills/install';
      try {
        const result =
          await deps.workspaceRuntime.workspaceService.installWorkspaceSkill(
            buildWorkspaceCtx(installRoute, clientId),
            input,
          );
        const runtimes = affectedSkillRuntimes(
          deps.workspaceRuntime,
          input.scope,
          deps.workspaceRegistry,
        );
        if (input.scope === 'global') {
          invalidateSkillsInventory(runtimes);
        }
        res.status(200).json({
          ...result,
          activation: scheduleSkillsConfiguration(runtimes),
        });
      } catch (err) {
        if (!sendSkillManagementError(res, err))
          deps.sendBridgeError(res, err, { route: installRoute });
      }
    },
  );
  app.delete(
    '/workspace/skills/:name',
    deps.mutate({ strict: true }),
    async (req, res) => {
      if (!requireTrustedWorkspaceRuntime(deps.workspaceRuntime, res)) return;
      const rawSkillName = req.params['name'];
      const scope = parseDeleteScope(req, res);
      if (!rawSkillName || !scope) return;
      let skillName: string;
      try {
        skillName = validateWorkspaceSkillName(rawSkillName);
      } catch (error) {
        sendSkillManagementError(res, error);
        return;
      }
      const clientId = deps.parseAndValidateClientId(req, res);
      if (clientId === null) return;
      const deleteRoute = 'DELETE /workspace/skills/:name';
      try {
        const result =
          await deps.workspaceRuntime.workspaceService.deleteWorkspaceSkill(
            buildWorkspaceCtx(deleteRoute, clientId),
            skillName,
            scope,
          );
        const runtimes = affectedSkillRuntimes(
          deps.workspaceRuntime,
          scope,
          deps.workspaceRegistry,
        );
        if (scope === 'global') {
          invalidateSkillsInventory(runtimes);
        }
        res.status(200).json({
          ...result,
          activation: scheduleSkillsConfiguration(runtimes),
        });
      } catch (err) {
        if (!sendSkillManagementError(res, err))
          deps.sendBridgeError(res, err, { route: deleteRoute });
      }
    },
  );
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
        res.status(200).json({
          ...result,
          activation: scheduleSkillsConfiguration([deps.workspaceRuntime]),
        });
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );

  app.post(
    '/workspace/config/skills/install',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const input = parseSkillInstallRequest(req, res, deps.safeBody);
      if (!input) return;
      if (rejectSingularWorkspaceScope(input.scope, res)) return;
      const installRoute = 'POST /workspace/config/skills/install';
      try {
        const result =
          await deps.workspaceRuntime.workspaceService.installWorkspaceSkill(
            buildWorkspaceCtx(installRoute),
            input,
          );
        const runtimes = affectedSkillRuntimes(
          deps.workspaceRuntime,
          input.scope,
          deps.workspaceRegistry,
        );
        if (input.scope === 'global') {
          invalidateSkillsInventory(runtimes);
        }
        res.status(200).json({
          ...result,
          activation: scheduleSkillsConfiguration(runtimes),
        });
      } catch (err) {
        if (!sendSkillManagementError(res, err))
          deps.sendBridgeError(res, err, { route: installRoute });
      }
    },
  );
  app.delete(
    '/workspace/config/skills/:name',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const rawSkillName = req.params['name'];
      const scope = parseDeleteScope(req, res);
      if (!rawSkillName || !scope) return;
      if (rejectSingularWorkspaceScope(scope, res)) return;
      let skillName: string;
      try {
        skillName = validateWorkspaceSkillName(rawSkillName);
      } catch (error) {
        sendSkillManagementError(res, error);
        return;
      }
      const deleteRoute = 'DELETE /workspace/config/skills/:name';
      try {
        const result =
          await deps.workspaceRuntime.workspaceService.deleteWorkspaceSkill(
            buildWorkspaceCtx(deleteRoute),
            skillName,
            scope,
          );
        const runtimes = affectedSkillRuntimes(
          deps.workspaceRuntime,
          scope,
          deps.workspaceRegistry,
        );
        if (scope === 'global') {
          invalidateSkillsInventory(runtimes);
        }
        res.status(200).json({
          ...result,
          activation: scheduleSkillsConfiguration(runtimes),
        });
      } catch (err) {
        if (!sendSkillManagementError(res, err))
          deps.sendBridgeError(res, err, { route: deleteRoute });
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
  app.get('/workspaces/:workspace/config/skills', async (req, res) => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return;
    const configRoute = 'GET /workspaces/:workspace/config/skills';
    try {
      res
        .status(200)
        .json(
          await runtime.workspaceService.getWorkspaceSkillsConfigStatus(
            createBuildWorkspaceCtx(runtime.workspaceCwd)(configRoute),
          ),
        );
    } catch (error) {
      deps.sendBridgeError(res, error, { route: configRoute });
    }
  });
  const route = 'POST /workspaces/:workspace/skills/:name/enable';
  app.post(
    '/workspaces/:workspace/skills/install',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const input = parseSkillInstallRequest(req, res, deps.safeBody);
      if (!input) return;
      if (rejectQualifiedGlobalScope(input.scope, res)) return;
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const installRoute = 'POST /workspaces/:workspace/skills/install';
      try {
        const result = await getWorkspaceRuntimeCoordinator(
          runtime,
        ).runManagementOperation(async () => {
          const installed =
            await runtime.workspaceService.installWorkspaceSkill(
              createBuildWorkspaceCtx(runtime.workspaceCwd)(
                installRoute,
                clientId,
              ),
              input,
            );
          return {
            ...installed,
            activation: scheduleSkillsConfiguration([runtime]),
          };
        });
        res.status(200).json(result);
      } catch (err) {
        if (!sendSkillManagementError(res, err))
          deps.sendBridgeError(res, err, { route: installRoute });
      }
    },
  );
  app.delete(
    '/workspaces/:workspace/skills/:name',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const rawSkillName = req.params['name'];
      const scope = parseDeleteScope(req, res);
      if (!rawSkillName || !scope) return;
      if (rejectQualifiedGlobalScope(scope, res)) return;
      let skillName: string;
      try {
        skillName = validateWorkspaceSkillName(rawSkillName);
      } catch (error) {
        sendSkillManagementError(res, error);
        return;
      }
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const deleteRoute = 'DELETE /workspaces/:workspace/skills/:name';
      try {
        const result = await getWorkspaceRuntimeCoordinator(
          runtime,
        ).runManagementOperation(async () => {
          const deleted = await runtime.workspaceService.deleteWorkspaceSkill(
            createBuildWorkspaceCtx(runtime.workspaceCwd)(
              deleteRoute,
              clientId,
            ),
            skillName,
            scope,
          );
          return {
            ...deleted,
            activation: scheduleSkillsConfiguration([runtime]),
          };
        });
        res.status(200).json(result);
      } catch (err) {
        if (!sendSkillManagementError(res, err))
          deps.sendBridgeError(res, err, { route: deleteRoute });
      }
    },
  );
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
        const result = await getWorkspaceRuntimeCoordinator(
          runtime,
        ).runManagementOperation(async () => {
          const updated =
            await runtime.workspaceService.setWorkspaceSkillEnabled(
              createBuildWorkspaceCtx(runtime.workspaceCwd)(route, clientId),
              input.skillName,
              input.enabled,
            );
          return {
            ...updated,
            activation: scheduleSkillsConfiguration([runtime]),
          };
        });
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route });
      }
    },
  );

  app.post(
    '/workspaces/:workspace/config/skills/install',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const input = parseSkillInstallRequest(req, res, deps.safeBody);
      if (!input) return;
      if (rejectQualifiedGlobalScope(input.scope, res)) return;
      const configRoute = 'POST /workspaces/:workspace/config/skills/install';
      try {
        const result = await getWorkspaceRuntimeCoordinator(
          runtime,
        ).runManagementOperation(async () => {
          const installed =
            await runtime.workspaceService.installWorkspaceSkill(
              createBuildWorkspaceCtx(runtime.workspaceCwd)(configRoute),
              input,
            );
          return {
            ...installed,
            activation: scheduleSkillsConfiguration([runtime]),
          };
        });
        res.status(200).json(result);
      } catch (err) {
        if (!sendSkillManagementError(res, err)) {
          deps.sendBridgeError(res, err, { route: configRoute });
        }
      }
    },
  );
  app.delete(
    '/workspaces/:workspace/config/skills/:name',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const rawSkillName = req.params['name'];
      const scope = parseDeleteScope(req, res);
      if (!rawSkillName || !scope) return;
      if (rejectQualifiedGlobalScope(scope, res)) return;
      let skillName: string;
      try {
        skillName = validateWorkspaceSkillName(rawSkillName);
      } catch (error) {
        sendSkillManagementError(res, error);
        return;
      }
      const configRoute = 'DELETE /workspaces/:workspace/config/skills/:name';
      try {
        const result = await getWorkspaceRuntimeCoordinator(
          runtime,
        ).runManagementOperation(async () => {
          const deleted = await runtime.workspaceService.deleteWorkspaceSkill(
            createBuildWorkspaceCtx(runtime.workspaceCwd)(configRoute),
            skillName,
            scope,
          );
          return {
            ...deleted,
            activation: scheduleSkillsConfiguration([runtime]),
          };
        });
        res.status(200).json(result);
      } catch (err) {
        if (!sendSkillManagementError(res, err)) {
          deps.sendBridgeError(res, err, { route: configRoute });
        }
      }
    },
  );
  app.post(
    '/workspaces/:workspace/config/skills/:name/enable',
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
      const configRoute =
        'POST /workspaces/:workspace/config/skills/:name/enable';
      try {
        const result = await getWorkspaceRuntimeCoordinator(
          runtime,
        ).runManagementOperation(async () => {
          const updated =
            await runtime.workspaceService.setWorkspaceSkillEnabled(
              createBuildWorkspaceCtx(runtime.workspaceCwd)(configRoute),
              input.skillName,
              input.enabled,
            );
          return {
            ...updated,
            activation: scheduleSkillsConfiguration([runtime]),
          };
        });
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route: configRoute });
      }
    },
  );
}
