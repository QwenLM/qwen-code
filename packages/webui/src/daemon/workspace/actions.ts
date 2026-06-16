/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from '@qwen-code/sdk/daemon';
import { withActionTimeout } from '../timing.js';
import type {
  DaemonDirectoryListing,
  DaemonFileStat,
  DaemonWorkspaceActions,
} from './types.js';

const AGENT_GENERATE_TIMEOUT_MS = 330_000;

export interface CreateDaemonWorkspaceActionsArgs {
  getClient: () => DaemonClient | undefined;
  getWorkspaceCwd: () => string | undefined;
  baseUrl: string;
  token?: string;
}

export function createDaemonWorkspaceActions({
  getClient,
  getWorkspaceCwd,
  baseUrl,
  token,
}: CreateDaemonWorkspaceActionsArgs): DaemonWorkspaceActions {
  return {
    async listSessions() {
      const client = requireClient(getClient, 'List sessions failed');
      const cwd = getWorkspaceCwd();
      if (!cwd) return [];
      return withActionTimeout(
        client.listWorkspaceSessions(cwd),
        'List sessions timed out',
      );
    },

    async deleteSession(sessionId: string) {
      const client = requireClient(getClient, 'Delete session failed');
      const result = await withActionTimeout(
        client.deleteSessionsData([sessionId]),
        'Delete session timed out',
      );
      if (result.errors.length > 0) {
        throw new Error(result.errors[0].error);
      }
      return result.removed.length > 0 || result.notFound.length > 0;
    },

    async deleteSessions(sessionIds: string[]) {
      const client = requireClient(getClient, 'Delete sessions failed');
      return withActionTimeout(
        client.deleteSessionsData(sessionIds),
        'Delete sessions timed out',
      );
    },

    async loadMcpStatus() {
      const client = requireClient(getClient, 'Load MCP status failed');
      return withActionTimeout(
        client.workspaceMcp(),
        'Load MCP status timed out',
      );
    },

    async loadMcpTools(serverName) {
      const client = requireClient(getClient, 'Load MCP tools failed');
      try {
        return await withActionTimeout(
          client.workspaceMcpTools(serverName),
          'Load MCP tools timed out',
        );
      } catch {
        return {
          v: 1 as const,
          workspaceCwd: '',
          serverName,
          initialized: false,
          acpChannelLive: false,
          tools: [],
          errors: [
            {
              kind: 'mcp_tools' as const,
              status: 'error' as const,
              error: 'The connected daemon does not expose MCP tool details.',
            },
          ],
        };
      }
    },

    async restartMcpServer(serverName) {
      const client = requireClient(getClient, 'Restart MCP server failed');
      return withActionTimeout(
        client.restartMcpServer(serverName),
        'Restart MCP server timed out',
        5 * 60_000,
      );
    },

    async manageMcpServer(serverName, action) {
      const client = requireClient(getClient, 'Manage MCP server failed');
      const timeoutMs = action === 'authenticate' ? 10 * 60_000 : 5 * 60_000;
      return withActionTimeout(
        client.manageMcpServer(serverName, action),
        'Manage MCP server timed out',
        timeoutMs,
      );
    },

    async loadSkillsStatus() {
      const client = requireClient(getClient, 'Load skills failed');
      return withActionTimeout(
        client.workspaceSkills(),
        'Load skills timed out',
      );
    },

    async loadToolsStatus() {
      const client = requireClient(getClient, 'Load tools failed');
      return withActionTimeout(client.workspaceTools(), 'Load tools timed out');
    },

    async setWorkspaceToolEnabled(toolName, enabled) {
      const client = requireClient(getClient, 'Set tool enabled failed');
      return withActionTimeout(
        client.setWorkspaceToolEnabled(toolName, enabled),
        'Set tool enabled timed out',
      );
    },

    async loadSettingsStatus() {
      const client = requireClient(getClient, 'Load settings failed');
      return withActionTimeout(
        client.workspaceSettings(),
        'Load settings timed out',
      );
    },

    async setWorkspaceSetting(scope: 'workspace', key: string, value: unknown) {
      const client = requireClient(getClient, 'Set setting failed');
      return withActionTimeout(
        client.setWorkspaceSetting(scope, key, value),
        'Set setting timed out',
      );
    },

    async loadMemoryStatus() {
      const client = requireClient(getClient, 'Load memory failed');
      return withActionTimeout(
        client.workspaceMemory(),
        'Load memory timed out',
      );
    },

    async readWorkspaceFile(filePath) {
      const client = requireClient(getClient, 'Read workspace file failed');
      return withActionTimeout(
        client.readWorkspaceFile(filePath),
        'Read workspace file timed out',
      );
    },

    async writeMemory(req) {
      const client = requireClient(getClient, 'Write memory failed');
      return withActionTimeout(
        client.writeWorkspaceMemory(req),
        'Write memory timed out',
      );
    },

    async listAgents() {
      const client = requireClient(getClient, 'List agents failed');
      return withActionTimeout(
        client.listWorkspaceAgents(),
        'List agents timed out',
      );
    },

    async getAgent(agentType) {
      const client = requireClient(getClient, 'Get agent failed');
      return withActionTimeout(
        client.getWorkspaceAgent(agentType),
        'Get agent timed out',
      );
    },

    async createAgent(req) {
      const client = requireClient(getClient, 'Create agent failed');
      return withActionTimeout(
        client.createWorkspaceAgent(req),
        'Create agent timed out',
      );
    },

    async generateAgent(description) {
      const client = requireClient(getClient, 'Generate agent failed');
      return withActionTimeout(
        client.generateWorkspaceAgent(description),
        'Generate agent timed out',
        AGENT_GENERATE_TIMEOUT_MS,
      );
    },

    async deleteAgent(agentType, scope) {
      const client = requireClient(getClient, 'Delete agent failed');
      return withActionTimeout(
        client.deleteWorkspaceAgent(agentType, scope ? { scope } : {}),
        'Delete agent timed out',
      );
    },

    // TODO(transport-parity): globWorkspace, stat, and listDirectory
    // bypass the DaemonClient transport layer by calling global fetch()
    // directly. This means ACP transports (WS, HTTP+JSON-RPC) never
    // see these requests. DaemonClient exposes client.glob(),
    // client.fileStat(), and client.dirList() that go through the
    // transport — migrate to those once the route table covers
    // /glob, /stat, /list (see acpRouteTable.ts).
    async globWorkspace(pattern, opts) {
      requireClient(getClient, 'Glob workspace failed');
      const url = createDaemonRequestUrl(baseUrl, '/glob');
      url.searchParams.set('pattern', pattern);
      if (opts?.maxResults !== undefined) {
        url.searchParams.set('maxResults', String(opts.maxResults));
      }
      if (opts?.includeIgnored !== undefined) {
        url.searchParams.set('includeIgnored', opts.includeIgnored ? '1' : '0');
      }
      if (opts?.cwd !== undefined) {
        url.searchParams.set('cwd', opts.cwd);
      }
      const res = await withActionTimeout(
        fetch(serializeDaemonRequestUrl(url, baseUrl), {
          headers: createDaemonHeaders(token),
        }),
        'Glob workspace timed out',
      );
      if (!res.ok) {
        throw new Error(await readDaemonError(res, 'GET /glob'));
      }
      const data = (await res.json()) as { matches?: unknown[] };
      return {
        matches: Array.isArray(data.matches)
          ? data.matches.filter(
              (match): match is string => typeof match === 'string',
            )
          : [],
      };
    },

    async loadProviders() {
      const client = requireClient(getClient, 'Load providers failed');
      return withActionTimeout(
        client.workspaceProviders(),
        'Load providers timed out',
      );
    },

    async readFileBytes(filePath, opts) {
      const client = requireClient(getClient, 'Read file bytes failed');
      return withActionTimeout(
        client.readWorkspaceFileBytes(filePath, opts ?? {}),
        'Read file bytes timed out',
      );
    },

    async writeFile(req) {
      const client = requireClient(getClient, 'Write file failed');
      return withActionTimeout(
        client.writeWorkspaceFile(req),
        'Write file timed out',
      );
    },

    async editFile(req) {
      const client = requireClient(getClient, 'Edit file failed');
      return withActionTimeout(
        client.editWorkspaceFile(req),
        'Edit file timed out',
      );
    },

    async stat(filePath) {
      requireClient(getClient, 'Stat file failed');
      const url = createDaemonRequestUrl(baseUrl, '/stat');
      url.searchParams.set('path', filePath);
      const res = await withActionTimeout(
        fetch(serializeDaemonRequestUrl(url, baseUrl), {
          headers: createDaemonHeaders(token),
        }),
        'Stat file timed out',
      );
      if (!res.ok) {
        throw new Error(await readDaemonError(res, 'GET /stat'));
      }
      return (await res.json()) as DaemonFileStat;
    },

    async listDirectory(dirPath) {
      requireClient(getClient, 'List directory failed');
      const url = createDaemonRequestUrl(baseUrl, '/list');
      url.searchParams.set('path', dirPath);
      const res = await withActionTimeout(
        fetch(serializeDaemonRequestUrl(url, baseUrl), {
          headers: createDaemonHeaders(token),
        }),
        'List directory timed out',
      );
      if (!res.ok) {
        throw new Error(await readDaemonError(res, 'GET /list'));
      }
      return (await res.json()) as DaemonDirectoryListing;
    },

    async loadEnv() {
      const client = requireClient(getClient, 'Load env failed');
      return withActionTimeout(client.workspaceEnv(), 'Load env timed out');
    },

    async loadPreflight() {
      const client = requireClient(getClient, 'Load preflight failed');
      return withActionTimeout(
        client.workspacePreflight(),
        'Load preflight timed out',
      );
    },

    async initWorkspace(opts) {
      const client = requireClient(getClient, 'Init workspace failed');
      return withActionTimeout(
        client.initWorkspace(opts),
        'Init workspace timed out',
      );
    },

    async updateAgent(agentType, req, scope) {
      const client = requireClient(getClient, 'Update agent failed');
      return withActionTimeout(
        client.updateWorkspaceAgent(agentType, req, scope ? { scope } : {}),
        'Update agent timed out',
      );
    },

    async startDeviceFlow(providerId) {
      const client = requireClient(getClient, 'Start device flow failed');
      return withActionTimeout(
        client.startDeviceFlow({ providerId }),
        'Start device flow timed out',
      );
    },

    async getDeviceFlow(deviceFlowId, opts) {
      const client = requireClient(getClient, 'Get device flow failed');
      return withActionTimeout(
        client.getDeviceFlow(deviceFlowId, opts),
        'Get device flow timed out',
      );
    },

    async cancelDeviceFlow(deviceFlowId) {
      const client = requireClient(getClient, 'Cancel device flow failed');
      return withActionTimeout(
        client.cancelDeviceFlow(deviceFlowId),
        'Cancel device flow timed out',
      );
    },

    async getAuthStatus() {
      const client = requireClient(getClient, 'Get auth status failed');
      return withActionTimeout(
        client.getAuthStatus(),
        'Get auth status timed out',
      );
    },

    async getAuthProviders() {
      const client = requireClient(getClient, 'Get auth providers failed');
      return withActionTimeout(
        client.getAuthProviders(),
        'Get auth providers timed out',
      );
    },

    async installAuthProvider(req) {
      const client = requireClient(getClient, 'Install auth provider failed');
      return withActionTimeout(
        client.installAuthProvider(req),
        'Install auth provider timed out',
      );
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function requireClient(
  getClient: () => DaemonClient | undefined,
  action: string,
): DaemonClient {
  const client = getClient();
  if (!client) {
    throw new Error(`${action}: DaemonClient is not connected`);
  }
  return client;
}

function createDaemonHeaders(token: string | undefined): HeadersInit {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function createDaemonRequestUrl(baseUrl: string, path: string): URL {
  const normalizedBaseUrl = stripTrailingSlashes(baseUrl);
  const fallbackBase =
    typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return new URL(`${normalizedBaseUrl}${path}`, fallbackBase);
}

function serializeDaemonRequestUrl(url: URL, baseUrl: string): string {
  return stripTrailingSlashes(baseUrl)
    ? url.toString()
    : `${url.pathname}${url.search}`;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return end === value.length ? value : value.slice(0, end);
}

async function readDaemonError(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown; message?: unknown };
    const message =
      typeof data.error === 'string'
        ? data.error
        : typeof data.message === 'string'
          ? data.message
          : undefined;
    return message
      ? `${fallback}: ${message}`
      : `${fallback}: HTTP ${res.status}`;
  } catch {
    return `${fallback}: HTTP ${res.status}`;
  }
}
