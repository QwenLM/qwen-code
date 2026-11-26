/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingScope } from '../../config/settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { addDirCommand } from './addDirCommand.js';
import type { AddDirTrustChoice } from './AddDirTrustSelector.js';
import type { CommandContext } from './types.js';
import { MessageType } from '../types.js';

type AddDirDialogElement = React.ReactElement<{
  onSelect: (choice: AddDirTrustChoice) => void;
}>;

type AddWorkspaceDirectoryDialogElement = React.ReactElement<{
  onSubmit: (resolvedPath: string, choice: AddDirTrustChoice) => void;
}>;

function createPermissionModuleMock() {
  return {
    getAdditionalDirectories: vi.fn().mockReturnValue([] as string[]),
    setAdditionalDirectories: vi.fn(),
    addDirectory: vi.fn(),
  };
}

describe('addDirCommand', () => {
  let tempDir: string;
  let realTempDir: string;
  let mockContext: CommandContext;
  let mockAddDirectory: ReturnType<typeof vi.fn>;

  let mockSetValue: ReturnType<typeof vi.fn>;
  let persistedDirectories: unknown;
  let mockReloadSkills: ReturnType<typeof vi.fn>;
  let mockPermission: ReturnType<typeof createPermissionModuleMock>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-add-dir-'));
    realTempDir = fs.realpathSync(tempDir);
    mockPermission = createPermissionModuleMock();
    mockAddDirectory = vi.fn();
    mockSetValue = vi.fn();
    mockSetValue.mockImplementation((_scope, _path, updater) => {
      persistedDirectories = updater(['/existing']);
      return true;
    });
    persistedDirectories = undefined;
    mockReloadSkills = vi.fn().mockResolvedValue(undefined);

    mockContext = createMockCommandContext({
      services: {
        agentContext: {
          config: {
            getTargetDir: vi.fn().mockReturnValue(tempDir),
            getWorkspaceContext: vi.fn().mockReturnValue({
              addDirectory: mockAddDirectory,
            }),
            permission: mockPermission,
            reloadSkills: mockReloadSkills,
          },
        },
        settings: {
          local: {
            settings: {
              permissions: {
                additionalDirectories: ['/existing'],
              },
            },
          },
          updateValue: mockSetValue,
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function runAddDir(choice: AddDirTrustChoice) {
    if (!addDirCommand.action) {
      throw new Error('addDirCommand must have an action.');
    }

    const actionPromise = addDirCommand.action(mockContext, tempDir);
    const dialog = vi.mocked(mockContext.ui.setCustomDialog).mock
      .calls[0][0] as AddDirDialogElement;
    dialog.props.onSelect(choice);
    await actionPromise;
  }

  it('adds session-only directories to the current permission context', async () => {
    await runAddDir('memory');

    expect(mockAddDirectory).toHaveBeenCalledWith(realTempDir);
    expect(mockPermission.addDirectory).toHaveBeenCalledTimes(1);
    expect(mockPermission.addDirectory).toHaveBeenCalledWith(realTempDir);
    expect(mockSetValue).not.toHaveBeenCalled();
    expect(mockReloadSkills).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.reloadCommands).toHaveBeenCalledTimes(1);
  });

  it('adds persisted directories to settings and the current permission context', async () => {
    await runAddDir('persist');

    expect(mockAddDirectory).toHaveBeenCalledWith(realTempDir);
    expect(mockPermission.setAdditionalDirectories).toHaveBeenCalledTimes(1);
    expect(mockPermission.setAdditionalDirectories).toHaveBeenCalledWith([
      realTempDir,
    ]);
    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Local,
      'permissions.additionalDirectories',
      expect.any(Function),
    );
    expect(persistedDirectories).toEqual(['/existing', realTempDir]);
    expect(mockReloadSkills).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.reloadCommands).toHaveBeenCalledTimes(1);
  });

  it('does not update the current permission context when persistence fails', async () => {
    mockSetValue.mockReturnValue(false);

    await runAddDir('persist');

    expect(mockAddDirectory).not.toHaveBeenCalled();
    expect(mockPermission.setAdditionalDirectories).not.toHaveBeenCalled();
    expect(mockReloadSkills).not.toHaveBeenCalled();
    expect(mockContext.ui.reloadCommands).not.toHaveBeenCalled();
  });

  it('handles unexpected errors from the interactive add flow', async () => {
    mockPermission.addDirectory.mockImplementationOnce(() => {
      throw new Error('permission update failed');
    });

    if (!addDirCommand.action) {
      throw new Error('addDirCommand must have an action.');
    }

    const actionPromise = Promise.resolve(
      addDirCommand.action(mockContext, ''),
    );
    const dialog = vi.mocked(mockContext.ui.setCustomDialog).mock
      .calls[0][0] as AddWorkspaceDirectoryDialogElement;
    dialog.props.onSubmit(realTempDir, 'memory');
    await actionPromise;

    expect(mockReloadSkills).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: 'Failed to add directory: permission update failed',
      },
      expect.any(Number),
    );
  });

  it('reloads resources when the directory is already trusted', async () => {
    mockPermission.getAdditionalDirectories.mockReturnValue([realTempDir]);

    await runAddDir('memory');

    expect(mockAddDirectory).not.toHaveBeenCalled();
    expect(mockPermission.setAdditionalDirectories).not.toHaveBeenCalled();
    expect(mockPermission.addDirectory).not.toHaveBeenCalled();
    expect(mockSetValue).not.toHaveBeenCalled();
    expect(mockReloadSkills).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.reloadCommands).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.WARNING,
        text: `Directory already trusted: ${realTempDir}`,
      },
      expect.any(Number),
    );
  });

  it('waits for resource and command refresh before completing', async () => {
    let resolveReload: (() => void) | undefined;
    mockReloadSkills.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveReload = resolve;
      }),
    );

    if (!addDirCommand.action) {
      throw new Error('addDirCommand must have an action.');
    }

    let completed = false;
    const actionPromise = Promise.resolve(
      addDirCommand.action(mockContext, tempDir),
    ).then(() => {
      completed = true;
    });
    const dialog = vi.mocked(mockContext.ui.setCustomDialog).mock
      .calls[0][0] as AddDirDialogElement;
    dialog.props.onSelect('memory');

    await vi.waitFor(() => {
      expect(mockReloadSkills).toHaveBeenCalledTimes(1);
    });
    expect(completed).toBe(false);
    expect(mockContext.ui.reloadCommands).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).not.toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: `Added and trusted directory (this session only): ${realTempDir}`,
      },
      expect.any(Number),
    );

    resolveReload?.();
    await actionPromise;

    expect(completed).toBe(true);
    expect(mockContext.ui.reloadCommands).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: `Added and trusted directory (this session only): ${realTempDir}`,
      },
      expect.any(Number),
    );
  });

  it('stops waiting silently after three seconds while the refresh continues', async () => {
    vi.useFakeTimers();
    mockReloadSkills.mockReturnValueOnce(new Promise<void>(() => {}));

    if (!addDirCommand.action) {
      throw new Error('addDirCommand must have an action.');
    }

    const actionPromise = Promise.resolve(
      addDirCommand.action(mockContext, tempDir),
    );
    const dialog = vi.mocked(mockContext.ui.setCustomDialog).mock
      .calls[0][0] as AddDirDialogElement;
    dialog.props.onSelect('memory');
    await vi.advanceTimersByTimeAsync(0);

    expect(mockReloadSkills).toHaveBeenCalledTimes(1);
    expect(mockContext.ui.setPendingItem).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(mockContext.ui.setPendingItem).toHaveBeenCalledWith({
      type: MessageType.INFO,
      text: 'Refreshing skills...',
    });

    await vi.advanceTimersByTimeAsync(2900);
    await actionPromise;

    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
    expect(mockContext.ui.setPendingItem).toHaveBeenLastCalledWith(null);
    expect(mockContext.ui.reloadCommands).not.toHaveBeenCalled();
  });

  it('keeps the directory and reports a warning when skill refresh fails', async () => {
    mockReloadSkills.mockRejectedValueOnce(new Error('reload failed'));

    await runAddDir('memory');

    expect(mockAddDirectory).toHaveBeenCalledWith(realTempDir);
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.WARNING,
        text: 'Directory is trusted, but resources could not be refreshed: reload failed',
      }),
      expect.any(Number),
    );
    expect(mockContext.ui.reloadCommands).not.toHaveBeenCalled();
  });
});
