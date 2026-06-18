/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getClaudeDesktopConfigPath,
  importClaudeMcpServers,
  loadClaudeMcpSources,
} from './claudeMcpImport.js';
import { SettingScope, type LoadedSettings } from './settings.js';

describe('claude MCP import', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mcp-import-'));
    homeDir = path.join(tmpDir, 'home');
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(filePath: string, value: unknown) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  }

  function createSettings(options?: {
    userMcpServers?: Record<string, unknown>;
    workspaceMcpServers?: Record<string, unknown>;
    mergedMcpServers?: Record<string, unknown>;
    inHome?: boolean;
  }): LoadedSettings {
    const userSettings = {
      ...(options?.userMcpServers && {
        mcpServers: options.userMcpServers,
      }),
    };
    const workspaceSettings = {
      ...(options?.workspaceMcpServers && {
        mcpServers: options.workspaceMcpServers,
      }),
    };
    const userFile = path.join(homeDir, '.qwen', 'settings.json');
    const workspaceFile = options?.inHome
      ? userFile
      : path.join(projectDir, '.qwen', 'settings.json');
    const mergedMcpServers =
      options?.mergedMcpServers ??
      (options?.userMcpServers || options?.workspaceMcpServers
        ? {
            ...(options?.userMcpServers ?? {}),
            ...(options?.workspaceMcpServers ?? {}),
          }
        : undefined);

    return {
      merged: {
        ...(mergedMcpServers && { mcpServers: mergedMcpServers }),
      },
      user: { path: userFile, settings: userSettings },
      workspace: { path: workspaceFile, settings: workspaceSettings },
      forScope: vi.fn((scope: SettingScope) =>
        scope === SettingScope.User
          ? { path: userFile, settings: userSettings }
          : { path: workspaceFile, settings: workspaceSettings },
      ),
      setValue: vi.fn((scope: SettingScope, key: string, value: unknown) => {
        const target =
          scope === SettingScope.User ? userSettings : workspaceSettings;
        target[key as keyof typeof target] = value as never;
      }),
    } as unknown as LoadedSettings;
  }

  it('imports Claude Code user MCP servers from .claude.json', () => {
    writeJson(path.join(homeDir, '.claude.json'), {
      mcpServers: {
        userServer: { command: 'node', args: ['user.js'] },
      },
      projects: {
        [projectDir]: {
          mcpServers: {
            projectServer: { command: 'node', args: ['project.js'] },
          },
        },
        [path.join(tmpDir, 'other')]: {
          mcpServers: {
            otherProjectServer: { command: 'node', args: ['other.js'] },
          },
        },
      },
    });

    const settings = createSettings();
    const result = importClaudeMcpServers({
      source: 'claude-code',
      scope: 'user',
      settings,
      cwd: projectDir,
      homeDir,
    });

    expect(result.imported.map((entry) => entry.name)).toEqual(['userServer']);
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'mcpServers',
      expect.objectContaining({
        userServer: { command: 'node', args: ['user.js'] },
      }),
    );
  });

  it('imports Claude Code current-project MCP servers into project scope', () => {
    writeJson(path.join(homeDir, '.claude.json'), {
      mcpServers: {
        userServer: { command: 'node', args: ['user.js'] },
      },
      projects: {
        [projectDir]: {
          mcpServers: {
            projectServer: { command: 'node', args: ['project.js'] },
          },
        },
      },
    });

    const settings = createSettings();
    const result = importClaudeMcpServers({
      source: 'claude-code',
      scope: 'project',
      settings,
      cwd: projectDir,
      homeDir,
    });

    expect(result.imported.map((entry) => entry.name)).toEqual([
      'projectServer',
    ]);
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'mcpServers',
      expect.objectContaining({
        projectServer: { command: 'node', args: ['project.js'] },
      }),
    );
  });

  it('imports Claude Code .claude/settings.json files by matching target scope', () => {
    writeJson(path.join(projectDir, '.claude', 'settings.json'), {
      mcpServers: {
        projectSettingsServer: { command: 'node', args: ['project.js'] },
      },
    });
    writeJson(path.join(homeDir, '.claude', 'settings.json'), {
      mcpServers: {
        globalSettingsServer: { command: 'node', args: ['global.js'] },
      },
    });

    const settings = createSettings();
    const result = importClaudeMcpServers({
      source: 'claude-code',
      scope: 'user',
      settings,
      cwd: projectDir,
      homeDir,
    });

    expect(result.imported.map((entry) => entry.name)).toEqual([
      'globalSettingsServer',
    ]);
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'mcpServers',
      expect.objectContaining({
        globalSettingsServer: { command: 'node', args: ['global.js'] },
      }),
    );
  });

  it('imports Claude Desktop MCP servers from the platform config path', () => {
    const desktopPath = getClaudeDesktopConfigPath(homeDir, 'darwin');
    writeJson(desktopPath, {
      mcpServers: {
        desktopServer: {
          command: 'uvx',
          args: ['mcp-server'],
        },
      },
    });

    const settings = createSettings();
    const result = importClaudeMcpServers({
      source: 'claude-desktop',
      scope: 'user',
      settings,
      homeDir,
      platform: 'darwin',
    });

    expect(result.scanned[0]?.path).toBe(desktopPath);
    expect(result.imported).toEqual([
      { name: 'desktopServer', source: 'Claude Desktop' },
    ]);
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'mcpServers',
      expect.objectContaining({
        desktopServer: { command: 'uvx', args: ['mcp-server'] },
      }),
    );
  });

  it('skips existing server names instead of overwriting them', () => {
    writeJson(path.join(homeDir, '.claude.json'), {
      mcpServers: {
        keep: { command: 'new' },
        fresh: { command: 'fresh' },
      },
    });

    const settings = createSettings({
      userMcpServers: {
        keep: { command: 'existing' },
      },
    });
    const result = importClaudeMcpServers({
      source: 'claude-code',
      scope: 'user',
      settings,
      homeDir,
    });

    expect(result.imported).toEqual([{ name: 'fresh', source: 'Claude Code' }]);
    expect(result.skipped).toEqual([
      { name: 'keep', source: 'Claude Code', reason: 'already-exists' },
    ]);
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'mcpServers',
      expect.objectContaining({
        keep: { command: 'existing' },
        fresh: { command: 'fresh' },
      }),
    );
  });

  it('skips server names that cannot be persisted safely', () => {
    fs.writeFileSync(
      path.join(homeDir, '.claude.json'),
      '{"mcpServers":{"__proto__":{"command":"node"}}}',
    );

    const settings = createSettings();
    const result = importClaudeMcpServers({
      source: 'claude-code',
      scope: 'user',
      settings,
      homeDir,
    });

    expect(settings.setValue).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([
      {
        name: '__proto__',
        source: 'Claude Code',
        reason: 'reserved-name',
      },
    ]);
  });

  it('skips names that already exist in the effective settings', () => {
    writeJson(path.join(projectDir, '.claude', 'settings.json'), {
      mcpServers: {
        keep: { command: 'new' },
        fresh: { command: 'fresh' },
      },
    });

    const settings = createSettings({
      userMcpServers: {
        keep: { command: 'existing-user' },
      },
    });
    const result = importClaudeMcpServers({
      source: 'claude-code',
      scope: 'project',
      settings,
      cwd: projectDir,
      homeDir,
    });

    expect(result.imported).toEqual([
      { name: 'fresh', source: 'Claude Code project settings' },
    ]);
    expect(result.skipped).toEqual([
      {
        name: 'keep',
        source: 'Claude Code project settings',
        reason: 'already-exists',
      },
    ]);
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'mcpServers',
      expect.objectContaining({
        fresh: { command: 'fresh' },
      }),
    );
  });

  it('writes to workspace settings when project scope is requested', () => {
    writeJson(path.join(projectDir, '.claude', 'settings.json'), {
      mcpServers: {
        local: { command: 'node' },
      },
    });

    const settings = createSettings();
    importClaudeMcpServers({
      source: 'claude-code',
      scope: 'project',
      settings,
      cwd: projectDir,
      homeDir,
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.Workspace,
      'mcpServers',
      expect.objectContaining({
        local: { command: 'node' },
      }),
    );
  });

  it('rejects project scope when workspace settings resolve to the user file', () => {
    writeJson(path.join(homeDir, '.claude.json'), {
      mcpServers: {
        local: { command: 'node' },
      },
    });

    expect(() =>
      importClaudeMcpServers({
        source: 'claude-code',
        scope: 'project',
        settings: createSettings({ inHome: true }),
        homeDir,
      }),
    ).toThrow('Please use --scope user');
  });

  it('reports malformed configs without writing settings', () => {
    fs.writeFileSync(path.join(homeDir, '.claude.json'), '{ nope');
    const settings = createSettings();

    const result = importClaudeMcpServers({
      source: 'claude-code',
      scope: 'user',
      settings,
      homeDir,
    });

    expect(result.errors[0]).toContain('Failed to parse');
    expect(result.imported).toEqual([]);
    expect(settings.setValue).not.toHaveBeenCalled();
  });

  it('reports unreadable config paths instead of treating them as absent', () => {
    fs.mkdirSync(path.join(homeDir, '.claude.json'));
    const settings = createSettings();

    const result = importClaudeMcpServers({
      source: 'claude-code',
      scope: 'user',
      settings,
      homeDir,
    });

    expect(result.errors[0]).toContain('Failed to read');
    expect(result.imported).toEqual([]);
    expect(settings.setValue).not.toHaveBeenCalled();
  });

  it('returns checked source paths when no Claude configs exist', () => {
    const sources = loadClaudeMcpSources({
      source: 'all',
      cwd: projectDir,
      homeDir,
      platform: 'darwin',
    });

    expect(sources.map((source) => source.found)).toEqual([
      false,
      false,
      false,
    ]);
    expect(sources.map((source) => source.path)).toEqual([
      path.join(homeDir, '.claude.json'),
      path.join(homeDir, '.claude', 'settings.json'),
      getClaudeDesktopConfigPath(homeDir, 'darwin'),
    ]);
  });
});
