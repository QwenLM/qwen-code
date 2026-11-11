/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUserMessage, type Message } from '@qwen-code/core';
import { renameCommand } from './renameCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import type { CommandContext } from './types.js';

const { generateTitle } = vi.hoisted(() => ({ generateTitle: vi.fn() }));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    SessionTitleService: class {
      generateTitle = generateTitle;
    },
  };
});

interface ConfigStub {
  persistSessionTitle: ReturnType<typeof vi.fn>;
  getSessionId: ReturnType<typeof vi.fn>;
  getModel: ReturnType<typeof vi.fn>;
  getModelPolicy: undefined;
  topicState: { getTopic: ReturnType<typeof vi.fn> };
}

function makeConfig(): ConfigStub {
  return {
    persistSessionTitle: vi.fn().mockResolvedValue(undefined),
    getSessionId: vi.fn().mockReturnValue('session-1'),
    getModel: vi.fn().mockReturnValue('model-a'),
    getModelPolicy: undefined,
    topicState: { getTopic: vi.fn().mockReturnValue(undefined) },
  };
}

function makeContext(
  config: ConfigStub,
  messages?: Message[],
): CommandContext {
  return createMockCommandContext({
    services: { agentContext: { config } },
    ...(messages ? { messages } : {}),
  } as unknown as CommandContext);
}

const conversation = (): Message[] => [
  createUserMessage('Fix the login button on mobile'),
];

async function run(context: CommandContext, args: string) {
  return renameCommand.action?.(context, args);
}

describe('renameCommand', () => {
  let config: ConfigStub;

  beforeEach(() => {
    vi.clearAllMocks();
    config = makeConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes an optional-argument hint, no alias, and concurrency', () => {
    expect(renameCommand.altNames).toBeUndefined();
    expect(renameCommand.argumentHint).toBe('[name]');
    expect(renameCommand.isSafeConcurrent).toBe(true);
  });

  it('fails when session context is unavailable', async () => {
    const result = await run(createMockCommandContext(), 'Plan approved title');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Session context not available.',
    });
  });

  describe('explicit name', () => {
    it('persists the trimmed name', async () => {
      const result = await run(makeContext(config), '  Plan approved title  ');

      expect(config.persistSessionTitle).toHaveBeenCalledWith(
        'Plan approved title',
      );
      expect(result).toEqual({
        type: 'local_command_result',
        text: 'Session renamed to: Plan approved title',
      });
      expect(generateTitle).not.toHaveBeenCalled();
    });

    it('strips invisible characters inside the name', async () => {
      await run(makeContext(config), 'a\u200Bb');

      expect(config.persistSessionTitle).toHaveBeenCalledWith('ab');
    });

    it.each([
      ['a zero-width space', '\u200B'],
      ['a bidi override', '\u202E'],
    ])('rejects a name made only of %s', async (_label, input) => {
      const result = await run(makeContext(config), input);

      expect(config.persistSessionTitle).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          'That name is empty once invisible characters are removed. Usage: /rename <name>',
      });
    });

    it.each([
      ['a ZWJ emoji sequence', '\u{1F469}\u200D\u{1F4BB}', '\u{1F469}\u200D\u{1F4BB}'],
      ['a ZWNJ inside a word', 'می\u200Cخواهم', 'می\u200Cخواهم'],
      ['a tab between words', 'Phase 1\tMigration', 'Phase 1 Migration'],
      ['enclosing quotes', '"Fix bug"', '"Fix bug"'],
    ])('keeps %s intact', async (_label, input, expected) => {
      await run(makeContext(config), input);

      expect(config.persistSessionTitle).toHaveBeenCalledWith(expected);
    });

    it('caps a long name at 120 UTF-16 units', async () => {
      await run(makeContext(config), 'x'.repeat(300));

      expect(config.persistSessionTitle).toHaveBeenCalledWith('x'.repeat(120));
    });

    it('drops an astral character that would cross the cap instead of splitting it', async () => {
      await run(makeContext(config), `${'a'.repeat(119)}\u{1F600}`);

      expect(config.persistSessionTitle).toHaveBeenCalledWith('a'.repeat(119));
    });

    it('drops a ZWJ sequence that would cross the cap instead of splitting it', async () => {
      const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
      await run(makeContext(config), `${'a'.repeat(115)}${family}`);

      expect(config.persistSessionTitle).toHaveBeenCalledWith('a'.repeat(115));
    });

    it('reports a persistence failure as an error', async () => {
      config.persistSessionTitle.mockRejectedValue(new Error('POST failed'));

      const result = await run(makeContext(config), 'foo');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Could not save the name: POST failed',
      });
    });
  });

  describe('generated name', () => {
    it('is not available when the surface provides no conversation', async () => {
      const result = await run(makeContext(config), '');

      expect(generateTitle).not.toHaveBeenCalled();
      expect(config.persistSessionTitle).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Name generation is not available here. Usage: /rename <name>',
      });
    });

    it('reports no conversation context for an empty history', async () => {
      const result = await run(makeContext(config, []), '');

      expect(generateTitle).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          'Could not generate a name: no conversation context yet. Usage: /rename <name>',
      });
    });

    it('generates, announces, and persists a name from the conversation', async () => {
      generateTitle.mockResolvedValue('Mobile login button');
      const messages = conversation();
      const context = makeContext(config, messages);

      const result = await run(context, '   ');

      expect(context.ui.addItem).toHaveBeenCalledWith(
        { type: MessageType.INFO, text: 'Generating a session name…' },
        expect.any(Number),
      );
      expect(generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          messages,
          currentModel: 'model-a',
          signal: expect.any(AbortSignal),
        }),
      );
      expect(config.persistSessionTitle).toHaveBeenCalledWith(
        'Mobile login button',
      );
      expect(result).toEqual({
        type: 'local_command_result',
        text: 'Session renamed to: Mobile login button',
      });
    });

    it('reports a generation failure without blaming the conversation', async () => {
      generateTitle.mockResolvedValue(null);

      const result = await run(makeContext(config, conversation()), '');

      expect(config.persistSessionTitle).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          'Could not generate a name from the conversation. Usage: /rename <name>',
      });
    });

    it('reports a timeout when the generation budget runs out', async () => {
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
      generateTitle.mockResolvedValue(null);

      const result = await run(makeContext(config, conversation()), '');

      expect(config.persistSessionTitle).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Name generation timed out. Usage: /rename <name>',
      });
    });

    it('does not persist when the session changed during generation', async () => {
      config.getSessionId
        .mockReturnValueOnce('session-1')
        .mockReturnValue('session-2');
      generateTitle.mockResolvedValue('Mobile login button');

      const result = await run(makeContext(config, conversation()), '');

      expect(config.persistSessionTitle).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Session changed while generating a name; nothing was renamed.',
      });
    });

    it('yields to a rename that landed during generation', async () => {
      config.topicState.getTopic
        .mockReturnValueOnce(undefined)
        .mockReturnValue('final');
      generateTitle.mockResolvedValue('Mobile login button');

      const result = await run(makeContext(config, conversation()), '');

      expect(config.persistSessionTitle).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'local_command_result',
        text: 'Session is named: final (a newer rename landed first)',
      });
    });
  });
});
