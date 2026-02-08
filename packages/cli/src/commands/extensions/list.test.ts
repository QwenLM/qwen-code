/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listCommand, handleList } from './list.js';
import yargs from 'yargs';

const mockGetLoadedExtensions = vi.hoisted(() => vi.fn());
const mockToOutputString = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

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
  });

  it('should display message when no extensions are installed', async () => {
    const processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);

    mockGetLoadedExtensions.mockReturnValueOnce([]);

    await handleList();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'No extensions installed.',
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
