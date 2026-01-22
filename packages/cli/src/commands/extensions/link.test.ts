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
import { linkCommand, handleLink } from './link.js';
import yargs from 'yargs';

const mockInstallExtension = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    installExtension: mockInstallExtension,
  }),
}));

vi.mock('./consent.js', () => ({
  requestConsentNonInteractive: vi.fn().mockResolvedValue(true),
  requestConsentOrFail: vi.fn(),
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

describe('extensions link command', () => {
  it('should fail if no path is provided', () => {
    const validationParser = yargs([])
      .command(linkCommand)
      .fail(false)
      .locale('en');
    expect(() => validationParser.parse('link')).toThrow(
      'Not enough non-option arguments: got 0, need at least 1',
    );
  });

  it('should accept a path argument', () => {
    const parser = yargs([]).command(linkCommand).fail(false).locale('en');
    expect(() => parser.parse('link /some/path')).not.toThrow();
  });
});

describe('handleLink', () => {
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

  it('should link an extension from a local path', async () => {
    mockInstallExtension.mockResolvedValueOnce({ name: 'linked-extension' });

    await handleLink({
      path: '/some/local/path',
    });

    expect(mockInstallExtension).toHaveBeenCalledWith(
      {
        source: '/some/local/path',
        type: 'link',
      },
      expect.any(Function),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'Extension "linked-extension" linked successfully and enabled.',
    );
  });

  it('should handle errors and exit with code 1', async () => {
    mockInstallExtension.mockRejectedValueOnce(new Error('Link failed'));

    await handleLink({
      path: '/some/local/path',
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('Link failed');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
