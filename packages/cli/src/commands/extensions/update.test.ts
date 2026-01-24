/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type MockInstance,
} from 'vitest';
import { updateCommand, handleUpdate } from './update.js';
import yargs from 'yargs';
import { ExtensionUpdateState } from '../../ui/state/extensions.js';

const mockGetLoadedExtensions = vi.hoisted(() => vi.fn());
const mockUpdateExtension = vi.hoisted(() => vi.fn());
const mockCheckForAllExtensionUpdates = vi.hoisted(() => vi.fn());
const mockUpdateAllUpdatableExtensions = vi.hoisted(() => vi.fn());
const mockCheckForExtensionUpdate = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    getLoadedExtensions: mockGetLoadedExtensions,
    updateExtension: mockUpdateExtension,
    checkForAllExtensionUpdates: mockCheckForAllExtensionUpdates,
    updateAllUpdatableExtensions: mockUpdateAllUpdatableExtensions,
  }),
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  checkForExtensionUpdate: mockCheckForExtensionUpdate,
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock('../../ui/state/extensions.js', () => ({
  ExtensionUpdateState: {
    UPDATE_AVAILABLE: 'update available',
    UP_TO_DATE: 'up to date',
    ERROR: 'error',
  },
}));

describe('extensions update command', () => {
  it('should fail if neither name nor --all is provided', () => {
    const validationParser = yargs([])
      .command(updateCommand)
      .fail(false)
      .locale('en');
    expect(() => validationParser.parse('update')).toThrow(
      'Either an extension name or --all must be provided',
    );
  });

  it('should fail if both name and --all are provided', () => {
    const validationParser = yargs([])
      .command(updateCommand)
      .fail(false)
      .locale('en');
    expect(() => validationParser.parse('update test-extension --all')).toThrow(
      /Arguments .* are mutually exclusive/,
    );
  });

  it('should accept --all flag', () => {
    const parser = yargs([]).command(updateCommand).fail(false).locale('en');
    expect(() => parser.parse('update --all')).not.toThrow();
  });

  it('should accept an extension name', () => {
    const parser = yargs([]).command(updateCommand).fail(false).locale('en');
    expect(() => parser.parse('update test-extension')).not.toThrow();
  });
});

describe('handleUpdate', () => {
  let consoleLogSpy: MockInstance;
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  describe('update by name', () => {
    it('should show message when extension is not found', async () => {
      mockGetLoadedExtensions.mockReturnValueOnce([]);

      await handleUpdate({ name: 'non-existent-extension' });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Extension "non-existent-extension" not found.',
      );
    });

    it('should show message when extension has no install metadata', async () => {
      mockGetLoadedExtensions.mockReturnValueOnce([
        { name: 'test-extension', installMetadata: undefined },
      ]);

      await handleUpdate({ name: 'test-extension' });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Unable to install extension "test-extension" due to missing install metadata',
      );
    });

    it('should show message when extension is already up to date', async () => {
      const mockExtension = {
        name: 'test-extension',
        installMetadata: { source: 'test' },
      };
      mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);
      mockCheckForExtensionUpdate.mockResolvedValueOnce(
        ExtensionUpdateState.UP_TO_DATE,
      );

      await handleUpdate({ name: 'test-extension' });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Extension "test-extension" is already up to date.',
      );
    });

    it('should update extension when update is available', async () => {
      const mockExtension = {
        name: 'test-extension',
        installMetadata: { source: 'test' },
      };
      mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);
      mockCheckForExtensionUpdate.mockResolvedValueOnce(
        ExtensionUpdateState.UPDATE_AVAILABLE,
      );
      mockUpdateExtension.mockResolvedValueOnce({
        name: 'test-extension',
        originalVersion: '1.0.0',
        updatedVersion: '2.0.0',
      });

      await handleUpdate({ name: 'test-extension' });

      expect(mockUpdateExtension).toHaveBeenCalledWith(
        mockExtension,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        expect.any(Function),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Extension "test-extension" successfully updated: 1.0.0 → 2.0.0.',
      );
    });

    it('should show up to date message when versions are the same after update', async () => {
      const mockExtension = {
        name: 'test-extension',
        installMetadata: { source: 'test' },
      };
      mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);
      mockCheckForExtensionUpdate.mockResolvedValueOnce(
        ExtensionUpdateState.UPDATE_AVAILABLE,
      );
      mockUpdateExtension.mockResolvedValueOnce({
        name: 'test-extension',
        originalVersion: '1.0.0',
        updatedVersion: '1.0.0',
      });

      await handleUpdate({ name: 'test-extension' });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Extension "test-extension" is already up to date.',
      );
    });

    it('should handle errors during update', async () => {
      const mockExtension = {
        name: 'test-extension',
        installMetadata: { source: 'test' },
      };
      mockGetLoadedExtensions.mockReturnValueOnce([mockExtension]);
      mockCheckForExtensionUpdate.mockRejectedValueOnce(
        new Error('Update check failed'),
      );

      await handleUpdate({ name: 'test-extension' });

      expect(consoleErrorSpy).toHaveBeenCalledWith('Update check failed');
    });
  });

  describe('update all', () => {
    it('should show message when no extensions to update', async () => {
      mockCheckForAllExtensionUpdates.mockResolvedValueOnce(undefined);
      mockUpdateAllUpdatableExtensions.mockResolvedValueOnce([]);

      await handleUpdate({ all: true });

      expect(consoleLogSpy).toHaveBeenCalledWith('No extensions to update.');
    });

    it('should update all extensions with updates available', async () => {
      mockCheckForAllExtensionUpdates.mockResolvedValueOnce(undefined);
      mockUpdateAllUpdatableExtensions.mockResolvedValueOnce([
        {
          name: 'extension-1',
          originalVersion: '1.0.0',
          updatedVersion: '2.0.0',
        },
        {
          name: 'extension-2',
          originalVersion: '1.0.0',
          updatedVersion: '1.5.0',
        },
      ]);

      await handleUpdate({ all: true });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Extension "extension-1" successfully updated: 1.0.0 → 2.0.0.\n' +
          'Extension "extension-2" successfully updated: 1.0.0 → 1.5.0.',
      );
    });

    it('should filter out extensions with same version after update', async () => {
      mockCheckForAllExtensionUpdates.mockResolvedValueOnce(undefined);
      mockUpdateAllUpdatableExtensions.mockResolvedValueOnce([
        {
          name: 'extension-1',
          originalVersion: '1.0.0',
          updatedVersion: '2.0.0',
        },
        {
          name: 'extension-2',
          originalVersion: '1.0.0',
          updatedVersion: '1.0.0',
        },
      ]);

      await handleUpdate({ all: true });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Extension "extension-1" successfully updated: 1.0.0 → 2.0.0.',
      );
    });

    it('should handle errors during update all', async () => {
      mockCheckForAllExtensionUpdates.mockRejectedValueOnce(
        new Error('Update all failed'),
      );

      await handleUpdate({ all: true });

      expect(consoleErrorSpy).toHaveBeenCalledWith('Update all failed');
    });
  });
});
