/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_CONTEXT_FILENAME,
  ApprovalMode,
  DEFAULT_CONTEXT_FILENAME,
  getAllMemoryFilenames,
  setMemoryFilename,
  SettingScope,
  Storage,
} from '@qwen-code/qwen-code-core';
import { createProjectRuntimeReloader, parseArguments } from './config.js';
import type { CliArgs, ProjectRuntimeHostPolicy } from './config.js';
import {
  createMinimalSettings,
  loadSettings,
  resetHomeEnvBootstrapForTesting,
  type LoadedSettings,
} from './settings.js';
import { resetMcpApprovalsForTesting } from './mcpApprovals.js';
import { AppEvent, appEvents } from '../utils/events.js';

/**
 * Drives the real reloader against real settings files and `.env` files
 * on disk — every other layer mocks the layer below it, so this is the
 * only place the settings→runtime assembly and the commit/rollback
 * transaction are actually executed.
 */
describe('createProjectRuntimeReloader', () => {
  let tempDir: string;
  let projectA: string;
  let projectB: string;
  let previousQwenHome: string | undefined;
  let argv: CliArgs;
  const ENV_KEYS = [
    'A_KEY',
    'B_TOKEN',
    'QWEN_DISABLED_SLASH_COMMANDS',
    'WEB_SEARCH_API_KEY',
    'WEB_SEARCH_BASE_URL',
    'PROJECT_SETTING_VALUE',
  ];

  const writeProject = (
    dir: string,
    settings: Record<string, unknown>,
    env?: string,
  ) => {
    const settingsPath = new Storage(dir).getWorkspaceSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    if (env !== undefined) {
      fs.writeFileSync(path.join(path.dirname(settingsPath), '.env'), env);
    }
  };

  const writeUserSettings = (settings: Record<string, unknown>) => {
    const userPath = Storage.getGlobalSettingsPath();
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify(settings));
  };

  const startupSettings = (): LoadedSettings =>
    loadSettings(projectA, {
      consumeCorruptionEnvVars: false,
      workspaceTrusted: true,
    });

  const makeReloader = (
    loaded: LoadedSettings,
    overrides: {
      bareMode?: boolean;
      safeMode?: boolean;
      cliIncludeDirectories?: string[];
      modelDisablesToolSearch?: boolean;
      settingsWatcher?: { pauseWorkspaceWatching?: () => Promise<() => void> };
      hostPolicy?: ProjectRuntimeHostPolicy;
    } = {},
  ) =>
    createProjectRuntimeReloader(
      loaded,
      overrides.settingsWatcher,
      argv,
      undefined,
      overrides.bareMode ?? false,
      overrides.safeMode ?? false,
      overrides.cliIncludeDirectories ?? [],
      overrides.modelDisablesToolSearch ?? false,
      overrides.hostPolicy,
    );

  const readWorkspaceAllow = (dir: string): string[] | undefined =>
    (
      JSON.parse(
        fs.readFileSync(new Storage(dir).getWorkspaceSettingsPath(), 'utf8'),
      ) as { permissions?: { allow?: string[] } }
    ).permissions?.allow;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-runtime-reloader-'));
    const fakeHome = path.join(tempDir, 'os-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(tempDir, 'home');
    resetHomeEnvBootstrapForTesting();
    resetMcpApprovalsForTesting();
    projectA = path.join(tempDir, 'project-a');
    projectB = path.join(tempDir, 'project-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    for (const key of ENV_KEYS) delete process.env[key];
    setMemoryFilename([DEFAULT_CONTEXT_FILENAME, AGENT_CONTEXT_FILENAME]);
    process.argv = ['node', 'script.js'];
    argv = await parseArguments();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    setMemoryFilename([DEFAULT_CONTEXT_FILENAME, AGENT_CONTEXT_FILENAME]);
    if (previousQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = previousQwenHome;
    }
    resetHomeEnvBootstrapForTesting();
    resetMcpApprovalsForTesting();
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies the target project environment on commit and restores it on rollback', async () => {
    // The assembled MCP servers inherit `process.env` at spawn; without
    // this step project B's server started without `B_TOKEN` while A's
    // `A_KEY` was still leaking into B's subprocesses.
    writeProject(projectA, {}, 'A_KEY=from-a\n');
    writeProject(projectB, {}, 'B_TOKEN=from-b\n');
    const loaded = startupSettings();
    expect(process.env['A_KEY']).toBe('from-a');
    expect(process.env['B_TOKEN']).toBeUndefined();

    const prepared = await makeReloader(loaded).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );
    expect(process.env['B_TOKEN']).toBeUndefined();

    await prepared.commit();
    expect(process.env['B_TOKEN']).toBe('from-b');
    expect(process.env['A_KEY']).toBeUndefined();
    expect(prepared.warnings).toEqual([]);

    await prepared.rollback();
    expect(process.env['A_KEY']).toBe('from-a');
    expect(process.env['B_TOKEN']).toBeUndefined();
  });

  it('leaves the process environment alone when the host reports sibling sessions', async () => {
    // An ACP child under `qwen serve` hosts every session on its channel,
    // and spawned MCP servers / shell tools inherit `process.env`. A
    // per-session `/cd` that rewrote it handed a sibling session's
    // subprocesses this project's secrets while deleting its own.
    writeProject(projectA, {}, 'A_KEY=from-a\n');
    writeProject(projectB, {}, 'B_TOKEN=from-b\n');
    const loaded = startupSettings();
    expect(process.env['A_KEY']).toBe('from-a');

    const prepared = await makeReloader(loaded, {
      hostPolicy: { ownsProcessEnvironment: () => false },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    await prepared.commit();
    expect(process.env['A_KEY']).toBe('from-a');
    expect(process.env['B_TOKEN']).toBeUndefined();
    expect(loaded.workspace.path).toBe(
      new Storage(projectB).getWorkspaceSettingsPath(),
    );
    expect(prepared.warnings).toHaveLength(1);
    expect(prepared.warnings?.[0]).toMatch(/may host other sessions/);

    await prepared.rollback();
    expect(process.env['A_KEY']).toBe('from-a');
    expect(process.env['B_TOKEN']).toBeUndefined();
  });

  it('never applies the target environment from a bare session', async () => {
    // Bare startup never loads env; a bare `/cd` must not start. And the
    // rollback twin must not "restore" an environment that was never
    // replaced — that leaked the boot environment's keys away.
    writeProject(
      projectB,
      { experimental: { cron: false } },
      'B_TOKEN=from-b\n',
    );
    process.env['A_KEY'] = 'from-boot';

    const prepared = await makeReloader(createMinimalSettings(), {
      bareMode: true,
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    await prepared.commit();
    expect(process.env['B_TOKEN']).toBeUndefined();
    expect(process.env['A_KEY']).toBe('from-boot');
    expect(prepared.warnings).toEqual([]);

    await prepared.rollback();
    expect(process.env['B_TOKEN']).toBeUndefined();
    expect(process.env['A_KEY']).toBe('from-boot');
  });

  it('keeps environment-backed config aligned when the host declines the rewrite', async () => {
    writeProject(projectA, {}, 'QWEN_DISABLED_SLASH_COMMANDS=auth\n');
    writeProject(projectB, {}, 'QWEN_DISABLED_SLASH_COMMANDS=deploy\n');
    const loaded = startupSettings();
    expect(process.env['QWEN_DISABLED_SLASH_COMMANDS']).toBe('auth');

    const prepared = await makeReloader(loaded, {
      hostPolicy: { ownsProcessEnvironment: () => false },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    expect(prepared.config.disabledSlashCommands).toEqual(['auth']);
    expect(process.env['QWEN_DISABLED_SLASH_COMMANDS']).toBe('auth');
  });

  it('resolves target settings against the startup environment', async () => {
    writeProject(projectA, {}, 'PROJECT_SETTING_VALUE=from-project-a\n');
    writeProject(
      projectB,
      {
        advanced: {
          bugCommand: {
            urlTemplate: 'https://${PROJECT_SETTING_VALUE}.example/{title}',
          },
        },
      },
      'PROJECT_SETTING_VALUE=from-project-b\n',
    );
    const loaded = startupSettings();
    expect(process.env['PROJECT_SETTING_VALUE']).toBe('from-project-a');

    const prepared = await makeReloader(loaded).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    expect(prepared.config.bugCommand?.urlTemplate).toBe(
      'https://${PROJECT_SETTING_VALUE}.example/{title}',
    );
  });

  it('keeps web search aligned when the host declines the environment rewrite', async () => {
    writeProject(
      projectA,
      {},
      'WEB_SEARCH_BASE_URL=https://a.example/search\n',
    );
    writeProject(
      projectB,
      {},
      'WEB_SEARCH_BASE_URL=https://b.example/search\nWEB_SEARCH_API_KEY=key-b\n',
    );
    const prepared = await makeReloader(startupSettings(), {
      hostPolicy: { ownsProcessEnvironment: () => false },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    expect(prepared.config.webSearch).toMatchObject({
      baseUrl: 'https://a.example/search',
    });
    expect(prepared.config.webSearch?.apiKeyEnv).toBe('DASHSCOPE_API_KEY');
    expect(process.env['WEB_SEARCH_BASE_URL']).toBe('https://a.example/search');
  });

  it('refreshes environment-backed config after commit force-writes values', async () => {
    process.env['WEB_SEARCH_BASE_URL'] = 'https://operator.example/search';
    writeProject(projectA, {});
    writeProject(
      projectB,
      {},
      'WEB_SEARCH_BASE_URL=https://b.example/search\nWEB_SEARCH_API_KEY=key-b\n',
    );
    const prepared = await makeReloader(startupSettings()).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    expect(prepared.config.webSearch).toMatchObject({
      baseUrl: 'https://operator.example/search',
    });
    await prepared.commit();
    expect(prepared.config.webSearch).toMatchObject({
      baseUrl: 'https://b.example/search',
      apiKeyEnv: 'WEB_SEARCH_API_KEY',
    });
    expect(process.env['WEB_SEARCH_BASE_URL']).toBe('https://b.example/search');
    expect(process.env['WEB_SEARCH_API_KEY']).toBe('key-b');
  });

  it('refreshes environment-backed config after commit deletes stale keys', async () => {
    writeProject(projectA, {}, 'QWEN_DISABLED_SLASH_COMMANDS=auth\n');
    writeProject(projectB, {});
    const loaded = startupSettings();
    process.env['QWEN_DISABLED_SLASH_COMMANDS'] = 'operator-command';
    const prepared = await makeReloader(loaded).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    expect(prepared.config.disabledSlashCommands).toEqual(['operator-command']);
    await prepared.commit();
    expect(prepared.config.disabledSlashCommands).toEqual([]);
    expect(process.env['QWEN_DISABLED_SLASH_COMMANDS']).toBeUndefined();
  });

  it('keeps explicit MCP allow flags authoritative after relocation', async () => {
    argv.allowedMcpServerNames = ['fs'];
    writeProject(projectA, {});
    writeProject(projectB, {
      mcp: { allowed: ['db'], excluded: ['fs'] },
    });
    fs.writeFileSync(
      path.join(projectB, '.mcp.json'),
      JSON.stringify({
        mcpServers: { fs: { command: 'project-server' } },
      }),
    );

    const prepared = await makeReloader(startupSettings()).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    expect(prepared.config.allowedMcpServers).toEqual(['fs']);
    expect(prepared.config.excludedMcpServers).toBeUndefined();
    expect(prepared.config.pendingMcpServers).toEqual(['fs']);
  });

  it('keeps web search disabled after a safe-mode relocation commits', async () => {
    writeUserSettings({
      tools: { webSearch: { enabled: true, model: 'qwen3.6-plus' } },
    });
    writeProject(projectA, {});
    writeProject(projectB, {});

    const prepared = await makeReloader(startupSettings(), {
      safeMode: true,
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    expect(prepared.config.webSearch).toBeUndefined();
    await prepared.commit();
    expect(prepared.config.webSearch).toBeUndefined();
  });

  it('keeps provisional workspace context inputs disabled after relocation', async () => {
    const cliInclude = path.join(projectA, 'cli-include');
    writeProject(projectA, {});
    writeProject(projectB, {
      context: {
        includeDirectories: ['target-include'],
        loadFromIncludeDirectories: true,
      },
    });

    const prepared = await makeReloader(startupSettings(), {
      cliIncludeDirectories: [cliInclude],
      hostPolicy: { provisionalWorkspace: true },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    expect(prepared.config.includeDirectories).toEqual([]);
    expect(prepared.config.loadMemoryFromIncludeDirectories).toBe(false);
  });

  it('keeps a bare session trusted after relocation', async () => {
    const prepared = await makeReloader(createMinimalSettings(), {
      bareMode: true,
    }).prepare(projectB, undefined, ApprovalMode.DEFAULT, projectA);

    expect(prepared.config.trustedFolder).toBe(true);
  });

  it('persists read-only migrations when relocation commits', async () => {
    writeProject(projectA, {});
    writeProject(projectB, { theme: 'dark' });
    const settingsPath = new Storage(projectB).getWorkspaceSettingsPath();
    const loaded = startupSettings();
    const prepared = await makeReloader(loaded).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
    });
    await prepared.commit();
    loaded.setValue(SettingScope.Workspace, 'ui.theme', 'light');
    loaded.reloadScopeFromDisk(SettingScope.Workspace);

    expect(loaded.merged.ui?.theme).toBe('light');
    expect(
      JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
    ).not.toHaveProperty('theme');
  });

  it('tolerates a non-array skills.directories setting', async () => {
    writeProject(projectA, {});
    writeProject(projectB, { skills: { directories: 'all' } });

    const prepared = await makeReloader(startupSettings()).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    expect(prepared.config.customSkillDirs).toEqual([]);
  });

  it('keeps the process memory filename aligned across commit and rollback', async () => {
    writeProject(projectA, { context: { fileName: 'PROJECT_A.md' } });
    writeProject(projectB, { context: { fileName: 'PROJECT_B.md' } });
    const loaded = startupSettings();
    setMemoryFilename('PROJECT_A.md');

    const prepared = await makeReloader(loaded).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );
    await prepared.commit();
    expect(getAllMemoryFilenames()).toEqual(['PROJECT_B.md']);

    await prepared.rollback();
    expect(getAllMemoryFilenames()).toEqual(['PROJECT_A.md']);
  });

  it('carries system hooks into the relocated runtime', async () => {
    const previousSystemSettings =
      process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
    const systemSettingsPath = path.join(tempDir, 'system-settings.json');
    const systemHooks = {
      PreToolUse: [
        {
          matcher: 'run_shell_command',
          hooks: [{ type: 'command', command: 'echo system-hook' }],
        },
      ],
    };
    process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = systemSettingsPath;
    fs.writeFileSync(
      systemSettingsPath,
      JSON.stringify({ hooks: systemHooks }),
    );
    try {
      writeProject(projectA, {});
      writeProject(projectB, {});

      const prepared = await makeReloader(startupSettings()).prepare(
        projectB,
        true,
        ApprovalMode.DEFAULT,
        projectA,
      );

      expect(prepared.config.userHooks).toEqual(systemHooks);
    } finally {
      if (previousSystemSettings === undefined) {
        delete process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
      } else {
        process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = previousSystemSettings;
      }
    }
  });

  it('keeps a bare session on minimal settings instead of loading the user files', async () => {
    // Bare startup never reads `~/.qwen/settings.json`; a `/cd` that did
    // would make ambient command hooks (bugCommand, artifact upload) live
    // mid-session and point later settings writes at the real files.
    writeUserSettings({
      experimental: { cron: false },
      advanced: { bugCommand: { urlTemplate: 'https://bugs.example/{title}' } },
    });
    writeProject(projectB, { experimental: { cron: false } });
    const loaded = createMinimalSettings();

    const prepared = await makeReloader(loaded, { bareMode: true }).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    expect(prepared.config.cronEnabled).toBe(true);
    expect(prepared.config.bugCommand).toBeUndefined();
    await prepared.commit();
    expect(loaded.user.path).toBe('');
    expect(loaded.workspace.path).toBe('');
  });

  it('replicates the startup tool_search denial', async () => {
    writeProject(projectA, {});
    const denyOf = async (
      settings: Record<string, unknown>,
      modelDisablesToolSearch: boolean,
    ) => {
      writeProject(projectB, settings);
      const prepared = await makeReloader(startupSettings(), {
        modelDisablesToolSearch,
      }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);
      return {
        deny: prepared.config.permissions?.deny ?? [],
        exclude: prepared.config.excludeTools ?? [],
      };
    };

    // Explicitly disabled in the target's settings.
    const explicit = await denyOf(
      { tools: { toolSearch: { enabled: false } } },
      false,
    );
    expect(explicit.deny).toContain('tool_search');
    expect(explicit.exclude).toContain('tool_search');

    // Disabled by the session model, nothing in settings.
    const byModel = await denyOf({}, true);
    expect(byModel.deny).toContain('tool_search');

    // An explicit enable wins over the model-derived default, as at startup.
    const enabled = await denyOf(
      { tools: { toolSearch: { enabled: true } } },
      true,
    );
    expect(enabled.deny).not.toContain('tool_search');
  });

  it('projects agents settings the same way startup does', async () => {
    // Startup and `/cd` share one projection: every schema-declared key
    // the runtime reads through `getAgentsSettings()` (arena limits)
    // survives; `team` is a schema-reserved opaque object and the keys read
    // from `settings.merged` elsewhere are dropped.
    writeProject(projectA, {});
    writeProject(projectB, {
      agents: {
        allowedGrades: ['fast'],
        team: { maxTeammates: 7 },
        arena: { maxRoundsPerAgent: 3, timeoutSeconds: 120 },
        crossSessionMessaging: true,
      },
      worktree: { symlinkDirectories: ['node_modules'] },
    });

    const prepared = await makeReloader(startupSettings()).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    expect(prepared.config.agents?.allowedGrades).toEqual(['fast']);
    expect('team' in (prepared.config.agents ?? {})).toBe(false);
    expect(prepared.config.agents?.arena).toMatchObject({
      maxRoundsPerAgent: 3,
      timeoutSeconds: 120,
    });
    expect('crossSessionMessaging' in (prepared.config.agents ?? {})).toBe(
      false,
    );
    expect(prepared.config.worktree?.symlinkDirectories).toEqual([
      'node_modules',
    ]);
  });

  it('ignores a doubled commit and a rollback or complete before commit', async () => {
    // A second commit() must not re-pause the watcher (losing the first
    // resume handle) or re-run the settings swap (a later rollback would
    // then restore the TARGET project's settings).
    writeProject(projectA, { disableAllHooks: true });
    writeProject(projectB, { disableAllHooks: false });
    const loaded = startupSettings();
    const workspacePathA = loaded.workspace.path;
    const resume = vi.fn();
    const pauseWorkspaceWatching = vi.fn().mockResolvedValue(resume);
    const replaceWith = vi.spyOn(loaded, 'replaceWith');

    const prepared = await makeReloader(loaded, {
      settingsWatcher: { pauseWorkspaceWatching },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    await prepared.rollback();
    await prepared.complete();
    expect(replaceWith).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();

    await prepared.commit();
    await prepared.commit();
    expect(pauseWorkspaceWatching).toHaveBeenCalledOnce();
    expect(replaceWith).toHaveBeenCalledOnce();

    await prepared.rollback();
    expect(loaded.workspace.path).toBe(workspacePathA);
    expect(loaded.merged.disableAllHooks).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('preserves user agent settings when reloading in safe mode', async () => {
    writeUserSettings({
      agents: { allowedGrades: ['fast'], maxParallelAgents: 2 },
    });
    writeProject(projectA, {});
    writeProject(projectB, {});

    const prepared = await makeReloader(startupSettings(), {
      safeMode: true,
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    expect(prepared.config.agents).toMatchObject({
      allowedGrades: ['fast'],
      maxParallelAgents: 2,
    });
  });

  it('swaps the loaded settings on commit, restores them on rollback, and resumes the watcher', async () => {
    writeProject(projectA, { disableAllHooks: true });
    writeProject(projectB, { disableAllHooks: false });
    const loaded = startupSettings();
    const workspacePathA = loaded.workspace.path;
    const resume = vi.fn();
    const pauseWorkspaceWatching = vi.fn().mockResolvedValue(resume);
    const emit = vi.spyOn(appEvents, 'emit');

    const prepared = await makeReloader(loaded, {
      settingsWatcher: { pauseWorkspaceWatching },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);
    expect(prepared.config.disableAllHooks).toBe(false);
    expect(loaded.merged.disableAllHooks).toBe(true);

    await prepared.commit();
    expect(pauseWorkspaceWatching).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    expect(loaded.workspace.path).toBe(
      new Storage(projectB).getWorkspaceSettingsPath(),
    );
    expect(loaded.merged.disableAllHooks).toBe(false);

    await prepared.rollback();
    expect(loaded.workspace.path).toBe(workspacePathA);
    expect(loaded.merged.disableAllHooks).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(AppEvent.McpPendingApprovalChanged);
  });

  it('resumes the watcher exactly once when the switch completes', async () => {
    writeProject(projectA, {});
    writeProject(projectB, {});
    const loaded = startupSettings();
    const resume = vi.fn();
    const emit = vi.spyOn(appEvents, 'emit');
    const prepared = await makeReloader(loaded, {
      settingsWatcher: { pauseWorkspaceWatching: async () => resume },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    await prepared.commit();
    expect(resume).not.toHaveBeenCalled();
    await prepared.complete();
    await prepared.complete();
    expect(resume).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(AppEvent.McpPendingApprovalChanged);
    expect(loaded.workspace.path).toBe(
      new Storage(projectB).getWorkspaceSettingsPath(),
    );
  });

  it('keeps the host cron policy authoritative over the target project setting', async () => {
    // A channel session runs with cron disabled for its whole life; the
    // target project's `experimental.cron: true` must not re-enable it.
    writeProject(projectA, {});
    writeProject(projectB, { experimental: { cron: true } });

    const prepared = await makeReloader(startupSettings(), {
      hostPolicy: { cronEnabled: false },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    expect(prepared.config.cronEnabled).toBe(false);
  });

  it('persists "Always allow" against the target project file in safe mode', async () => {
    // `--safe-mode` loads the target with `skipWorkspaceSettings`, so the
    // in-memory workspace scope is EMPTY while the file on disk is not. A
    // read-modify-write against memory wrote `[newRule]` over the
    // project's existing allow rules — data loss for every later session.
    writeProject(projectA, {});
    writeProject(projectB, { permissions: { allow: ['rule-A', 'rule-B'] } });
    const loaded = startupSettings();
    const prepared = await makeReloader(loaded, { safeMode: true }).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );

    await prepared.commit();
    expect(loaded.workspace.settings.permissions?.allow).toBeUndefined();
    await prepared.config.onPersistPermissionRule?.(
      'project',
      'allow',
      'run_shell_command(ls *)',
    );

    expect(readWorkspaceAllow(projectB)).toEqual([
      'rule-A',
      'rule-B',
      'run_shell_command(ls *)',
    ]);
    expect(readWorkspaceAllow(projectA)).toBeUndefined();
  });

  it('reads the target project file fresh on every persist', async () => {
    // Two sessions in one project: a rule the sibling persisted since the
    // settings watcher last refreshed must survive this session's write.
    writeProject(projectA, {});
    writeProject(projectB, { permissions: { allow: ['rule-A'] } });
    const loaded = startupSettings();
    const prepared = await makeReloader(loaded).prepare(
      projectB,
      true,
      ApprovalMode.DEFAULT,
      projectA,
    );
    await prepared.commit();
    expect(loaded.workspace.settings.permissions?.allow).toEqual(['rule-A']);

    // The sibling session writes behind this session's back.
    writeProject(projectB, {
      permissions: { allow: ['rule-A', 'rule-from-sibling'] },
    });
    await prepared.config.onPersistPermissionRule?.(
      'project',
      'allow',
      'run_shell_command(ls *)',
    );

    expect(readWorkspaceAllow(projectB)).toEqual([
      'rule-A',
      'rule-from-sibling',
      'run_shell_command(ls *)',
    ]);
  });

  it('persists bare-mode permission rules in the relocation target', async () => {
    writeProject(projectA, {});
    writeProject(projectB, {});
    const prepared = await makeReloader(createMinimalSettings(), {
      bareMode: true,
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    await prepared.commit();
    await prepared.config.onPersistPermissionRule?.(
      'project',
      'allow',
      'run_shell_command(ls *)',
    );

    const settingsA = loadSettings(projectA, {
      consumeCorruptionEnvVars: false,
      workspaceTrusted: true,
    });
    const settingsB = loadSettings(projectB, {
      consumeCorruptionEnvVars: false,
      workspaceTrusted: true,
    });
    expect(settingsA.workspace.settings.permissions?.allow).toBeUndefined();
    expect(settingsB.workspace.settings.permissions?.allow).toEqual([
      'run_shell_command(ls *)',
    ]);
  });

  it('resumes the watcher when the settings swap itself throws', async () => {
    // Otherwise a one-off `replaceWith` failure leaves the workspace
    // watcher stopped for the rest of the session.
    writeProject(projectA, {});
    writeProject(projectB, {});
    const loaded = startupSettings();
    const resume = vi.fn();
    vi.spyOn(loaded, 'replaceWith').mockImplementationOnce(() => {
      throw new Error('swap failed');
    });

    const prepared = await makeReloader(loaded, {
      settingsWatcher: { pauseWorkspaceWatching: async () => resume },
    }).prepare(projectB, true, ApprovalMode.DEFAULT, projectA);

    await expect(prepared.commit()).rejects.toThrow('swap failed');
    expect(resume).toHaveBeenCalledOnce();
  });
});
