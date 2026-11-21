/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { DaemonGoogleOAuthFlow } from '@qwen-code/sdk/daemon';
import type { SendBridgeError } from '../server/error-response.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveTrustedRuntime,
} from '../workspace-route-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import type {
  DaemonWorkspaceService,
  WorkspaceRequestContext,
} from '../workspace-service/types.js';

const MAX_FLOWS = 8;
// Must outlast the five-minute user-code budget, setup, and terminal retention.
const FLOW_IDLE_TIMEOUT_MS = 7 * 60_000;

type FlowRuntime = {
  owner: WorkspaceRuntime;
  invoke: DaemonWorkspaceService['googleOAuthCommand'];
  context: WorkspaceRequestContext;
  timer?: NodeJS.Timeout;
};

export function registerGoogleOAuthRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
    sendBridgeError: SendBridgeError;
  },
): () => void {
  const flows = new Map<string, FlowRuntime>();
  let pendingStarts = 0;
  let disposed = false;

  const runtimeFor = (
    req: Request,
    res: Response,
  ): WorkspaceRuntime | undefined => {
    if (req.params['workspace'] !== undefined) {
      return (
        resolveTrustedRuntime(deps.workspaceRegistry, req, res) ?? undefined
      );
    }
    const primary = deps.workspaceRegistry.primaryEntry;
    const runtime =
      primary?.state === 'active' ? primary.current?.runtime : undefined;
    if (runtime && requireTrustedWorkspaceRuntime(runtime, res)) {
      return runtime;
    }
    if (!runtime) {
      res.status(409).json({ code: 'google_oauth_runtime_unavailable' });
    }
    return undefined;
  };

  const flowFor = (req: Request, res: Response): FlowRuntime | undefined => {
    const id = req.params['id'] ?? '';
    const flow = flows.get(id);
    if (!flow) {
      res.status(404).json({ code: 'flow_not_found' });
      return undefined;
    }
    const runtime = runtimeFor(req, res);
    if (!runtime) return undefined;
    if (runtime !== flow.owner) {
      res.status(409).json({ code: 'google_oauth_workspace_mismatch' });
      return undefined;
    }
    return flow;
  };

  const clearExpiry = (flow: FlowRuntime) => {
    if (flow.timer) clearTimeout(flow.timer);
  };

  const expire = (id: string, flow: FlowRuntime) => {
    if (flows.get(id) === flow) {
      clearExpiry(flow);
      flows.delete(id);
      void flow
        .invoke(flow.context, 'qwen/google-oauth/cancel', { id })
        .catch(() => undefined);
    }
  };

  const touch = (id: string, flow: FlowRuntime, terminal = false) => {
    clearExpiry(flow);
    flow.timer = setTimeout(
      () => expire(id, flow),
      terminal ? 60_000 : FLOW_IDLE_TIMEOUT_MS,
    );
    flow.timer.unref();
  };

  const cancelBestEffort = async (
    flow: FlowRuntime,
    id: string,
  ): Promise<void> => {
    await flow
      .invoke(flow.context, 'qwen/google-oauth/cancel', { id })
      .catch(() => undefined);
  };

  const fail = (res: Response, error: unknown, route: string, id?: string) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('already active')) {
      res.status(409).json({ code: 'google_oauth_flow_in_progress' });
      return;
    }
    if (id && message.includes('not found')) {
      const flow = flows.get(id);
      if (flow) {
        clearExpiry(flow);
        flows.delete(id);
      }
      res.status(404).json({ code: 'flow_not_found' });
      return;
    }
    deps.sendBridgeError(res, error, { route });
  };

  const create: RequestHandler = async (req, res) => {
    if (disposed) {
      res.status(404).json({ code: 'google_oauth_unavailable' });
      return;
    }
    if (flows.size + pendingStarts >= MAX_FLOWS) {
      res.status(429).json({ code: 'too_many_flows' });
      return;
    }
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    pendingStarts += 1;
    let abandoned = false;
    let startedId: string | undefined;
    const candidate: FlowRuntime = {
      owner: runtime,
      invoke: runtime.workspaceService.googleOAuthCommand,
      context: {
        route: 'POST /auth/google/flows',
        workspaceCwd: runtime.workspaceCwd,
      },
    };
    const abandon = () => {
      req.off('aborted', abandon);
      res.off('close', abandon);
      if (!req.aborted && res.writableFinished) return;
      abandoned = true;
      const id =
        startedId ??
        [...flows].find(([, registered]) => registered === candidate)?.[0];
      startedId = undefined;
      if (id) {
        const flow = flows.get(id);
        if (flow) {
          clearExpiry(flow);
          flows.delete(id);
          void cancelBestEffort(flow, id);
        }
      }
    };
    req.once('aborted', abandon);
    res.once('close', abandon);
    try {
      const flow = await candidate.invoke<{ id: string }>(
        candidate.context,
        'qwen/google-oauth/start',
        { cwd: runtime.workspaceCwd },
      );
      if (typeof flow.id !== 'string' || !flow.id) {
        await cancelBestEffort(candidate, flow.id);
        throw new Error('ACP returned an invalid Google OAuth flow id.');
      }
      startedId = flow.id;
      if (
        disposed ||
        abandoned ||
        req.aborted ||
        res.destroyed ||
        req.destroyed
      ) {
        if (startedId === flow.id) {
          startedId = undefined;
          await cancelBestEffort(candidate, flow.id);
        }
        if (!res.destroyed)
          res.status(404).json({ code: 'google_oauth_unavailable' });
        return;
      }
      if (flows.has(flow.id)) {
        await cancelBestEffort(candidate, flow.id);
        startedId = undefined;
        throw new Error('Duplicate Google OAuth flow id.');
      }
      flows.set(flow.id, candidate);
      touch(flow.id, candidate);
      res.status(201).json(flow);
      startedId = undefined;
    } catch (error) {
      if (startedId) await cancelBestEffort(candidate, startedId);
      if (!res.destroyed) fail(res, error, 'POST /auth/google/flows');
    } finally {
      pendingStarts -= 1;
    }
  };

  const status: RequestHandler = async (req, res) => {
    if (disposed) {
      res.status(404).json({ code: 'google_oauth_unavailable' });
      return;
    }
    const id = req.params['id'] ?? '';
    const flow = flowFor(req, res);
    if (!flow) return;
    try {
      const view = await flow.invoke<DaemonGoogleOAuthFlow>(
        flow.context,
        'qwen/google-oauth/status',
        { id },
      );
      touch(id, flow, view.status === 'ready' || view.status === 'error');
      res.json(view);
    } catch (error) {
      if (!res.destroyed) fail(res, error, 'GET /auth/google/flows/:id', id);
    }
  };

  const code: RequestHandler = async (req, res) => {
    if (disposed) {
      res.status(404).json({ code: 'google_oauth_unavailable' });
      return;
    }
    const id = req.params['id'] ?? '';
    const value = req.body?.code;
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 16_384 ||
      !flows.has(id)
    ) {
      res.status(400).json({ code: 'invalid_authorization_code' });
      return;
    }
    const flow = flowFor(req, res);
    if (!flow) return;
    touch(id, flow);
    try {
      await flow.invoke(flow.context, 'qwen/google-oauth/code', {
        id,
        code: value.trim(),
      });
      touch(id, flow);
      if (!res.destroyed) res.status(202).json({ accepted: true });
    } catch (error) {
      if (!res.destroyed)
        fail(res, error, 'POST /auth/google/flows/:id/code', id);
    }
  };

  const cancel: RequestHandler = async (req, res) => {
    if (disposed) {
      res.status(404).json({ code: 'google_oauth_unavailable' });
      return;
    }
    const id = req.params['id'] ?? '';
    const flow = flowFor(req, res);
    if (!flow) return;
    try {
      await flow.invoke(flow.context, 'qwen/google-oauth/cancel', { id });
      clearExpiry(flow);
      flows.delete(id);
      res.status(204).end();
    } catch (error) {
      if (!res.destroyed) fail(res, error, 'DELETE /auth/google/flows/:id', id);
    }
  };

  const logout: RequestHandler = async (req, res) => {
    if (disposed) {
      res.status(404).json({ code: 'google_oauth_unavailable' });
      return;
    }
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    try {
      await runtime.workspaceService.googleOAuthCommand(
        {
          route: 'DELETE /auth/google',
          workspaceCwd: runtime.workspaceCwd,
        },
        'qwen/google-oauth/logout',
      );
      res.status(204).end();
    } catch (error) {
      if (!res.destroyed) fail(res, error, 'DELETE /auth/google');
    }
  };

  for (const prefix of ['/auth/google', '/workspaces/:workspace/auth/google']) {
    app.delete(prefix, deps.mutate({ strict: true }), logout);
    app.post(`${prefix}/flows`, deps.mutate({ strict: true }), create);
    app.get(`${prefix}/flows/:id`, status);
    app.post(`${prefix}/flows/:id/code`, deps.mutate({ strict: true }), code);
    app.delete(`${prefix}/flows/:id`, deps.mutate({ strict: true }), cancel);
  }

  return () => {
    disposed = true;
    for (const [id, flow] of flows) {
      clearExpiry(flow);
      void cancelBestEffort(flow, id);
    }
    flows.clear();
  };
}
