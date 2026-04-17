/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getInstallationInfo, PackageManager } from './installationInfo.js';
import { updateEventEmitter } from './updateEventEmitter.js';
import type { UpdateObject } from '../ui/utils/updateCheck.js';
import type { LoadedSettings } from '../config/settings.js';
import EventEmitter from 'node:events';
import { handleAutoUpdate, setUpdateHandler } from './handleAutoUpdate.js';
import { MessageType } from '../ui/types.js';

vi.mock('./installationInfo.js', async () => {
  const actual = await vi.importActual('./installationInfo.js');
  return {
    ...actual,
    getInstallationInfo: vi.fn(),
  };
});

vi.mock('./updateEventEmitter.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    updateEventEmitter: new EventEmitter(),
  };
});

interface MockChildProcess extends EventEmitter {
  stdin: EventEmitter & {
    write: Mock;
    end: Mock;
  };
  stderr: EventEmitter;
}

const mockGetInstallationInfo = vi.mocked(getInstallationInfo);

describe('handleAutoUpdate', () => {
  let mockSpawn: Mock;
  let mockUpdateInfo: UpdateObject;
  let mockSettings: LoadedSettings;
  let mockChildProcess: MockChildProcess;
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSpawn = vi.fn();
    vi.clearAllMocks();
    emitSpy = vi.spyOn(updateEventEmitter, 'emit');
    mockUpdateInfo = {
      update: {
        latest: '2.0.0',
        current: '1.0.0',
        type: 'major',
        name: '@qwen-code/qwen-code',
      },
      message: 'An update is available!',
    };

    mockSettings = {
      merged: {
        general: {
          enableAutoUpdate: true,
        },
      },
    } as LoadedSettings;

    mockChildProcess = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(),
      }),
      stderr: new EventEmitter(),
    }) as MockChildProcess;

    mockSpawn.mockReturnValue(
      mockChildProcess as unknown as ReturnType<typeof mockSpawn>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should do nothing if update info is null', () => {
    handleAutoUpdate(null, mockSettings, '/root', mockSpawn);
    expect(mockGetInstallationInfo).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should show manual update message when enableAutoUpdate is false', () => {
    // When enableAutoUpdate is false, gemini.tsx won't call checkForUpdates(),
    // but if handleAutoUpdate is still called, it should show a manual update message.
    mockSettings.merged.general!.enableAutoUpdate = false;
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: 'npm i -g @qwen-code/qwen-code@latest',
      updateMessage:
        'Please run npm i -g @qwen-code/qwen-code@latest to update',
      isGlobal: true,
      packageManager: PackageManager.NPM,
    });

    handleAutoUpdate(mockUpdateInfo, mockSettings, '/root', mockSpawn);

    // Should still emit update-received with manual update message
    expect(emitSpy).toHaveBeenCalledWith('update-received', {
      message:
        'An update is available!\nPlease run npm i -g @qwen-code/qwen-code@latest to update',
    });
    // Should NOT spawn update when enableAutoUpdate is false
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should emit "update-received" but not update if no update command is found', () => {
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: undefined,
      updateMessage: 'Cannot determine update command.',
      isGlobal: false,
      packageManager: PackageManager.NPM,
    });

    handleAutoUpdate(mockUpdateInfo, mockSettings, '/root', mockSpawn);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('update-received', {
      message: 'An update is available!\nCannot determine update command.',
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should combine update messages correctly', () => {
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: undefined, // No command to prevent spawn
      updateMessage: 'This is an additional message.',
      isGlobal: false,
      packageManager: PackageManager.NPM,
    });

    handleAutoUpdate(mockUpdateInfo, mockSettings, '/root', mockSpawn);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith('update-received', {
      message: 'An update is available!\nThis is an additional message.',
    });
  });

  it('should attempt to perform an update when conditions are met', async () => {
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: 'npm i -g @qwen-code/qwen-code@latest',
      updateMessage: 'This is an additional message.',
      isGlobal: false,
      packageManager: PackageManager.NPM,
    });

    // Simulate successful execution
    setTimeout(() => {
      mockChildProcess.emit('close', 0);
    }, 0);

    handleAutoUpdate(mockUpdateInfo, mockSettings, '/root', mockSpawn);

    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('should emit "update-failed" when the update process fails', async () => {
    await new Promise<void>((resolve) => {
      mockGetInstallationInfo.mockReturnValue({
        updateCommand: 'npm i -g @qwen-code/qwen-code@latest',
        updateMessage: 'This is an additional message.',
        isGlobal: false,
        packageManager: PackageManager.NPM,
      });

      // Simulate failed execution
      setTimeout(() => {
        mockChildProcess.stderr.emit('data', 'An error occurred');
        mockChildProcess.emit('close', 1);
        resolve();
      }, 0);

      handleAutoUpdate(mockUpdateInfo, mockSettings, '/root', mockSpawn);
    });

    expect(emitSpy).toHaveBeenCalledWith('update-failed', {
      message:
        'Automatic update failed. Please try updating manually. (command: npm i -g @qwen-code/qwen-code@2.0.0, stderr: An error occurred)',
    });
  });

  it('should emit "update-failed" when the spawn function throws an error', async () => {
    await new Promise<void>((resolve) => {
      mockGetInstallationInfo.mockReturnValue({
        updateCommand: 'npm i -g @qwen-code/qwen-code@latest',
        updateMessage: 'This is an additional message.',
        isGlobal: false,
        packageManager: PackageManager.NPM,
      });

      // Simulate an error event
      setTimeout(() => {
        mockChildProcess.emit('error', new Error('Spawn error'));
        resolve();
      }, 0);

      handleAutoUpdate(mockUpdateInfo, mockSettings, '/root', mockSpawn);
    });

    expect(emitSpy).toHaveBeenCalledWith('update-failed', {
      message:
        'Automatic update failed. Please try updating manually. (error: Spawn error)',
    });
  });

  it('should use the "@nightly" tag for nightly updates', async () => {
    mockUpdateInfo.update.latest = '2.0.0-nightly';
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: 'npm i -g @qwen-code/qwen-code@latest',
      updateMessage: 'This is an additional message.',
      isGlobal: false,
      packageManager: PackageManager.NPM,
    });

    handleAutoUpdate(mockUpdateInfo, mockSettings, '/root', mockSpawn);

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/^(bash|cmd\.exe)$/),
      expect.arrayContaining([
        expect.stringMatching(/^(-c|\/c)$/),
        'npm i -g @qwen-code/qwen-code@nightly',
      ]),
      {
        stdio: 'pipe',
      },
    );
  });

  it('should emit "update-success" when the update process succeeds', async () => {
    await new Promise<void>((resolve) => {
      mockGetInstallationInfo.mockReturnValue({
        updateCommand: 'npm i -g @qwen-code/qwen-code@latest',
        updateMessage: 'This is an additional message.',
        isGlobal: false,
        packageManager: PackageManager.NPM,
      });

      // Simulate successful execution
      setTimeout(() => {
        mockChildProcess.emit('close', 0);
        resolve();
      }, 0);

      handleAutoUpdate(mockUpdateInfo, mockSettings, '/root', mockSpawn);
    });

    expect(emitSpy).toHaveBeenCalledWith('update-success', {
      message:
        'Update successful! The new version will be used on your next run.',
    });
  });
});

describe('setUpdateHandler', () => {
  let addItem: Mock;
  let setUpdateInfo: Mock;

  beforeEach(() => {
    addItem = vi.fn();
    setUpdateInfo = vi.fn();
    updateEventEmitter.removeAllListeners();
  });

  afterEach(() => {
    updateEventEmitter.removeAllListeners();
  });

  it('should call addItem immediately when idle', () => {
    const isIdleRef = { current: true };
    const { cleanup } = setUpdateHandler(addItem, setUpdateInfo, isIdleRef);

    updateEventEmitter.emit('update-success', {
      message: 'Update successful!',
    });

    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: 'Update successful! The new version will be used on your next run.',
      },
      expect.any(Number),
    );

    cleanup();
  });

  it('should defer addItem when not idle (update-success)', () => {
    const isIdleRef = { current: false };
    const { cleanup } = setUpdateHandler(addItem, setUpdateInfo, isIdleRef);

    updateEventEmitter.emit('update-success', {
      message: 'Update successful!',
    });

    expect(addItem).not.toHaveBeenCalled();

    cleanup();
  });

  it('should defer addItem when not idle (update-failed)', () => {
    const isIdleRef = { current: false };
    const { cleanup } = setUpdateHandler(addItem, setUpdateInfo, isIdleRef);

    updateEventEmitter.emit('update-failed', {
      message: 'Update failed',
    });

    expect(addItem).not.toHaveBeenCalled();

    cleanup();
  });

  it('should flush deferred notifications when flush is called', () => {
    const isIdleRef = { current: false };
    const { cleanup, flush } = setUpdateHandler(
      addItem,
      setUpdateInfo,
      isIdleRef,
    );

    updateEventEmitter.emit('update-success', {
      message: 'Update successful!',
    });

    expect(addItem).not.toHaveBeenCalled();

    isIdleRef.current = true;
    flush();

    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: 'Update successful! The new version will be used on your next run.',
      },
      expect.any(Number),
    );

    cleanup();
  });

  it('should flush update-failed notifications correctly', () => {
    const isIdleRef = { current: false };
    const { cleanup, flush } = setUpdateHandler(
      addItem,
      setUpdateInfo,
      isIdleRef,
    );

    updateEventEmitter.emit('update-failed', {
      message: 'Update failed',
    });

    expect(addItem).not.toHaveBeenCalled();

    flush();

    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: 'Automatic update failed. Please try updating manually',
      },
      expect.any(Number),
    );

    cleanup();
  });

  it('should flush multiple deferred notifications in order', () => {
    const isIdleRef = { current: false };
    const { cleanup, flush } = setUpdateHandler(
      addItem,
      setUpdateInfo,
      isIdleRef,
    );

    updateEventEmitter.emit('update-info', { message: 'Info message' });
    updateEventEmitter.emit('update-success', { message: 'Success!' });

    expect(addItem).not.toHaveBeenCalled();

    flush();

    expect(addItem).toHaveBeenCalledTimes(2);
    expect(addItem).toHaveBeenNthCalledWith(
      1,
      { type: MessageType.INFO, text: 'Info message' },
      expect.any(Number),
    );
    expect(addItem).toHaveBeenNthCalledWith(
      2,
      {
        type: MessageType.INFO,
        text: 'Update successful! The new version will be used on your next run.',
      },
      expect.any(Number),
    );

    cleanup();
  });

  it('should clear pending notifications on cleanup', () => {
    const isIdleRef = { current: false };
    const { cleanup, flush } = setUpdateHandler(
      addItem,
      setUpdateInfo,
      isIdleRef,
    );

    updateEventEmitter.emit('update-success', { message: 'Success!' });
    expect(addItem).not.toHaveBeenCalled();

    cleanup();
    flush();

    // Pending queue was cleared by cleanup, so addItem should not be called
    expect(addItem).not.toHaveBeenCalled();
  });

  it('should be a no-op when flushing an empty queue', () => {
    const isIdleRef = { current: true };
    const { cleanup, flush } = setUpdateHandler(
      addItem,
      setUpdateInfo,
      isIdleRef,
    );

    flush();

    expect(addItem).not.toHaveBeenCalled();

    cleanup();
  });

  it('should deliver immediately after transitioning from busy to idle', () => {
    const isIdleRef = { current: false };
    const { cleanup, flush } = setUpdateHandler(
      addItem,
      setUpdateInfo,
      isIdleRef,
    );

    // First event while busy — deferred
    updateEventEmitter.emit('update-info', { message: 'Deferred msg' });
    expect(addItem).not.toHaveBeenCalled();

    // Transition to idle
    isIdleRef.current = true;

    // Next event while idle — delivered immediately
    updateEventEmitter.emit('update-info', { message: 'Immediate msg' });
    expect(addItem).toHaveBeenCalledTimes(1);
    expect(addItem).toHaveBeenCalledWith(
      { type: MessageType.INFO, text: 'Immediate msg' },
      expect.any(Number),
    );

    // The earlier deferred message should still be in the queue
    flush();
    expect(addItem).toHaveBeenCalledTimes(2);
    expect(addItem).toHaveBeenNthCalledWith(
      2,
      { type: MessageType.INFO, text: 'Deferred msg' },
      expect.any(Number),
    );

    cleanup();
  });
});
