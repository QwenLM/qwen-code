/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlashCommandConflictHandler } from './SlashCommandConflictHandler.js';
import {
  coreEvents,
  CoreEvent,
  type SlashCommandConflictsPayload,
  type SlashCommandConflict,
} from '@qwen-code/core';
import { CommandKind } from '../ui/commands/types.js';

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    coreEvents: {
      on: vi.fn(),
      off: vi.fn(),
      emitFeedback: vi.fn(),
    },
  };
});

describe('SlashCommandConflictHandler', () => {
  let handler: SlashCommandConflictHandler;

  /**
   * Helper to find and invoke the registered conflict event listener.
   */
  const simulateEvent = (conflicts: SlashCommandConflict[]) => {
    const callback = vi
      .mocked(coreEvents.on)
      .mock.calls.find(
        (call) => call[0] === CoreEvent.SlashCommandConflicts,
      )![1] as (payload: SlashCommandConflictsPayload) => void;
    callback({ conflicts });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    handler = new SlashCommandConflictHandler();
    handler.start();
  });

  afterEach(() => {
    handler.stop();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should listen for conflict events on start', () => {
    expect(coreEvents.on).toHaveBeenCalledWith(
      CoreEvent.SlashCommandConflicts,
      expect.any(Function),
    );
  });

  it('should display a descriptive message for a single skill conflict', () => {
    simulateEvent([
      {
        name: 'deploy',
        renamedTo: 'firebase:deploy',
        loserPluginName: 'firebase',
        loserKind: CommandKind.SKILL,
        winnerKind: CommandKind.BUILT_IN,
      },
    ]);

    vi.advanceTimersByTime(600);

    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'info',
      "Plugin 'firebase' skill '/deploy' was renamed to '/firebase:deploy' because it conflicts with built-in command.",
      undefined,
      { omitFromTranscript: true },
    );
  });

  it('should display a descriptive message for a single MCP conflict', () => {
    simulateEvent([
      {
        name: 'pickle',
        renamedTo: 'test-server.pickle',
        loserMcpServerName: 'test-server',
        loserKind: CommandKind.MCP_PROMPT,
        winnerPluginName: 'pickle-rick',
        winnerKind: CommandKind.SKILL,
      },
    ]);

    vi.advanceTimersByTime(600);

    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'info',
      "MCP server 'test-server' command '/pickle' was renamed to '/test-server.pickle' because it conflicts with plugin 'pickle-rick' skill.",
      undefined,
      { omitFromTranscript: true },
    );
  });

  it('should display a descriptive message for a single dynamic command conflict', () => {
    simulateEvent([
      {
        name: 'review',
        renamedTo: 'dynamic.review',
        loserKind: CommandKind.DYNAMIC,
        winnerKind: CommandKind.BUILT_IN,
      },
    ]);

    vi.advanceTimersByTime(600);

    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'info',
      "Dynamic command '/review' was renamed to '/dynamic.review' because it conflicts with built-in command.",
      undefined,
      { omitFromTranscript: true },
    );
  });

  it('should group multiple conflicts for the same command name', () => {
    simulateEvent([
      {
        name: 'launch',
        renamedTo: 'ext-a:launch',
        loserPluginName: 'ext-a',
        loserKind: CommandKind.SKILL,
        winnerKind: CommandKind.BUILT_IN,
      },
      {
        name: 'launch',
        renamedTo: 'ext-b:launch',
        loserPluginName: 'ext-b',
        loserKind: CommandKind.SKILL,
        winnerKind: CommandKind.BUILT_IN,
      },
    ]);

    vi.advanceTimersByTime(600);

    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'info',
      `Conflicts detected for command '/launch':
- Plugin 'ext-a' skill '/launch' was renamed to '/ext-a:launch'
- Plugin 'ext-b' skill '/launch' was renamed to '/ext-b:launch'`,
      undefined,
      { omitFromTranscript: true },
    );
  });

  it('should debounce multiple events within the flush window', () => {
    simulateEvent([
      {
        name: 'a',
        renamedTo: 'ext-a:a',
        loserPluginName: 'ext-a',
        loserKind: CommandKind.SKILL,
        winnerKind: CommandKind.BUILT_IN,
      },
    ]);

    vi.advanceTimersByTime(200);

    simulateEvent([
      {
        name: 'b',
        renamedTo: 'ext-b:b',
        loserPluginName: 'ext-b',
        loserKind: CommandKind.SKILL,
        winnerKind: CommandKind.BUILT_IN,
      },
    ]);

    vi.advanceTimersByTime(600);

    // Should emit two feedbacks (one for each unique command name)
    expect(coreEvents.emitFeedback).toHaveBeenCalledTimes(2);
  });

  it('should deduplicate already notified conflicts', () => {
    const conflict = {
      name: 'deploy',
      renamedTo: 'firebase:deploy',
      loserPluginName: 'firebase',
      loserKind: CommandKind.SKILL,
      winnerKind: CommandKind.BUILT_IN,
    };

    simulateEvent([conflict]);
    vi.advanceTimersByTime(600);
    expect(coreEvents.emitFeedback).toHaveBeenCalledTimes(1);

    vi.mocked(coreEvents.emitFeedback).mockClear();

    simulateEvent([conflict]);
    vi.advanceTimersByTime(600);
    expect(coreEvents.emitFeedback).not.toHaveBeenCalled();
  });

  it('should display a descriptive message for a skill conflict', () => {
    simulateEvent([
      {
        name: 'chat',
        renamedTo: 'google-workspace.chat',
        loserPluginName: 'google-workspace',
        loserKind: CommandKind.SKILL,
        winnerKind: CommandKind.BUILT_IN,
      },
    ]);

    vi.advanceTimersByTime(600);

    expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
      'info',
      "Plugin 'google-workspace' skill '/chat' was renamed to '/google-workspace.chat' because it conflicts with built-in command.",
      undefined,
      { omitFromTranscript: true },
    );
  });
});
