/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useFolderTrust } from './useFolderTrust.js';
import type { LoadedSettings } from '../../config/settings.js';
import { FolderTrustChoice } from '../components/FolderTrustDialog.js';
import {
  coreEvents,
  ExitCodes,
  isHeadlessMode,
  FolderTrustDiscoveryService,
} from '@qwen-code/core';
import { MessageType } from '../types.js';

const mockedCwd = vi.hoisted(() => vi.fn().mockReturnValue('/mock/cwd'));
const mockedExit = vi.hoisted(() => vi.fn());
const mockedIsWorkspaceTrusted = vi.hoisted(() => vi.fn());
const mockedGracefulExit = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/core')
  >('@qwen-code/core');
  return {
    ...actual,
    isHeadlessMode: vi.fn().mockReturnValue(false),
    FolderTrustDiscoveryService: {
      discover: vi.fn(() => new Promise(() => {})),
    },
  };
});

vi.mock('node:process', async () => {
  const actual =
    await vi.importActual<typeof import('node:process')>('node:process');
  return {
    ...actual,
    cwd: mockedCwd,
    exit: mockedExit,
    platform: 'linux',
  };
});

vi.mock('../../config/trustedFolders.js', () => ({
  isWorkspaceTrusted: mockedIsWorkspaceTrusted,
}));

vi.mock('../../utils/cleanup.js', () => ({
  gracefulExit: mockedGracefulExit,
}));

describe('useFolderTrust', () => {
  let mockSettings: LoadedSettings;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockConfig: any;
  let onTrustChange: (isTrusted: boolean | undefined) => void;
  let addItem: Mock;

  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalStdinIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.useFakeTimers();

    // Default to interactive mode for tests
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });

    mockConfig = {
      setTrustedFolder: vi.fn(),
      storage: { getProjectRoot: () => '/test/path' },
    };

    mockSettings = {
      merged: {
        security: {
          folderTrust: {
            enabled: true,
          },
        },
        permissions: {},
      },
      setValue: vi.fn(),
      updateValue: vi.fn().mockReturnValue(true),
      setTrusted: vi.fn(),
    } as unknown as LoadedSettings;

    mockedIsWorkspaceTrusted.mockReset();
    mockedCwd.mockReturnValue('/test/path');
    onTrustChange = vi.fn();
    addItem = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTTY,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true,
      writable: true,
    });
  });

  it('should not open dialog when folder is already trusted', async () => {
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: true,
      source: 'file',
    });
    const { result } = await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );
    expect(result.current.isFolderTrustDialogOpen).toBe(false);
    expect(onTrustChange).toHaveBeenCalledWith(true);
  });

  it('requires trust for the original project when resuming from a trusted worktree', async () => {
    const projectRoot = '/project';
    const worktree = `${projectRoot}/.qwen/worktrees/resumed`;
    mockedCwd.mockReturnValue(worktree);
    mockConfig.storage.getProjectRoot = () => projectRoot;
    mockSettings.merged.permissions.trustDirectories = [worktree];
    const { isWorkspaceTrusted } = await vi.importActual<
      typeof import('../../config/trustedFolders.js')
    >('../../config/trustedFolders.js');
    mockedIsWorkspaceTrusted.mockImplementation(isWorkspaceTrusted);

    const { result, unmount } = await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );

    expect(result.current.isFolderTrustDialogOpen).toBe(true);
    expect(onTrustChange).toHaveBeenLastCalledWith(undefined);
    expect(FolderTrustDiscoveryService.discover).toHaveBeenCalledWith(
      projectRoot,
    );
    expect(mockConfig.setTrustedFolder).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleFolderTrustSelect(
        FolderTrustChoice.TRUST_FOLDER,
      );
    });
    const update = vi.mocked(mockSettings.updateValue).mock.calls[0][2];
    const savedDirectories = update([worktree]) as string[];
    expect(savedDirectories).toEqual([worktree, projectRoot]);
    expect(update(savedDirectories)).toEqual(savedDirectories);
    expect(mockConfig.setTrustedFolder).toHaveBeenCalledWith(true);
    expect(result.current.isFolderTrustDialogOpen).toBe(false);
    unmount();

    // A subsequent resume reads the same directory that the dialog persisted.
    mockSettings.merged.permissions.trustDirectories = savedDirectories;
    const resumed = await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );
    expect(resumed.result.current.isFolderTrustDialogOpen).toBe(false);
    expect(onTrustChange).toHaveBeenLastCalledWith(true);
    resumed.unmount();
  });

  it('should not open dialog when folder is already untrusted', async () => {
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: false,
      source: 'file',
    });
    const { result } = await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );
    expect(result.current.isFolderTrustDialogOpen).toBe(false);
    expect(onTrustChange).toHaveBeenCalledWith(false);
  });

  it('should open dialog when folder trust is undefined', async () => {
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: undefined,
      source: undefined,
    });
    const { result } = await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );
    await waitFor(() => {
      expect(result.current.isFolderTrustDialogOpen).toBe(true);
    });
    expect(onTrustChange).toHaveBeenCalledWith(undefined);
  });

  it('should send a message if the folder is untrusted', async () => {
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: false,
      source: 'file',
    });
    await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );
    expect(addItem).toHaveBeenCalledWith(
      {
        text: 'This folder is untrusted, project settings, hooks, MCPs, and AGENTS.md files will not be applied for this folder.\nUse the `/permissions` command to change the trust level.',
        type: 'info',
      },
      expect.any(Number),
    );
  });

  it('should not send a message if the folder is trusted', async () => {
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: true,
      source: 'file',
    });
    await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );
    expect(addItem).not.toHaveBeenCalled();
  });

  it('should handle TRUST_FOLDER choice and update trust reactively', async () => {
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: undefined,
      source: undefined,
    });

    const { result } = await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );

    await waitFor(() => {
      expect(result.current.isTrusted).toBeUndefined();
    });

    await act(async () => {
      await result.current.handleFolderTrustSelect(
        FolderTrustChoice.TRUST_FOLDER,
      );
    });

    await waitFor(() => {
      expect(mockSettings.updateValue).toHaveBeenCalledWith(
        'User',
        'permissions.trustDirectories',
        expect.any(Function),
      );
      expect(mockSettings.setTrusted).toHaveBeenCalledWith(true);
      expect(
        vi.mocked(mockSettings.setTrusted).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(mockConfig.setTrustedFolder).mock.invocationCallOrder[0],
      );
      expect(mockConfig.setTrustedFolder).toHaveBeenCalledWith(true);
      expect(result.current.isFolderTrustDialogOpen).toBe(false);
      expect(onTrustChange).toHaveBeenLastCalledWith(true);
    });
  });

  it('should reactively update trust when status changes from false to true', async () => {
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: false,
      source: 'file',
    }); // Initially untrusted

    const { result } = await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );

    await waitFor(() => {
      expect(result.current.isTrusted).toBe(false);
    });

    await act(async () => {
      await result.current.handleFolderTrustSelect(
        FolderTrustChoice.TRUST_FOLDER,
      );
    });

    await waitFor(() => {
      expect(mockConfig.setTrustedFolder).toHaveBeenCalledWith(true);
      expect(result.current.isFolderTrustDialogOpen).toBe(false);
    });
  });

  it('should close dialog when trust status does not change (true -> true)', async () => {
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: true,
      source: 'file',
    });
    const { result } = await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );

    await act(async () => {
      await result.current.handleFolderTrustSelect(
        FolderTrustChoice.TRUST_FOLDER,
      );
    });

    await waitFor(() => {
      expect(result.current.isFolderTrustDialogOpen).toBe(false); // Dialog should close
    });
  });

  it('should emit feedback on failure to set value', async () => {
    mockedIsWorkspaceTrusted.mockReturnValue({
      isTrusted: undefined,
      source: undefined,
    });
    (mockSettings.updateValue as Mock).mockReturnValue(false);
    const emitFeedbackSpy = vi.spyOn(coreEvents, 'emitFeedback');
    const { result } = await renderHook(() =>
      useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
    );

    await act(async () => {
      await result.current.handleFolderTrustSelect(
        FolderTrustChoice.TRUST_FOLDER,
      );
    });

    await vi.runAllTimersAsync();

    expect(emitFeedbackSpy).toHaveBeenCalledWith(
      'error',
      'Failed to save trust settings. Exiting Qwen Code.',
    );
    expect(mockedGracefulExit).toHaveBeenCalledWith(
      ExitCodes.FATAL_CONFIG_ERROR,
      { exitReason: 'error' },
    );
  });

  describe('headless mode', () => {
    it('should force trust and hide dialog in headless mode', async () => {
      vi.mocked(isHeadlessMode).mockReturnValue(true);
      mockedIsWorkspaceTrusted.mockReturnValue({
        isTrusted: false,
        source: 'file',
      });

      const { result } = await renderHook(() =>
        useFolderTrust(mockSettings, mockConfig, onTrustChange, addItem),
      );

      expect(result.current.isFolderTrustDialogOpen).toBe(false);
      expect(onTrustChange).toHaveBeenCalledWith(true);
      expect(addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('This folder is untrusted'),
        }),
        expect.any(Number),
      );
    });
  });
});
