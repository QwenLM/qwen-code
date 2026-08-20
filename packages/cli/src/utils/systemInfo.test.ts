/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getSystemInfo,
  getExtendedSystemInfo,
  getNpmVersion,
  getSandboxEnv,
  getIdeClientName,
} from './systemInfo.js';
import type { CommandContext } from '../ui/commands/types.js';
import { createMockCommandContext } from '../test-utils/mockCommandContext.js';
import type * as child_process from 'node:child_process';
import os from 'node:os';
import { IdeClient } from '@qwen-code/qwen-code-core';
import * as versionUtils from './version.js';

// `getNpmVersion` / `getGitVersion` use `execFile` callback-style. Mock
// the named export via `vi.hoisted` so the spy reference is the same one
// the module imports — the synchronous factory return ensures the mock is
// applied before `systemInfo.ts` evaluates its imports.
const { mockedExecFile } = vi.hoisted(() => ({
  mockedExecFile: vi.fn(),
}));
vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  return {
    ...actual,
    default: { ...actual, execFile: mockedExecFile },
    execFile: mockedExecFile,
  };
});

type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;
const setExecFileStdout = (stdout: string) => {
  mockedExecFile.mockImplementation(((
    _file: string,
    _args: readonly string[],
    _options: object,
    callback: ExecFileCb,
  ) => {
    callback(null, stdout, '');
    return {};
  }) as unknown as typeof child_process.execFile);
};
const setExecFileError = (err: Error) => {
  mockedExecFile.mockImplementation(((
    _file: string,
    _args: readonly string[],
    _options: object,
    callback: ExecFileCb,
  ) => {
    callback(err, '', '');
    return {};
  }) as unknown as typeof child_process.execFile);
};

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: {
      ...actual,
      release: vi.fn(),
    },
  };
});

vi.mock('./version.js', () => ({
  getCliVersion: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    IdeClient: {
      getInstance: vi.fn(),
    },
  };
});

describe('systemInfo', () => {
  let mockContext: CommandContext;
  const originalPlatform = process.platform;
  const originalArch = process.arch;
  const originalVersion = process.version;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        config: {
          getModel: vi.fn().mockReturnValue('test-model'),
          getIdeMode: vi.fn().mockReturnValue(true),
          getSessionId: vi.fn().mockReturnValue('test-session-id'),
          getAuthType: vi.fn().mockReturnValue('test-auth'),
          getProxy: vi.fn().mockReturnValue(undefined),
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            baseUrl: 'https://api.openai.com',
          }),
        },
        settings: {
          merged: {
            security: {
              auth: {
                selectedType: 'test-auth',
              },
            },
          },
        },
      },
    } as unknown as CommandContext);

    vi.mocked(versionUtils.getCliVersion).mockResolvedValue('test-version');
    setExecFileStdout('10.0.0');
    vi.mocked(os.release).mockReturnValue('22.0.0');
    process.env['GOOGLE_CLOUD_PROJECT'] = 'test-gcp-project';
    Object.defineProperty(process, 'platform', {
      value: 'test-os',
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64',
    });
    Object.defineProperty(process, 'version', {
      value: 'v20.0.0',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
    Object.defineProperty(process, 'arch', {
      value: originalArch,
    });
    Object.defineProperty(process, 'version', {
      value: originalVersion,
    });
    process.env = originalEnv;
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  describe('getNpmVersion', () => {
    it('should return npm version when available', async () => {
      setExecFileStdout('10.0.0\n');
      const version = await getNpmVersion();
      expect(version).toBe('10.0.0');
    });

    it('should return unknown when npm command fails', async () => {
      setExecFileError(new Error('npm not found'));
      const version = await getNpmVersion();
      expect(version).toBe('unknown');
    });
  });

  describe('getSandboxEnv', () => {
    it('should return "no sandbox" when SANDBOX is not set', () => {
      delete process.env['SANDBOX'];
      expect(getSandboxEnv()).toBe('no sandbox');
    });

    it('should return sandbox-exec info when SANDBOX is sandbox-exec', () => {
      process.env['SANDBOX'] = 'sandbox-exec';
      process.env['SEATBELT_PROFILE'] = 'test-profile';
      expect(getSandboxEnv()).toBe('sandbox-exec (test-profile)');
    });

    it('should return sandbox name without prefix when stripPrefix is true', () => {
      process.env['SANDBOX'] = 'qwen-code-test-sandbox';
      expect(getSandboxEnv(true)).toBe('test-sandbox');
    });

    it('should return sandbox name with prefix when stripPrefix is false', () => {
      process.env['SANDBOX'] = 'qwen-code-test-sandbox';
      expect(getSandboxEnv(false)).toBe('qwen-code-test-sandbox');
    });

    it('should handle qwen- prefix removal', () => {
      process.env['SANDBOX'] = 'qwen-custom-sandbox';
      expect(getSandboxEnv(true)).toBe('custom-sandbox');
    });
  });

  describe('getIdeClientName', () => {
    it('should return IDE client name when IDE mode is enabled', async () => {
      vi.mocked(IdeClient.getInstance).mockResolvedValue({
        getDetectedIdeDisplayName: vi.fn().mockReturnValue('test-ide'),
      } as unknown as IdeClient);

      const ideClient = await getIdeClientName(mockContext);
      expect(ideClient).toBe('test-ide');
    });

    it('should return empty string when IDE mode is disabled', async () => {
      vi.mocked(mockContext.services.config!.getIdeMode).mockReturnValue(false);

      const ideClient = await getIdeClientName(mockContext);
      expect(ideClient).toBe('');
    });

    it('should return empty string when IDE client detection fails', async () => {
      vi.mocked(IdeClient.getInstance).mockRejectedValue(
        new Error('IDE client error'),
      );

      const ideClient = await getIdeClientName(mockContext);
      expect(ideClient).toBe('');
    });
  });

  describe('getSystemInfo', () => {
    it('should collect all system information', async () => {
      // Ensure SANDBOX is not set for this test
      delete process.env['SANDBOX'];
      vi.mocked(IdeClient.getInstance).mockResolvedValue({
        getDetectedIdeDisplayName: vi.fn().mockReturnValue('test-ide'),
      } as unknown as IdeClient);
      setExecFileStdout('10.0.0');

      const systemInfo = await getSystemInfo(mockContext);

      expect(systemInfo).toEqual({
        cliVersion: 'test-version',
        osPlatform: 'test-os',
        osArch: 'x64',
        osRelease: '22.0.0',
        nodeVersion: 'v20.0.0',
        npmVersion: '10.0.0',
        sandboxEnv: 'no sandbox',
        modelVersion: 'test-model',
        selectedAuthType: 'test-auth',
        ideClient: 'test-ide',
        sessionId: 'test-session-id',
        proxy: undefined,
      });
    });

    it('should handle missing config gracefully', async () => {
      mockContext.services.config = null;
      vi.mocked(IdeClient.getInstance).mockResolvedValue({
        getDetectedIdeDisplayName: vi.fn().mockReturnValue(''),
      } as unknown as IdeClient);

      const systemInfo = await getSystemInfo(mockContext);

      expect(systemInfo.modelVersion).toBe('Unknown');
      expect(systemInfo.sessionId).toBe('unknown');
    });
  });

  describe('getExtendedSystemInfo', () => {
    it('should include memory usage and base URL', async () => {
      vi.mocked(IdeClient.getInstance).mockResolvedValue({
        getDetectedIdeDisplayName: vi.fn().mockReturnValue('test-ide'),
      } as unknown as IdeClient);
      setExecFileStdout('10.0.0');

      const { AuthType } = await import('@qwen-code/qwen-code-core');
      // Update the mock context to use OpenAI auth
      mockContext.services.settings.merged.security!.auth!.selectedType =
        AuthType.USE_OPENAI;
      vi.mocked(mockContext.services.config!.getAuthType).mockReturnValue(
        AuthType.USE_OPENAI,
      );

      const extendedInfo = await getExtendedSystemInfo(mockContext);

      expect(extendedInfo.memoryUsage).toBeDefined();
      expect(extendedInfo.memoryUsage).toMatch(/\d+\.\d+ (KB|MB|GB)/);
      expect(extendedInfo.baseUrl).toBe('https://api.openai.com');
    });

    it('should use sandbox env without prefix for bug reports', async () => {
      process.env['SANDBOX'] = 'qwen-code-test-sandbox';
      vi.mocked(IdeClient.getInstance).mockResolvedValue({
        getDetectedIdeDisplayName: vi.fn().mockReturnValue(''),
      } as unknown as IdeClient);
      setExecFileStdout('10.0.0');

      const extendedInfo = await getExtendedSystemInfo(mockContext);

      expect(extendedInfo.sandboxEnv).toBe('test-sandbox');
    });

    it('should not include base URL for non-OpenAI auth', async () => {
      vi.mocked(IdeClient.getInstance).mockResolvedValue({
        getDetectedIdeDisplayName: vi.fn().mockReturnValue(''),
      } as unknown as IdeClient);
      setExecFileStdout('10.0.0');

      const extendedInfo = await getExtendedSystemInfo(mockContext);

      expect(extendedInfo.baseUrl).toBeUndefined();
    });

    it('should include formatted LSP status when config exposes it', async () => {
      vi.mocked(IdeClient.getInstance).mockResolvedValue({
        getDetectedIdeDisplayName: vi.fn().mockReturnValue(''),
      } as unknown as IdeClient);
      const getLspStatusSnapshot = vi.fn().mockReturnValue({
        enabled: true,
        configuredServers: 2,
        readyServers: 1,
        failedServers: 1,
        inProgressServers: 0,
        notStartedServers: 0,
        servers: [
          {
            name: 'clangd',
            status: 'READY',
            languages: ['cpp'],
            transport: 'stdio',
          },
          {
            name: 'pyright',
            status: 'FAILED',
            languages: ['python'],
            transport: 'stdio',
            error: 'startup failed',
          },
        ],
      });
      mockContext.services.config = {
        ...(mockContext.services.config ?? {}),
        getLspStatusSnapshot,
        getDebugMode: vi.fn().mockReturnValue(false),
      } as unknown as CommandContext['services']['config'];

      const extendedInfo = await getExtendedSystemInfo(mockContext);

      expect(getLspStatusSnapshot).toHaveBeenCalledTimes(1);
      expect(extendedInfo.lspStatus).toBe('enabled, 1/2 ready (1 failed)');
    });

    it('should report unavailable LSP status distinctly', async () => {
      vi.mocked(IdeClient.getInstance).mockResolvedValue({
        getDetectedIdeDisplayName: vi.fn().mockReturnValue(''),
      } as unknown as IdeClient);
      mockContext.services.config = {
        ...(mockContext.services.config ?? {}),
        getLspStatusSnapshot: vi.fn().mockReturnValue({
          enabled: true,
          configuredServers: 0,
          readyServers: 0,
          failedServers: 0,
          inProgressServers: 0,
          notStartedServers: 0,
          servers: [],
          statusUnavailable: true,
        }),
        getDebugMode: vi.fn().mockReturnValue(false),
      } as unknown as CommandContext['services']['config'];

      const extendedInfo = await getExtendedSystemInfo(mockContext);

      expect(extendedInfo.lspStatus).toBe('enabled, status unavailable');
    });

    it('should omit LSP status when the status snapshot throws', async () => {
      vi.mocked(IdeClient.getInstance).mockResolvedValue({
        getDetectedIdeDisplayName: vi.fn().mockReturnValue(''),
      } as unknown as IdeClient);
      mockContext.services.config = {
        ...(mockContext.services.config ?? {}),
        getLspStatusSnapshot: vi.fn(() => {
          throw new Error('snapshot failed');
        }),
        getDebugMode: vi.fn().mockReturnValue(false),
      } as unknown as CommandContext['services']['config'];

      const extendedInfo = await getExtendedSystemInfo(mockContext);

      expect(extendedInfo.lspStatus).toBeUndefined();
    });

    it.each([
      [
        'disabled',
        {
          enabled: false,
          configuredServers: 0,
          readyServers: 0,
          failedServers: 0,
          inProgressServers: 0,
          notStartedServers: 0,
          servers: [],
        },
        'disabled',
      ],
      [
        'initialization failed',
        {
          enabled: true,
          configuredServers: 0,
          readyServers: 0,
          failedServers: 0,
          inProgressServers: 0,
          notStartedServers: 0,
          servers: [],
          initializationError: 'discovery failed',
        },
        'enabled, initialization failed: discovery failed',
      ],
      [
        'no servers configured',
        {
          enabled: true,
          configuredServers: 0,
          readyServers: 0,
          failedServers: 0,
          inProgressServers: 0,
          notStartedServers: 0,
          servers: [],
        },
        'enabled, no servers configured',
      ],
      [
        'starting and not-started servers',
        {
          enabled: true,
          configuredServers: 3,
          readyServers: 1,
          failedServers: 0,
          inProgressServers: 1,
          notStartedServers: 1,
          servers: [],
        },
        'enabled, 1/3 ready (1 starting, 1 not started)',
      ],
    ])(
      'should format LSP status when %s',
      async (_name, snapshot, expected) => {
        vi.mocked(IdeClient.getInstance).mockResolvedValue({
          getDetectedIdeDisplayName: vi.fn().mockReturnValue(''),
        } as unknown as IdeClient);
        mockContext.services.config = {
          ...(mockContext.services.config ?? {}),
          getLspStatusSnapshot: vi.fn().mockReturnValue(snapshot),
          getDebugMode: vi.fn().mockReturnValue(false),
        } as unknown as CommandContext['services']['config'];

        const extendedInfo = await getExtendedSystemInfo(mockContext);

        expect(extendedInfo.lspStatus).toBe(expected);
      },
    );
  });
});
