import type { Application, Request, RequestHandler, Response } from 'express';
import { issueAgentHostEnrollment } from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { isLoopbackBind } from '../loopback-binds.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';

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

const PROVIDERS = ['qwen'];

export function registerAgentHostConnectionRoutes(
  app: Application,
  prefix: string,
  runtimeFor: (req: Request, res: Response) => WorkspaceRuntime | undefined,
  mutate: () => RequestHandler,
): void {
  const isCurrent = (
    req: Request,
    res: Response,
    runtime: WorkspaceRuntime,
  ) => {
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
  app.get(`${prefix}/hosts/service`, async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    res.json({
      protocol: 1,
      workspaceCwd: runtime.workspaceCwd,
      providers: PROVIDERS,
    });
  });

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
      const url = serverUrl(input.serverUrl, input.allowHttp === true);
      if (
        typeof input.workspaceId !== 'string' ||
        !input.workspaceId ||
        typeof input.enrollmentToken !== 'string' ||
        !input.enrollmentToken ||
        input.provider !== 'qwen'
      ) {
        throw new Error('Missing connection parameters.');
      }
      if (!isCurrent(req, res, runtime)) return;
      const { startAgentHostConnection } = await import(
        '../agent-host-client.js'
      );
      await startAgentHostConnection({
        bridge: runtime.bridge,
        workspaceCwd: runtime.workspaceCwd,
        serverUrl: url,
        workspaceId: input.workspaceId,
        enrollmentToken: input.enrollmentToken,
        allowHttp: input.allowHttp === true,
        generationGuard: runtime.generationGuard,
      });
      if (!isCurrent(req, res, runtime)) return;
      res.json({
        connected: true,
        workspaceCwd: runtime.workspaceCwd,
        provider: input.provider,
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Connection failed.',
      });
    }
  });

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
        input.provider !== 'qwen'
      )
        throw new Error(
          'Remote server credential, remote workspace, and provider are required.',
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
            'The remote server does not support Agent Host enrollment, or the workspace is not registered. Upgrade it, enable agent collaboration, confirm the remote workspace, and retry.',
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
      if (
        service.protocol !== 1 ||
        !service.providers?.includes(input.provider)
      )
        throw new Error(
          'The remote server does not support the selected provider or connection protocol.',
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
        provider: input.provider,
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
