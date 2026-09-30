/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getExtensionManager, extensionToOutputString } from './utils.js';
import type { Extension, ExtensionManager } from '@qwen-code/qwen-code-core';

const mockRefreshCache = vi.fn();
const mockExtensionManagerInstance = {
  refreshCache: mockRefreshCache,
};
const mockLoadSettings = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    ExtensionManager: vi
      .fn()
      .mockImplementation(() => mockExtensionManagerInstance),
  };
});

vi.mock('../../config/settings.js', () => ({
  SettingScope: {
    User: 'User',
    Workspace: 'Workspace',
    System: 'System',
    SystemDefaults: 'SystemDefaults',
  },
  loadSettings: mockLoadSettings,
}));

vi.mock('../../config/trustedFolders.js', () => ({
  isWorkspaceTrusted: vi.fn().mockReturnValue({ isTrusted: true }),
}));

vi.mock('./consent.js', () => ({
  requestConsentOrFail: vi.fn(),
  requestConsentNonInteractive: vi.fn(),
  requestChoicePluginNonInteractive: vi.fn(),
}));

describe('getExtensionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshCache.mockResolvedValue(undefined);
    mockLoadSettings.mockReturnValue({ merged: {} });
  });

  it('should return an ExtensionManager instance', async () => {
    const manager = await getExtensionManager();

    expect(manager).toBeDefined();
    expect(manager).toBe(mockExtensionManagerInstance);
  });

  it('should call refreshCache on the ExtensionManager', async () => {
    await getExtensionManager();

    expect(mockRefreshCache).toHaveBeenCalled();
  });

  it('should use current working directory as workspace', async () => {
    const { ExtensionManager } = await import('@qwen-code/qwen-code-core');

    await getExtensionManager();

    expect(ExtensionManager).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: process.cwd(),
      }),
    );
  });

  it('forwards the resolved telemetry opt-out and proxy to the ExtensionManager', async () => {
    const { ExtensionManager } = await import('@qwen-code/qwen-code-core');
    mockLoadSettings.mockReturnValue({
      merged: {
        privacy: { usageStatisticsEnabled: false },
        proxy: 'http://settings-proxy:8080',
      },
    });
    // The real resolvers consult the ambient env; pin it out of the
    // assertion so the test decides the outcome, not the runner's env.
    const envKeys = [
      'QWEN_USAGE_STATISTICS_ENABLED',
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
    ];
    const saved = envKeys.map(
      (key) => [key, process.env[key]] as [string, string | undefined],
    );
    for (const key of envKeys) delete process.env[key];
    try {
      await getExtensionManager();

      expect(ExtensionManager).toHaveBeenCalledWith(
        expect.objectContaining({
          usageStatisticsEnabled: false,
          proxy: 'http://settings-proxy:8080',
        }),
      );
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('resolves consent from the env term and the proxy from the env fallback at this call site', async () => {
    const { ExtensionManager } = await import('@qwen-code/qwen-code-core');
    // Settings alone would opt out and declare no proxy, so only the env terms
    // can produce the expected values: replacing the two resolver calls in
    // `utils.ts` with raw `settings.privacy?.usageStatisticsEnabled ?? true` /
    // `settings.proxy` reads reds this case, which is what re-opens the
    // `QwenLogger.getInstance` gate for enable/disable/link/update. The
    // winners are opposite on purpose — consent is env-then-settings, proxy
    // settings-then-env.
    mockLoadSettings.mockReturnValue({
      merged: { privacy: { usageStatisticsEnabled: false } },
    });
    const envKeys = [
      'QWEN_USAGE_STATISTICS_ENABLED',
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
    ];
    const saved = envKeys.map(
      (key) => [key, process.env[key]] as [string, string | undefined],
    );
    for (const key of envKeys) delete process.env[key];
    process.env['QWEN_USAGE_STATISTICS_ENABLED'] = 'true';
    process.env['HTTPS_PROXY'] = 'http://env-proxy:3128';
    try {
      await getExtensionManager();

      expect(ExtensionManager).toHaveBeenCalledWith(
        expect.objectContaining({
          usageStatisticsEnabled: true,
          proxy: 'http://env-proxy:3128',
        }),
      );
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('extensionToOutputString', () => {
  const mockIsEnabled = vi.fn();
  const mockExtensionManager = {
    isEnabled: mockIsEnabled,
  } as unknown as ExtensionManager;

  const createMockExtension = (overrides = {}): Extension => ({
    id: 'test-ext-id',
    name: 'test-extension',
    version: '1.0.0',
    isActive: true,
    path: '/path/to/extension',
    contextFiles: [],
    config: { name: 'test-extension', version: '1.0.0' },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
  });

  it('should include status icon when inline is false', () => {
    const extension = createMockExtension();
    const result = extensionToOutputString(
      extension,
      mockExtensionManager,
      '/workspace',
      false,
    );

    // Should contain either ✓ or ✗ (with ANSI color codes)
    expect(result).toMatch(/test-extension/);
    expect(result).toContain('(1.0.0)');
  });

  it('should exclude status icon when inline is true', () => {
    const extension = createMockExtension();
    const result = extensionToOutputString(
      extension,
      mockExtensionManager,
      '/workspace',
      true,
    );

    // Should start with extension name (after stripping potential whitespace)
    expect(result.trim()).toMatch(/^test-extension/);
  });

  it('should default inline to false', () => {
    const extension = createMockExtension();
    const resultWithoutInline = extensionToOutputString(
      extension,
      mockExtensionManager,
      '/workspace',
    );
    const resultWithInlineFalse = extensionToOutputString(
      extension,
      mockExtensionManager,
      '/workspace',
      false,
    );

    expect(resultWithoutInline).toEqual(resultWithInlineFalse);
  });

  it('should include description when present', () => {
    const extension = createMockExtension({
      config: {
        name: 'test-extension',
        version: '1.0.0',
        description: 'A helpful test extension',
      },
    });
    const result = extensionToOutputString(
      extension,
      mockExtensionManager,
      '/workspace',
    );

    expect(result).toContain('Description:');
    expect(result).toContain('A helpful test extension');
  });

  it('should strip ANSI escape codes from description', () => {
    const extension = createMockExtension({
      config: {
        name: 'test-extension',
        version: '1.0.0',
        description: '\x1b[31mMalicious\x1b[0m description',
      },
    });
    const result = extensionToOutputString(
      extension,
      mockExtensionManager,
      '/workspace',
    );

    expect(result).toContain('Malicious description');
    expect(result).not.toContain('\x1b[31m');
  });

  it('should handle non-string description gracefully', () => {
    const extension = createMockExtension({
      config: {
        name: 'test-extension',
        version: '1.0.0',
        description: 42,
      },
    });
    const result = extensionToOutputString(
      extension,
      mockExtensionManager,
      '/workspace',
    );

    expect(result).not.toContain('Description:');
  });

  it('should not include description line when absent', () => {
    const extension = createMockExtension();
    const result = extensionToOutputString(
      extension,
      mockExtensionManager,
      '/workspace',
    );

    expect(result).not.toContain('Description:');
  });

  it('should redact URL credentials in install source output', () => {
    const extension = createMockExtension({
      installMetadata: {
        type: 'git',
        source: 'https://user:token@example.com/owner/repo.git',
      },
    });

    const result = extensionToOutputString(
      extension,
      mockExtensionManager,
      '/workspace',
      true,
    );

    expect(result).toContain(
      'https://***REDACTED***@example.com/owner/repo.git',
    );
    expect(result).not.toContain('user');
    expect(result).not.toContain('token');
  });

  it('should display the native Agent Plugins origin', () => {
    const extension = createMockExtension({
      installMetadata: {
        type: 'local',
        source: '/path/to/portable-plugin',
        originSource: 'AgentPlugins',
      },
    });

    const result = extensionToOutputString(
      extension,
      mockExtensionManager,
      '/workspace',
    );

    expect(result).toContain('Origin: AgentPlugins');
  });
});
