/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonClient,
  DaemonMcpManageResult,
  DaemonWorkspaceRuntimeCapability,
  DaemonWorkspaceRuntimeStatus,
  WorkspaceDaemonClient,
} from '@qwen-code/sdk/daemon';
import { withActionTimeout } from '../timing.js';
import type {
  DaemonDirectoryListing,
  DaemonFileStat,
  DaemonGoal,
  DaemonScheduledTask,
  DaemonWorkspaceActions,
  DaemonWorkspacePathSuggestions,
} from './types.js';

const AGENT_GENERATE_TIMEOUT_MS = 330_000;
const WORKSPACE_RUNTIME_ENSURE_ACTION_TIMEOUT_MS = 130_000;
const WORKSPACE_RUNTIME_ENSURE_POLL_TIMEOUT_MS = 125_000;
const WORKSPACE_RUNTIME_ACTION_TIMEOUT_MS = 70_000;
const WORKSPACE_RUNTIME_POLL_INTERVAL_MS = 500;
const WORKSPACE_RUNTIME_POLL_TIMEOUT_MS = 65_000;

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
    async listSessions(options) {
      const client = requireClient(getClient, 'List sessions failed');
      const cwd = getWorkspaceCwd();
      if (!cwd) return [];
      return withActionTimeout(
        client
          .listWorkspaceSessionsPage(cwd, options)
          .then((page) => page.sessions),
        'List sessions timed out',
      );
    },

    async listSessionsPage(options) {
      const client = requireClient(getClient, 'List sessions failed');
      const cwd = getWorkspaceCwd();
      if (!cwd) return { sessions: [] };
      return withActionTimeout(
        client.listWorkspaceSessionsPage(cwd, options),
        'List sessions timed out',
      );
    },

    async listSessionGroups() {
      const client = requireClient(getClient, 'List session groups failed');
      const cwd = getWorkspaceCwd();
      if (!cwd) return { groups: [], colorOptions: [] };
      return withActionTimeout(
        client.listSessionGroups(cwd),
        'List session groups timed out',
      );
    },

    async createSessionGroup(input) {
      const client = requireClient(getClient, 'Create session group failed');
      const cwd = requireWorkspaceCwd(getWorkspaceCwd);
      return withActionTimeout(
        client.createSessionGroup(cwd, input),
        'Create session group timed out',
      );
    },

    async updateSessionGroup(groupId, update) {
      const client = requireClient(getClient, 'Update session group failed');
      const cwd = requireWorkspaceCwd(getWorkspaceCwd);
      return withActionTimeout(
        client.updateSessionGroup(cwd, groupId, update),
        'Update session group timed out',
      );
    },

    async deleteSessionGroup(groupId) {
      const client = requireClient(getClient, 'Delete session group failed');
      const cwd = requireWorkspaceCwd(getWorkspaceCwd);
      return withActionTimeout(
        client.deleteSessionGroup(cwd, groupId),
        'Delete session group timed out',
      );
    },

    async updateSessionOrganization(sessionId, update) {
      const client = requireClient(
        getClient,
        'Update session organization failed',
      );
      return withActionTimeout(
        client.updateSessionOrganization(sessionId, update),
        'Update session organization timed out',
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

    async exportSession(sessionId, format = 'html') {
      const client = requireClient(getClient, 'Export session failed');
      return withActionTimeout(
        client.exportSession(sessionId, { format }),
        'Export session timed out',
      );
    },

    async archiveSession(sessionId: string) {
      const client = requireClient(getClient, 'Archive session failed');
      const result = await withActionTimeout(
        client.archiveSessionsData([sessionId]),
        'Archive session timed out',
      );
      if (result.errors.length > 0) {
        throw new Error(result.errors[0].error);
      }
      return result.archived.length > 0 || result.alreadyArchived.length > 0;
    },

    async unarchiveSession(sessionId: string) {
      const client = requireClient(getClient, 'Unarchive session failed');
      const result = await withActionTimeout(
        client.unarchiveSessionsData([sessionId]),
        'Unarchive session timed out',
      );
      if (result.errors.length > 0) {
        throw new Error(result.errors[0].error);
      }
      return result.unarchived.length > 0 || result.alreadyActive.length > 0;
    },

    async ensureRuntime() {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Ensure workspace runtime failed',
      );
      return withActionTimeout(
        ensureWorkspaceRuntime(client),
        'Ensure workspace runtime timed out',
        WORKSPACE_RUNTIME_ENSURE_ACTION_TIMEOUT_MS,
      );
    },

    async loadMcpStatus(timeoutMs) {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Load MCP status failed',
      );
      const [catalog, runtime] = await withActionTimeout(
        Promise.all([
          client.workspaceRuntimeMcp(timeoutMs),
          client.workspaceRuntimeStatus(timeoutMs).catch(() => undefined),
        ]),
        'Load MCP status timed out',
        timeoutMs,
      );
      const capability = runtime?.capabilities.mcp;
      return {
        ...catalog,
        runtimeState: capability?.state,
        coordinatorRuntimeEpoch: runtime?.runtimeEpoch,
        capabilityRuntimeEpoch: capability?.runtimeEpoch,
      };
    },

    async initializeMcp() {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Initialize MCP failed',
      );
      return withActionTimeout(
        ensureRuntimeCapability(client, 'mcp'),
        'Initialize MCP timed out',
        WORKSPACE_RUNTIME_ACTION_TIMEOUT_MS,
      );
    },

    async reloadMcp() {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Reload MCP failed',
      );
      return withActionTimeout(
        reloadMcpRuntime(client),
        'Reload MCP timed out',
        WORKSPACE_RUNTIME_ACTION_TIMEOUT_MS,
      );
    },

    async waitForMcpRuntime() {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Wait for MCP runtime failed',
      );
      return withActionTimeout(
        waitForRuntimeCapability(client, 'mcp'),
        'Wait for MCP runtime timed out',
        WORKSPACE_RUNTIME_ACTION_TIMEOUT_MS,
      );
    },

    async loadMcpConfig() {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Load MCP config failed',
      );
      return withActionTimeout(
        client.workspaceMcpConfig(),
        'Load MCP config timed out',
      );
    },

    async setMcpConfig(name, scope, config) {
      const client = requireClient(getClient, 'Set MCP config failed');
      const operation =
        scope === 'workspace'
          ? client
              .workspaceByCwd(requireWorkspaceCwd(getWorkspaceCwd))
              .setWorkspaceMcpConfig(name, config)
          : client.setWorkspaceMcpConfig(name, scope, config);
      return withActionTimeout(operation, 'Set MCP config timed out');
    },

    async removeMcpConfig(name, scope) {
      const client = requireClient(getClient, 'Remove MCP config failed');
      const operation =
        scope === 'workspace'
          ? client
              .workspaceByCwd(requireWorkspaceCwd(getWorkspaceCwd))
              .removeWorkspaceMcpConfig(name)
          : client.removeWorkspaceMcpConfig(name, scope);
      return withActionTimeout(operation, 'Remove MCP config timed out');
    },

    async loadMcpTools(serverName) {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Load MCP tools failed',
      );
      return withActionTimeout(
        client.workspaceRuntimeMcpTools(serverName),
        'Load MCP tools timed out',
      );
    },

    async loadMcpResources(serverName) {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Load MCP resources failed',
      );
      return withActionTimeout(
        client.workspaceRuntimeMcpResources(serverName),
        'Load MCP resources timed out',
      );
    },

    async restartMcpServer(serverName) {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Restart MCP server failed',
      );
      return withActionTimeout(
        client.restartWorkspaceRuntimeMcpServer(serverName),
        'Restart MCP server timed out',
        5 * 60_000,
      );
    },

    async manageMcpServer(serverName, action, scope) {
      const daemon = requireClient(getClient, 'Manage MCP server failed');
      const timeoutMs = action === 'authenticate' ? 10 * 60_000 : 5 * 60_000;
      let operation: Promise<DaemonMcpManageResult>;
      if (action === 'enable' || action === 'disable') {
        if (!scope) {
          throw new Error('MCP configuration scope is required');
        }
        operation =
          scope === 'user'
            ? daemon.setUserConfigMcpServerEnabled(
                serverName,
                action === 'enable',
              )
            : daemon
                .workspaceByCwd(requireWorkspaceCwd(getWorkspaceCwd))
                .setWorkspaceConfigMcpServerEnabled(
                  serverName,
                  action === 'enable',
                );
      } else {
        operation = daemon
          .workspaceByCwd(requireWorkspaceCwd(getWorkspaceCwd))
          .manageWorkspaceRuntimeMcpServer(serverName, action);
      }
      return withActionTimeout(
        operation,
        'Manage MCP server timed out',
        timeoutMs,
      );
    },

    async mcpOperationStatus(operationId, timeoutMs) {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Load MCP operation failed',
      );
      return withActionTimeout(
        client.workspaceRuntimeOperation(operationId, timeoutMs),
        'Load MCP operation timed out',
        timeoutMs,
      );
    },

    async activeMcpOperations(timeoutMs) {
      const client = requireWorkspaceClient(
        getClient,
        getWorkspaceCwd,
        'Load active MCP operations failed',
      );
      return withActionTimeout(
        client.activeWorkspaceRuntimeOperations(timeoutMs),
        'Load active MCP operations timed out',
        timeoutMs,
      );
    },

    async loadDaemonStatus(detail) {
      const client = requireClient(getClient, 'Load daemon status failed');
      return withActionTimeout(
        client.daemonStatus(detail),
        'Load daemon status timed out',
      );
    },

    async loadUsageDashboard(opts) {
      const client = requireClient(getClient, 'Load usage dashboard failed');
      return withActionTimeout(
        client.usageDashboard(opts),
        'Load usage dashboard timed out',
      );
    },

    async loadSkillsStatus() {
      const client = requireClient(getClient, 'Load skills failed');
      return withActionTimeout(
        client.workspaceSkills(),
        'Load skills timed out',
      );
    },

    async setWorkspaceSkillEnabled(skillName, enabled) {
      const client = requireClient(getClient, 'Set skill enabled failed');
      return withActionTimeout(
        client.setWorkspaceSkillEnabled(skillName, enabled),
        'Set skill enabled timed out',
      );
    },

    async installWorkspaceSkill(request) {
      const client = requireClient(getClient, 'Install skill failed');
      return withActionTimeout(
        client.installWorkspaceSkill(request),
        'Install skill timed out',
      );
    },

    async deleteWorkspaceSkill(skillName, scope) {
      const client = requireClient(getClient, 'Delete skill failed');
      return withActionTimeout(
        client.deleteWorkspaceSkill(skillName, scope),
        'Delete skill timed out',
      );
    },

    async loadExtensionsStatus() {
      const client = requireClient(getClient, 'Load extensions failed');
      return withActionTimeout(
        client.workspaceExtensions(),
        'Load extensions timed out',
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

    async setWorkspaceSetting(
      scope: 'workspace' | 'user',
      key: string,
      value: unknown,
      options?: {
        mcpServerMutation?: { operation: 'set' | 'remove'; name: string };
      },
    ) {
      const client = requireClient(getClient, 'Set setting failed');
      return withActionTimeout(
        client.setWorkspaceSetting(scope, key, value, options),
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

    // Scheduled tasks (durable cron). Raw fetch like glob/stat/list — the
    // /scheduled-tasks routes are REST-only and not yet on the DaemonClient
    // transport, so this path only reaches the daemon over plain HTTP (the
    // web-shell's own origin), which is exactly where the page runs. A
    // `workspaceId` selects a non-primary workspace's own cron file via the
    // workspace-qualified route; omitting it hits the primary surface.
    async listScheduledTasks(workspaceId) {
      requireClient(getClient, 'List scheduled tasks failed');
      const path = scheduledTasksPath(workspaceId);
      const url = createDaemonRequestUrl(baseUrl, path);
      const res = await withActionTimeout(
        fetch(serializeDaemonRequestUrl(url, baseUrl), {
          headers: createDaemonHeaders(token),
        }),
        'List scheduled tasks timed out',
      );
      if (!res.ok) {
        throw new Error(await readDaemonError(res, `GET ${path}`));
      }
      const data = (await res.json()) as { tasks?: DaemonScheduledTask[] };
      return Array.isArray(data.tasks) ? data.tasks : [];
    },

    async createScheduledTask(req, workspaceId) {
      requireClient(getClient, 'Create scheduled task failed');
      const path = scheduledTasksPath(workspaceId);
      const url = createDaemonRequestUrl(baseUrl, path);
      const res = await withActionTimeout(
        fetch(serializeDaemonRequestUrl(url, baseUrl), {
          method: 'POST',
          headers: createDaemonJsonHeaders(token),
          body: JSON.stringify(req),
        }),
        'Create scheduled task timed out',
      );
      if (!res.ok) {
        throw new Error(await readDaemonError(res, `POST ${path}`));
      }
      return (await res.json()) as DaemonScheduledTask;
    },

    async updateScheduledTask(id, patch, workspaceId) {
      requireClient(getClient, 'Update scheduled task failed');
      const path = scheduledTasksPath(
        workspaceId,
        `/${encodeURIComponent(id)}`,
      );
      const url = createDaemonRequestUrl(baseUrl, path);
      const res = await withActionTimeout(
        fetch(serializeDaemonRequestUrl(url, baseUrl), {
          method: 'PATCH',
          headers: createDaemonJsonHeaders(token),
          body: JSON.stringify(patch),
        }),
        'Update scheduled task timed out',
      );
      if (!res.ok) {
        throw new Error(await readDaemonError(res, `PATCH ${path}`));
      }
      return (await res.json()) as DaemonScheduledTask;
    },

    async runScheduledTask(id, workspaceId) {
      requireClient(getClient, 'Run scheduled task failed');
      const path = scheduledTasksPath(
        workspaceId,
        `/${encodeURIComponent(id)}/run`,
      );
      const url = createDaemonRequestUrl(baseUrl, path);
      const res = await withActionTimeout(
        fetch(serializeDaemonRequestUrl(url, baseUrl), {
          method: 'POST',
          headers: createDaemonJsonHeaders(token),
        }),
        'Run scheduled task timed out',
      );
      if (!res.ok) {
        throw new Error(await readDaemonError(res, `POST ${path}`));
      }
      return (await res.json()) as DaemonScheduledTask;
    },

    async deleteScheduledTask(id, workspaceId) {
      requireClient(getClient, 'Delete scheduled task failed');
      const path = scheduledTasksPath(
        workspaceId,
        `/${encodeURIComponent(id)}`,
      );
      const url = createDaemonRequestUrl(baseUrl, path);
      const res = await withActionTimeout(
        fetch(serializeDaemonRequestUrl(url, baseUrl), {
          method: 'DELETE',
          headers: createDaemonHeaders(token),
        }),
        'Delete scheduled task timed out',
      );
      if (!res.ok) {
        throw new Error(await readDaemonError(res, `DELETE ${path}`));
      }
    },

    // Goals. `GET /goals` is REST-only (like /scheduled-tasks) and not on the
    // DaemonClient transport; the clear path reuses the existing per-session
    // route so a page-level clear and a `/goal clear` in chat take the same
    // code path in the daemon.
    async listGoals() {
      requireClient(getClient, 'List goals failed');
      const url = createDaemonRequestUrl(baseUrl, '/goals');
      const res = await withActionTimeout(
        fetch(serializeDaemonRequestUrl(url, baseUrl), {
          headers: createDaemonHeaders(token),
        }),
        'List goals timed out',
      );
      if (!res.ok) {
        throw new Error(await readDaemonError(res, 'GET /goals'));
      }
      const data = (await res.json()) as {
        goals?: DaemonGoal[];
        droppedCount?: number;
      };
      return {
        goals: Array.isArray(data.goals) ? data.goals : [],
        droppedCount:
          typeof data.droppedCount === 'number' && data.droppedCount > 0
            ? data.droppedCount
            : 0,
      };
    },

    async clearGoal(sessionId) {
      requireClient(getClient, 'Clear goal failed');
      const url = createDaemonRequestUrl(
        baseUrl,
        `/session/${encodeURIComponent(sessionId)}/goal/clear`,
      );
      const res = await withActionTimeout(
        fetch(serializeDaemonRequestUrl(url, baseUrl), {
          method: 'POST',
          headers: createDaemonJsonHeaders(token),
          body: '{}',
        }),
        'Clear goal timed out',
      );
      if (!res.ok) {
        throw new Error(
          await readDaemonError(res, `POST /session/${sessionId}/goal/clear`),
        );
      }
      return (await res.json()) as { cleared: boolean };
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

    async installExtension(params, clientId) {
      const client = requireClient(getClient, 'Install extension failed');
      return withActionTimeout(
        client.installExtension(params, clientId),
        'Install extension timed out',
      );
    },

    async extensionOperationStatus(operationId) {
      const client = requireClient(
        getClient,
        'Load extension operation failed',
      );
      return withActionTimeout(
        client.extensionOperationStatus(operationId),
        'Load extension operation timed out',
      );
    },

    async activeExtensionOperations() {
      const client = requireClient(
        getClient,
        'Load active extension operations failed',
      );
      return withActionTimeout(
        client.activeExtensionOperations(),
        'Load active extension operations timed out',
      );
    },

    async respondToExtensionInteraction(
      operationId,
      interactionId,
      response,
      clientId,
    ) {
      const client = requireClient(
        getClient,
        'Respond to extension interaction failed',
      );
      return withActionTimeout(
        client.respondToExtensionInteraction(
          operationId,
          interactionId,
          response,
          clientId,
        ),
        'Respond to extension interaction timed out',
      );
    },

    async checkExtensionUpdates(clientId) {
      const client = requireClient(getClient, 'Check extension updates failed');
      return withActionTimeout(
        client.checkExtensionUpdates(clientId),
        'Check extension updates timed out',
      );
    },

    async refreshExtensions(clientId) {
      const client = requireClient(getClient, 'Refresh extensions failed');
      return withActionTimeout(
        client.refreshExtensions(clientId),
        'Refresh extensions timed out',
      );
    },

    async enableExtension(name, params, clientId) {
      const client = requireClient(getClient, 'Enable extension failed');
      return withActionTimeout(
        client.enableExtension(name, params, clientId),
        'Enable extension timed out',
      );
    },

    async disableExtension(name, params, clientId) {
      const client = requireClient(getClient, 'Disable extension failed');
      return withActionTimeout(
        client.disableExtension(name, params, clientId),
        'Disable extension timed out',
      );
    },

    async updateExtension(name, clientId) {
      const client = requireClient(getClient, 'Update extension failed');
      return withActionTimeout(
        client.updateExtension(name, clientId),
        'Update extension timed out',
      );
    },

    async uninstallExtension(name, clientId) {
      const client = requireClient(getClient, 'Uninstall extension failed');
      return withActionTimeout(
        client.uninstallExtension(name, clientId),
        'Uninstall extension timed out',
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

    async deleteModel(target) {
      const client = requireClient(getClient, 'Delete model failed');
      return withActionTimeout(
        client.deleteModel(target),
        'Delete model timed out',
      );
    },

    async addWorkspace(cwd, options) {
      const client = requireClient(getClient, 'Add workspace failed');
      return withActionTimeout(
        client.addWorkspace(cwd, options),
        'Add workspace timed out',
      );
    },

    async suggestWorkspacePaths(prefix) {
      const client = requireClient(getClient, 'Suggest workspace paths failed');
      const result = await withActionTimeout(
        client.workspacePathSuggestions(prefix),
        'Suggest workspace paths timed out',
      );
      return result as DaemonWorkspacePathSuggestions;
    },

    async removeWorkspace(workspaceId, options) {
      const client = requireClient(getClient, 'Remove workspace failed');
      const removal = client.workspaceById(workspaceId).remove(options);
      if (options?.timeoutMs === 0) return removal;
      return withActionTimeout(
        removal,
        'Remove workspace timed out',
        options?.timeoutMs,
      );
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

async function ensureWorkspaceRuntime(
  client: WorkspaceDaemonClient,
): Promise<DaemonWorkspaceRuntimeStatus> {
  const deadlineAt = Date.now() + WORKSPACE_RUNTIME_ENSURE_POLL_TIMEOUT_MS;
  const initial = await client.ensureWorkspaceRuntime();
  let status: DaemonWorkspaceRuntimeStatus = initial;
  while (true) {
    const capabilities = Object.values(status.capabilities).filter(
      (capability) => capability !== undefined,
    );
    if (
      capabilities.length > 0 &&
      capabilities.every(
        (capability) =>
          capability.state === 'ready' || capability.state === 'error',
      )
    ) {
      return status;
    }
    const remainingMs = Math.floor(deadlineAt - Date.now());
    if (remainingMs <= 0) {
      throw new Error('Workspace runtime is still starting');
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(WORKSPACE_RUNTIME_POLL_INTERVAL_MS, remainingMs),
      ),
    );
    status = await client.workspaceRuntimeStatus(
      Math.max(1, Math.floor(deadlineAt - Date.now())),
    );
  }
}

async function ensureRuntimeCapability(
  client: WorkspaceDaemonClient,
  capability: DaemonWorkspaceRuntimeCapability,
): Promise<DaemonWorkspaceRuntimeStatus> {
  const deadlineAt = Date.now() + WORKSPACE_RUNTIME_POLL_TIMEOUT_MS;
  const initial = await client.ensureWorkspaceRuntime();
  const terminal = await waitForRuntimeCapability(
    client,
    capability,
    initial,
    deadlineAt,
  );
  return terminal;
}

async function reloadMcpRuntime(
  client: WorkspaceDaemonClient,
): Promise<DaemonWorkspaceRuntimeStatus> {
  const deadlineAt = Date.now() + WORKSPACE_RUNTIME_POLL_TIMEOUT_MS;
  const initial = await client.reloadWorkspaceRuntimeMcp(
    remainingRuntimePollTimeout(deadlineAt, 'mcp'),
  );
  const terminal = await waitForRuntimeCapability(
    client,
    'mcp',
    initial,
    deadlineAt,
  );
  return terminal;
}

async function waitForRuntimeCapability(
  client: WorkspaceDaemonClient,
  capability: DaemonWorkspaceRuntimeCapability,
  initial?: DaemonWorkspaceRuntimeStatus,
  deadlineAt = Date.now() + WORKSPACE_RUNTIME_POLL_TIMEOUT_MS,
): Promise<DaemonWorkspaceRuntimeStatus> {
  let status =
    initial ??
    (await client.workspaceRuntimeStatus(
      remainingRuntimePollTimeout(deadlineAt, capability),
    ));
  while (true) {
    const capabilityStatus = status.capabilities[capability];
    if (capabilityStatus?.state === 'ready') return status;
    if (capabilityStatus?.state === 'error') {
      throw new Error(
        capabilityStatus.error?.message ??
          `Workspace ${capability} runtime failed`,
      );
    }
    const remainingMs = remainingRuntimePollTimeout(deadlineAt, capability);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(WORKSPACE_RUNTIME_POLL_INTERVAL_MS, remainingMs),
      ),
    );
    status = await client.workspaceRuntimeStatus(
      remainingRuntimePollTimeout(deadlineAt, capability),
    );
  }
}

function remainingRuntimePollTimeout(
  deadlineAt: number,
  capability: DaemonWorkspaceRuntimeCapability,
): number {
  const remainingMs = Math.floor(deadlineAt - Date.now());
  if (remainingMs <= 0) {
    throw new Error(`Workspace ${capability} runtime is still starting`);
  }
  return remainingMs;
}

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

function requireWorkspaceClient(
  getClient: () => DaemonClient | undefined,
  getWorkspaceCwd: () => string | undefined,
  action: string,
): WorkspaceDaemonClient {
  return requireClient(getClient, action).workspaceByCwd(
    requireWorkspaceCwd(getWorkspaceCwd),
  );
}

function requireWorkspaceCwd(
  getWorkspaceCwd: () => string | undefined,
): string {
  const cwd = getWorkspaceCwd();
  if (!cwd) {
    throw new Error('Daemon workspace is not connected');
  }
  return cwd;
}

// Builds a scheduled-tasks REST path. With a `workspaceId` it targets that
// workspace's own cron file via the qualified route; without one it hits the
// primary surface. `suffix` appends the task id (and `/run`) for item routes.
// The aggregated view passes the primary workspace as `undefined`, so the
// primary keeps its trust-free unqualified surface while secondaries use the
// (trust-checked) qualified one.
function scheduledTasksPath(workspaceId?: string, suffix = ''): string {
  return workspaceId
    ? `/workspaces/${encodeURIComponent(workspaceId)}/scheduled-tasks${suffix}`
    : `/scheduled-tasks${suffix}`;
}

function createDaemonHeaders(token: string | undefined): HeadersInit {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// Same as createDaemonHeaders but with a JSON content-type, for the
// POST/PATCH scheduled-task writes that carry a body.
function createDaemonJsonHeaders(token: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
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
