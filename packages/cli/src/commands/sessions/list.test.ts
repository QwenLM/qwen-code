/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
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
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    mockInitSessionService.mockReturnValue({
      listSessions: mockListSessions,
    });
  });

  it('should display message when no sessions found', async () => {
    mockListSessions.mockResolvedValue({ items: [], hasMore: false });

    await handleList({});

    expect(mockWriteStdoutLine).toHaveBeenCalledWith('No sessions found.');
  });

  it('should display sessions in human-readable table format', async () => {
    mockListSessions.mockResolvedValue({
      items: [sampleSession],
      hasMore: false,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('SESSION ID'))).toBe(true);
    expect(calls.some((c) => c.includes('STARTED'))).toBe(true);
    expect(calls.some((c) => c.includes('TITLE'))).toBe(true);
    expect(calls.some((c) => c.includes('BRANCH'))).toBe(true);
    expect(calls.some((c) => c.includes('PROMPT'))).toBe(true);
    expect(
      calls.some((c) => c.includes('a1b2c3d4') && c.includes('React 组件开发')),
    ).toBe(true);
  });

  it('should display dash for missing git branch', async () => {
    mockListSessions.mockResolvedValue({
      items: [{ ...sampleSession, gitBranch: undefined }],
      hasMore: false,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain('-');
  });

  it('should fall back to prompt when customTitle is missing', async () => {
    mockListSessions.mockResolvedValue({
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

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain('你好');
  });

  it('should not fall back to prompt when customTitle is empty string', async () => {
    mockListSessions.mockResolvedValue({
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
    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    const titleStart = SESSION_COL + 1 + TIME_COL + 1;
    const titleCol = dataLine!.slice(titleStart, titleStart + TITLE_COL);
    expect(titleCol.trim()).toBe('');
  });

  it('should output JSON Lines format when --json is set', async () => {
    mockListSessions.mockResolvedValue({
      items: [sampleSession],
      hasMore: false,
    });

    await handleList({ json: true });

    const calls = mockWriteStdoutLine.mock.calls;
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
    expect(parsed.cwd).toBe(sampleSession.cwd);
  });

  it('should output gitBranch as null in JSON when undefined', async () => {
    mockListSessions.mockResolvedValue({
      items: [{ ...sampleSession, gitBranch: undefined }],
      hasMore: false,
    });

    await handleList({ json: true });

    const calls = mockWriteStdoutLine.mock.calls;
    const jsonLines = calls.filter(
      (c) => c[0] !== undefined && c[0].trim().startsWith('{'),
    );
    expect(jsonLines.length).toBe(1);

    const parsed = JSON.parse(jsonLines[0][0]);
    expect(parsed.gitBranch).toBeNull();
  });

  it('should pass limit option to listSessions', async () => {
    mockListSessions.mockResolvedValue({ items: [], hasMore: false });

    await handleList({ limit: 10 });

    expect(mockListSessions).toHaveBeenCalledWith({
      size: 10,
    });
  });

  it('should default limit to 20', async () => {
    mockListSessions.mockResolvedValue({ items: [], hasMore: false });

    await handleList({});

    expect(mockListSessions).toHaveBeenCalledWith({
      size: 20,
    });
  });

  it('should yield JSON without header for multiple sessions', async () => {
    mockListSessions.mockResolvedValue({
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

    const calls = mockWriteStdoutLine.mock.calls;
    const jsonLines = calls.filter(
      (c) => c[0] !== undefined && c[0].trim().startsWith('{'),
    );
    expect(jsonLines.length).toBe(2);
  });

  it('should show hasMore hint when there are more sessions', async () => {
    mockListSessions.mockResolvedValue({
      items: [sampleSession],
      hasMore: true,
    });

    await handleList({});

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Use --limit to show more'),
    );
  });

  it('should not show hasMore hint when hasMore is false', async () => {
    mockListSessions.mockResolvedValue({
      items: [sampleSession],
      hasMore: false,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('Use --limit to show more'))).toBe(
      false,
    );
  });

  it('should not show hasMore hint when items is empty', async () => {
    mockListSessions.mockResolvedValue({
      items: [],
      hasMore: true,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('Use --limit to show more'))).toBe(
      false,
    );
  });

  it('should truncate long prompt with ellipsis', async () => {
    const longPrompt = 'A'.repeat(100);
    mockListSessions.mockResolvedValue({
      items: [{ ...sampleSession, customTitle: undefined, prompt: longPrompt }],
      hasMore: false,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    // Truncated output should contain ellipsis
    expect(dataLine).toContain('...');
    // Full original string must not appear
    expect(dataLine).not.toContain(longPrompt);
  });

  it('should truncate CJK characters correctly', async () => {
    const longCjk = '这是一个非常非常长的中文测试标题文本内容'.repeat(5);
    mockListSessions.mockResolvedValue({
      items: [{ ...sampleSession, customTitle: undefined, prompt: longCjk }],
      hasMore: false,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    // Full CJK string must not appear (truncated by display width)
    expect(dataLine).not.toContain(longCjk);
  });

  // --- sanitize() tests ---

  it('should strip CR, LF, and TAB from prompt in human output', async () => {
    mockListSessions.mockResolvedValue({
      items: [
        {
          ...sampleSession,
          customTitle: undefined,
          prompt: 'hello\r\n\tworld',
        },
      ],
      hasMore: false,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    // CR, LF, and TAB must all be stripped
    expect(dataLine).toContain('helloworld');
    expect(dataLine).not.toContain('\r');
    expect(dataLine).not.toContain('\n');
    expect(dataLine).not.toContain('\t');
  });

  it('should escape ANSI escape sequences in human output', async () => {
    // After escapeAnsiCtrlCodes, the ESC byte \x1b becomes the 6-char
    // literal "", so keep the prompt short enough to fit the column.
    const prompt = '\x1b[31mRED\x1b[0m';
    mockListSessions.mockResolvedValue({
      items: [{ ...sampleSession, customTitle: undefined, prompt }],
      hasMore: false,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    // Raw ANSI ESC byte must not appear (escapeAnsiCtrlCodes replaces it
    // with a literal  escape sequence).
    expect(dataLine).not.toContain('\x1b');
    // The visible text should remain.
    expect(dataLine).toContain('RED');
  });

  it('should strip bell and backspace C0 control characters', async () => {
    const prompt = 'ab\x07c\x08d';
    mockListSessions.mockResolvedValue({
      items: [{ ...sampleSession, customTitle: undefined, prompt }],
      hasMore: false,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    // C0 controls must be stripped, alphabetic chars remain
    expect(dataLine).toContain('abcd');
  });

  it('should not strip printable text in sanitize', async () => {
    mockListSessions.mockResolvedValue({
      items: [
        { ...sampleSession, customTitle: undefined, prompt: 'Hello World 123' },
      ],
      hasMore: false,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    expect(dataLine).toContain('Hello World 123');
  });

  it('should sanitize and truncate the time column', async () => {
    // An invalid startTime hits the isNaN fallback in formatTime, returning
    // the raw string. sanitize + truncate must prevent raw injection there.
    mockListSessions.mockResolvedValue({
      items: [
        {
          ...sampleSession,
          startTime: 'not-a-date\r\n\x1b[31mEVIL\x1b[0m',
        },
      ],
      hasMore: false,
    });

    await handleList({});

    const calls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    const dataLine = calls.find(
      (c) => c.includes('a1b2c3d4') && !c.includes('SESSION ID'),
    );
    expect(dataLine).toBeDefined();
    // Raw evil sequences must be gone
    expect(dataLine).not.toContain('\r');
    expect(dataLine).not.toContain('\n');
    expect(dataLine).not.toContain('\x1b');
    expect(dataLine).not.toContain('EVIL');
    // The sanitized result is 'not-a-date[31mEVIL[0m' — without the ESC byte,
    // and truncated. The key point is the raw escape is gone.
  });

  // --- JSON mode hasMore tests ---

  it('should emit hasMore hint to stderr in JSON mode', async () => {
    mockListSessions.mockResolvedValue({
      items: [sampleSession],
      hasMore: true,
    });

    await handleList({ json: true });

    // Hint must go to stderr, not stdout
    const stdoutCalls = mockWriteStdoutLine.mock.calls.map((c) => c[0]);
    expect(stdoutCalls.some((c) => c.includes('Use --limit'))).toBe(false);

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Use --limit to show more'),
    );
  });

  it('should not emit hasMore hint to stderr when hasMore is false in JSON mode', async () => {
    mockListSessions.mockResolvedValue({
      items: [sampleSession],
      hasMore: false,
    });

    await handleList({ json: true });

    const stderrCalls = mockWriteStderrLine.mock.calls.map((c) => c[0]);
    expect(stderrCalls.some((c) => c.includes('Use --limit'))).toBe(false);
  });

  it('should not emit hasMore hint to stderr when items is empty in JSON mode', async () => {
    mockListSessions.mockResolvedValue({
      items: [],
      hasMore: true,
    });

    await handleList({ json: true });

    const stderrCalls = mockWriteStderrLine.mock.calls.map((c) => c[0]);
    expect(stderrCalls.some((c) => c.includes('Use --limit'))).toBe(false);
  });

  it('should handle initSessionService failure', async () => {
    mockInitSessionService.mockImplementation(() => {
      throw new Error('settings not found');
    });

    await handleList({});

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('initialize session service'),
    );
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('settings not found'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('should handle listSessions failure', async () => {
    mockListSessions.mockRejectedValue(new Error('disk full'));

    await handleList({});

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('failed to list sessions'),
    );
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
