/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useIncludeDirsTrust } from './useIncludeDirsTrust.js';
import type { Config, WorkspaceContext } from '@qwen-code/core';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import type { LoadedSettings } from '../../config/settings.js';

import type { MultiFolderTrustDialogProps } from '../components/MultiFolderTrustDialog.js';

vi.mock('../utils/directoryUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/directoryUtils.js')>();
  return {
    ...actual,
    expandHomeDir: (p: string) => p, // Simple pass-through for testing
    batchAddDirectories: (
      workspaceContext: WorkspaceContext,
      paths: string[],
    ) => {
      const result = workspaceContext.addDirectories(paths);
      const errors: string[] = [];
      for (const failure of result.failed) {
        errors.push(`Error adding '${failure.path}': ${failure.error.message}`);
      }
      return { added: result.added, errors };
    },
    loadMemoryFromDirectories: vi.fn().mockResolvedValue({ fileCount: 1 }),
  };
});

vi.mock('../components/MultiFolderTrustDialog.js', () => ({
  MultiFolderTrustDialog: (props: MultiFolderTrustDialogProps) => (
    <div data-testid="mock-dialog">{JSON.stringify(props.folders)}</div>
  ),
}));

describe('useIncludeDirsTrust', () => {
  let mockConfig: Config;
  let mockHistoryManager: UseHistoryManagerReturn;
  let mockSetCustomDialog: Mock;
  let mockWorkspaceContext: WorkspaceContext;
  let mockSettings: LoadedSettings;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWorkspaceContext = {
      addDirectory: vi.fn(),
      addDirectories: vi.fn().mockReturnValue({ added: [], failed: [] }),
      getDirectories: vi.fn().mockReturnValue([]),
      onDirectoriesChangedListeners: new Set(),
      onDirectoriesChanged: vi.fn(),
      notifyDirectoriesChanged: vi.fn(),
      resolveAndValidateDir: vi.fn(),
      getInitialDirectories: vi.fn(),
      setDirectories: vi.fn(),
      isPathWithinWorkspace: vi.fn(),
      fullyResolvedPath: vi.fn(),
      isPathWithinRoot: vi.fn(),
      isFileSymlink: vi.fn(),
    } as unknown as ReturnType<typeof mockConfig.getWorkspaceContext>;

    mockConfig = {
      getPendingIncludeDirectories: vi.fn().mockReturnValue([]),
      clearPendingIncludeDirectories: vi.fn(),
      getFolderTrust: vi.fn().mockReturnValue(true),
      getWorkspaceContext: () => mockWorkspaceContext,
    } as unknown as Config;

    mockHistoryManager = {
      addItem: vi.fn(),
      history: [],
      updateItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
      loadHistoryItems: vi.fn(),
    };
    mockSetCustomDialog = vi.fn();

    mockSettings = {
      merged: {
        permissions: {
          additionalDirectories: [],
        },
      },
      local: {
        settings: {
          permissions: {
            additionalDirectories: [],
          },
        },
      },
    } as unknown as LoadedSettings;
  });

  const renderTestHook = async (isTrustedFolder: boolean | undefined) => {
    await renderHook(() =>
      useIncludeDirsTrust(
        mockConfig,
        isTrustedFolder,
        mockHistoryManager,
        mockSetCustomDialog,
        mockSettings,
      ),
    );
  };

  it('should do nothing if isTrustedFolder is undefined', async () => {
    vi.mocked(mockConfig.getPendingIncludeDirectories).mockReturnValue([
      '/foo',
    ]);
    await renderTestHook(undefined);
    expect(mockConfig.clearPendingIncludeDirectories).not.toHaveBeenCalled();
  });

  it('should do nothing if there are no pending directories', async () => {
    await renderTestHook(true);
    expect(mockConfig.clearPendingIncludeDirectories).not.toHaveBeenCalled();
  });

  describe('when folder trust is disabled or workspace is untrusted', () => {
    it.each([
      { trustEnabled: false, isTrusted: true, scenario: 'trust is disabled' },
      {
        trustEnabled: true,
        isTrusted: false,
        scenario: 'workspace is untrusted',
      },
    ])(
      'should add directories directly when $scenario',
      async ({ trustEnabled, isTrusted }) => {
        vi.mocked(mockConfig.getFolderTrust).mockReturnValue(trustEnabled);
        vi.mocked(mockConfig.getPendingIncludeDirectories).mockReturnValue([
          '/dir1',
          '/dir2',
        ]);
        vi.mocked(mockWorkspaceContext.addDirectories).mockReturnValue({
          added: ['/dir1'],
          failed: [{ path: '/dir2', error: new Error('Test error') }],
        });

        await renderTestHook(isTrusted);

        await waitFor(() => {
          expect(mockWorkspaceContext.addDirectories).toHaveBeenCalledWith([
            '/dir1',
            '/dir2',
          ]);
          expect(mockHistoryManager.addItem).toHaveBeenCalledWith(
            expect.objectContaining({
              text: expect.stringContaining("Error adding '/dir2': Test error"),
            }),
          );
          expect(
            mockConfig.clearPendingIncludeDirectories,
          ).toHaveBeenCalledTimes(1);
        });
      },
    );
  });

  describe('when folder trust is enabled and workspace is trusted', () => {
    it('should add directories in additionalDirectories and open dialog for others', async () => {
      const pendingDirs = ['/trusted', '/undefined'];
      vi.mocked(mockConfig.getFolderTrust).mockReturnValue(true);
      vi.mocked(mockConfig.getPendingIncludeDirectories).mockReturnValue(
        pendingDirs,
      );

      mockSettings = {
        merged: {
          permissions: {
            additionalDirectories: ['/trusted'],
          },
        },
        local: {
          settings: {
            permissions: {
              additionalDirectories: [],
            },
          },
        },
      } as unknown as LoadedSettings;

      vi.mocked(mockWorkspaceContext.addDirectories).mockReturnValue({
        added: ['/trusted'],
        failed: [],
      });

      await renderTestHook(true);

      // Opens dialog for the dir not in additionalDirectories
      expect(mockSetCustomDialog).toHaveBeenCalledTimes(1);
      const customDialogAction = mockSetCustomDialog.mock.calls[0][0];
      expect(customDialogAction).toBeDefined();
      const dialogProps = (
        customDialogAction as React.ReactElement<MultiFolderTrustDialogProps>
      ).props;
      expect(dialogProps.folders).toEqual(['/undefined']);
      expect(dialogProps.trustedDirs).toEqual(['/trusted']);
      expect(dialogProps.errors).toEqual([]);
    });

    it('should only add directories and clear pending if no dialog is needed', async () => {
      const pendingDirs = ['/trusted1', '/trusted2'];
      vi.mocked(mockConfig.getFolderTrust).mockReturnValue(true);
      vi.mocked(mockConfig.getPendingIncludeDirectories).mockReturnValue(
        pendingDirs,
      );

      mockSettings = {
        merged: {
          permissions: {
            additionalDirectories: ['/trusted1', '/trusted2'],
          },
        },
        local: {
          settings: {
            permissions: {
              additionalDirectories: [],
            },
          },
        },
      } as unknown as LoadedSettings;

      vi.mocked(mockWorkspaceContext.addDirectories).mockReturnValue({
        added: pendingDirs,
        failed: [],
      });

      await renderTestHook(true);

      await waitFor(() => {
        expect(mockWorkspaceContext.addDirectories).toHaveBeenCalledWith(
          pendingDirs,
        );
        expect(mockSetCustomDialog).not.toHaveBeenCalled();
        expect(mockConfig.clearPendingIncludeDirectories).toHaveBeenCalledTimes(
          1,
        );
      });
    });

    it('should auto-trust directories listed in local settings additionalDirectories', async () => {
      const pendingDirs = ['/local-trusted', '/unknown'];
      vi.mocked(mockConfig.getFolderTrust).mockReturnValue(true);
      vi.mocked(mockConfig.getPendingIncludeDirectories).mockReturnValue(
        pendingDirs,
      );

      mockSettings = {
        merged: {
          permissions: {
            additionalDirectories: [],
          },
        },
        local: {
          settings: {
            permissions: {
              additionalDirectories: ['/local-trusted'],
            },
          },
        },
      } as unknown as LoadedSettings;

      vi.mocked(mockWorkspaceContext.addDirectories).mockReturnValue({
        added: ['/local-trusted'],
        failed: [],
      });

      await renderTestHook(true);

      // Dialog should only show for the unknown dir, not the local-trusted one
      expect(mockSetCustomDialog).toHaveBeenCalledTimes(1);
      const customDialogAction = mockSetCustomDialog.mock.calls[0][0];
      const dialogProps = (
        customDialogAction as React.ReactElement<MultiFolderTrustDialogProps>
      ).props;
      expect(dialogProps.folders).toEqual(['/unknown']);
      expect(dialogProps.trustedDirs).toEqual(['/local-trusted']);
    });
  });
});
