/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { aboutCommand } from './aboutCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import * as systemInfoUtils from '../../utils/systemInfo.js';

vi.mock('../../utils/systemInfo.js');

describe('aboutCommand', () => {
  let mockContext: CommandContext;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockContext = createMockCommandContext({
      services: {
        config: {
          getModel: vi.fn().mockReturnValue('test-model'),
          getIdeMode: vi.fn().mockReturnValue(true),
          getSessionId: vi.fn().mockReturnValue('test-session-id'),
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
      ui: {
        addItem: vi.fn(),
      },
    } as unknown as CommandContext);

    vi.mocked(systemInfoUtils.getExtendedSystemInfo).mockResolvedValue({
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
      memoryUsage: '100 MB',
      baseUrl: undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  it('should have the correct name and description', () => {
    expect(aboutCommand.name).toBe('about');
    expect(aboutCommand.description).toBe('show version info');
  });

  it('should call addItem with all version info', async () => {
    if (!aboutCommand.action) {
      throw new Error('The about command must have an action.');
    }

    await aboutCommand.action(mockContext, '');

    expect(systemInfoUtils.getExtendedSystemInfo).toHaveBeenCalledWith(
      mockContext,
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ABOUT,
        systemInfo: expect.objectContaining({
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
          memoryUsage: '100 MB',
          baseUrl: undefined,
        }),
      }),
      expect.any(Number),
    );
  });

  it('should show the correct sandbox environment variable', async () => {
    vi.mocked(systemInfoUtils.getExtendedSystemInfo).mockResolvedValue({
      cliVersion: 'test-version',
      osPlatform: 'test-os',
      osArch: 'x64',
      osRelease: '22.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'gemini-sandbox',
      modelVersion: 'test-model',
      selectedAuthType: 'test-auth',
      ideClient: 'test-ide',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      baseUrl: undefined,
    });

    if (!aboutCommand.action) {
      throw new Error('The about command must have an action.');
    }

    await aboutCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ABOUT,
        systemInfo: expect.objectContaining({
          sandboxEnv: 'gemini-sandbox',
        }),
      }),
      expect.any(Number),
    );
  });

  it('should show sandbox-exec profile when applicable', async () => {
    vi.mocked(systemInfoUtils.getExtendedSystemInfo).mockResolvedValue({
      cliVersion: 'test-version',
      osPlatform: 'test-os',
      osArch: 'x64',
      osRelease: '22.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'sandbox-exec (test-profile)',
      modelVersion: 'test-model',
      selectedAuthType: 'test-auth',
      ideClient: 'test-ide',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      baseUrl: undefined,
    });

    if (!aboutCommand.action) {
      throw new Error('The about command must have an action.');
    }

    await aboutCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInfo: expect.objectContaining({
          sandboxEnv: 'sandbox-exec (test-profile)',
        }),
      }),
      expect.any(Number),
    );
  });

  it('should not show ide client when it is not detected', async () => {
    vi.mocked(systemInfoUtils.getExtendedSystemInfo).mockResolvedValue({
      cliVersion: 'test-version',
      osPlatform: 'test-os',
      osArch: 'x64',
      osRelease: '22.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'no sandbox',
      modelVersion: 'test-model',
      selectedAuthType: 'test-auth',
      ideClient: '',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      baseUrl: undefined,
    });

    if (!aboutCommand.action) {
      throw new Error('The about command must have an action.');
    }

    await aboutCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ABOUT,
        systemInfo: expect.objectContaining({
          cliVersion: 'test-version',
          osPlatform: 'test-os',
          osArch: 'x64',
          osRelease: '22.0.0',
          nodeVersion: 'v20.0.0',
          npmVersion: '10.0.0',
          sandboxEnv: 'no sandbox',
          modelVersion: 'test-model',
          selectedAuthType: 'test-auth',
          ideClient: '',
          sessionId: 'test-session-id',
          memoryUsage: '100 MB',
          baseUrl: undefined,
        }),
      }),
      expect.any(Number),
    );
  });

  it('should show unknown npmVersion when npm command fails', async () => {
    vi.mocked(systemInfoUtils.getExtendedSystemInfo).mockResolvedValue({
      cliVersion: 'test-version',
      osPlatform: 'test-os',
      osArch: 'x64',
      osRelease: '22.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: 'unknown',
      sandboxEnv: 'no sandbox',
      modelVersion: 'test-model',
      selectedAuthType: 'test-auth',
      ideClient: 'test-ide',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      baseUrl: undefined,
    });

    if (!aboutCommand.action) {
      throw new Error('The about command must have an action.');
    }

    await aboutCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInfo: expect.objectContaining({
          npmVersion: 'unknown',
        }),
      }),
      expect.any(Number),
    );
  });

  it('should show unknown sessionId when config is not available', async () => {
    vi.mocked(systemInfoUtils.getExtendedSystemInfo).mockResolvedValue({
      cliVersion: 'test-version',
      osPlatform: 'test-os',
      osArch: 'x64',
      osRelease: '22.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'no sandbox',
      modelVersion: 'Unknown',
      selectedAuthType: 'test-auth',
      ideClient: '',
      sessionId: 'unknown',
      memoryUsage: '100 MB',
      baseUrl: undefined,
    });

    if (!aboutCommand.action) {
      throw new Error('The about command must have an action.');
    }

    await aboutCommand.action(mockContext, '');

    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInfo: expect.objectContaining({
          sessionId: 'unknown',
        }),
      }),
      expect.any(Number),
    );
  });
});
