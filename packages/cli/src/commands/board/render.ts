/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AskRecord,
  BoardTaskRecord,
} from '@qwen-code/qwen-code-core/board';
import { sanitizeTerminalText } from '../../ui/utils/textUtils.js';

export interface BoardSnapshot {
  board: string;
  tasks: BoardTaskRecord[];
  asks: AskRecord[];
}

export function oneLine(value: string): string {
  return sanitizeTerminalText(value).replace(/[\r\n\t]+/g, ' ');
}

export function renderBoard(snapshot: BoardSnapshot): string {
  const lines = [`board: ${oneLine(snapshot.board)}`];
  for (const ask of snapshot.asks) {
    lines.push(
      `? ${ask.id} [${ask.state}] ${oneLine(ask.from)} -> ${oneLine(ask.to)}: ${oneLine(ask.question)}`,
    );
  }
  for (const task of snapshot.tasks) {
    lines.push(
      `- ${task.id} [${task.status}] ${oneLine(task.owner ?? 'unowned')}: ${oneLine(task.subject)}`,
    );
  }

  if (lines.length === 1) lines.push('(empty)');
  return lines.join('\n');
}
