/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Joining a coordinator without a restart (session-multi-agent design §3.5).
 *
 * Runtime side (`registerAgentHostRuntimeRoutes`), mounted whatever the
 * boot-time collaboration flag says: `GET hosts/service` describes this
 * daemon as a Host, `POST hosts/connect` makes it join a coordinator (and
 * remembers the connection across restarts), `DELETE hosts/connect` leaves.
 *
 * Coordinator side (`registerAgentHostRemoteConnectRoute`), gated with the
 * rest of collaboration: `POST hosts/remote-connect` mints an enrollment and
 * asks a remote daemon to connect back.
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import { HOST_PROTOCOL_VERSION } from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { issueAgentHostEnrollment } from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { isLoopbackBind } from '../loopback-binds.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import {
  availablePrograms,
  getHostProgramProbe,
} from '../agent-host-programs.js';

function serverUrl(value: unknown, allowHttp: boolean): string {
  if (typeof value !== 'string') throw new Error('A server URL is required.');
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        (allowHttp || isLoopbackBind(url.hostname))
      ))
  ) {
    throw new Error(
      'Use HTTPS; HTTP is allowed only when explicitly enabled for a trusted network. The URL must not contain credentials, a query, or a fragment.',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

function isCleartext(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'http:' && !isLoopbackBind(url.hostname);
}

type RuntimeFor = (req: Request, res: Response) => WorkspaceRuntime | undefined;

function currentCheck(runtimeFor: RuntimeFor) {
  return (req: Request, res: Response, runtime: WorkspaceRuntime) => {
    const current = runtimeFor(req, res);
    if (!current) return false;
    if (current !== runtime || runtime.generationGuard?.closed) {
      res
        .status(409)
        .json({ error: 'Workspace runtime changed; retry the request.' });
      return false;
    }
    return true;
  };
}

/** This daemon's programs; a failed probe still reports qwen (its bridge). */
async function probePrograms() {
  try {
    const programs = await getHostProgramProbe();
    const ids = availablePrograms(programs);
    return { programs, providers: ids.length > 0 ? ids : ['qwen'] };
  } catch {
    return { programs: [], providers: ['qwen'] };
  }
}

/**
 * `runtimeFor` must resolve and check trust only — not the collaboration
 * opt-in: being joined as a runtime does not depend on it (decision 5).
 */
export function registerAgentHostRuntimeRoutes(
  app: Application,
  prefix: string,
  runtimeFor: RuntimeFor,
  mutate: () => RequestHandler,
): void {
  const isCurrent = currentCheck(runtimeFor);

  /** → `{protocol: 2, workspaceCwd, programs: HostProgramProbe[], providers}` */
  app.get(`${prefix}/hosts/service`, async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    const { programs, providers } = await probePrograms();
    res.json({
      protocol: HOST_PROTOCOL_VERSION,
      workspaceCwd: runtime.workspaceCwd,
      programs,
      // Program ids; kept under the v1 name for older coordinators.
      providers,
    });
  });

  /**
   * `{serverUrl, workspaceId, enrollmentToken, allowHttp?}` →
   * `{connected: true, workspaceCwd, providers}`. Saved, so the daemon
   * reconnects after a restart.
   */
  app.post(`${prefix}/hosts/connect`, mutate(), async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    try {
      if (!runtime.generationGuard || runtime.generationGuard.closed) {
        res
          .status(409)
          .json({ error: 'Workspace runtime changed; retry the request.' });
        return;
      }
      const input = req.body ?? {};
      const allowHttp = input.allowHttp === true;
      const url = serverUrl(input.serverUrl, allowHttp);
      if (
        typeof input.workspaceId !== 'string' ||
        !input.workspaceId ||
        typeof input.enrollmentToken !== 'string' ||
        !input.enrollmentToken
      ) {
        throw new Error('Missing connection parameters.');
      }
      if (!isCurrent(req, res, runtime)) return;
      const { normalizeServerUrl, startAgentHostConnection } = await import(
        '../agent-host-client.js'
      );
      await startAgentHostConnection({
        bridge: runtime.bridge,
        workspaceCwd: runtime.workspaceCwd,
        serverUrl: url,
        workspaceId: input.workspaceId,
        enrollmentToken: input.enrollmentToken,
        allowHttp,
        generationGuard: runtime.generationGuard,
      });
      const { saveAgentHostConnection } = await import(
        '../agent-host-connections.js'
      );
      await saveAgentHostConnection({
        serverUrl: normalizeServerUrl(url, allowHttp),
        workspaceId: input.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
        allowHttp,
      }).catch((error: unknown) => {
        // Connected anyway; only the reconnect after a restart is lost.
        writeStderrLine(
          `qwen serve: could not save the Agent Host connection: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (!isCurrent(req, res, runtime)) return;
      const { providers } = await probePrograms();
      res.json({
        connected: true,
        workspaceCwd: runtime.workspaceCwd,
        providers,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Connection failed.',
      });
    }
  });

  /**
   * `{serverUrl, workspaceId, allowHttp?}` → `{disconnected}`. Stops the
   * connection and forgets it. The credential stays (the coordinator
   * revokes a Host); a later `connect` with a fresh token re-enrolls.
   */
  app.delete(`${prefix}/hosts/connect`, mutate(), async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    try {
      const input = req.body ?? {};
      const allowHttp = input.allowHttp === true;
      const url = serverUrl(input.serverUrl, allowHttp);
      if (typeof input.workspaceId !== 'string' || !input.workspaceId) {
        throw new Error('Missing connection parameters.');
      }
      const { normalizeServerUrl, stopAgentHostConnection } = await import(
        '../agent-host-client.js'
      );
      const { removeAgentHostConnection } = await import(
        '../agent-host-connections.js'
      );
      const target = {
        serverUrl: normalizeServerUrl(url, allowHttp),
        workspaceId: input.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
        allowHttp,
      };
      const stopped = stopAgentHostConnection(target);
      const removed = await removeAgentHostConnection(target);
      res.json({ disconnected: stopped || removed });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Disconnect failed.',
      });
    }
  });
}

export function registerAgentHostRemoteConnectRoute(
  app: Application,
  prefix: string,
  runtimeFor: RuntimeFor,
  mutate: () => RequestHandler,
): void {
  const isCurrent = currentCheck(runtimeFor);
  /**
   * `{remoteUrl, serverUrl, remoteCwd, remoteToken, allowHttp?, provider?}`.
   * `provider` is optional: a v2 remote reports what it has, and the
   * coordinator adds an agent per program once it heartbeats.
   */
  app.post(`${prefix}/hosts/remote-connect`, mutate(), async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    try {
      if (!runtime.generationGuard || runtime.generationGuard.closed) {
        res
          .status(409)
          .json({ error: 'Workspace runtime changed; retry the request.' });
        return;
      }
      const input = req.body ?? {};
      const remote = serverUrl(input.remoteUrl, input.allowHttp === true);
      const callback = serverUrl(input.serverUrl, input.allowHttp === true);
      if (
        typeof input.remoteCwd !== 'string' ||
        !input.remoteCwd.trim() ||
        typeof input.remoteToken !== 'string' ||
        !input.remoteToken.trim() ||
        (input.provider !== undefined && typeof input.provider !== 'string')
      )
        throw new Error(
          'Remote server credential and remote workspace are required.',
        );
      const endpoint = `${remote}/workspaces/${encodeURIComponent(input.remoteCwd)}/agent/hosts`;
      const request = async (path: string, body?: unknown) => {
        const response = await fetch(`${endpoint}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            authorization: `Bearer ${input.remoteToken}`,
            'content-type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
        });
        if (response.status === 404)
          throw new Error(
            'The remote server does not support Agent Host enrollment, or the workspace is not registered. Upgrade it, confirm the remote workspace, and retry.',
          );
        if (response.status === 401 || response.status === 403)
          throw new Error(
            'The remote credential is invalid, or the remote workspace is not authorized.',
          );
        if (!response.ok)
          throw new Error(
            `Remote connection failed (${response.status}). Check the remote server log and the coordinator callback URL.`,
          );
        return (await response.json()) as {
          protocol?: number;
          providers?: string[];
          connected?: boolean;
        };
      };
      const service = await request('/service');
      // A v1 remote would join but never run anything: this coordinator only
      // hands v2 turns out.
      if (service.protocol !== HOST_PROTOCOL_VERSION)
        throw new Error(
          'The remote server speaks an older Agent Host protocol. Upgrade it and retry.',
        );
      if (input.provider && !service.providers?.includes(input.provider))
        throw new Error(
          `The remote server does not have ${input.provider} installed.`,
        );
      if (!isCurrent(req, res, runtime)) return;
      // The enrollment token below crosses both legs; mirror the Host's
      // warning on this side, which is the one holding the secret.
      if (isCleartext(remote) || isCleartext(callback))
        writeStderrLine(
          'WARNING: Agent Host HTTP demo mode sends the enrollment token, credentials, task content and results without encryption. Use only on a trusted network.',
        );
      const enrollment = await issueAgentHostEnrollment(runtime.workspaceCwd);
      if (!isCurrent(req, res, runtime)) return;
      const result = await request('/connect', {
        serverUrl: callback,
        workspaceId: runtime.workspaceId,
        enrollmentToken: enrollment.token,
        allowHttp: input.allowHttp === true,
      });
      if (!isCurrent(req, res, runtime)) return;
      if (!result.connected)
        throw new Error('The remote server did not confirm the connection.');
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : 'Cannot reach the remote server.',
      });
    }
  });
}
