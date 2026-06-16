/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { handleList, SESSION_COL, TIME_COL, TITLE_COL } from './list.js';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockListSessions = vi.hoisted(() => vi.fn());
const mockInitSessionService = vi.hoisted(() => vi.fn());

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(() => ({
    merged: { advanced: {} },
  })),
}));

vi.mock('./common.js', () => ({
  initSessionService: mockInitSessionService,
}));

const mockedListSessions = mockListSessions as Mock;
const mockedWriteStdout = mockWriteStdoutLine as Mock;
const mockedWriteStderr = mockWriteStderrLine as Mock;
const mockedInit = mockInitSessionService as Mock;

const sampleSession = {
  sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  cwd: '/Users/test/project',
  startTime: '2026-06-15T10:30:00.000Z',
  mtime: 1718447400000,
  prompt: '帮我写一个 React 组件',
  gitBranch: 'main',
  filePath: '/path/to/chats/a1b2c3d4.jsonl',
  customTitle: 'React 组件开发',
  titleSource: 'auto',
};

describe('sessions list command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteStdoutLine.mockClear();
    mockWriteStderrLine.mockClear();
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    mockedInit.mockReturnValue({
      listSessions: mockedListSessions,
    });
  });

  it('should display message when no sessions found', async () => {
    mockedListSessions.mockResolvedValue({ items: [], hasMore: false });

    await handleList({});

    expect(mockedWriteStdout).toHaveBeenCalledWith('No sessions found.');
  });

  it('should display sessions in human-readable table format', async () => {
    mockedListSessions.mockResolvedValue({
      items: [sampleSession],
      hasMore: false,
    });

    await handleList({});

    const calls = mockedWriteStdout.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('SESSION ID'))).toBe(true);
    expect(calls.some((c) => c.includes('STARTED (LOCAL)'))).toBe(true);
    expect(calls.some((c) => c.includes('TITLE'))).toBe(true);
    expect(calls.some((c) => c.includes('BRANCH'))).toBe(true);
    expect(calls.some((c) => c.includes('PROMPT'))).toBe(true);
    expect(
      calls.some((c) => c.includes('a1b2c3d4') && c.includes('React 组件开发')),
    ).toBe(true);
  });

  it('should display dash for missing git branch', async () => {
    mockedListSessions.mockResolvedValue({
      items: [{ ...sampleSession, gitBranch: undefined }],
      hasMore: false,
    });

    await handleList({});

    const calls = mockedWriteStdout.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain('-');
  });

  it('should fall back to prompt when customTitle is missing', async () => {
    mockedListSessions.mockResolvedValue({
      items: [
        {
          ...sampleSession,
          customTitle: undefined,
          prompt: '你好',
        },
      ],
      hasMore: false,
    });

    await handleList({});

    const calls = mockedWriteStdout.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain('你好');
  });

  it('should not fall back to prompt when customTitle is empty string', async () => {
    mockedListSessions.mockResolvedValue({
      items: [
        {
          ...sampleSession,
          customTitle: '',
          prompt: '你好',
        },
      ],
      hasMore: false,
    });

    await handleList({});

    // customTitle '' is a valid value — should not fall back to prompt.
    // TITLE column starts after SESSION_COL + 1 + TIME_COL + 1.
    const calls = mockedWriteStdout.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    const titleStart = SESSION_COL + 1 + TIME_COL + 1;
    const titleCol = dataLine!.slice(titleStart, titleStart + TITLE_COL);
    expect(titleCol.trim()).toBe('');
  });

  it('should output JSON Lines format when --json is set', async () => {
    mockedListSessions.mockResolvedValue({
      items: [sampleSession],
      hasMore: false,
    });

    await handleList({ json: true });

    const calls = mockedWriteStdout.mock.calls;
    const jsonLines = calls.filter(
      (c) => c[0] !== undefined && c[0].trim().startsWith('{'),
    );
    expect(jsonLines.length).toBe(1);

    const parsed = JSON.parse(jsonLines[0][0]);
    expect(parsed.sessionId).toBe(sampleSession.sessionId);
    expect(parsed.startTime).toBe(sampleSession.startTime);
    expect(parsed.mtime).toBe(sampleSession.mtime);
    expect(parsed.prompt).toBe(sampleSession.prompt);
    expect(parsed.gitBranch).toBe('main');
    expect(parsed.customTitle).toBe('React 组件开发');
    expect(parsed.titleSource).toBe('auto');
    expect(parsed.filePath).toBe(sampleSession.filePath);
  });

  it('should output gitBranch as null in JSON when undefined', async () => {
    mockedListSessions.mockResolvedValue({
      items: [{ ...sampleSession, gitBranch: undefined }],
      hasMore: false,
    });

    await handleList({ json: true });

    const calls = mockedWriteStdout.mock.calls;
    const jsonLines = calls.filter(
      (c) => c[0] !== undefined && c[0].trim().startsWith('{'),
    );
    expect(jsonLines.length).toBe(1);

    const parsed = JSON.parse(jsonLines[0][0]);
    expect(parsed.gitBranch).toBeNull();
  });

  it('should pass limit option to listSessions', async () => {
    mockedListSessions.mockResolvedValue({ items: [], hasMore: false });

    await handleList({ limit: 10 });

    expect(mockedListSessions).toHaveBeenCalledWith({
      size: 10,
    });
  });

  it('should default limit to 20', async () => {
    mockedListSessions.mockResolvedValue({ items: [], hasMore: false });

    await handleList({});

    expect(mockedListSessions).toHaveBeenCalledWith({
      size: 20,
    });
  });

  it('should yield JSON without header for multiple sessions', async () => {
    mockedListSessions.mockResolvedValue({
      items: [
        sampleSession,
        {
          ...sampleSession,
          sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        },
      ],
      hasMore: false,
    });

    await handleList({ json: true });

    const calls = mockedWriteStdout.mock.calls;
    const jsonLines = calls.filter(
      (c) => c[0] !== undefined && c[0].trim().startsWith('{'),
    );
    expect(jsonLines.length).toBe(2);
  });

  it('should show hasMore hint when there are more sessions', async () => {
    mockedListSessions.mockResolvedValue({
      items: [sampleSession],
      hasMore: true,
    });

    await handleList({});

    expect(mockedWriteStdout).toHaveBeenCalledWith(
      expect.stringContaining('Use --limit to show more'),
    );
  });

  it('should not show hasMore hint when hasMore is false', async () => {
    mockedListSessions.mockResolvedValue({
      items: [sampleSession],
      hasMore: false,
    });

    await handleList({});

    const calls = mockedWriteStdout.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('Use --limit to show more'))).toBe(
      false,
    );
  });

  it('should not show hasMore hint when items is empty', async () => {
    mockedListSessions.mockResolvedValue({
      items: [],
      hasMore: true,
    });

    await handleList({});

    const calls = mockedWriteStdout.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('Use --limit to show more'))).toBe(
      false,
    );
  });

  it('should handle initSessionService failure', async () => {
    mockedInit.mockImplementation(() => {
      throw new Error('settings not found');
    });

    await handleList({});

    expect(mockedWriteStderr).toHaveBeenCalledWith(
      expect.stringContaining('initialize session service'),
    );
    expect(mockedWriteStderr).toHaveBeenCalledWith(
      expect.stringContaining('settings not found'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('should handle listSessions failure', async () => {
    mockedListSessions.mockRejectedValue(new Error('disk full'));

    await handleList({});

    expect(mockedWriteStderr).toHaveBeenCalledWith(
      expect.stringContaining('failed to list sessions'),
    );
    expect(mockedWriteStderr).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
