/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SessionHistoryNode {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  prompt: string;
}
