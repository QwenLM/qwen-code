/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { historyCommand } from './historyCommand.js';
import { MessageType, type HistoryItem } from '../types.js';
import type { CommandContext } from './types.js';

describe('historyCommand', () => {
  let mockHistory: HistoryItem[];
  let mockLoadHistory: ReturnType<typeof vi.fn>;
  let mockAddItem: ReturnType<typeof vi.fn>;
  let mockRefreshStatic: ReturnType<typeof vi.fn>;
  let mockSettings: { setValue: ReturnType<typeof vi.fn> };
  let mockContext: CommandContext;

  beforeEach(() => {
    mockHistory = [
      { id: 1, type: 'user', text: 'hello' } as HistoryItem,
      { id: 2, type: 'gemini', text: 'hi' } as HistoryItem,
    ];
    mockLoadHistory = vi.fn((newHistory) => {
      mockHistory = newHistory;
    });
    mockAddItem = vi.fn();
    mockRefreshStatic = vi.fn();
    mockSettings = {
      setValue: vi.fn(),
    };

    mockContext = {
      ui: {
        history: mockHistory,
        loadHistory: mockLoadHistory,
        addItem: mockAddItem,
        refreshStatic: mockRefreshStatic,
      },
      services: {
        settings: mockSettings,
      },
    } as unknown as CommandContext;
  });

  it('collapses a fresh session: marks items suppressed and adds summary', async () => {
    const collapseCommand = historyCommand.subCommands!.find(
      (c) => c.name === 'collapse',
    )!;
    const result = await collapseCommand.action!(mockContext, '');

    expect(result).toBeUndefined();
    expect(mockLoadHistory).toHaveBeenCalledWith([
      expect.objectContaining({ id: 1, display: { suppressOnRestore: true } }),
      expect.objectContaining({ id: 2, display: { suppressOnRestore: true } }),
    ]);
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        display: { kind: 'collapse-summary' },
        text: expect.stringContaining('2 messages hidden'),
      }),
      expect.any(Number),
    );
    expect(mockRefreshStatic).toHaveBeenCalled();
  });

  it('returns already collapsed when collapsing twice', async () => {
    const collapseCommand = historyCommand.subCommands!.find(
      (c) => c.name === 'collapse',
    )!;
    // First collapse
    await collapseCommand.action!(mockContext, '');

    // Update context with the new history
    mockContext.ui.history = mockHistory;

    // Second collapse
    const result = await collapseCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'History is already collapsed.',
    });
  });

  it('counts correctly when collapsing again after adding new messages', async () => {
    const collapseCommand = historyCommand.subCommands!.find(
      (c) => c.name === 'collapse',
    )!;
    // First collapse
    await collapseCommand.action!(mockContext, '');

    // Simulate adding a summary item to history (which happens in real app via addItem)
    mockHistory.push({
      id: 3,
      type: MessageType.INFO,
      text: 'History collapsed: 2 messages hidden. Use /history expand to show.',
      display: { kind: 'collapse-summary' },
    } as HistoryItem);

    // Add new messages
    mockHistory.push({
      id: 4,
      type: 'user',
      text: 'new message',
    } as HistoryItem);
    mockHistory.push({
      id: 5,
      type: 'gemini',
      text: 'new reply',
    } as HistoryItem);

    mockContext.ui.history = mockHistory;

    // Second collapse
    await collapseCommand.action!(mockContext, '');

    // Should hide 4 messages in total (1, 2, 4, 5) and drop the old summary (3)
    expect(mockLoadHistory).toHaveBeenCalledWith([
      expect.objectContaining({ id: 1, display: { suppressOnRestore: true } }),
      expect.objectContaining({ id: 2, display: { suppressOnRestore: true } }),
      expect.objectContaining({ id: 4, display: { suppressOnRestore: true } }),
      expect.objectContaining({ id: 5, display: { suppressOnRestore: true } }),
    ]);

    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        display: { kind: 'collapse-summary' },
        text: expect.stringContaining('4 messages hidden'),
      }),
      expect.any(Number),
    );
  });

  it('expands collapsed history: removes suppressOnRestore and drops summary', async () => {
    const expandCommand = historyCommand.subCommands!.find(
      (c) => c.name === 'expand',
    )!;
    // Setup collapsed state
    mockHistory = [
      {
        id: 1,
        type: 'user',
        text: 'hello',
        display: { suppressOnRestore: true },
      } as HistoryItem,
      {
        id: 2,
        type: 'gemini',
        text: 'hi',
        display: { suppressOnRestore: true },
      } as HistoryItem,
      {
        id: 3,
        type: MessageType.INFO,
        display: { kind: 'collapse-summary' },
      } as HistoryItem,
    ];
    mockContext.ui.history = mockHistory;

    const result = await expandCommand.action!(mockContext, '');

    expect(result).toBeUndefined();
    expect(mockLoadHistory).toHaveBeenCalledWith([
      expect.objectContaining({ id: 1, display: { suppressOnRestore: false } }),
      expect.objectContaining({ id: 2, display: { suppressOnRestore: false } }),
    ]);
    expect(mockRefreshStatic).toHaveBeenCalled();
  });

  it('returns already expanded when expanding an uncollapsed session', async () => {
    const expandCommand = historyCommand.subCommands!.find(
      (c) => c.name === 'expand',
    )!;
    const result = await expandCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'History is already expanded.',
    });
  });

  it('returns usage error for unknown subcommand', async () => {
    const result = await historyCommand.action!(mockContext, 'unknown');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /history collapse|expand',
    });
  });
});
