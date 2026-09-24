import type { Application, Request, RequestHandler, Response } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { issueAgentHostEnrollment } from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { startAgentHostConnection } from '../agent-host-client.js';
import { isLoopbackBind } from '../loopback-binds.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';

function serverUrl(value: unknown, allowHttp: boolean): string {
  if (typeof value !== 'string') throw new Error('请填写服务地址。');
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
      '请使用 HTTPS；可信演示网络可显式允许 HTTP。地址不能包含凭证或查询参数。',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

async function providers(): Promise<string[]> {
  try {
    await promisify(execFile)('codex', ['--version'], { timeout: 5000 });
    return ['qwen', 'codex'];
  } catch {
    return ['qwen'];
  }
}

export function registerAgentHostConnectionRoutes(
  app: Application,
  prefix: string,
  runtimeFor: (req: Request, res: Response) => WorkspaceRuntime | undefined,
  mutate: () => RequestHandler,
): void {
  app.get(`${prefix}/hosts/service`, async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    res.json({
      protocol: 1,
      workspaceCwd: runtime.workspaceCwd,
      providers: await providers(),
    });
  });

  app.post(`${prefix}/hosts/connect`, mutate(), async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    try {
      const input = req.body ?? {};
      const url = serverUrl(input.serverUrl, input.allowHttp === true);
      if (
        typeof input.workspaceId !== 'string' ||
        !input.workspaceId ||
        typeof input.enrollmentToken !== 'string' ||
        !input.enrollmentToken ||
        !['qwen', 'codex'].includes(input.provider)
      ) {
        throw new Error('接入参数不完整。');
      }
      if (!(await providers()).includes(input.provider))
        throw new Error('此服务环境未安装所选执行程序。');
      await startAgentHostConnection({
        bridge: runtime.bridge,
        workspaceCwd: runtime.workspaceCwd,
        serverUrl: url,
        workspaceId: input.workspaceId,
        enrollmentToken: input.enrollmentToken,
        provider: input.provider,
        allowHttp: input.allowHttp === true,
      });
      res.json({
        connected: true,
        workspaceCwd: runtime.workspaceCwd,
        provider: input.provider,
      });
    } catch (error) {
      res
        .status(400)
        .json({ error: error instanceof Error ? error.message : '接入失败。' });
    }
  });

  app.post(`${prefix}/hosts/remote-connect`, mutate(), async (req, res) => {
    const runtime = runtimeFor(req, res);
    if (!runtime) return;
    try {
      const input = req.body ?? {};
      const remote = serverUrl(input.remoteUrl, input.allowHttp === true);
      const callback = serverUrl(input.serverUrl, input.allowHttp === true);
      if (
        typeof input.remoteCwd !== 'string' ||
        !input.remoteCwd.trim() ||
        typeof input.remoteToken !== 'string' ||
        !input.remoteToken.trim() ||
        !['qwen', 'codex'].includes(input.provider)
      )
        throw new Error('请填写远程服务凭证、远程执行目录和执行程序。');
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
            '远程服务不支持在线主机接入，或执行目录未注册。请升级并启用协作功能，确认远程工作区后重试。',
          );
        if (response.status === 401 || response.status === 403)
          throw new Error('远程凭证无效，或远程项目尚未授权。');
        if (!response.ok)
          throw new Error(
            `远程接入失败（${response.status}），请检查远程服务日志及协调端回连地址。`,
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
        throw new Error('远程服务不支持所选执行程序或接入协议。');
      const enrollment = await issueAgentHostEnrollment(runtime.workspaceCwd);
      const result = await request('/connect', {
        serverUrl: callback,
        workspaceId: runtime.workspaceId,
        enrollmentToken: enrollment.token,
        provider: input.provider,
        allowHttp: input.allowHttp === true,
      });
      if (!result.connected) throw new Error('远程服务未确认接入。');
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : '无法连接远程服务。',
      });
    }
  });
}
