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
import type { AgentHostConnectionLookup } from '../agent-host-connections.js';
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

/**
 * Why a disconnect stopped nothing, and what helps. Retrying helps a
 * transient read error, not a permission, so the error itself is named. A
 * file that cannot be parsed stays that way until it is fixed or removed. A
 * newer version's file cannot be changed here, but this version does not
 * reconnect from it, so stopping this daemon ends the connection.
 */
function disconnectRefusal(
  lookup: Exclude<AgentHostConnectionLookup, { kind: 'absent' }>,
  reason: string,
): string {
  if (lookup.kind === 'found') {
    return `Could not forget the saved connection, so nothing was stopped: ${reason}`;
  }
  const { code } = lookup.error as NodeJS.ErrnoException;
  if (code === 'ENEWERSCHEMA') {
    return `Could not forget the saved connection, so nothing was stopped: ${lookup.error.message} This version does not reconnect from that file, so the connection ends when this daemon stops.`;
  }
  if (code === 'ECORRUPT') {
    // With why forgetting failed (a read-only directory, a mount), which is
    // what stands in the way of the next try.
    return `Could not read the saved Agent Host connections, so nothing was stopped: ${lookup.error.message}. Fix or remove that file, then retry. Forgetting the connection failed with: ${reason}`;
  }
  return `Could not read the saved Agent Host connections, so nothing was stopped: ${lookup.error.message}`;
}

/** The saved connections were held by, or lost to, another writer. */
function isStoreBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ELOCKED' || code === 'ECOMPROMISED';
}

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
   * `{connected: true, saved, saveError?, workspaceCwd, providers}`. Saved,
   * so the daemon reconnects after a restart or a workspace reload;
   * `saved: false` says it will not, and why.
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
      const { findAgentHostConnection, saveAgentHostConnection } = await import(
        '../agent-host-connections.js'
      );
      const record = {
        serverUrl: normalizeServerUrl(url, allowHttp),
        workspaceId: input.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
        allowHttp,
      };
      const saveError = await saveAgentHostConnection(record).then(
        () => undefined,
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
      // Connected anyway; only the reconnect after a restart or a workspace
      // reload is lost, unless an earlier record for this connection still
      // stands. The answer stays a success, because the join is done: a
      // client that treated this as a failed join would invite a needless
      // rerun. (Saving before connecting would make the failure
      // retryable, but a failed join would then have to undo its record
      // against a concurrent join or disconnect of the same connection.)
      const saved =
        saveError === undefined ||
        (await findAgentHostConnection(record)) !== undefined;
      if (saveError !== undefined) {
        writeStderrLine(
          `qwen serve: could not save the Agent Host connection: ${saveError}`,
        );
      }
      if (!isCurrent(req, res, runtime)) return;
      const { providers } = await probePrograms();
      res.json({
        connected: true,
        saved,
        ...(saved ? {} : { saveError }),
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
   * `{serverUrl, workspaceId, allowHttp?}` → `{disconnected}`. Forgets the
   * connection, then stops it. The credential stays (the coordinator
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
      const { findAgentHostConnectionChecked, removeAgentHostConnection } =
        await import('../agent-host-connections.js');
      const target = {
        serverUrl: normalizeServerUrl(url, allowHttp),
        workspaceId: input.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
        allowHttp,
      };
      // Forget first. The restore loop reconnects any connection it still
      // finds saved, so a stop followed by a failed removal would abort the
      // running turns and then come back a few seconds later.
      const removed = await removeAgentHostConnection(target).catch(
        async (error: unknown) => {
          // A held lock clears soon, and another writer may be about to
          // change the file: answered as busy below, for the caller to
          // retry. So does a lock lost to another writer before this one
          // wrote. Past that, only stop a connection we can confirm is
          // forgotten: a readable file with no record (joined at boot, or a
          // join that was not saved) has nothing for the restore loop to
          // bring back, so stop it anyway. An UNREADABLE file is not "no
          // record" — the restore loop would reconnect and undo the
          // disconnect — so refuse rather than stop, saying why.
          if (isStoreBusy(error)) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          const lookup =
            (error as NodeJS.ErrnoException).code === 'ENEWERSCHEMA'
              ? { kind: 'unreadable' as const, error: error as Error }
              : await findAgentHostConnectionChecked(target);
          if (lookup.kind === 'absent') return false;
          throw new Error(disconnectRefusal(lookup, reason));
        },
      );
      const stopped = stopAgentHostConnection(target);
      res.json({ disconnected: stopped || removed });
    } catch (error) {
      if (isStoreBusy(error)) {
        res.status(503).json({
          error:
            'The saved Agent Host connections are busy, so nothing was stopped. Retry the request.',
        });
        return;
      }
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
      const request = async (
        path: string,
        body?: unknown,
        timeoutMs = 20_000,
      ) => {
        const response = await fetch(`${endpoint}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            authorization: `Bearer ${input.remoteToken}`,
            'content-type': 'application/json',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
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
      // The remote probes its programs, enrolls and sends up to three
      // heartbeats (up to 10 s each), saves the connection, which can wait
      // about 13.5 s for its lock, and probes its programs again. Giving up
      // sooner would report a join that spent the token as failed.
      const result = await request(
        '/connect',
        {
          serverUrl: callback,
          workspaceId: runtime.workspaceId,
          enrollmentToken: enrollment.token,
          allowHttp: input.allowHttp === true,
        },
        90_000,
      );
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
