/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpStatusMessage, parseMcpStatusMessage } from './McpStatusMessage.js';
import {
  TasksStatusMessage,
  parseTasksStatusMessage,
} from './TasksStatusMessage.js';
import type { DaemonStatusCardRenderers } from './daemon-status-cards-context.js';

export const DAEMON_STATUS_CARD_RENDERERS: Required<DaemonStatusCardRenderers> =
  {
    renderMcpStatus(content) {
      const parsed = parseMcpStatusMessage(content);
      return parsed ? <McpStatusMessage message={parsed} /> : null;
    },
    renderTasksStatus(content) {
      const parsed = parseTasksStatusMessage(content);
      return parsed ? <TasksStatusMessage message={parsed} /> : null;
    },
  };
