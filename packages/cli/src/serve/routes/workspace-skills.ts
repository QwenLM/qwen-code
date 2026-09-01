/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { ServeWorkspaceSkillsStatus } from '@qwen-code/acp-bridge/status';
import type { SendBridgeError } from '../server/error-response.js';
import { PathMutexRegistry } from '../fs/path-mutex-registry.js';
import {
  createBuildWorkspaceCtx,
  parseAndValidateWorkspaceClientId,
} from '../server/request-helpers.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceEntryFromParam,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { getWorkspaceRuntimeCoordinatorIfSupported } from '../workspace-runtime-coordinator.js';
import {
  MAX_WORKSPACE_SKILL_NAME_LENGTH,
  WorkspaceSkillManagementError,
  validateWorkspaceSkillName,
  type WorkspaceSkillInstallRequest,
  type WorkspaceSkillMutationResult,
  type WorkspaceSkillScope,
} from '../workspace-skill-management.js';
const MAX_WORKSPACE_SKILL_BATCH_SIZE = 100;
const skillConfigMutationLocks = new PathMutexRegistry();

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
  getSkillsConfigStatus: (
    workspaceCwd: string,
    trusted: boolean,
  ) => Promise<ServeWorkspaceSkillsStatus>;
  invalidateSkillsConfigStatus: (workspaceCwd: string) => void;
  installSkillConfig: (
    workspaceCwd: string,
    request: WorkspaceSkillInstallRequest,
  ) => Promise<WorkspaceSkillMutationResult>;
  deleteSkillConfig: (
    workspaceCwd: string,
    scope: WorkspaceSkillScope,
    skillName: string,
    installedPath: string,
  ) => Promise<WorkspaceSkillMutationResult>;
}

type WorkspaceSkillActivation = 'deferred' | 'reconciling';

function reconcileSkills(
  runtimes: readonly WorkspaceRuntime[],
): WorkspaceSkillActivation {
  let reconciling = false;
  for (const runtime of runtimes) {
    runtime.workspaceService.invalidateWorkspaceSkillsStatus();
    if (!runtime.trusted) continue;
    const coordinator = getWorkspaceRuntimeCoordinatorIfSupported(runtime);
    if (coordinator?.reconcileSkillsConfiguration() === 'reconciling') {
      reconciling = true;
    }
  }
  return reconciling ? 'reconciling' : 'deferred';
}

function rejectQualifiedGlobalScope(
  scope: WorkspaceSkillScope,
  res: Response,
): boolean {
  if (scope !== 'global') return false;
  res.status(400).json({
    error: 'Global Skill scope must use /workspace/config/skills',
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
      'Workspace Skill scope must use /workspaces/:workspace/config/skills',
    code: 'workspace_scope_requires_qualified_workspace',
  });
  return true;
}

function requireRuntimeCoordinator(runtime: WorkspaceRuntime, res: Response) {
  const coordinator = getWorkspaceRuntimeCoordinatorIfSupported(runtime);
  if (coordinator) return coordinator;
  res.status(501).json({
    error: 'Workspace runtime lifecycle is not supported',
    code: 'workspace_runtime_not_supported',
  });
  return null;
}

function rejectSkillNameTooLong(skillName: string, res: Response): boolean {
  if (skillName.length <= MAX_WORKSPACE_SKILL_NAME_LENGTH) return false;
  res.status(400).json({
    error: `Skill name exceeds ${MAX_WORKSPACE_SKILL_NAME_LENGTH}-character limit`,
    code: 'invalid_skill_name',
  });
  return true;
}

function parseEnabledFlag(
  body: Record<string, unknown>,
  res: Response,
): { enabled: boolean } | undefined {
  const enabled = body['enabled'];
  if (typeof enabled === 'boolean') return { enabled };
  res.status(400).json({
    error: '`enabled` is required and must be a boolean',
    code: 'invalid_enabled_flag',
  });
  return undefined;
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
  if (rejectSkillNameTooLong(skillName, res)) return undefined;
  const flag = parseEnabledFlag(safeBody(req), res);
  return flag ? { skillName, enabled: flag.enabled } : undefined;
}

function parseSkillBatchToggleRequest(
  req: Request,
  res: Response,
  safeBody: (req: Request) => Record<string, unknown>,
): { skillNames: string[]; enabled: boolean } | undefined {
  const body = safeBody(req);
  const rawSkillNames = body['skillNames'];
  if (
    !Array.isArray(rawSkillNames) ||
    rawSkillNames.length === 0 ||
    rawSkillNames.length > MAX_WORKSPACE_SKILL_BATCH_SIZE ||
    !rawSkillNames.every((name) => typeof name === 'string')
  ) {
    res.status(400).json({
      error: `\`skillNames\` must be a non-empty string array (max ${MAX_WORKSPACE_SKILL_BATCH_SIZE})`,
      code: 'invalid_skill_names',
    });
    return undefined;
  }

  const skillNames: string[] = [];
  const seen = new Set<string>();
  for (const rawSkillName of rawSkillNames as string[]) {
    const skillName = rawSkillName.trim();
    if (skillName.length === 0) {
      res.status(400).json({
        error: 'Skill names must not be empty',
        code: 'invalid_skill_name',
      });
      return undefined;
    }
    if (rejectSkillNameTooLong(skillName, res)) return undefined;
    const normalizedName = skillName.toLowerCase();
    if (seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    skillNames.push(skillName);
  }

  const flag = parseEnabledFlag(body, res);
  return flag ? { skillNames, enabled: flag.enabled } : undefined;
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
  if (rejectSkillNameTooLong(name.trim(), res)) return undefined;
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

async function deleteConfiguredSkill(
  deps: RegisterWorkspaceSkillsRoutesDeps,
  workspaceCwd: string,
  trusted: boolean,
  skillName: string,
  scope: WorkspaceSkillScope,
): Promise<WorkspaceSkillMutationResult> {
  const status = await deps.getSkillsConfigStatus(workspaceCwd, trusted);
  const normalizedName = skillName.trim().toLowerCase();
  const matches = status.skills.filter(
    (candidate) => candidate.name.trim().toLowerCase() === normalizedName,
  );
  if (matches.length === 0) {
    throw new WorkspaceSkillManagementError(
      'skill_not_found',
      `Skill not found: ${skillName}`,
      404,
    );
  }
  const expectedLevel = scope === 'workspace' ? 'project' : 'user';
  const skill = matches.find((candidate) => candidate.level === expectedLevel);
  if (!skill?.installedPath) {
    throw new WorkspaceSkillManagementError(
      'skill_not_managed',
      'Skill is not managed in the requested scope',
      409,
    );
  }
  return deps.deleteSkillConfig(
    workspaceCwd,
    scope,
    skill.name,
    skill.installedPath,
  );
}

export function registerWorkspaceSkillsRoutes(
  app: Application,
  deps: RegisterWorkspaceSkillsRoutesDeps,
): void {
  const buildWorkspaceCtx = createBuildWorkspaceCtx(
    deps.workspaceRuntime.workspaceCwd,
  );
  const globalConfigOwner = () => {
    const entry = deps.workspaceRegistry?.primaryEntry;
    return {
      workspaceCwd: entry?.workspaceCwd ?? deps.workspaceRuntime.workspaceCwd,
      trusted: entry?.current?.runtime.trusted ?? deps.workspaceRuntime.trusted,
    };
  };
  const invalidateGlobalConfigStatus = (ownerWorkspaceCwd: string) => {
    const entries = deps.workspaceRegistry?.listAllEntries();
    if (!entries) {
      deps.invalidateSkillsConfigStatus(ownerWorkspaceCwd);
      return;
    }
    for (const entry of entries) {
      deps.invalidateSkillsConfigStatus(entry.workspaceCwd);
    }
  };
  app.get('/workspace/config/skills', async (_req, res) => {
    const configRoute = 'GET /workspace/config/skills';
    try {
      const owner = globalConfigOwner();
      res
        .status(200)
        .json(
          await deps.getSkillsConfigStatus(owner.workspaceCwd, owner.trusted),
        );
    } catch (error) {
      deps.sendBridgeError(res, error, { route: configRoute });
    }
  });
  app.get('/workspace/runtime/skills', async (_req, res) => {
    if (!requireTrustedWorkspaceRuntime(deps.workspaceRuntime, res)) return;
    const runtimeRoute = 'GET /workspace/runtime/skills';
    try {
      res
        .status(200)
        .json(
          await deps.workspaceRuntime.workspaceService.getWorkspaceSkillsRuntimeStatus(
            buildWorkspaceCtx(runtimeRoute),
          ),
        );
    } catch (error) {
      deps.sendBridgeError(res, error, { route: runtimeRoute });
    }
  });
  app.post(
    '/workspace/config/skills/install',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const input = parseSkillInstallRequest(req, res, deps.safeBody);
      if (!input || rejectSingularWorkspaceScope(input.scope, res)) return;
      const configRoute = 'POST /workspace/config/skills/install';
      try {
        const owner = globalConfigOwner();
        const result = await skillConfigMutationLocks.runExclusive(
          `global\0${input.name.trim().toLowerCase()}`,
          () => deps.installSkillConfig(owner.workspaceCwd, input),
        );
        invalidateGlobalConfigStatus(owner.workspaceCwd);
        const runtimes = deps.workspaceRegistry?.listManaged() ?? [
          deps.workspaceRuntime,
        ];
        res.status(200).json({
          ...result,
          activation: reconcileSkills(runtimes),
        });
      } catch (error) {
        if (!sendSkillManagementError(res, error)) {
          deps.sendBridgeError(res, error, { route: configRoute });
        }
      }
    },
  );
  app.delete(
    '/workspace/config/skills/:name',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const scope = parseDeleteScope(req, res);
      const rawSkillName = req.params['name'];
      if (!rawSkillName || !scope || rejectSingularWorkspaceScope(scope, res)) {
        return;
      }
      const configRoute = 'DELETE /workspace/config/skills/:name';
      try {
        const owner = globalConfigOwner();
        const skillName = validateWorkspaceSkillName(rawSkillName);
        const result = await skillConfigMutationLocks.runExclusive(
          `global\0${skillName.toLowerCase()}`,
          () =>
            deleteConfiguredSkill(
              deps,
              owner.workspaceCwd,
              owner.trusted,
              skillName,
              scope,
            ),
        );
        invalidateGlobalConfigStatus(owner.workspaceCwd);
        const runtimes = deps.workspaceRegistry?.listManaged() ?? [
          deps.workspaceRuntime,
        ];
        res.status(200).json({
          ...result,
          activation: reconcileSkills(runtimes),
        });
      } catch (error) {
        if (!sendSkillManagementError(res, error)) {
          deps.sendBridgeError(res, error, { route: configRoute });
        }
      }
    },
  );
  const route = 'POST /workspace/skills/:name/enable';
  const batchRoute = 'POST /workspace/skills/enable';
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
        res.status(200).json(result);
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
        res.status(200).json(result);
      } catch (err) {
        if (!sendSkillManagementError(res, err))
          deps.sendBridgeError(res, err, { route: deleteRoute });
      }
    },
  );
  app.post(
    '/workspace/skills/enable',
    deps.mutate({ strict: true }),
    async (req, res) => {
      if (!requireTrustedWorkspaceRuntime(deps.workspaceRuntime, res)) return;
      const input = parseSkillBatchToggleRequest(req, res, deps.safeBody);
      if (!input) return;
      const clientId = deps.parseAndValidateClientId(req, res);
      if (clientId === null) return;
      try {
        const result =
          await deps.workspaceRuntime.workspaceService.setWorkspaceSkillsEnabled(
            buildWorkspaceCtx(batchRoute, clientId),
            input.skillNames,
            input.enabled,
          );
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route: batchRoute });
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
    | 'mutate'
    | 'safeBody'
    | 'sendBridgeError'
    | 'getSkillsConfigStatus'
    | 'invalidateSkillsConfigStatus'
  > & { workspaceRegistry: WorkspaceRegistry },
): void {
  app.get('/workspaces/:workspace/config/skills', async (req, res) => {
    const entry = resolveWorkspaceEntryFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!entry) return;
    const configRoute = 'GET /workspaces/:workspace/config/skills';
    try {
      res
        .status(200)
        .json(
          await deps.getSkillsConfigStatus(
            entry.workspaceCwd,
            entry.current?.runtime.trusted ?? false,
          ),
        );
    } catch (error) {
      deps.sendBridgeError(res, error, { route: configRoute });
    }
  });
  app.get('/workspaces/:workspace/runtime/skills', async (req, res) => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
    const runtimeRoute = 'GET /workspaces/:workspace/runtime/skills';
    try {
      res
        .status(200)
        .json(
          await runtime.workspaceService.getWorkspaceSkillsRuntimeStatus(
            createBuildWorkspaceCtx(runtime.workspaceCwd)(runtimeRoute),
          ),
        );
    } catch (error) {
      deps.sendBridgeError(res, error, { route: runtimeRoute });
    }
  });
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
      if (!input || rejectQualifiedGlobalScope(input.scope, res)) return;
      const coordinator = requireRuntimeCoordinator(runtime, res);
      if (!coordinator) return;
      const configRoute = 'POST /workspaces/:workspace/config/skills/install';
      try {
        const result = await skillConfigMutationLocks.runExclusive(
          `workspace\0${runtime.workspaceCwd}\0${input.name.trim().toLowerCase()}`,
          () =>
            coordinator.runManagementOperation(() =>
              runtime.workspaceService.installWorkspaceSkill(
                createBuildWorkspaceCtx(runtime.workspaceCwd)(configRoute),
                input,
                { refreshRuntime: false },
              ),
            ),
        );
        deps.invalidateSkillsConfigStatus(runtime.workspaceCwd);
        res.status(200).json({
          ...result,
          activation: reconcileSkills([runtime]),
        });
      } catch (error) {
        if (!sendSkillManagementError(res, error)) {
          deps.sendBridgeError(res, error, { route: configRoute });
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
      const scope = parseDeleteScope(req, res);
      const rawSkillName = req.params['name'];
      if (!rawSkillName || !scope || rejectQualifiedGlobalScope(scope, res)) {
        return;
      }
      const coordinator = requireRuntimeCoordinator(runtime, res);
      if (!coordinator) return;
      const configRoute = 'DELETE /workspaces/:workspace/config/skills/:name';
      try {
        const skillName = validateWorkspaceSkillName(rawSkillName);
        const result = await skillConfigMutationLocks.runExclusive(
          `workspace\0${runtime.workspaceCwd}\0${skillName.toLowerCase()}`,
          () =>
            coordinator.runManagementOperation(() =>
              runtime.workspaceService.deleteWorkspaceSkill(
                createBuildWorkspaceCtx(runtime.workspaceCwd)(configRoute),
                skillName,
                scope,
                { refreshRuntime: false },
              ),
            ),
        );
        deps.invalidateSkillsConfigStatus(runtime.workspaceCwd);
        res.status(200).json({
          ...result,
          activation: reconcileSkills([runtime]),
        });
      } catch (error) {
        if (!sendSkillManagementError(res, error)) {
          deps.sendBridgeError(res, error, { route: configRoute });
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
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const coordinator = requireRuntimeCoordinator(runtime, res);
      if (!coordinator) return;
      const configRoute =
        'POST /workspaces/:workspace/config/skills/:name/enable';
      try {
        const result = await coordinator.runManagementOperation(() =>
          runtime.workspaceService.setWorkspaceSkillEnabled(
            createBuildWorkspaceCtx(runtime.workspaceCwd)(
              configRoute,
              clientId,
            ),
            input.skillName,
            input.enabled,
            { refreshRuntime: false },
          ),
        );
        deps.invalidateSkillsConfigStatus(runtime.workspaceCwd);
        res.status(200).json({
          ...result,
          activation: result.changed
            ? reconcileSkills([runtime])
            : result.activation,
        });
      } catch (error) {
        deps.sendBridgeError(res, error, { route: configRoute });
      }
    },
  );
  const route = 'POST /workspaces/:workspace/skills/:name/enable';
  const batchRoute = 'POST /workspaces/:workspace/skills/enable';
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
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      const installRoute = 'POST /workspaces/:workspace/skills/install';
      try {
        const result = await runtime.workspaceService.installWorkspaceSkill(
          createBuildWorkspaceCtx(runtime.workspaceCwd)(installRoute, clientId),
          input,
        );
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
        const result = await runtime.workspaceService.deleteWorkspaceSkill(
          createBuildWorkspaceCtx(runtime.workspaceCwd)(deleteRoute, clientId),
          skillName,
          scope,
        );
        res.status(200).json(result);
      } catch (err) {
        if (!sendSkillManagementError(res, err))
          deps.sendBridgeError(res, err, { route: deleteRoute });
      }
    },
  );
  app.post(
    '/workspaces/:workspace/skills/enable',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      const input = parseSkillBatchToggleRequest(req, res, deps.safeBody);
      if (!input) return;
      const clientId = parseAndValidateWorkspaceClientId(
        req,
        res,
        runtime.bridge,
      );
      if (clientId === null) return;
      try {
        const result = await runtime.workspaceService.setWorkspaceSkillsEnabled(
          createBuildWorkspaceCtx(runtime.workspaceCwd)(batchRoute, clientId),
          input.skillNames,
          input.enabled,
        );
        res.status(200).json(result);
      } catch (err) {
        deps.sendBridgeError(res, err, { route: batchRoute });
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
