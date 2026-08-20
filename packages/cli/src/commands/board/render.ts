/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AskRecord,
  BoardTaskRecord,
  DecisionRecord,
} from '@qwen-code/qwen-code-core/board';
import { sanitizeTerminalText } from '../../ui/utils/textUtils.js';

export interface BoardSnapshot {
  board: string;
  tasks: BoardTaskRecord[];
  asks: AskRecord[];
  decisions: DecisionRecord[];
}

export function oneLine(value: string): string {
  return sanitizeTerminalText(value).replace(/[\r\n\t]+/g, ' ');
}

// Foreign agents write board records directly, so a record can arrive without
// the fields its type promises. Coerce to a string instead of handing
// `undefined` to `sanitizeTerminalText` (which would throw on `.replace`).
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function renderBoard(snapshot: BoardSnapshot): string {
  const lines = [`board: ${oneLine(text(snapshot.board))}`];

  for (const decision of snapshot.decisions) {
    lines.push(
      `! ${text(decision.id)} [${text(decision.state)}] ${oneLine(text(decision.question))}`,
    );
  }
  for (const ask of snapshot.asks) {
    lines.push(
      `? ${text(ask.id)} [${text(ask.state)}] ${oneLine(text(ask.from))} -> ${oneLine(text(ask.to))}: ${oneLine(text(ask.question))}`,
    );
  }
  for (const task of snapshot.tasks) {
    lines.push(
      `- ${text(task.id)} [${text(task.status)}] ${oneLine(text(task.owner ?? 'unowned'))}: ${oneLine(text(task.subject))}`,
    );
  }

  if (lines.length === 1) lines.push('(empty)');
  return lines.join('\n');
}
