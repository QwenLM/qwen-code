/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sourcesCommand,
  handleSourcesAdd,
  handleSourcesRemove,
  handleSourcesList,
  handleSourcesUpdate,
} from './sources.js';
import yargs from 'yargs';

const mockAddSource = vi.hoisted(() => vi.fn());
const mockRemoveSource = vi.hoisted(() => vi.fn());
const mockGetSources = vi.hoisted(() => vi.fn());
const mockLoadSource = vi.hoisted(() => vi.fn());
const mockMarkSourceUpdated = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('./utils.js', () => ({
  getExtensionManager: vi.fn().mockResolvedValue({
    addSource: mockAddSource,
    removeSource: mockRemoveSource,
    getSources: mockGetSources,
    loadSource: mockLoadSource,
    markSourceUpdated: mockMarkSourceUpdated,
  }),
}));

vi.mock('../../utils/errors.js', () => ({
  getErrorMessage: vi.fn((error: Error) => error.message),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
  clearScreen: vi.fn(),
}));

describe('extensions sources command', () => {
  it('should parse the sources subcommands', () => {
    // Benign mock returns: parse() invokes the handlers asynchronously.
    mockAddSource.mockResolvedValue({ name: 'my-marketplace' });
    mockRemoveSource.mockReturnValue(true);
    mockGetSources.mockReturnValue([
      { name: 'my-marketplace', source: 'owner/repo', type: 'github' },
    ]);
    mockLoadSource.mockResolvedValue({ name: 'my-marketplace', entries: [] });
    // A fresh parser per parse: yargs carries validation state across calls.
    const parse = (command: string) =>
      yargs([]).command(sourcesCommand).fail(false).locale('en').parse(command);
    expect(() => parse('sources add owner/repo')).not.toThrow();
    expect(() => parse('sources remove my-marketplace')).not.toThrow();
    expect(() => parse('sources list')).not.toThrow();
    expect(() => parse('sources update my-marketplace')).not.toThrow();
  });

  it('should fail without a subcommand', () => {
    const parser = yargs([]).command(sourcesCommand).fail(false).locale('en');
    expect(() => parser.parse('sources')).toThrow();
  });
});

describe('handleSourcesAdd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds a marketplace and reports its name', async () => {
    mockAddSource.mockResolvedValue({
      name: 'my-marketplace',
      source: 'owner/repo',
      type: 'github',
    });

    await handleSourcesAdd({ source: 'owner/repo' });

    expect(mockAddSource).toHaveBeenCalledWith('owner/repo');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Added marketplace "my-marketplace".',
    );
  });

  it('reports errors and exits with code 1', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    mockAddSource.mockRejectedValue(new Error('No marketplace found'));

    await handleSourcesAdd({ source: 'owner/repo' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith('No marketplace found');
    expect(processSpy).toHaveBeenCalledWith(1);
    processSpy.mockRestore();
  });
});

describe('handleSourcesRemove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes a marketplace by name', async () => {
    mockRemoveSource.mockReturnValue(true);

    await handleSourcesRemove({ name: 'my-marketplace' });

    expect(mockRemoveSource).toHaveBeenCalledWith('my-marketplace');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Removed marketplace "my-marketplace".',
    );
  });

  it('errors when the marketplace is unknown', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    mockRemoveSource.mockReturnValue(false);

    await handleSourcesRemove({ name: 'missing' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Marketplace "missing" not found.',
    );
    expect(processSpy).toHaveBeenCalledWith(1);
    processSpy.mockRestore();
  });
});

describe('handleSourcesList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prints a message when no sources are configured', async () => {
    mockGetSources.mockReturnValue([]);

    await handleSourcesList();

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'No marketplace sources added yet.',
    );
  });

  it('lists configured sources with source and type', async () => {
    mockGetSources.mockReturnValue([
      {
        name: 'market-a',
        source: 'owner/repo',
        type: 'github',
        lastUpdatedAt: '2026-06-10T00:00:00.000Z',
      },
      {
        name: 'market-b',
        source: 'https://example.com/marketplace.json',
        type: 'http',
      },
    ]);

    await handleSourcesList();

    const output = mockWriteStdoutLine.mock.calls[0][0] as string;
    expect(output).toContain('market-a');
    expect(output).toContain('owner/repo');
    expect(output).toContain('market-b');
    expect(output).toContain('https://example.com/marketplace.json');
  });
});

describe('handleSourcesUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-fetches the marketplace and reports the plugin count', async () => {
    mockGetSources.mockReturnValue([
      { name: 'market-a', source: 'owner/repo', type: 'github' },
    ]);
    mockLoadSource.mockResolvedValue({
      format: 'claude',
      name: 'market-a',
      entries: [{ name: 'p1' }, { name: 'p2' }],
    });

    await handleSourcesUpdate({ name: 'market-a' });

    expect(mockLoadSource).toHaveBeenCalledWith('owner/repo');
    expect(mockMarkSourceUpdated).toHaveBeenCalledWith('market-a');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Updated marketplace "market-a".',
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('2 available extensions');
  });

  it('errors when the marketplace is unknown', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    mockGetSources.mockReturnValue([]);

    await handleSourcesUpdate({ name: 'missing' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Marketplace "missing" not found.',
    );
    expect(processSpy).toHaveBeenCalledWith(1);
    processSpy.mockRestore();
  });

  it('errors when the marketplace cannot be loaded', async () => {
    const processSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    mockGetSources.mockReturnValue([
      { name: 'market-a', source: 'owner/repo', type: 'github' },
    ]);
    mockLoadSource.mockResolvedValue(null);

    await handleSourcesUpdate({ name: 'market-a' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Could not load this marketplace.',
    );
    expect(processSpy).toHaveBeenCalledWith(1);
    processSpy.mockRestore();
  });
});
