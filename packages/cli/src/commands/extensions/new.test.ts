/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { newCommand } from './new.js';
import yargs from 'yargs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises');

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

const mockedFs = vi.mocked(fsPromises);

describe('extensions new command', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    const fakeFiles = [
      { name: 'context', isDirectory: () => true },
      { name: 'custom-commands', isDirectory: () => true },
      { name: 'mcp-server', isDirectory: () => true },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFs.readdir.mockResolvedValue(fakeFiles as any);
  });

  it('should fail if no path is provided', async () => {
    const parser = yargs([]).command(newCommand).fail(false).locale('en');
    await expect(parser.parseAsync('new')).rejects.toThrow(
      'Not enough non-option arguments: got 0, need at least 1',
    );
  });

  it('should create directory when no template is provided', async () => {
    mockedFs.access.mockRejectedValue(new Error('ENOENT'));
    mockedFs.mkdir.mockResolvedValue(undefined);

    const parser = yargs([]).command(newCommand).fail(false);

    await parser.parseAsync('new /some/path');

    expect(mockedFs.mkdir).toHaveBeenCalledWith('/some/path', {
      recursive: true,
    });
    expect(mockedFs.cp).not.toHaveBeenCalled();
  });

  it('should create directory and copy files when path does not exist', async () => {
    mockedFs.access.mockRejectedValue(new Error('ENOENT'));
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.cp.mockResolvedValue(undefined);

    const parser = yargs([]).command(newCommand).fail(false);

    await parser.parseAsync('new /some/path context');

    expect(mockedFs.mkdir).toHaveBeenCalledWith('/some/path', {
      recursive: true,
    });
    expect(mockedFs.cp).toHaveBeenCalledWith(
      expect.stringContaining(path.normalize('context/context')),
      path.normalize('/some/path/context'),
      { recursive: true },
    );
    expect(mockedFs.cp).toHaveBeenCalledWith(
      expect.stringContaining(path.normalize('context/custom-commands')),
      path.normalize('/some/path/custom-commands'),
      { recursive: true },
    );
    expect(mockedFs.cp).toHaveBeenCalledWith(
      expect.stringContaining(path.normalize('context/mcp-server')),
      path.normalize('/some/path/mcp-server'),
      { recursive: true },
    );
  });

  it('should still create an extension when the examples directory is missing', async () => {
    mockedFs.readdir.mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      }),
    );
    mockedFs.access.mockRejectedValue(new Error('ENOENT'));
    mockedFs.mkdir.mockResolvedValue(undefined);

    const parser = yargs([]).command(newCommand).fail(false);

    await parser.parseAsync('new /some/path');

    expect(mockedFs.mkdir).toHaveBeenCalledWith('/some/path', {
      recursive: true,
    });
    expect(mockedFs.cp).not.toHaveBeenCalled();
    // A plainly missing directory is the expected degraded state, not an
    // install problem worth warning about.
    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });

  it('should reject a template argument with a clear error when the examples directory is missing', async () => {
    mockedFs.readdir.mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      }),
    );
    mockedFs.access.mockRejectedValue(new Error('ENOENT'));
    mockedFs.mkdir.mockResolvedValue(undefined);

    const parser = yargs([]).command(newCommand).fail(false);

    await expect(parser.parseAsync('new /some/path context')).rejects.toThrow(
      'No boilerplate templates are available in this installation.',
    );

    expect(mockedFs.mkdir).not.toHaveBeenCalled();
    expect(mockedFs.cp).not.toHaveBeenCalled();
  });

  it('should reject a template that is not in the available list', async () => {
    mockedFs.access.mockRejectedValue(new Error('ENOENT'));
    mockedFs.mkdir.mockResolvedValue(undefined);

    const parser = yargs([]).command(newCommand).fail(false).locale('en');

    await expect(parser.parseAsync('new /some/path bogus')).rejects.toThrow(
      /Invalid values/,
    );

    expect(mockedFs.mkdir).not.toHaveBeenCalled();
    expect(mockedFs.cp).not.toHaveBeenCalled();
  });

  it('should still create an extension when reading templates fails with a non-ENOENT error', async () => {
    mockedFs.readdir.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      }),
    );
    mockedFs.access.mockRejectedValue(new Error('ENOENT'));
    mockedFs.mkdir.mockResolvedValue(undefined);

    const parser = yargs([]).command(newCommand).fail(false);

    await parser.parseAsync('new /some/path');

    expect(mockedFs.mkdir).toHaveBeenCalledWith('/some/path', {
      recursive: true,
    });
    expect(mockedFs.cp).not.toHaveBeenCalled();
    // Unexpected errors must be surfaced, not silently treated as
    // "no templates installed".
    expect(mockWriteStderrLine).toHaveBeenCalledTimes(1);
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Warning: failed to read extension templates'),
    );
  });

  it('should warn and reject a template argument when reading templates fails with a non-ENOENT error', async () => {
    mockedFs.readdir.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      }),
    );
    mockedFs.access.mockRejectedValue(new Error('ENOENT'));
    mockedFs.mkdir.mockResolvedValue(undefined);

    const parser = yargs([]).command(newCommand).fail(false);

    await expect(parser.parseAsync('new /some/path context')).rejects.toThrow(
      'Extension templates could not be read in this installation.',
    );

    expect(mockedFs.mkdir).not.toHaveBeenCalled();
    expect(mockedFs.cp).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledTimes(1);
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Warning: failed to read extension templates'),
    );
  });

  it('should throw an error if the path already exists', async () => {
    mockedFs.access.mockResolvedValue(undefined);
    const parser = yargs([]).command(newCommand).fail(false);

    await expect(parser.parseAsync('new /some/path context')).rejects.toThrow(
      'Path already exists: /some/path',
    );

    expect(mockedFs.mkdir).not.toHaveBeenCalled();
    expect(mockedFs.cp).not.toHaveBeenCalled();
  });
});
