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
import { listCommand, handleList } from './list.js';
import yargs from 'yargs';

const mockGetLoadedExtensions = vi.hoisted(() => vi.fn());
const mockToOutputString = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    getLoadedExtensions: mockGetLoadedExtensions,
    toOutputString: mockToOutputString,
  }),
  extensionToOutputString: mockToOutputString,
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

describe('extensions list command', () => {
  it('should parse the list command', () => {
    const parser = yargs([]).command(listCommand).fail(false).locale('en');
    expect(() => parser.parse('list')).not.toThrow();
  });
});

describe('handleList', () => {
  let consoleLogSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  let processExitSpy: MockInstance;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    vi.clearAllMocks();
  });

  it('should display message when no extensions are installed', async () => {
    mockGetLoadedExtensions.mockReturnValueOnce([]);

    await handleList();

    expect(consoleLogSpy).toHaveBeenCalledWith('No extensions installed.');
  });

  it('should list installed extensions', async () => {
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
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'extension-1 (1.0.0)\n\nextension-2 (2.0.0)',
    );
  });

  it('should handle errors and exit with code 1', async () => {
    mockGetLoadedExtensions.mockImplementationOnce(() => {
      throw new Error('List failed');
    });

    await handleList();

    expect(consoleErrorSpy).toHaveBeenCalledWith('List failed');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
