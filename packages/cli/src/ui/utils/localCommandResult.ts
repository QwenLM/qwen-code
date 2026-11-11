/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MessageType, type HistoryItemWithoutId } from '../types.js';

export type LocalCommandResultSeverity = 'info' | 'error';

export function createLocalCommandResultItem(
  text: string,
  severity: LocalCommandResultSeverity = 'info',
): HistoryItemWithoutId {
  if (severity === 'error') {
    return {
      type: MessageType.ERROR,
      text,
      transcriptSubtype: 'local_command_output',
    };
  }

  return {
    type: MessageType.INFO,
    text,
    transcriptSubtype: 'local_command_output',
  };
}
