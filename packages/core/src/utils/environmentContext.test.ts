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
  afterEach,
  type Mock,
} from 'vitest';
import type { Content } from '@google/genai';
import {
  getEnvironmentContext,
  getDirectoryContextString,
  getInitialChatHistory,
  stripStartupContext,
} from './environmentContext.js';
import type { Config } from '../config/config.js';
import { getFolderStructure } from './getFolderStructure.js';

vi.mock('../config/config.js');
vi.mock('./getFolderStructure.js', () => ({
  getFolderStructure: vi.fn(),
}));
vi.mock('../tools/read-many-files.js');

describe('getDirectoryContextString', () => {
  let mockConfig: Partial<Config>;

  beforeEach(() => {
    mockConfig = {
      getWorkspaceContext: vi.fn().mockReturnValue({
        getDirectories: vi.fn().mockReturnValue(['/test/dir']),
      }),
      getFileService: vi.fn(),
    };
    vi.mocked(getFolderStructure).mockResolvedValue('Mock Folder Structure');
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should return context string for a single directory', async () => {
    const contextString = await getDirectoryContextString(mockConfig as Config);
    expect(contextString).toContain(
      "I'm currently working in the directory: /test/dir",
    );
    expect(contextString).toContain(
      'Here is the folder structure of the current working directories:\n\nMock Folder Structure',
    );
  });

  it('should return context string for multiple directories', async () => {
    (
      vi.mocked(mockConfig.getWorkspaceContext!)().getDirectories as Mock
    ).mockReturnValue(['/test/dir1', '/test/dir2']);
    vi.mocked(getFolderStructure)
      .mockResolvedValueOnce('Structure 1')
      .mockResolvedValueOnce('Structure 2');

    const contextString = await getDirectoryContextString(mockConfig as Config);
    expect(contextString).toContain(
      "I'm currently working in the following directories:\n  - /test/dir1\n  - /test/dir2",
    );
    expect(contextString).toContain(
      'Here is the folder structure of the current working directories:\n\nStructure 1\nStructure 2',
    );
  });
});

describe('getEnvironmentContext', () => {
  let mockConfig: Partial<Config>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-08-05T12:00:00Z'));

    // Mock the locale to ensure consistent English date formatting
    vi.stubGlobal('Intl', {
      ...global.Intl,
      DateTimeFormat: vi.fn().mockImplementation(() => ({
        format: vi.fn().mockReturnValue('Tuesday, August 5, 2025'),
      })),
    });

    mockConfig = {
      getWorkspaceContext: vi.fn().mockReturnValue({
        getDirectories: vi.fn().mockReturnValue(['/test/dir']),
      }),
      getFileService: vi.fn(),
    };

    vi.mocked(getFolderStructure).mockResolvedValue('Mock Folder Structure');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('should return basic environment context for a single directory', async () => {
    const parts = await getEnvironmentContext(mockConfig as Config);

    expect(parts.length).toBe(1);
    const context = parts[0].text;

    expect(context).toContain("Today's date is");
    expect(context).toContain("(formatted according to the user's locale)");
    expect(context).toContain(`My operating system is: ${process.platform}`);
    expect(context).toContain(
      "I'm currently working in the directory: /test/dir",
    );
    expect(context).toContain(
      'Here is the folder structure of the current working directories:\n\nMock Folder Structure',
    );
    expect(getFolderStructure).toHaveBeenCalledWith('/test/dir', {
      fileService: undefined,
    });
  });

  it('should return basic environment context for multiple directories', async () => {
    (
      vi.mocked(mockConfig.getWorkspaceContext!)().getDirectories as Mock
    ).mockReturnValue(['/test/dir1', '/test/dir2']);
    vi.mocked(getFolderStructure)
      .mockResolvedValueOnce('Structure 1')
      .mockResolvedValueOnce('Structure 2');

    const parts = await getEnvironmentContext(mockConfig as Config);

    expect(parts.length).toBe(1);
    const context = parts[0].text;

    expect(context).toContain(
      "I'm currently working in the following directories:\n  - /test/dir1\n  - /test/dir2",
    );
    expect(context).toContain(
      'Here is the folder structure of the current working directories:\n\nStructure 1\nStructure 2',
    );
    expect(getFolderStructure).toHaveBeenCalledTimes(2);
  });
});

describe('getInitialChatHistory', () => {
  let mockConfig: Partial<Config>;

  beforeEach(() => {
    vi.mocked(getFolderStructure).mockResolvedValue('Mock Folder Structure');
    mockConfig = {
      getSkipStartupContext: vi.fn().mockReturnValue(false),
      getWorkspaceContext: vi.fn().mockReturnValue({
        getDirectories: vi.fn().mockReturnValue(['/test/dir']),
      }),
      getFileService: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('includes startup context when skipStartupContext is false', async () => {
    const history = await getInitialChatHistory(mockConfig as Config);

    expect(mockConfig.getSkipStartupContext).toHaveBeenCalled();
    expect(history).toHaveLength(2);
    expect(history).toEqual([
      expect.objectContaining({
        role: 'user',
        parts: [
          expect.objectContaining({
            text: expect.stringContaining(
              "I'm currently working in the directory",
            ),
          }),
        ],
      }),
      {
        role: 'model',
        parts: [{ text: 'Got it. Thanks for the context!' }],
      },
    ]);
  });

  it('returns only extra history when skipStartupContext is true', async () => {
    mockConfig.getSkipStartupContext = vi.fn().mockReturnValue(true);
    mockConfig.getWorkspaceContext = vi.fn(() => {
      throw new Error(
        'getWorkspaceContext should not be called when skipping startup context',
      );
    });
    const extraHistory: Content[] = [
      { role: 'user', parts: [{ text: 'custom context' }] },
    ];

    const history = await getInitialChatHistory(
      mockConfig as Config,
      extraHistory,
    );

    expect(mockConfig.getSkipStartupContext).toHaveBeenCalled();
    expect(history).toEqual(extraHistory);
    expect(history).not.toBe(extraHistory);
  });

  it('returns empty history when skipping startup context without extras', async () => {
    mockConfig.getSkipStartupContext = vi.fn().mockReturnValue(true);
    mockConfig.getWorkspaceContext = vi.fn(() => {
      throw new Error(
        'getWorkspaceContext should not be called when skipping startup context',
      );
    });

    const history = await getInitialChatHistory(mockConfig as Config);

    expect(history).toEqual([]);
  });
});

describe('stripStartupContext', () => {
  it('should strip the env context + model ack from the start of history', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'This is the Qwen Code...' }] },
      {
        role: 'model',
        parts: [{ text: 'Got it. Thanks for the context!' }],
      },
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ];

    const result = stripStartupContext(history);
    expect(result).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ]);
  });

  it('should return history unchanged when no startup context is present', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ];

    const result = stripStartupContext(history);
    expect(result).toEqual(history);
  });

  it('should return empty array when history is only the startup context', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'This is the Qwen Code...' }] },
      {
        role: 'model',
        parts: [{ text: 'Got it. Thanks for the context!' }],
      },
    ];

    const result = stripStartupContext(history);
    expect(result).toEqual([]);
  });

  it('should return history unchanged when it has fewer than 2 entries', () => {
    expect(stripStartupContext([])).toEqual([]);
    expect(
      stripStartupContext([{ role: 'user', parts: [{ text: 'Hello' }] }]),
    ).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
  });

  it('should round-trip with getInitialChatHistory', async () => {
    const mockConfig = {
      getSkipStartupContext: vi.fn().mockReturnValue(false),
      getWorkspaceContext: vi.fn().mockReturnValue({
        getDirectories: vi.fn().mockReturnValue(['/test/dir']),
      }),
      getFileService: vi.fn(),
    };

    const conversation: Content[] = [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi' }] },
    ];

    const withStartup = await getInitialChatHistory(
      mockConfig as unknown as Config,
      conversation,
    );
    const stripped = stripStartupContext(withStartup);

    expect(stripped).toEqual(conversation);
  });
});
