/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import stripJsonComments from 'strip-json-comments';
import { SettingScope, type LoadedSettings } from './settings.js';

export type ClaudeMcpImportSource = 'all' | 'claude-code' | 'claude-desktop';
export type ClaudeMcpImportScope = 'user' | 'project';

export interface ClaudeMcpImportOptions {
  source: ClaudeMcpImportSource;
  scope: ClaudeMcpImportScope;
  settings: LoadedSettings;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ClaudeMcpSourceResult {
  source: Exclude<ClaudeMcpImportSource, 'all'>;
  label: string;
  path: string;
  servers: Record<string, MCPServerConfig>;
  errors: string[];
  found: boolean;
}

export interface ImportedClaudeMcpServer {
  name: string;
  source: string;
}

export interface SkippedClaudeMcpServer {
  name: string;
  source: string;
  reason: 'already-exists' | 'reserved-name';
}

export interface ClaudeMcpImportResult {
  scope: ClaudeMcpImportScope;
  settingScope: SettingScope.User | SettingScope.Workspace;
  scanned: ClaudeMcpSourceResult[];
  imported: ImportedClaudeMcpServer[];
  skipped: SkippedClaudeMcpServer[];
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isReadableConfigError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}

function isReservedServerName(name: string): boolean {
  return name === '__proto__' || name === 'constructor' || name === 'prototype';
}

function emptyServerRecord(): Record<string, MCPServerConfig> {
  return Object.create(null) as Record<string, MCPServerConfig>;
}

function readJsonObject(filePath: string): {
  found: boolean;
  data?: Record<string, unknown>;
  error?: string;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (
      isReadableConfigError(error) &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return { found: false };
    }

    return {
      found: true,
      error: `Failed to read ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!raw.trim()) {
    return { found: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (error) {
    return {
      found: true,
      error: `Failed to parse ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!isRecord(parsed)) {
    return {
      found: true,
      error: `${filePath} must contain a JSON object`,
    };
  }

  return { found: true, data: parsed };
}

function copyMcpServers(
  value: unknown,
  sourcePath: string,
  servers: Record<string, MCPServerConfig>,
  errors: string[],
) {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value)) {
    errors.push(`${sourcePath} has no "mcpServers" object`);
    return;
  }

  for (const [name, serverConfig] of Object.entries(value)) {
    if (!isRecord(serverConfig)) {
      errors.push(`${sourcePath}: server "${name}" is not an object - skipped`);
      continue;
    }
    servers[name] = serverConfig as MCPServerConfig;
  }
}

function normalizeProjectPath(projectPath: string): string {
  return path.resolve(projectPath);
}

function getClaudeProjectSettings(
  projects: unknown,
  cwd: string,
): Record<string, unknown> | undefined {
  if (!isRecord(projects)) {
    return undefined;
  }

  const normalizedCwd = normalizeProjectPath(cwd);
  for (const [projectPath, projectSettings] of Object.entries(projects)) {
    if (
      normalizeProjectPath(projectPath) === normalizedCwd &&
      isRecord(projectSettings)
    ) {
      return projectSettings;
    }
  }

  return undefined;
}

export function getClaudeCodeConfigPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.claude.json');
}

export function getClaudeDesktopConfigPath(
  homeDir = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const appData =
      env['APPDATA'] ?? path.win32.join(homeDir, 'AppData', 'Roaming');
    return path.win32.join(appData, 'Claude', 'claude_desktop_config.json');
  }

  if (platform === 'darwin') {
    return path.join(
      homeDir,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }

  return path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
}

function loadMcpServersFromSettingsFile(
  filePath: string,
  label: string,
  source: Exclude<ClaudeMcpImportSource, 'all'>,
): ClaudeMcpSourceResult {
  const errors: string[] = [];
  const servers = emptyServerRecord();
  const parsed = readJsonObject(filePath);

  if (!parsed.found) {
    return {
      source,
      label,
      path: filePath,
      servers,
      errors,
      found: false,
    };
  }

  if (!parsed.data) {
    return {
      source,
      label,
      path: filePath,
      servers,
      errors: parsed.error ? [parsed.error] : errors,
      found: true,
    };
  }

  copyMcpServers(parsed.data['mcpServers'], filePath, servers, errors);

  return {
    source,
    label,
    path: filePath,
    servers,
    errors,
    found: true,
  };
}

function loadClaudeCodeJsonMcpServers(
  homeDir: string,
  cwd: string,
  scope: ClaudeMcpImportScope,
): ClaudeMcpSourceResult {
  const filePath = getClaudeCodeConfigPath(homeDir);
  const errors: string[] = [];
  const servers = emptyServerRecord();
  const parsed = readJsonObject(filePath);

  if (!parsed.found) {
    return {
      source: 'claude-code',
      label: 'Claude Code',
      path: filePath,
      servers,
      errors,
      found: false,
    };
  }

  if (!parsed.data) {
    return {
      source: 'claude-code',
      label: 'Claude Code',
      path: filePath,
      servers,
      errors: parsed.error ? [parsed.error] : errors,
      found: true,
    };
  }

  if (scope === 'user') {
    copyMcpServers(parsed.data['mcpServers'], filePath, servers, errors);
  } else {
    const projectSettings = getClaudeProjectSettings(
      parsed.data['projects'],
      cwd,
    );
    if (projectSettings) {
      copyMcpServers(
        projectSettings['mcpServers'],
        `${filePath} projects["${normalizeProjectPath(cwd)}"]`,
        servers,
        errors,
      );
    }
  }

  return {
    source: 'claude-code',
    label: 'Claude Code',
    path: filePath,
    servers,
    errors,
    found: true,
  };
}

function loadClaudeCodeMcpSources(
  homeDir: string,
  cwd: string,
  scope: ClaudeMcpImportScope,
): ClaudeMcpSourceResult[] {
  const candidates =
    scope === 'project'
      ? [
          loadMcpServersFromSettingsFile(
            path.join(cwd, '.claude', 'settings.json'),
            'Claude Code project settings',
            'claude-code',
          ),
          loadClaudeCodeJsonMcpServers(homeDir, cwd, scope),
        ]
      : [
          loadClaudeCodeJsonMcpServers(homeDir, cwd, scope),
          loadMcpServersFromSettingsFile(
            path.join(homeDir, '.claude', 'settings.json'),
            'Claude Code global settings',
            'claude-code',
          ),
        ];

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) {
      return false;
    }
    seen.add(candidate.path);
    return true;
  });
}

function loadClaudeDesktopMcpServers(
  homeDir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ClaudeMcpSourceResult {
  const filePath = getClaudeDesktopConfigPath(homeDir, platform, env);
  const errors: string[] = [];
  const servers = emptyServerRecord();
  const parsed = readJsonObject(filePath);

  if (!parsed.found) {
    return {
      source: 'claude-desktop',
      label: 'Claude Desktop',
      path: filePath,
      servers,
      errors,
      found: false,
    };
  }

  if (!parsed.data) {
    return {
      source: 'claude-desktop',
      label: 'Claude Desktop',
      path: filePath,
      servers,
      errors: parsed.error ? [parsed.error] : errors,
      found: true,
    };
  }

  copyMcpServers(parsed.data['mcpServers'], filePath, servers, errors);

  return {
    source: 'claude-desktop',
    label: 'Claude Desktop',
    path: filePath,
    servers,
    errors,
    found: true,
  };
}

export function loadClaudeMcpSources(
  options: Pick<
    ClaudeMcpImportOptions,
    'source' | 'cwd' | 'homeDir' | 'env' | 'platform'
  > &
    Partial<Pick<ClaudeMcpImportOptions, 'scope'>>,
): ClaudeMcpSourceResult[] {
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const scope = options.scope ?? 'user';

  const sources: ReadonlyArray<Exclude<ClaudeMcpImportSource, 'all'>> =
    options.source === 'all'
      ? (['claude-code', 'claude-desktop'] as const)
      : ([options.source] as const);

  return sources.flatMap((source) =>
    source === 'claude-code'
      ? loadClaudeCodeMcpSources(homeDir, cwd, scope)
      : [loadClaudeDesktopMcpServers(homeDir, platform, env)],
  );
}

function getSettingScope(
  settings: LoadedSettings,
  scope: ClaudeMcpImportScope,
): SettingScope.User | SettingScope.Workspace {
  if (scope === 'user') {
    return SettingScope.User;
  }

  if (settings.workspace.path === settings.user.path) {
    throw new Error(
      'Please use --scope user to edit settings in the home directory.',
    );
  }

  return SettingScope.Workspace;
}

function addServerNamesFromRecord(value: unknown, names: Set<string>) {
  if (!isRecord(value)) {
    return;
  }

  for (const name of Object.keys(value)) {
    names.add(name);
  }
}

function copyExistingServers(
  settings: LoadedSettings,
  settingScope: SettingScope.User | SettingScope.Workspace,
): {
  nextServers: Record<string, MCPServerConfig>;
  existingNames: Set<string>;
} {
  const existingServers = settings.forScope(settingScope).settings.mcpServers;
  const existingNames = new Set<string>();

  if (existingServers === undefined) {
    addServerNamesFromRecord(settings.merged?.mcpServers, existingNames);
    return { nextServers: emptyServerRecord(), existingNames };
  }

  if (!isRecord(existingServers)) {
    throw new Error('Existing mcpServers setting must be an object.');
  }

  const copy = emptyServerRecord();
  for (const [name, serverConfig] of Object.entries(existingServers)) {
    copy[name] = serverConfig as MCPServerConfig;
    existingNames.add(name);
  }
  addServerNamesFromRecord(settings.merged?.mcpServers, existingNames);
  return { nextServers: copy, existingNames };
}

export function importClaudeMcpServers(
  options: ClaudeMcpImportOptions,
): ClaudeMcpImportResult {
  const settingScope = getSettingScope(options.settings, options.scope);
  const { nextServers, existingNames } = copyExistingServers(
    options.settings,
    settingScope,
  );
  const scanned = loadClaudeMcpSources(options);
  const imported: ImportedClaudeMcpServer[] = [];
  const skipped: SkippedClaudeMcpServer[] = [];
  const errors = scanned.flatMap((source) => source.errors);

  for (const source of scanned) {
    for (const [name, serverConfig] of Object.entries(source.servers)) {
      if (isReservedServerName(name)) {
        skipped.push({ name, source: source.label, reason: 'reserved-name' });
        continue;
      }

      if (existingNames.has(name)) {
        skipped.push({ name, source: source.label, reason: 'already-exists' });
        continue;
      }

      nextServers[name] = serverConfig as MCPServerConfig;
      existingNames.add(name);
      imported.push({ name, source: source.label });
    }
  }

  if (imported.length > 0) {
    options.settings.setValue(settingScope, 'mcpServers', nextServers);
  }

  return {
    scope: options.scope,
    settingScope,
    scanned,
    imported,
    skipped,
    errors,
  };
}
