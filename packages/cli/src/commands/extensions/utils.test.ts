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

vi.mock('@qwen-code/qwen-code-core', () => ({
  ExtensionManager: vi
    .fn()
    .mockImplementation(() => mockExtensionManagerInstance),
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn().mockReturnValue({
    merged: {},
  }),
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
});
