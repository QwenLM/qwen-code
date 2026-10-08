/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Squad CRUD for session multi-agent collaboration (session-multi-agent design §11). Same gates as
 * `registerSessionAgentRoutes`: bearer auth (global), trusted workspace,
 * per-workspace `experimental.agentCollaboration` (404
 * `agent_collaboration_disabled`), and strict `mutate` on every write.
 *
 *   GET    /workspaces/:workspace/agent/squads          -> {squads: SessionSquadView[]}
 *   POST   /workspaces/:workspace/agent/squads          -> 201 {squad}
 *   PATCH  /workspaces/:workspace/agent/squads/:squadId -> {squad}
 *   DELETE /workspaces/:workspace/agent/squads/:squadId -> {squad} (retired)
 *
 * Every write publishes `{type: 'changed', scope: 'squads'}` on the
 * workspace's session-agent event hub, so open clients refetch.
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import {
  SquadStoreError,
  createSquad,
  isValidSquadId,
  listSquadViews,
  retireSquad,
  updateSquad,
} from '@qwen-code/qwen-code-core/agents/session-agents/squad-store.js';
import { getSessionAgentEventHub } from '../session-agents/events.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

export interface RegisterSessionAgentSquadRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  /** Same per-workspace opt-in check the session-agent routes use. */
  isAgentCollaborationEnabledFor: (workspaceCwd: string) => boolean;
}

export function registerSessionAgentSquadRoutes(
  app: Application,
  deps: RegisterSessionAgentSquadRoutesDeps,
): void {
  const prefix = '/workspaces/:workspace/agent/squads';

  const runtimeFor = (
    req: Request,
    res: Response,
  ): WorkspaceRuntime | undefined => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return undefined;
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return undefined;
    if (!deps.isAgentCollaborationEnabledFor(runtime.workspaceCwd)) {
      res.status(404).json({ error: 'agent_collaboration_disabled' });
      return undefined;
    }
    if (runtime.generationGuard?.closed) {
      res.status(503).json({ error: 'workspace_runtime_closed' });
      return undefined;
    }
    return runtime;
  };

  const squadIdParam = (req: Request, res: Response): string | undefined => {
    const squadId = req.params['squadId'];
    if (!isValidSquadId(squadId)) {
      res.status(404).json({ error: 'squad_not_found' });
      return undefined;
    }
    return squadId;
  };

  const fail = (res: Response, error: unknown) => {
    if (error instanceof SquadStoreError) {
      res.status(error.status).json({
        error: error.code,
        message: error.message,
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/lock file is already being held/i.test(message)) {
      res
        .set('Retry-After', '11')
        .status(503)
        .json({ error: 'workspace_busy' });
      return;
    }
    res.status(500).json({ error: message });
  };

  const changed = (runtime: WorkspaceRuntime) => {
    getSessionAgentEventHub(runtime.workspaceCwd).publish({
      type: 'changed',
      scope: 'squads',
    });
  };

  const body = (req: Request): Record<string, unknown> =>
    typeof req.body === 'object' &&
    req.body !== null &&
    !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};

  app.get(prefix, async (req: Request, res: Response) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    try {
      res.json({ squads: await listSquadViews(runtime.workspaceCwd) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(
    prefix,
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const input = body(req);
      try {
        const squad = await createSquad(runtime.workspaceCwd, {
          name: input['name'],
          description: input['description'],
          instructions: input['instructions'],
          leaderAgentId: input['leaderAgentId'],
          members: input['members'],
        });
        changed(runtime);
        res.status(201).json({ squad });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.patch(
    `${prefix}/:squadId`,
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const squadId = squadIdParam(req, res);
      if (!squadId) return;
      const input = body(req);
      try {
        const squad = await updateSquad(runtime.workspaceCwd, squadId, {
          ...('name' in input ? { name: input['name'] } : {}),
          ...('description' in input
            ? { description: input['description'] }
            : {}),
          ...('instructions' in input
            ? { instructions: input['instructions'] }
            : {}),
          ...('leaderAgentId' in input
            ? { leaderAgentId: input['leaderAgentId'] }
            : {}),
          ...('members' in input ? { members: input['members'] } : {}),
        });
        changed(runtime);
        res.json({ squad });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  // Retires: the squad keeps its name and history and takes no new work.
  app.delete(
    `${prefix}/:squadId`,
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const runtime = runtimeFor(req, res);
      if (!runtime) return;
      const squadId = squadIdParam(req, res);
      if (!squadId) return;
      try {
        const squad = await retireSquad(runtime.workspaceCwd, squadId);
        changed(runtime);
        res.json({ squad });
      } catch (error) {
        fail(res, error);
      }
    },
  );
}
