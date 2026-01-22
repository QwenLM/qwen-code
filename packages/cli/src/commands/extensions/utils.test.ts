/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getExtensionManager } from './utils.js';

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
