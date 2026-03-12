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
  truncateContentToTokenBudget,
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
  let mockGeminiClient: { getHistory: () => Content[] };

  beforeEach(() => {
    vi.mocked(getFolderStructure).mockResolvedValue('Mock Folder Structure');
    mockGeminiClient = {
      getHistory: vi.fn().mockReturnValue([]),
    };
    mockConfig = {
      getSkipStartupContext: vi.fn().mockReturnValue(false),
      getWorkspaceContext: vi.fn().mockReturnValue({
        getDirectories: vi.fn().mockReturnValue(['/test/dir']),
      }),
      getFileService: vi.fn(),
      getGeminiClient: vi.fn().mockReturnValue(mockGeminiClient),
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

    const history = await getInitialChatHistory(mockConfig as Config, {
      extraHistory,
    });

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

  it('returns clean context without session history when useCleanContext is true', async () => {
    const mockGeminiClient = {
      getHistory: vi.fn().mockReturnValue([
        { role: 'user', parts: [{ text: 'Previous conversation' }] },
        { role: 'model', parts: [{ text: 'Previous response' }] },
      ]),
    };
    mockConfig.getGeminiClient = vi.fn().mockReturnValue(mockGeminiClient);

    const history = await getInitialChatHistory(mockConfig as Config, {
      useCleanContext: true,
    });

    // Should only have environment context, not the session history
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('user');
    expect(history[0]?.parts?.[0]?.text).toContain(
      "I'm currently working in the directory",
    );
    expect(history[1]?.role).toBe('model');
    expect(history[1]?.parts?.[0]?.text).toBe(
      'Got it. Thanks for the context!',
    );

    // Session history should NOT be included
    expect(history).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parts: [expect.objectContaining({ text: 'Previous conversation' })],
        }),
      ]),
    );
  });

  it('includes session history when useCleanContext is false (default)', async () => {
    const mockGeminiClient = {
      getHistory: vi.fn().mockReturnValue([
        { role: 'user', parts: [{ text: 'Previous conversation' }] },
        { role: 'model', parts: [{ text: 'Previous response' }] },
      ]),
    };
    mockConfig.getGeminiClient = vi.fn().mockReturnValue(mockGeminiClient);

    const history = await getInitialChatHistory(mockConfig as Config, {
      useCleanContext: false,
    });

    // Should have environment context + session history
    expect(history.length).toBeGreaterThan(2);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parts: [expect.objectContaining({ text: 'Previous conversation' })],
        }),
      ]),
    );
  });

  it('truncates content to fit within maxContextTokens budget', async () => {
    const mockGeminiClient = {
      getHistory: vi.fn().mockReturnValue([
        { role: 'user', parts: [{ text: 'A'.repeat(400) }] }, // ~100 tokens
        { role: 'model', parts: [{ text: 'B'.repeat(400) }] }, // ~100 tokens
        { role: 'user', parts: [{ text: 'C'.repeat(400) }] }, // ~100 tokens
      ]),
    };
    mockConfig.getGeminiClient = vi.fn().mockReturnValue(mockGeminiClient);

    // Set a very low token budget that should truncate
    const history = await getInitialChatHistory(mockConfig as Config, {
      useCleanContext: false,
      maxContextTokens: 150,
    });

    // Should have truncated the content
    expect(history.length).toBeLessThanOrEqual(3);
    // First item (environment context) should always be preserved
    expect(history[0]?.role).toBe('user');
    expect(history[0]?.parts?.[0]?.text).toContain(
      "I'm currently working in the directory",
    );
  });

  it('does not truncate when content is already under token budget', async () => {
    const mockGeminiClient = {
      getHistory: vi
        .fn()
        .mockReturnValue([
          { role: 'user', parts: [{ text: 'Short message' }] },
        ]),
    };
    mockConfig.getGeminiClient = vi.fn().mockReturnValue(mockGeminiClient);

    const history = await getInitialChatHistory(mockConfig as Config, {
      useCleanContext: false,
      maxContextTokens: 1000,
    });

    // Should not truncate - all content should be present
    expect(history.length).toBeGreaterThan(2);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parts: [expect.objectContaining({ text: 'Short message' })],
        }),
      ]),
    );
  });

  it('truncates to minimum when maxContextTokens is very low', async () => {
    mockGeminiClient.getHistory = vi
      .fn()
      .mockReturnValue([
        { role: 'user', parts: [{ text: 'Previous'.repeat(100) }] },
      ]);
    const history = await getInitialChatHistory(mockConfig as Config, {
      useCleanContext: false,
      maxContextTokens: 50,
    });

    // Very low token budget should truncate but preserve at least environment context
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]?.role).toBe('user');
    // The text should be truncated but still start with the context preamble
    expect(history[0]?.parts?.[0]?.text).toContain('This is the Qwen Code');
    expect(history[0]?.parts?.[0]?.text).toContain(
      '[truncated due to token budget]',
    );
  });
});

describe('truncateContentToTokenBudget', () => {
  it('returns content as-is when under token budget', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Short text' }] },
      { role: 'model', parts: [{ text: 'Response' }] },
    ];

    const result = truncateContentToTokenBudget(contents, 1000);

    // Should return a clone with same structure (not mutate original)
    expect(result).not.toBe(contents);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          parts: expect.arrayContaining([
            expect.objectContaining({ text: 'Short text' }),
          ]),
        }),
        expect.objectContaining({
          role: 'model',
          parts: expect.arrayContaining([
            expect.objectContaining({ text: 'Response' }),
          ]),
        }),
      ]),
    );
  });

  it('truncates oldest messages first when over budget', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Environment context' }] }, // Should be preserved
      { role: 'user', parts: [{ text: 'A'.repeat(400) }] }, // ~100 tokens - should be removed
      { role: 'model', parts: [{ text: 'B'.repeat(400) }] }, // ~100 tokens - should be removed
      { role: 'user', parts: [{ text: 'Keep this' }] }, // Should be kept
    ];

    const result = truncateContentToTokenBudget(contents, 150);

    // First item and last item should be kept
    expect(result.length).toBeLessThan(contents.length);
    expect(result[0]?.parts?.[0]?.text).toContain('Environment context');
  });

  it('preserves first item (environment context) even when over budget', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Important environment info' }] },
      { role: 'user', parts: [{ text: 'A'.repeat(1000) }] },
    ];

    const result = truncateContentToTokenBudget(contents, 50);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.parts?.[0]?.text).toContain('Important environment info');
  });

  it('returns empty array when maxTokens is 0 or negative', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Some content' }] },
    ];

    expect(truncateContentToTokenBudget(contents, 0)).toEqual([]);
    expect(truncateContentToTokenBudget(contents, -10)).toEqual([]);
  });

  it('truncates text with ellipsis when still over budget after removing items', () => {
    const longText = 'A'.repeat(1000);
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'Env' }] },
      { role: 'user', parts: [{ text: longText }] },
    ];

    const result = truncateContentToTokenBudget(contents, 50);

    expect(result.length).toBe(2);
    expect(result[1]?.parts?.[0]?.text).toContain(
      '... [truncated due to token budget]',
    );
  });

  it('handles empty content array', () => {
    const result = truncateContentToTokenBudget([], 100);
    expect(result).toEqual([]);
  });

  it('handles content without parts', () => {
    const contents: Content[] = [
      { role: 'user', parts: undefined },
      { role: 'model', parts: [] },
    ];

    const result = truncateContentToTokenBudget(contents, 100);

    // Should return a clone (not mutate original)
    expect(result).not.toBe(contents);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', parts: undefined }),
        expect.objectContaining({ role: 'model', parts: [] }),
      ]),
    );
  });
});
