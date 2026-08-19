/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `/board` — join a shared board from a session that is already running.
 *
 * `qwen fleet up` puts `QWEN_BOARD` in each pane's environment, but the
 * environment is fixed at launch. The case this design exists for is an agent
 * that was already working before any coordination started, and that session
 * has no way to become a participant without this.
 *
 * Joining sets the runtime context and refreshes the system instruction, so
 * the board section is present from the next turn onward.
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import {
  setBoardPromptContext,
  resolveBoardPromptContext,
  joinBoard,
  leaveBoard,
} from '@qwen-code/qwen-code-core';

export const boardCommand: SlashCommand = {
  name: 'board',
  get description() {
    return 'join a shared agent board (or "off" to leave)';
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context, args) => {
    const parts = (args ?? '').trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
      const current = resolveBoardPromptContext();
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: current
            ? `On board "${current.board}"${
                current.as ? ` as ${current.as}` : ''
              }. Use "/board off" to leave, or "/board <name>" to switch.`
            : 'Not on a board. Use "/board <name> [as <who>]" to join one.',
        },
        Date.now(),
      );
      return;
    }

    const client = context.services.config?.getGeminiClient();

    if (parts[0] === 'off') {
      const leaving = resolveBoardPromptContext();
      if (leaving?.as) {
        await leaveBoard(leaving.board, leaving.as).catch(() => false);
      }
      setBoardPromptContext(null);
      await client?.refreshSystemInstruction();
      context.ui.addItem(
        { type: MessageType.INFO, text: 'Left the board.' },
        Date.now(),
      );
      return;
    }

    // `/board demo as api-worker` — the participant name is what peers address,
    // so it is worth spelling out rather than deriving something opaque.
    const asIndex = parts.indexOf('as');
    const board = parts[0];
    const as =
      asIndex > 0 && parts[asIndex + 1] ? parts[asIndex + 1] : undefined;

    // Register so peers can address this session by name. joinBoard may hand
    // back a suffixed name when the one asked for is held by a live process,
    // so the context records what was actually claimed.
    let claimed = as;
    try {
      const rec = await joinBoard({
        board,
        name: as ?? 'session',
        kind: 'interactive',
      });
      claimed = rec.name;
    } catch {
      // A board that cannot be written to is still worth joining in prompt
      // terms — the session can read it and answer by hand.
    }

    setBoardPromptContext({ board, ...(claimed ? { as: claimed } : {}) });
    await client?.refreshSystemInstruction();

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text:
          `Joined board "${board}"${claimed ? ` as ${claimed}` : ''}. ` +
          `Run "qwen board show --board ${board}" to see what is on it. ` +
          `Nothing is delivered — check the board when you need to.`,
      },
      Date.now(),
    );
  },
};
