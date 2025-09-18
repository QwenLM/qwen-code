/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { formatDuration } from '../utils/formatters.js';
import { CommandKind, type SlashCommand } from './types.js';

export const quitConfirmCommand: SlashCommand = {
  name: 'quit-confirm',
  description: 'Show quit confirmation dialog',
  kind: CommandKind.BUILT_IN,
  action: (context) => {
    const now = Date.now();
    const { sessionStartTime } = context.session.stats;
    const wallDuration = now - sessionStartTime.getTime();

    return {
      type: 'quit_confirmation',
      messages: [
        {
          type: 'user',
          text: `/quit-confirm`,
          id: now - 1,
        },
        {
          type: 'quit_confirmation',
          duration: formatDuration(wallDuration),
          id: now,
        },
      ],
    };
  },
};

export const quitCommand: SlashCommand = {
  name: 'quit',
  altNames: ['exit'],
  description: 'exit the cli',
  kind: CommandKind.BUILT_IN,
  action: (context) => {
    const now = Date.now();
    const { sessionStartTime } = context.session.stats;
    const wallDuration = now - sessionStartTime.getTime();

    return {
      type: 'quit',
      messages: [
        {
          type: 'user',
          text: `/quit`, // Keep it consistent, even if /exit was used
          id: now - 1,
        },
        {
          type: 'quit',
          duration: formatDuration(wallDuration),
          id: now,
        },
      ],
    };
  },
};
