/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listCommand, handleList } from './list.js';
import { t } from '../../i18n/index.js';
import yargs from 'yargs';

const mockGetLoadedExtensions = vi.hoisted(() => vi.fn());
const mockGetAllLoadedExtensions = vi.hoisted(() => vi.fn());
const mockGetExtensionStoreSnapshot = vi.hoisted(() => vi.fn());
const mockToOutputString = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    getLoadedExtensions: mockGetLoadedExtensions,
    getAllLoadedExtensions: mockGetAllLoadedExtensions,
    getExtensionStoreSnapshot: mockGetExtensionStoreSnapshot,
    toOutputString: mockToOutputString,
  }),
  extensionToOutputString: mockToOutputString,
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

describe('extensions list command', () => {
  it('should parse the list command', () => {
    const parser = yargs([]).command(listCommand).fail(false).locale('en');
    expect(() => parser.parse('list')).not.toThrow();
  });
});

describe('handleList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllLoadedExtensions.mockImplementation(mockGetLoadedExtensions);
    mockGetExtensionStoreSnapshot.mockResolvedValue({ extensions: {} });
  });

  it('should display message when no extensions are installed', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockGetLoadedExtensions.mockReturnValueOnce([]);

    await handleList();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      t('No extensions installed.'),
    );

    processExitSpy.mockRestore();
  });

  it('should list installed extensions', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    const mockExtensions = [
      { name: 'extension-1', version: '1.0.0' },
      { name: 'extension-2', version: '2.0.0' },
    ];
    mockGetLoadedExtensions.mockReturnValueOnce(mockExtensions);
    mockToOutputString.mockImplementation(
      (ext) => `${ext.name} (${ext.version})`,
    );

    await handleList();

    expect(mockGetLoadedExtensions).toHaveBeenCalled();
    expect(mockToOutputString).toHaveBeenCalledTimes(2);
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'extension-1 (1.0.0)\n\nextension-2 (2.0.0)',
    );

    processExitSpy.mockRestore();
  });

  it('shows only active versioned extensions in the current workspace', async () => {
    mockGetLoadedExtensions.mockReturnValue([
      {
        id: 'v1',
        name: 'demo',
        version: '1.0.0',
        versionSlot: '1.0.0',
        isActive: true,
      },
      {
        id: 'v2',
        name: 'demo',
        version: '2.0.0',
        versionSlot: '2.0.0',
        isActive: false,
      },
    ]);
    mockToOutputString.mockImplementation(
      (ext) => `${ext.name} (${ext.version})`,
    );

    await handleList();
    expect(mockGetAllLoadedExtensions).toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('demo (1.0.0)');

    await handleList({ all: true });
    expect(mockGetExtensionStoreSnapshot).toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenLastCalledWith(
      'demo (1.0.0)\n\ndemo (2.0.0)',
    );
  });

  it('should handle errors and exit with code 1', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockGetLoadedExtensions.mockImplementationOnce(() => {
      throw new Error('List failed');
    });

    await handleList();

    expect(mockWriteStderrLine).toHaveBeenCalledWith('List failed');
    expect(processExitSpy).toHaveBeenCalledWith(1);

    processExitSpy.mockRestore();
  });
});
