/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock @qwen-code/qwen-code-core to avoid the undici dependency chain.
// This is required so @qwen-code/acp-bridge/status can load (it imports
// SkillError from core).
vi.mock('@qwen-code/qwen-code-core', () => {
  class SkillError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'SkillError';
      this.code = code;
    }
  }
  class FatalConfigError extends Error {}
  const noopLogger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  class Storage {
    constructor(private readonly workspace: string) {}

    static getGlobalQwenDir() {
      return process.env['QWEN_HOME'] ?? '/tmp/.qwen';
    }

    static getGlobalSettingsPath() {
      return `${Storage.getGlobalQwenDir()}/settings.json`;
    }

    getWorkspaceSettingsPath() {
      return `${this.workspace}/.qwen/settings.json`;
    }
  }

  class ModelsConfig {
    getAllConfiguredModels() {
      return [];
    }
  }

  return {
    SkillError,
    FatalConfigError,
    ApprovalMode: {
      DEFAULT: 'default',
      AUTO_EDIT: 'autoEdit',
      YOLO: 'yolo',
    },
    DEFAULT_STOP_HOOK_BLOCK_CAP: 5,
    DEFAULT_TOOL_OUTPUT_BATCH_BUDGET: 100_000,
    DEFAULT_TOOL_RESULTS_TOTAL_CHARS_THRESHOLD: 100_000,
    DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES: 2000,
    DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD: 100_000,
    DEFAULT_QWEN_CUSTOM_IGNORE_FILE_NAMES: ['.agentignore', '.aiignore'],
    QWEN_DIR: '.qwen',
    Storage,
    ModelsConfig,
    atomicWriteFileSync: vi.fn(),
    createDebugLogger: () => noopLogger,
    getErrorMessage: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
    ideContextStore: {
      get: () => undefined,
    },
    isWithinRoot: (location: string, root: string) =>
      location === root || location.startsWith(`${root}/`),
    stripRuntimeSnapshotPrefix: (value: string) => value,
  };
});

const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
}));

const { createDaemonWorkspaceService } = await import('../index.js');
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import {
  resetHomeEnvBootstrapForTesting,
  SettingScope,
  SETTINGS_DIRECTORY_NAME,
} from '../../../config/settings.js';
import {
  resetTrustedFoldersForTesting,
  TRUSTED_FOLDERS_FILENAME,
  TrustLevel,
} from '../../../config/trustedFolders.js';
import { WorkspaceVoiceError } from '../../../services/voice-service.js';
import type {
  DaemonWorkspaceServiceDeps,
  WorkspaceRequestContext,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(
  overrides: Partial<DaemonWorkspaceServiceDeps> = {},
): DaemonWorkspaceServiceDeps {
  return {
    boundWorkspace: '/workspace',
    contextFilename: 'QWEN.md',
    persistDisabledTools: vi.fn().mockResolvedValue(undefined),
    queryWorkspaceStatus: vi
      .fn()
      .mockImplementation((_method: string, idle: () => unknown) =>
        Promise.resolve(idle()),
      ),
    invokeWorkspaceCommand: vi.fn().mockResolvedValue({
      serverName: 'test',
      restarted: true,
      durationMs: 42,
    }),
    publishWorkspaceEvent: vi.fn(),
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<WorkspaceRequestContext> = {},
): WorkspaceRequestContext {
  return {
    route: 'TEST /test',
    workspaceCwd: '/workspace',
    originatorClientId: 'client-1',
    ...overrides,
  };
}

async function withIsolatedQwenHome<T>(fn: () => Promise<T>): Promise<T> {
  return withIsolatedWorkspace(() => fn());
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function withIsolatedWorkspace<T>(
  fn: (paths: { home: string; workspace: string }) => Promise<T>,
): Promise<T> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'facade-ws-'));
  const home = path.join(scratch, 'home');
  const workspace = path.join(scratch, 'workspace');
  const originalQwenHome = process.env['QWEN_HOME'];
  const originalTrustedFoldersPath =
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  process.env['QWEN_HOME'] = home;
  process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = path.join(
    home,
    TRUSTED_FOLDERS_FILENAME,
  );
  resetHomeEnvBootstrapForTesting();
  resetTrustedFoldersForTesting();
  try {
    return await fn({ home, workspace });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    if (originalTrustedFoldersPath === undefined) {
      delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    } else {
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] =
        originalTrustedFoldersPath;
    }
    resetHomeEnvBootstrapForTesting();
    resetTrustedFoldersForTesting();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDaemonWorkspaceService', () => {
  beforeEach(() => {
    mockWriteStderrLine.mockClear();
  });

  describe('workspace voice', () => {
    it('reports missing voice settings persistence as a structured voice error', async () => {
      const svc = createDaemonWorkspaceService(makeDeps());

      let caught: unknown;
      try {
        await svc.setWorkspaceVoiceSettings(makeCtx(), { enabled: false });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(WorkspaceVoiceError);
      expect(caught).toMatchObject({
        name: 'WorkspaceVoiceError',
        status: 501,
        code: 'not_implemented',
      });
    });

    it('persists voice settings through batch persistence and publishes events', async () => {
      await withIsolatedQwenHome(async () => {
        const persistSettings = vi.fn(async () => {});
        const publishWorkspaceEvent = vi.fn();
        const svc = createDaemonWorkspaceService(
          makeDeps({ persistSettings, publishWorkspaceEvent }),
        );

        const result = await svc.setWorkspaceVoiceSettings(
          makeCtx({ originatorClientId: 'voice-client' }),
          { enabled: false, mode: 'tap', language: 'english' },
        );

        expect(persistSettings).toHaveBeenCalledWith('/workspace', [
          {
            scope: SettingScope.User,
            key: 'general.voice.mode',
            value: 'tap',
          },
          {
            scope: SettingScope.User,
            key: 'general.voice.language',
            value: 'english',
          },
          {
            scope: SettingScope.User,
            key: 'general.voice.enabled',
            value: false,
          },
        ]);
        expect(publishWorkspaceEvent).toHaveBeenCalledTimes(3);
        expect(publishWorkspaceEvent).toHaveBeenCalledWith({
          type: 'settings_changed',
          data: {
            key: 'general.voice.enabled',
            value: false,
            scope: 'user',
          },
          originatorClientId: 'voice-client',
        });
        expect(result.v).toBe(1);
      });
    });

    it('rejects invalid voice settings before persisting', async () => {
      await withIsolatedQwenHome(async () => {
        const persistSettings = vi.fn(async () => {});
        const publishWorkspaceEvent = vi.fn();
        const svc = createDaemonWorkspaceService(
          makeDeps({ persistSettings, publishWorkspaceEvent }),
        );

        await expect(
          svc.setWorkspaceVoiceSettings(makeCtx(), {
            voiceModel: 'not-configured',
          }),
        ).rejects.toMatchObject({ code: 'unknown_voice_model' });
        await expect(
          svc.setWorkspaceVoiceSettings(makeCtx(), {}),
        ).rejects.toMatchObject({ code: 'invalid_voice_update' });

        expect(persistSettings).not.toHaveBeenCalled();
        expect(publishWorkspaceEvent).not.toHaveBeenCalled();
      });
    });

    it('does not publish fallback voice writes when a later write fails', async () => {
      await withIsolatedQwenHome(async () => {
        const persistSetting = vi.fn(
          async (
            _workspace: string,
            _scope: SettingScope,
            key: string,
            _value: unknown,
          ) => {
            if (key === 'general.voice.language') {
              throw new Error('disk full');
            }
          },
        );
        const publishWorkspaceEvent = vi.fn();
        const svc = createDaemonWorkspaceService(
          makeDeps({ persistSetting, publishWorkspaceEvent }),
        );

        await expect(
          svc.setWorkspaceVoiceSettings(
            makeCtx({ originatorClientId: 'voice-client' }),
            { mode: 'tap', language: 'english' },
          ),
        ).rejects.toThrow('disk full');

        expect(publishWorkspaceEvent).not.toHaveBeenCalled();
        expect(mockWriteStderrLine).toHaveBeenCalledWith(
          expect.stringContaining('partial persist error'),
        );
      });
    });
  });

  describe('workspace permissions', () => {
    it('sets permission rules through the ACP command when a session is live', async () => {
      const acpResult = {
        v: 1,
        user: {
          path: '/user/settings.json',
          rules: { allow: [], ask: [], deny: [] },
        },
        workspace: {
          path: '/workspace/.qwen/settings.json',
          rules: { allow: ['Shell(*)'], ask: [], deny: [] },
        },
        merged: { allow: ['Shell(*)'], ask: [], deny: [] },
        isTrusted: true,
      };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(acpResult);
      const publishWorkspaceEvent = vi.fn();
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand, publishWorkspaceEvent }),
      );

      const result = await svc.setWorkspacePermissionRules(
        makeCtx({ originatorClientId: 'perm-client' }),
        { scope: 'workspace', ruleType: 'allow', rules: ['Shell(*)'] },
      );

      expect(invokeWorkspaceCommand).toHaveBeenCalledWith(
        'qwen/permissions/setRules',
        { scope: 'workspace', ruleType: 'allow', rules: ['Shell(*)'] },
      );
      expect(publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'settings_changed',
        data: {
          key: 'permissions.allow',
          value: ['Shell(*)'],
          scope: 'workspace',
        },
        originatorClientId: 'perm-client',
      });
      expect(result).toBe(acpResult);
    });

    it('rejects permission updates when ACP has no live session', async () => {
      await withIsolatedQwenHome(async () => {
        const invokeWorkspaceCommand = vi
          .fn()
          .mockRejectedValue(new SessionNotFoundError('session-1'));
        const persistSetting = vi.fn(async () => {});
        const publishWorkspaceEvent = vi.fn();
        const svc = createDaemonWorkspaceService(
          makeDeps({
            invokeWorkspaceCommand,
            persistSetting,
            publishWorkspaceEvent,
          }),
        );

        await expect(
          svc.setWorkspacePermissionRules(
            makeCtx({ originatorClientId: 'perm-client' }),
            { scope: 'user', ruleType: 'deny', rules: ['Shell(rm -rf *)'] },
          ),
        ).rejects.toThrow('live ACP session');

        expect(persistSetting).not.toHaveBeenCalled();
        expect(publishWorkspaceEvent).not.toHaveBeenCalled();
      });
    });

    it('rethrows non-session permission command errors without fallback persistence', async () => {
      const invokeWorkspaceCommand = vi
        .fn()
        .mockRejectedValue(new Error('bridge failed'));
      const persistSetting = vi.fn(async () => {});
      const publishWorkspaceEvent = vi.fn();
      const svc = createDaemonWorkspaceService(
        makeDeps({
          invokeWorkspaceCommand,
          persistSetting,
          publishWorkspaceEvent,
        }),
      );

      await expect(
        svc.setWorkspacePermissionRules(makeCtx(), {
          scope: 'workspace',
          ruleType: 'allow',
          rules: ['Shell(*)'],
        }),
      ).rejects.toThrow('bridge failed');

      expect(persistSetting).not.toHaveBeenCalled();
      expect(publishWorkspaceEvent).not.toHaveBeenCalled();
    });
  });

  describe('status methods', () => {
    it('getWorkspaceTrustStatus reads current settings and trusted folders', async () => {
      await withIsolatedWorkspace(async ({ home, workspace }) => {
        await writeJson(path.join(home, 'settings.json'), {
          security: { folderTrust: { enabled: true } },
        });
        await writeJson(path.join(home, TRUSTED_FOLDERS_FILENAME), {
          [workspace]: TrustLevel.TRUST_FOLDER,
        });
        const svc = createDaemonWorkspaceService(
          makeDeps({ boundWorkspace: workspace }),
        );

        const result = await svc.getWorkspaceTrustStatus(makeCtx());

        expect(result).toMatchObject({
          v: 1,
          workspaceCwd: workspace,
          folderTrustEnabled: true,
          effective: { state: 'trusted', source: 'file' },
          explicitTrustLevel: TrustLevel.TRUST_FOLDER,
        });
      });
    });

    it('getWorkspacePermissionsStatus reads scoped and merged settings', async () => {
      await withIsolatedWorkspace(async ({ home, workspace }) => {
        await writeJson(path.join(home, 'settings.json'), {
          permissions: {
            allow: ['Shell(git *)'],
            deny: ['Read(.env)'],
          },
        });
        await writeJson(
          path.join(workspace, SETTINGS_DIRECTORY_NAME, 'settings.json'),
          {
            permissions: {
              allow: ['Read(src/**)'],
              ask: ['Shell(npm *)'],
            },
          },
        );
        const svc = createDaemonWorkspaceService(
          makeDeps({ boundWorkspace: workspace }),
        );

        const result = await svc.getWorkspacePermissionsStatus(makeCtx());

        expect(result).toMatchObject({
          v: 1,
          user: {
            path: path.join(home, 'settings.json'),
            rules: {
              allow: ['Shell(git *)'],
              ask: [],
              deny: ['Read(.env)'],
            },
          },
          workspace: {
            path: path.join(
              workspace,
              SETTINGS_DIRECTORY_NAME,
              'settings.json',
            ),
            rules: {
              allow: ['Read(src/**)'],
              ask: ['Shell(npm *)'],
              deny: [],
            },
          },
          merged: {
            allow: ['Shell(git *)', 'Read(src/**)'],
            ask: ['Shell(npm *)'],
            deny: ['Read(.env)'],
          },
        });
      });
    });

    it('getWorkspaceVoiceStatus reads daemon-local voice settings', async () => {
      await withIsolatedWorkspace(async ({ home, workspace }) => {
        await writeJson(path.join(home, 'settings.json'), {
          voiceModel: 'qwen3-asr-flash',
          general: {
            voice: {
              enabled: true,
              mode: 'tap',
              language: 'english',
            },
          },
        });
        const svc = createDaemonWorkspaceService(
          makeDeps({ boundWorkspace: workspace }),
        );

        const result = await svc.getWorkspaceVoiceStatus(makeCtx());

        expect(result).toMatchObject({
          v: 1,
          workspaceCwd: workspace,
          enabled: true,
          mode: 'tap',
          language: 'english',
          voiceModel: 'qwen3-asr-flash',
          availableVoiceModels: [],
        });
      });
    });

    it('getWorkspaceMcpStatus delegates to queryWorkspaceStatus with correct method', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockResolvedValue({ v: 1, servers: [] });
      const svc = createDaemonWorkspaceService(
        makeDeps({ queryWorkspaceStatus }),
      );

      await svc.getWorkspaceMcpStatus(makeCtx());

      expect(queryWorkspaceStatus).toHaveBeenCalledWith(
        'qwen/status/workspace/mcp',
        expect.any(Function),
      );
    });

    it('getWorkspaceMcpStatus idle fallback returns correct envelope', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockImplementation((_m: string, idle: () => unknown) =>
          Promise.resolve(idle()),
        );
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          boundWorkspace: '/my/ws',
        }),
      );

      const result = await svc.getWorkspaceMcpStatus(makeCtx());

      expect(result.workspaceCwd).toBe('/my/ws');
      expect(result.initialized).toBe(false);
      expect(result.servers).toEqual([]);
    });

    it('getWorkspaceSkillsStatus delegates with correct method', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockResolvedValue({ v: 1, skills: [] });
      const svc = createDaemonWorkspaceService(
        makeDeps({ queryWorkspaceStatus }),
      );

      await svc.getWorkspaceSkillsStatus(makeCtx());

      expect(queryWorkspaceStatus).toHaveBeenCalledWith(
        'qwen/status/workspace/skills',
        expect.any(Function),
      );
    });

    it('getWorkspaceSkillsStatus idle fallback returns correct envelope', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockImplementation((_m: string, idle: () => unknown) =>
          Promise.resolve(idle()),
        );
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          boundWorkspace: '/ws',
        }),
      );

      const result = await svc.getWorkspaceSkillsStatus(makeCtx());

      expect(result.workspaceCwd).toBe('/ws');
      expect(result.initialized).toBe(false);
      expect(result.skills).toEqual([]);
    });

    it('getWorkspaceProvidersStatus uses daemon-local provider when present', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockResolvedValue({ v: 1, providers: [] });
      const workspaceProvidersStatusProvider = vi.fn().mockResolvedValue({
        v: 1,
        workspaceCwd: '/workspace',
        initialized: true,
        acpChannelLive: false,
        current: {
          authType: 'USE_OPENAI',
          modelId: 'fresh-model(USE_OPENAI)',
        },
        providers: [],
      });
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          workspaceProvidersStatusProvider,
          isChannelLive: () => false,
        }),
      );

      const result = await svc.getWorkspaceProvidersStatus(makeCtx());

      expect(result.current?.modelId).toBe('fresh-model(USE_OPENAI)');
      expect(result.acpChannelLive).toBe(false);
      expect(workspaceProvidersStatusProvider).toHaveBeenCalledWith(
        '/workspace',
        false,
      );
      expect(queryWorkspaceStatus).not.toHaveBeenCalled();
    });

    it('getWorkspaceProvidersStatus keeps ACP fallback without daemon-local provider', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockResolvedValue({ v: 1, providers: [] });
      const svc = createDaemonWorkspaceService(
        makeDeps({ queryWorkspaceStatus }),
      );

      await svc.getWorkspaceProvidersStatus(makeCtx());

      expect(queryWorkspaceStatus).toHaveBeenCalledWith(
        'qwen/status/workspace/providers',
        expect.any(Function),
      );
    });

    it('getWorkspaceEnvStatus uses statusProvider instead of queryWorkspaceStatus', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockResolvedValue({ v: 1, cells: [] });
      const statusProvider: DaemonWorkspaceServiceDeps['statusProvider'] = {
        getEnvStatus: vi.fn().mockResolvedValue({
          v: 1,
          workspaceCwd: '/workspace',
          initialized: true,
          acpChannelLive: false,
          cells: [
            { kind: 'runtime', name: 'node', status: 'ok', present: true },
          ],
        }),
        getDaemonPreflightCells: vi.fn().mockResolvedValue([]),
      };
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          statusProvider,
        }),
      );

      const result = await svc.getWorkspaceEnvStatus(makeCtx());

      // Env status is daemon-local — queryWorkspaceStatus must NOT be called.
      expect(queryWorkspaceStatus).not.toHaveBeenCalled();
      expect(statusProvider.getEnvStatus).toHaveBeenCalledWith(
        '/workspace',
        false,
      );
      expect(result.initialized).toBe(true);
    });

    it('getWorkspaceEnvStatus fallback has acpChannelLive=false when no statusProvider', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockImplementation((_m: string, idle: () => unknown) =>
          Promise.resolve(idle()),
        );
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          statusProvider: undefined,
        }),
      );

      const result = await svc.getWorkspaceEnvStatus(makeCtx());

      expect(result.acpChannelLive).toBe(false);
      expect(result.initialized).toBe(true);
    });

    it('getWorkspacePreflightStatus queries ACP only when channel is live', async () => {
      const queryWorkspaceStatus = vi.fn().mockResolvedValue({
        cells: [{ kind: 'auth', status: 'ok', locality: 'acp' }],
      });
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          isChannelLive: () => true,
        }),
      );

      await svc.getWorkspacePreflightStatus(makeCtx());

      expect(queryWorkspaceStatus).toHaveBeenCalledWith(
        'qwen/status/workspace/preflight',
        expect.any(Function),
      );
    });

    it('getWorkspaceEnvStatus falls back to idle envelope when statusProvider throws', async () => {
      const statusProvider: DaemonWorkspaceServiceDeps['statusProvider'] = {
        getEnvStatus: vi.fn().mockRejectedValue(new Error('provider boom')),
        getDaemonPreflightCells: vi.fn().mockResolvedValue([]),
      };
      const svc = createDaemonWorkspaceService(
        makeDeps({
          statusProvider,
          boundWorkspace: '/ws',
          isChannelLive: () => true,
        }),
      );

      const result = await svc.getWorkspaceEnvStatus(makeCtx());

      expect(result.workspaceCwd).toBe('/ws');
      expect(result.acpChannelLive).toBe(true);
      expect(result.initialized).toBe(true);
    });

    it('getWorkspacePreflightStatus falls back to empty daemon cells when getDaemonPreflightCells throws', async () => {
      const statusProvider: DaemonWorkspaceServiceDeps['statusProvider'] = {
        getEnvStatus: vi.fn().mockResolvedValue({ v: 1, cells: [] }),
        getDaemonPreflightCells: vi
          .fn()
          .mockRejectedValue(new Error('daemon cells boom')),
      };
      const svc = createDaemonWorkspaceService(
        makeDeps({
          statusProvider,
          boundWorkspace: '/ws',
          isChannelLive: () => false,
        }),
      );

      const result = await svc.getWorkspacePreflightStatus(makeCtx());

      // Daemon cells failed → no daemon-locality cells in the result.
      const daemonCells = result.cells.filter((c) => c.locality === 'daemon');
      expect(daemonCells).toHaveLength(0);
      // ACP idle cells should still be present (channel is not live).
      expect(result.cells.length).toBeGreaterThan(0);
    });

    it('getWorkspacePreflightStatus builds error entry when ACP query throws', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockRejectedValue(new Error('acp channel down'));
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          isChannelLive: () => true,
        }),
      );

      const result = await svc.getWorkspacePreflightStatus(makeCtx());

      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(result.errors![0]!.kind).toBe('preflight');
      expect(result.errors![0]!.status).toBe('error');
      expect(result.errors![0]!.error).toContain('acp channel down');
    });

    it('getWorkspacePreflightStatus idle fallback includes ACP placeholder cells', async () => {
      const queryWorkspaceStatus = vi
        .fn()
        .mockImplementation((_m: string, idle: () => unknown) =>
          Promise.resolve(idle()),
        );
      const svc = createDaemonWorkspaceService(
        makeDeps({
          queryWorkspaceStatus,
          isChannelLive: () => false,
        }),
      );

      const result = await svc.getWorkspacePreflightStatus(makeCtx());

      expect(result.acpChannelLive).toBe(false);
      // When no statusProvider is given, daemon cells are empty; only ACP idle cells.
      const acpCells = result.cells.filter((c) => c.locality === 'acp');
      expect(acpCells.length).toBe(6);
      expect(acpCells.every((c) => c.status === 'not_started')).toBe(true);
      // queryWorkspaceStatus should NOT be called when channel is not live.
      expect(queryWorkspaceStatus).not.toHaveBeenCalled();
    });
  });

  describe('setWorkspaceToolEnabled', () => {
    it('calls persistDisabledTools with workspace, toolName, and enabled', async () => {
      const persistDisabledTools = vi.fn().mockResolvedValue(undefined);
      const svc = createDaemonWorkspaceService(
        makeDeps({
          persistDisabledTools,
          boundWorkspace: '/my/workspace',
        }),
      );

      await svc.setWorkspaceToolEnabled(makeCtx(), 'Bash', false);

      expect(persistDisabledTools).toHaveBeenCalledWith(
        '/my/workspace',
        'Bash',
        false,
      );
    });

    it('publishes tool_toggled event with originatorClientId', async () => {
      const publishWorkspaceEvent = vi.fn();
      const svc = createDaemonWorkspaceService(
        makeDeps({ publishWorkspaceEvent }),
      );

      await svc.setWorkspaceToolEnabled(
        makeCtx({ originatorClientId: 'c-42' }),
        'Read',
        true,
      );

      expect(publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'tool_toggled',
        data: { toolName: 'Read', enabled: true },
        originatorClientId: 'c-42',
      });
    });

    it('returns the toolName and enabled state', async () => {
      const svc = createDaemonWorkspaceService(makeDeps());

      const result = await svc.setWorkspaceToolEnabled(
        makeCtx(),
        'WebSearch',
        false,
      );

      expect(result).toEqual({ toolName: 'WebSearch', enabled: false });
    });

    it('does not publish toggle event when persistDisabledTools rejects', async () => {
      const persistDisabledTools = vi
        .fn()
        .mockRejectedValue(new Error('disk full'));
      const publishWorkspaceEvent = vi.fn();
      const svc = createDaemonWorkspaceService(
        makeDeps({ persistDisabledTools, publishWorkspaceEvent }),
      );

      await expect(
        svc.setWorkspaceToolEnabled(makeCtx(), 'Bash', false),
      ).rejects.toThrow('disk full');
      expect(publishWorkspaceEvent).not.toHaveBeenCalled();
    });
  });

  describe('requestWorkspaceTrustChange', () => {
    it('publishes trust_change_requested with originatorClientId', async () => {
      const publishWorkspaceEvent = vi.fn();
      const svc = createDaemonWorkspaceService(
        makeDeps({ boundWorkspace: '/my/workspace', publishWorkspaceEvent }),
      );

      const result = await svc.requestWorkspaceTrustChange(
        makeCtx({ originatorClientId: 'c-42' }),
        { desiredState: 'untrusted', reason: 'remote user request' },
      );

      expect(publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'trust_change_requested',
        data: {
          workspaceCwd: '/my/workspace',
          desiredState: 'untrusted',
          reason: 'remote user request',
        },
        originatorClientId: 'c-42',
      });
      expect(result).toEqual({
        accepted: false,
        desiredState: 'untrusted',
        requiresOperatorAction: true,
      });
    });
  });

  describe('refreshExtensionsForAllSessions', () => {
    it('delegates to the all-session refresh callback', async () => {
      const invokeWorkspaceCommand = vi.fn();
      const refreshExtensionsForAllSessions = vi
        .fn()
        .mockResolvedValue({ refreshed: 2, failed: 1 });
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand, refreshExtensionsForAllSessions }),
      );

      const result = await svc.refreshExtensionsForAllSessions();

      expect(result).toEqual({ refreshed: 2, failed: 1 });
      expect(refreshExtensionsForAllSessions).toHaveBeenCalledOnce();
      expect(invokeWorkspaceCommand).not.toHaveBeenCalled();
    });

    it('returns a failed result when the refresh callback is not wired', async () => {
      const svc = createDaemonWorkspaceService(makeDeps());

      await expect(svc.refreshExtensionsForAllSessions()).resolves.toEqual({
        refreshed: 0,
        failed: 1,
      });
    });

    it('returns a failed result when the refresh callback rejects', async () => {
      const refreshExtensionsForAllSessions = vi
        .fn()
        .mockRejectedValue(new Error('bridge down'));
      const svc = createDaemonWorkspaceService(
        makeDeps({ refreshExtensionsForAllSessions }),
      );

      await expect(svc.refreshExtensionsForAllSessions()).resolves.toEqual({
        refreshed: 0,
        failed: 1,
      });
    });
  });

  describe('restartMcpServer', () => {
    it('calls invokeWorkspaceCommand with correct method and params', async () => {
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue({
        serverName: 'myServer',
        restarted: true,
        durationMs: 100,
      });
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await svc.restartMcpServer(makeCtx(), 'myServer');

      expect(invokeWorkspaceCommand).toHaveBeenCalledWith(
        'qwen/control/workspace/mcp/restart',
        { serverName: 'myServer' },
        { timeoutMs: 300_000 },
      );
    });

    it('passes entryIndex when provided', async () => {
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue({
        serverName: 's',
        restarted: true,
        durationMs: 50,
      });
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await svc.restartMcpServer(makeCtx(), 'poolServer', { entryIndex: 3 });

      expect(invokeWorkspaceCommand).toHaveBeenCalledWith(
        'qwen/control/workspace/mcp/restart',
        { serverName: 'poolServer', entryIndex: 3 },
        { timeoutMs: 300_000 },
      );
    });

    it('publishes mcp_server_restarted event after success', async () => {
      const publishWorkspaceEvent = vi.fn();
      const invokeResult = { serverName: 'x', restarted: true, durationMs: 10 };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(invokeResult);
      const svc = createDaemonWorkspaceService(
        makeDeps({
          invokeWorkspaceCommand,
          publishWorkspaceEvent,
        }),
      );

      await svc.restartMcpServer(makeCtx({ originatorClientId: 'c-7' }), 'x');

      expect(publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'mcp_server_restarted',
        data: { serverName: 'x', durationMs: 10 },
        originatorClientId: 'c-7',
      });
    });

    it('returns the result from invokeWorkspaceCommand', async () => {
      const invokeResult = {
        serverName: 'srv',
        restarted: false,
        skipped: true,
        reason: 'disabled',
      };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(invokeResult);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      const result = await svc.restartMcpServer(makeCtx(), 'srv');

      expect(result).toEqual(invokeResult);
    });

    it('publishes mcp_server_restart_refused event when restarted is false', async () => {
      const publishWorkspaceEvent = vi.fn();
      const invokeResult = {
        serverName: 'blocked',
        restarted: false,
        skipped: true,
        reason: 'in_flight',
      };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(invokeResult);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand, publishWorkspaceEvent }),
      );

      await svc.restartMcpServer(
        makeCtx({ originatorClientId: 'c-1' }),
        'blocked',
      );

      expect(publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_server_restart_refused',
          data: expect.objectContaining({ serverName: 'blocked' }),
          originatorClientId: 'c-1',
        }),
      );
    });

    it('translates mcp_server_not_found errorKind into McpServerNotFoundError', async () => {
      const err = Object.assign(new Error('not found'), {
        data: { errorKind: 'mcp_server_not_found', serverName: 'ghost' },
      });
      const invokeWorkspaceCommand = vi.fn().mockRejectedValue(err);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await expect(svc.restartMcpServer(makeCtx(), 'ghost')).rejects.toThrow(
        /ghost/,
      );
    });

    it('translates mcp_restart_failed errorKind into McpServerRestartFailedError', async () => {
      const err = Object.assign(new Error('restart failed'), {
        data: {
          errorKind: 'mcp_restart_failed',
          serverName: 'broken',
          mcpStatus: 'disconnected',
        },
      });
      const invokeWorkspaceCommand = vi.fn().mockRejectedValue(err);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await expect(svc.restartMcpServer(makeCtx(), 'broken')).rejects.toThrow(
        /broken/,
      );
    });

    it('re-throws non-errorKind errors without translation', async () => {
      const err = new Error('generic boom');
      const invokeWorkspaceCommand = vi.fn().mockRejectedValue(err);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await expect(svc.restartMcpServer(makeCtx(), 'srv')).rejects.toThrow(
        'generic boom',
      );
    });

    it('lets SessionNotFoundError pass through for 404 mapping', async () => {
      const err = new SessionNotFoundError('some-session-id');
      const invokeWorkspaceCommand = vi.fn().mockRejectedValue(err);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand }),
      );

      await expect(
        svc.restartMcpServer(makeCtx(), 'my-mcp-server'),
      ).rejects.toThrow(SessionNotFoundError);
    });

    it('fans out per-entry events in pool-mode', async () => {
      const publishWorkspaceEvent = vi.fn();
      const invokeResult = {
        serverName: 'pool-srv',
        entries: [
          { entryIndex: 0, restarted: true, durationMs: 50 },
          { entryIndex: 1, restarted: false, reason: 'in_flight' },
        ],
      };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(invokeResult);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand, publishWorkspaceEvent }),
      );

      await svc.restartMcpServer(
        makeCtx({ originatorClientId: 'c-pool' }),
        'pool-srv',
      );

      expect(publishWorkspaceEvent).toHaveBeenCalledTimes(2);
      expect(publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_server_restarted',
          data: expect.objectContaining({ entryIndex: 0, durationMs: 50 }),
        }),
      );
      expect(publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_server_restart_refused',
          data: expect.objectContaining({ entryIndex: 1 }),
        }),
      );
    });

    it('skips malformed pool entries without crashing', async () => {
      const publishWorkspaceEvent = vi.fn();
      const invokeResult = {
        serverName: 'pool-srv',
        entries: [
          null,
          { entryIndex: 0, restarted: true, durationMs: 10 },
          'not-an-object',
        ],
      };
      const invokeWorkspaceCommand = vi.fn().mockResolvedValue(invokeResult);
      const svc = createDaemonWorkspaceService(
        makeDeps({ invokeWorkspaceCommand, publishWorkspaceEvent }),
      );

      await svc.restartMcpServer(makeCtx(), 'pool-srv');

      expect(publishWorkspaceEvent).toHaveBeenCalledTimes(1);
      expect(publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp_server_restarted',
          data: expect.objectContaining({ entryIndex: 0 }),
        }),
      );
    });
  });

  describe('initWorkspace', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'facade-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('creates a new file and returns action=created', async () => {
      const publishWorkspaceEvent = vi.fn();
      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
          publishWorkspaceEvent,
        }),
      );

      const result = await svc.initWorkspace(
        makeCtx({ workspaceCwd: tmpDir }),
        {},
      );

      expect(result.action).toBe('created');
      expect(result.path).toBe(path.join(tmpDir, 'QWEN.md'));
      const stat = await fs.stat(result.path);
      expect(stat.isFile()).toBe(true);
    });

    it('publishes workspace_initialized event on create', async () => {
      const publishWorkspaceEvent = vi.fn();
      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
          publishWorkspaceEvent,
        }),
      );

      await svc.initWorkspace(makeCtx({ originatorClientId: 'c-9' }), {});

      expect(publishWorkspaceEvent).toHaveBeenCalledWith({
        type: 'workspace_initialized',
        data: { path: path.join(tmpDir, 'QWEN.md'), action: 'created' },
        originatorClientId: 'c-9',
      });
    });

    it('returns noop when file exists but is whitespace-only', async () => {
      const target = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(target, '   \n  ', 'utf8');

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      const result = await svc.initWorkspace(makeCtx(), {});

      expect(result.action).toBe('noop');
    });

    it('throws when file has content and force is not set', async () => {
      const target = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(target, '# Hello', 'utf8');

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
        /already exists/,
      );
    });

    it('overwrites existing file when force=true', async () => {
      const target = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(target, '# Existing content', 'utf8');

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      const result = await svc.initWorkspace(makeCtx(), { force: true });

      expect(result.action).toBe('overwrote');
      const content = await fs.readFile(target, 'utf8');
      expect(content).toBe('');
    });

    it('throws for escaping filename', async () => {
      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: '../escape.md',
        }),
      );

      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
        /resolves outside/,
      );
    });

    it('throws when target is a symlink', async () => {
      const realFile = path.join(tmpDir, 'real.md');
      const linkFile = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(realFile, '', 'utf8');
      await fs.symlink(realFile, linkFile);

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(/symlink/);
    });

    it('throws when target is a non-regular file', async () => {
      const target = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(target, '', 'utf8');

      const origLstat = fs.lstat;
      const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (p) => {
        const stats = await origLstat(p);
        if (path.resolve(String(p)) !== target) return stats;
        return new Proxy(stats, {
          get(obj, prop, receiver) {
            if (prop === 'isFile') return () => false;
            if (prop === 'isSymbolicLink') return () => false;
            return Reflect.get(obj, prop, receiver);
          },
        });
      });

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      try {
        await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
          /not a regular file/,
        );
      } finally {
        lstatSpy.mockRestore();
      }
    });

    it('throws WorkspaceInitConflictError when existing file has content and force is unset', async () => {
      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      // Create the file between the readFile ENOENT and the open('wx')
      // by pre-creating it — the 'wx' flag throws EEXIST atomically.
      await fs.writeFile(path.join(tmpDir, 'QWEN.md'), '# content', 'utf8');

      // Since the file has content and force is not set, it throws
      // WorkspaceInitConflictError (not the race). To test the EEXIST
      // race, we'd need to inject between lstat and open — this verifies
      // the conflict guard at least.
      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
        /already exists/,
      );
    });

    it('throws WorkspaceInitRaceError when fs.open hits EEXIST', async () => {
      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      const origOpen = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(
        async (
          filePath: Parameters<typeof origOpen>[0],
          flags?: Parameters<typeof origOpen>[1],
        ) => {
          if (String(flags) === 'wx' && String(filePath).endsWith('QWEN.md')) {
            const err = new Error('EEXIST') as NodeJS.ErrnoException;
            err.code = 'EEXIST';
            throw err;
          }
          return origOpen(filePath, flags as string);
        },
      );

      try {
        await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
          /appeared.*between/,
        );
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('throws WorkspaceInitSymlinkError when overwrite open hits ELOOP', async () => {
      const target = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(target, '# existing content', 'utf8');

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      const origOpen = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(
        async (
          filePath: Parameters<typeof origOpen>[0],
          flags?: Parameters<typeof origOpen>[1],
        ) => {
          if (
            typeof flags === 'number' &&
            String(filePath).endsWith('QWEN.md')
          ) {
            const err = new Error('ELOOP') as NodeJS.ErrnoException;
            err.code = 'ELOOP';
            throw err;
          }
          return origOpen(filePath, flags as string);
        },
      );

      try {
        await expect(
          svc.initWorkspace(makeCtx(), { force: true }),
        ).rejects.toThrow(/O_NOFOLLOW.*ELOOP|symlink/i);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('throws WorkspaceInitRaceError when overwrite open hits ENOENT', async () => {
      const target = path.join(tmpDir, 'QWEN.md');
      await fs.writeFile(target, '# existing content', 'utf8');

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'QWEN.md',
        }),
      );

      const origOpen = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(
        async (
          filePath: Parameters<typeof origOpen>[0],
          flags?: Parameters<typeof origOpen>[1],
        ) => {
          if (
            typeof flags === 'number' &&
            String(filePath).endsWith('QWEN.md')
          ) {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          }
          return origOpen(filePath, flags as string);
        },
      );

      try {
        await expect(
          svc.initWorkspace(makeCtx(), { force: true }),
        ).rejects.toThrow(/deleted.*between|concurrent/i);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('parent symlink outside workspace is rejected', async () => {
      // Create a subdirectory that's actually a symlink to /tmp
      const docsLink = path.join(tmpDir, 'docs');
      await fs.symlink(os.tmpdir(), docsLink);

      const svc = createDaemonWorkspaceService(
        makeDeps({
          boundWorkspace: tmpDir,
          contextFilename: 'docs/QWEN.md',
        }),
      );

      await expect(svc.initWorkspace(makeCtx(), {})).rejects.toThrow(
        /parent.*resolves outside|parent.*workspace/i,
      );
    });
  });
});
