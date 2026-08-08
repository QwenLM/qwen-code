/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies commands-output.ts against the ink `addMessage` conversion and
 * the chat-recording helpers in ui/hooks/slashCommandProcessor.ts.
 */

import { describe, it, expect } from 'vitest';
import { MessageType } from '../types.js';
import {
  commandMessageItem,
  messageToHistoryItem,
  serializeHistoryItemForRecording,
  SLASH_COMMANDS_SKIP_RECORDING,
} from './commands-output.js';

const timestamp = new Date('2026-08-08T08:00:00Z');

describe('messageToHistoryItem (ink addMessage parity)', () => {
  it('maps INFO/WARNING/ERROR/USER to text items', () => {
    expect(
      messageToHistoryItem({
        type: MessageType.INFO,
        content: 'hello',
        timestamp,
      }),
    ).toEqual({ type: 'info', text: 'hello' });
    expect(
      messageToHistoryItem({
        type: MessageType.WARNING,
        content: 'careful',
        timestamp,
      }),
    ).toEqual({ type: 'warning', text: 'careful' });
    expect(
      messageToHistoryItem({
        type: MessageType.ERROR,
        content: 'boom',
        timestamp,
      }),
    ).toEqual({ type: 'error', text: 'boom' });
  });

  it('maps ABOUT to the system-info item', () => {
    const systemInfo = {
      cliVersion: '0.0.0',
      osPlatform: 'darwin',
      osArch: 'arm64',
      osRelease: '26.0.0',
      nodeVersion: 'v22.0.0',
      npmVersion: '11.0.0',
      sandboxEnv: 'none',
      modelVersion: 'test-model',
      selectedAuthType: 'api-key',
      ideClient: 'none',
      sessionId: 'abc',
      memoryUsage: '1MB',
    };
    expect(
      messageToHistoryItem({
        type: MessageType.ABOUT,
        timestamp,
        systemInfo,
      }),
    ).toEqual({ type: 'about', systemInfo });
  });

  it('maps HELP/STATS/QUIT with their display payloads', () => {
    expect(messageToHistoryItem({ type: MessageType.HELP, timestamp })).toEqual(
      { type: 'help', timestamp },
    );
    expect(
      messageToHistoryItem({
        type: MessageType.STATS,
        timestamp,
        duration: '1m 2s',
      }),
    ).toEqual({ type: 'stats', duration: '1m 2s' });
    expect(
      messageToHistoryItem({
        type: MessageType.QUIT,
        timestamp,
        duration: '3s',
      }),
    ).toEqual({ type: 'quit', duration: '3s' });
  });

  it('maps the stats-family items without payloads', () => {
    expect(
      messageToHistoryItem({ type: MessageType.MODEL_STATS, timestamp }),
    ).toEqual({ type: 'model_stats' });
    expect(
      messageToHistoryItem({ type: MessageType.TOOL_STATS, timestamp }),
    ).toEqual({ type: 'tool_stats' });
    expect(
      messageToHistoryItem({ type: MessageType.SKILL_STATS, timestamp }),
    ).toEqual({ type: 'skill_stats' });
  });

  it('maps COMPRESSION, SUMMARY and INSIGHT_PROGRESS payloads', () => {
    const compression = {
      isPending: false,
      originalTokenCount: 100,
      newTokenCount: 40,
      compressionStatus: null,
    };
    expect(
      messageToHistoryItem({
        type: MessageType.COMPRESSION,
        compression,
        timestamp,
      }),
    ).toEqual({ type: 'compression', compression });

    const summary = { isPending: false, stage: 'completed' as const };
    expect(
      messageToHistoryItem({
        type: MessageType.SUMMARY,
        summary,
        timestamp,
      }),
    ).toEqual({ type: 'summary', summary });

    const progress = { stage: 'scanning', progress: 0.5 };
    expect(
      messageToHistoryItem({
        type: MessageType.INSIGHT_PROGRESS,
        progress,
        timestamp,
      }),
    ).toEqual({ type: 'insight_progress', progress });
  });

  it('commandMessageItem builds the plain text shapes', () => {
    expect(commandMessageItem('info', 'Operation cancelled.')).toEqual({
      type: 'info',
      text: 'Operation cancelled.',
    });
  });
});

describe('chat-recording helpers (slashCommandProcessor parity)', () => {
  it('keeps the original skip-recording set', () => {
    expect([...SLASH_COMMANDS_SKIP_RECORDING].sort()).toEqual([
      'branch',
      'btw',
      'clear',
      'delete',
      'exit',
      'history',
      'new',
      'quit',
      'reset',
      'resume',
    ]);
  });

  it('serializes Date timestamps to ISO strings, keeps other fields', () => {
    const item = { type: 'help', timestamp } as const;
    const serialized = serializeHistoryItemForRecording(item);
    expect(serialized).toEqual({
      type: 'help',
      timestamp: timestamp.toISOString(),
    });
    // Items without timestamps pass through untouched.
    const plain = { type: 'info', text: 'x' } as const;
    expect(serializeHistoryItemForRecording(plain)).toEqual(plain);
  });
});
