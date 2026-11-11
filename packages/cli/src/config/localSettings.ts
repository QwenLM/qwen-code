/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandSettings } from './createCliSettingsService.js';
/**
 * MCP server CRUD helpers.
 *
 * The CLI exposes three scope flags (user / local / project):
 *
 * - `user`            -> ~/${CONFIG_DIR}/settings.json
 * - `local` (default) -> <cwd>/${CONFIG_DIR}/settings.local.json  (gitignored)
 * - `project`         -> <cwd>/.mcp.json  (VCS-shared, cross-tool standard)
 *                        Also reads from <cwd>/${CONFIG_DIR}/settings.json (legacy)
 *                        for backwards compatibility, but new writes go to .mcp.json.
 */

import {
  homedir,
  stripScope,
  type MCPServerConfig,
  sessionLogger,
} from '@qwen-code/core';
import {
  SettingScope,
  type LoadableSettingScope,
} from './settings.js';
import {
  loadProjectMcpJson,
  type ProjectMcpConfigValidator,
  getProjectMcpJsonPath,
  writeProjectMcpJson,
} from './mcp/projectMcpJson.js';

export type McpScope = 'user' | 'local' | 'project';

function toSettingScope(scope: McpScope): LoadableSettingScope {
  switch (scope) {
    case 'user':
      return SettingScope.User;
    case 'local':
      return SettingScope.Local;
    case 'project':
      return SettingScope.Project;
    default:
      return SettingScope.Local;
  }
}

/**
 * Read MCP servers from project settings.json (legacy project-level source).
 */
function readProjectSettingsMcpServers(
  settings: CommandSettings,
): Record<string, MCPServerConfig> {
  const file = settings.forScope(SettingScope.Project);
  return { ...(file.settings.mcpServers ?? {}) };
}

function readMcpServers(
  scope: McpScope,
  cwd: string,
  settings: CommandSettings,
  validator?: ProjectMcpConfigValidator,
): Record<string, MCPServerConfig> {
  if (scope === 'project') {
    // Merge legacy project settings.json with .mcp.json; the latter wins.
    const projectSettingsServers = readProjectSettingsMcpServers(settings);
    const mcpJsonServers = loadProjectMcpJson(cwd, validator);
    return { ...projectSettingsServers, ...mcpJsonServers };
  }
  const file = settings.forScope(toSettingScope(scope));
  return { ...(file.settings.mcpServers ?? {}) };
}

/**
 * Get MCP servers for a specific scope.
 */
export function getMcpServersByScope(
  scope: McpScope,
  cwd: string,
  settings: CommandSettings,
  validator?: ProjectMcpConfigValidator,
): Record<string, MCPServerConfig> {
  return readMcpServers(scope, cwd, settings, validator);
}

/**
 * Upsert an MCP server in the given scope. Returns true if the server already
 * existed (i.e. this is an update), false if it is new.
 */
export function upsertMcpServer(
  name: string,
  config: MCPServerConfig,
  scope: McpScope,
  cwd: string,
  rejectExisting = false,
  settings: CommandSettings,
  validator?: ProjectMcpConfigValidator,
): boolean {
  if (scope === 'project') {
    const servers = readMcpServers(scope, cwd, settings, validator);
    const existed = !!servers[name];
    if (existed && rejectExisting) return true;
    servers[name] = config;
    writeProjectMcpJson(cwd, servers);
    return existed;
  }

  const settingScope = toSettingScope(scope);
  let existed = false;
  const success = settings.mutateScope(
    settingScope,
    (editor) => {
      existed = editor.get(['mcpServers', name]) !== undefined;
      if (existed && rejectExisting) return;
      editor.set(['mcpServers', name], stripScope({ [name]: config })[name]);
    },
  );
  if (!success) throw new Error('Failed to update MCP settings.');
  return existed;
}

/** Project scope may remove both .mcp.json and legacy settings entries. */
export function removeMcpServer(
  name: string,
  scope: McpScope,
  cwd: string,
  settings: CommandSettings,
  validator?: ProjectMcpConfigValidator,
): MCPServerConfig[] {
  if (scope === 'project') {
    const removed: MCPServerConfig[] = [];
    const projectServers = loadProjectMcpJson(cwd, validator);
    const fromMcpJson = projectServers[name];
    if (name in projectServers) {
      delete projectServers[name];
      writeProjectMcpJson(cwd, projectServers);
    }
    if (fromMcpJson) {
      // Sessions read .mcp.json as written.
      removed.push(fromMcpJson);
    }
    removed.push(
      ...removeSettingsEntry(
        name,
        SettingScope.Project,
        settings,
        'Failed to update project MCP settings.',
      ),
    );
    return removed;
  }
  return removeSettingsEntry(
    name,
    toSettingScope(scope),
    settings,
    'Failed to update MCP settings.',
  );
}

function removeSettingsEntry(
  name: string,
  scope: Parameters<CommandSettings['forScope']>[0],
  settings: CommandSettings,
  failureMessage: string,
): MCPServerConfig[] {
  let removed: MCPServerConfig | undefined;
  const success = settings.mutateScope(scope, (editor) => {
    const current = editor.get(['mcpServers', name]);
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      removed = current as MCPServerConfig;
      editor.delete(['mcpServers', name]);
    }
  });
  if (!success) throw new Error(failureMessage);
  return removed ? [removed] : [];
}

/**
 * Find which scope(s) contain a given MCP server.
 */
export function findMcpServerScopes(
  name: string,
  cwd: string,
  settings: CommandSettings,
  validator?: ProjectMcpConfigValidator,
): McpScope[] {
  const scopes: McpScope[] = [];
  if (readMcpServers('user', cwd, settings, validator)[name]) {
    scopes.push('user');
  }
  if (readMcpServers('local', cwd, settings, validator)[name]) {
    scopes.push('local');
  }
  if (readMcpServers('project', cwd, settings, validator)[name]) {
    scopes.push('project');
  }
  return scopes;
}

/**
 * Resolve the on-disk path that backs a given scope. For `project` scope this
 * returns the `.mcp.json` path (the canonical write target).
 */
export function getScopeSettingsPath(
  scope: McpScope,
  cwd: string,
  settings: CommandSettings,
): string {
  if (scope === 'project') {
    return getProjectMcpJsonPath(cwd);
  }
  return settings.forScope(toSettingScope(scope)).path;
}

/**
 * Return every on-disk file path where `name` is defined within the `project`
 * scope. The project scope merges legacy project settings.json and .mcp.json,
 * so a server may appear in one or both files.
 */
export function getProjectSourcePaths(
  name: string,
  cwd: string,
  settings: CommandSettings,
  validator?: ProjectMcpConfigValidator,
): string[] {
  const paths: string[] = [];
  if (readProjectSettingsMcpServers(settings)[name]) {
    paths.push(settings.forScope(SettingScope.Project).path);
  }
  if (loadProjectMcpJson(cwd, validator)[name]) {
    paths.push(getProjectMcpJsonPath(cwd));
  }
  return paths;
}

/**
 * Guards against writing local/project scope configs when cwd is the home
 * directory. Exits with an error message if the check fails.
 */
export function guardHomeDirScope(scope: string, cwd: string): void {
  if ((scope === 'local' || scope === 'project') && cwd === homedir()) {
    process.stderr.write(
      'Error: Please use --scope user to edit settings in the home directory.\n',
    );
    sessionLogger.setExitContext({
      reason: 'config_error',
      exit_code: 1,
      message: 'Cannot use local/project scope in home directory',
      source: 'localSettings.guardHomeDirScope',
    });
    process.exit(1);
  }
}

/**
 * Helper: update a server entry in-place within a single source (either
 * .mcp.json or a settings scope). Used by enable/disable to write back to
 * the exact file that holds the server.
 */
function updateServerInSource(
  serverName: string,
  cwd: string,
  source: 'mcpJson' | LoadableSettingScope,
  updater: (server: MCPServerConfig) => MCPServerConfig,
  settings: CommandSettings,
  validator?: ProjectMcpConfigValidator,
): boolean {
  if (source === 'mcpJson') {
    const servers = loadProjectMcpJson(cwd, validator);
    if (!servers[serverName]) return false;
    servers[serverName] = updater(servers[serverName]);
    writeProjectMcpJson(cwd, servers);
    return true;
  }
  let found = false;
  const success = settings.updateValue(
    source,
    ['mcpServers', serverName],
    (current) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return current;
      }
      found = true;
      const next = updater(current as MCPServerConfig);
      return stripScope({ [serverName]: next })[serverName];
    },
  );
  if (!success) throw new Error('Failed to update MCP settings.');
  return found;
}

/**
 * All concrete sources that contribute to MCP servers, in order from most
 * general to most specific.
 */
const ALL_SOURCES: Array<'mcpJson' | LoadableSettingScope> = [
  SettingScope.User,
  SettingScope.Project,
  'mcpJson',
  SettingScope.Local,
];

/**
 * Persistently enable a server by clearing its `disabled` field from every
 * source that contains it.
 */
export async function persistentEnableMcpServer(
  serverName: string,
  cwd: string = process.cwd(),
  settings: CommandSettings,
  validator?: ProjectMcpConfigValidator,
): Promise<void> {
  for (const source of ALL_SOURCES) {
    updateServerInSource(
      serverName,
      cwd,
      source,
      (server) => {
        const { disabled: _disabled, ...rest } = server;
        return rest as MCPServerConfig;
      },
      settings,
      validator,
    );
  }
}

/**
 * Persistently disable a server by setting `disabled: true` in the most
 * specific source that contains it (local > .mcp.json > project settings > user).
 */
export async function persistentDisableMcpServer(
  serverName: string,
  cwd: string = process.cwd(),
  settings: CommandSettings,
  validator?: ProjectMcpConfigValidator,
): Promise<void> {
  // Iterate most-specific-first
  for (const source of [...ALL_SOURCES].reverse()) {
    const found = updateServerInSource(
      serverName,
      cwd,
      source,
      (server) => ({
        // eslint-disable-next-line @typescript-eslint/no-misused-spread -- MCPServerConfig from JSON is a plain object
        ...server,
        disabled: true,
      }),
      settings,
      validator,
    );
    if (found) return;
  }
}
