/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockResolve = vi.fn();
const mockFindSessionsByTitle = vi.fn();

vi.mock('@qwen-code/qwen-code-core', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    SessionReferenceService: class {
      resolve = mockResolve;
    },
    SessionService: class {
      findSessionsByTitle = mockFindSessionsByTitle;
    },
  };
});

import { handleAtCommand } from './atCommandProcessor.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  FileDiscoveryService,
  StandardFileSystemService,
  COMMON_IGNORE_PATTERNS,
} from '@qwen-code/qwen-code-core';
import * as os from 'node:os';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('handleAtCommand @session:', () => {
  let testRootDir: string;
  let mockConfig: Config;
  const mockAddItem: Mock<UseHistoryManagerReturn['addItem']> = vi.fn();
  const mockOnDebugMessage: Mock<(message: string) => void> = vi.fn();
  let abortController: AbortController;

  beforeEach(async () => {
    vi.clearAllMocks();
    testRootDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'at-session-test-'),
    );
    abortController = new AbortController();
    mockConfig = {
      getTargetDir: () => testRootDir,
      getProjectRoot: () => testRootDir,
      isSandboxed: () => false,
      getFileService: () => new FileDiscoveryService(testRootDir),
      getFileFilteringOptions: () => ({
        respectGitIgnore: true,
        respectQwenIgnore: true,
      }),
      getFileSystemService: () => new StandardFileSystemService(),
      getEnableRecursiveFileSearch: vi.fn(() => true),
      getWorkspaceContext: () => ({
        isPathWithinWorkspace: () => true,
        getDirectories: () => [testRootDir],
      }),
      getMcpServers: () => ({}),
      getActiveExtensions: () => [],
      getToolRegistry: () => ({}),
      getDebugMode: () => false,
      getFileExclusions: () => ({
        getCoreIgnorePatterns: () => COMMON_IGNORE_PATTERNS,
        getReadManyFilesExcludes: () => [],
      }),
    } as unknown as Config;
  });

  afterEach(async () => {
    abortController.abort();
    await fsPromises.rm(testRootDir, { recursive: true, force: true });
  });

  it('injects slimmed session text for a valid @session:<uuid>', async () => {
    mockResolve.mockResolvedValue({
      text: '--- Referenced session "s1" (slimmed, read-only) ---\nUser: hi',
      meta: { sessionId: UUID, title: 's1', messageCount: 1, approxTokens: 5 },
      truncated: false,
    });
    const result = await handleAtCommand({
      query: `see @session:${UUID} please`,
      config: mockConfig,
      addItem: mockAddItem,
      onDebugMessage: mockOnDebugMessage,
      messageId: 1,
      signal: abortController.signal,
    });
    expect(result.shouldProceed).toBe(true);
    const joined = JSON.stringify(result.processedQuery);
    expect(joined).toContain('User: hi');
    // @session: token kept verbatim in the prompt text
    expect(joined).toContain(`@session:${UUID}`);
    // a display card is emitted
    expect(
      result.toolDisplays?.some((d) => d.name === 'Referenced Session'),
    ).toBe(true);
  });

  it('resolves a title to a single session', async () => {
    mockFindSessionsByTitle.mockResolvedValue([{ sessionId: UUID }]);
    mockResolve.mockResolvedValue({
      text: '--- Referenced session "My Chat" (slimmed, read-only) ---\nUser: hi',
      meta: {
        sessionId: UUID,
        title: 'My Chat',
        messageCount: 1,
        approxTokens: 5,
      },
      truncated: false,
    });
    const result = await handleAtCommand({
      // spaces in a title must be escaped, exactly like file paths
      query: '@session:My\\ Chat',
      config: mockConfig,
      addItem: mockAddItem,
      onDebugMessage: mockOnDebugMessage,
      messageId: 2,
      signal: abortController.signal,
    });
    expect(mockFindSessionsByTitle).toHaveBeenCalledWith('My Chat');
    expect(mockResolve).toHaveBeenCalledWith(UUID, { title: 'My Chat' });
    expect(JSON.stringify(result.processedQuery)).toContain('User: hi');
  });

  it('falls back to literal text with an error card when not found', async () => {
    mockResolve.mockResolvedValue({ notFound: true });
    const result = await handleAtCommand({
      query: `look @session:${UUID}`,
      config: mockConfig,
      addItem: mockAddItem,
      onDebugMessage: mockOnDebugMessage,
      messageId: 3,
      signal: abortController.signal,
    });
    expect(result.shouldProceed).toBe(true);
    const joined = JSON.stringify(result.processedQuery);
    // literal token retained
    expect(joined).toContain(`@session:${UUID}`);
    // an error card explains the miss
    expect(
      result.toolDisplays?.some(
        (d) => d.name === 'Referenced Session' && d.status !== undefined,
      ),
    ).toBe(true);
  });

  it('reports an ambiguous title without guessing', async () => {
    mockFindSessionsByTitle.mockResolvedValue([
      { sessionId: UUID },
      { sessionId: 'other' },
    ]);
    const result = await handleAtCommand({
      query: '@session:Ambiguous',
      config: mockConfig,
      addItem: mockAddItem,
      onDebugMessage: mockOnDebugMessage,
      messageId: 4,
      signal: abortController.signal,
    });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(result.shouldProceed).toBe(true);
    expect(JSON.stringify(result.processedQuery)).toContain(
      '@session:Ambiguous',
    );
  });

  it('survives a filesystem error during title lookup', async () => {
    mockFindSessionsByTitle.mockRejectedValue(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    const result = await handleAtCommand({
      query: '@session:Some\\ Title',
      config: mockConfig,
      addItem: mockAddItem,
      onDebugMessage: mockOnDebugMessage,
      messageId: 5,
      signal: abortController.signal,
    });
    expect(result.shouldProceed).toBe(true);
    const joined = JSON.stringify(result.processedQuery);
    expect(joined).toContain('@session:Some Title');
    const card = result.toolDisplays?.find(
      (d) => d.name === 'Referenced Session',
    );
    expect(card).toBeDefined();
    expect(card!.resultDisplay).toContain('EACCES');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('survives a load error during session resolve', async () => {
    mockResolve.mockRejectedValue(
      Object.assign(new Error('corrupted JSONL'), { code: 'EIO' }),
    );
    const result = await handleAtCommand({
      query: `see @session:${UUID} please`,
      config: mockConfig,
      addItem: mockAddItem,
      onDebugMessage: mockOnDebugMessage,
      messageId: 6,
      signal: abortController.signal,
    });
    expect(result.shouldProceed).toBe(true);
    const joined = JSON.stringify(result.processedQuery);
    expect(joined).toContain(`@session:${UUID}`);
    const card = result.toolDisplays?.find(
      (d) => d.name === 'Referenced Session',
    );
    expect(card).toBeDefined();
    expect(card!.resultDisplay).toContain('corrupted JSONL');
  });

  it('deduplicates cross-form refs (UUID + title) resolving to the same session', async () => {
    mockFindSessionsByTitle.mockResolvedValue([{ sessionId: UUID }]);
    mockResolve.mockResolvedValue({
      text: '--- Referenced session "s1" (slimmed, read-only) ---\nUser: hi',
      meta: { sessionId: UUID, title: 's1', messageCount: 1, approxTokens: 5 },
      truncated: false,
    });
    const result = await handleAtCommand({
      query: `compare @session:${UUID} with @session:My\\ Chat`,
      config: mockConfig,
      addItem: mockAddItem,
      onDebugMessage: mockOnDebugMessage,
      messageId: 8,
      signal: abortController.signal,
    });
    expect(result.shouldProceed).toBe(true);
    // Both refs resolve to the same session id — resolve called only once
    expect(mockResolve).toHaveBeenCalledTimes(1);
    const cards = result.toolDisplays?.filter(
      (d) => d.name === 'Referenced Session',
    );
    expect(cards).toHaveLength(1);
  });

  it('deduplicates identical session mentions', async () => {
    mockResolve.mockResolvedValue({
      text: '--- Referenced session "s1" (slimmed, read-only) ---\nUser: hi',
      meta: { sessionId: UUID, title: 's1', messageCount: 1, approxTokens: 5 },
      truncated: false,
    });
    const result = await handleAtCommand({
      query: `compare @session:${UUID} with @session:${UUID}`,
      config: mockConfig,
      addItem: mockAddItem,
      onDebugMessage: mockOnDebugMessage,
      messageId: 7,
      signal: abortController.signal,
    });
    expect(result.shouldProceed).toBe(true);
    expect(mockResolve).toHaveBeenCalledTimes(1);
    const cards = result.toolDisplays?.filter(
      (d) => d.name === 'Referenced Session',
    );
    expect(cards).toHaveLength(1);
  });
});
