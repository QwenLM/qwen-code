/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MANAGED_LIFECYCLE_MESSAGES_RU } from './components/managed/managed-lifecycle-messages.js';
import { MESSAGE_DELETION_MESSAGES_RU } from './components/message-deletion-messages.js';
import { TRAJECTORY_EXECUTION_MESSAGES_RU } from './trajectory/execution-messages.js';
import { FILES_MESSAGES_RU } from './components/artifacts/files-messages.js';
import { TOKEN_USAGE_MESSAGES_RU } from './components/artifacts/token-usage-messages.js';
import { TRAJECTORY_FILTER_MESSAGES_RU } from './trajectory/filter-messages.js';
import { TRAJECTORY_WINDOW_MESSAGES_RU } from './trajectory/window-messages.js';
import { VOICE_MESSAGES_RU } from './voice/messages.js';
import { LIVE_MESSAGES_RU } from './live/messages.js';
import { MCP_APP_MESSAGES_RU } from './mcp-app/messages.js';
import { COLLAB_MESSAGES_RU } from './components/workspace-agents/messages.js';
import { SETTINGS_MESSAGES_RU } from './settings/messages.js';
import { MANAGED_TASK_MESSAGES_RU } from './components/managed/managed-task-messages.js';
import { BROWSER_NOTIFICATION_MESSAGES_RU } from './browser-notifications/messages.js';
import { WORKSPACE_REGISTRATION_MESSAGES_RU } from './components/managed/managed-workspace-messages.js';
import { ARTIFACT_LIBRARY_MESSAGES_RU } from './components/managed/managed-artifact-library-messages.js';
import { WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_RU } from './components/artifacts/workspace-artifact-library-messages.js';
import { ARCHIVED_SESSIONS_MESSAGES_RU } from './components/sidebar/archived-sessions-messages.js';
import { MANAGED_MCP_MESSAGES_RU } from './components/managed/managed-mcp-messages.js';
// The Russian catalog is split so `--mode transcript` can stub these
// modules (see vite.lib.config.ts). Exported HTML would otherwise ship a
// third full UI dictionary to every reader.
import { RU_PART1 } from './i18n-ru-part1.js';
import { RU_PART2 } from './i18n-ru-part2.js';
import { RU_PART3 } from './i18n-ru-part3.js';
import { RU_PART4 } from './i18n-ru-part4.js';
import { RU_PART5 } from './i18n-ru-part5.js';
import { RU_PART6 } from './i18n-ru-part6.js';
import { RU_REMAINDER } from './i18n-ru-remainder.js';
import type { Messages } from './i18n.js';

export const RU: Messages = {
  ...RU_PART1,
  ...RU_PART2,
  ...RU_PART3,
  ...RU_PART4,
  ...RU_PART5,
  ...RU_PART6,
  ...RU_REMAINDER,
  ...FILES_MESSAGES_RU,
  ...TOKEN_USAGE_MESSAGES_RU,
  ...MESSAGE_DELETION_MESSAGES_RU,
  ...BROWSER_NOTIFICATION_MESSAGES_RU,
  ...MCP_APP_MESSAGES_RU,
  ...VOICE_MESSAGES_RU,
  ...LIVE_MESSAGES_RU,
  ...COLLAB_MESSAGES_RU,
  ...SETTINGS_MESSAGES_RU,
  ...MANAGED_TASK_MESSAGES_RU,
  ...MANAGED_LIFECYCLE_MESSAGES_RU,
  ...WORKSPACE_REGISTRATION_MESSAGES_RU,
  ...ARTIFACT_LIBRARY_MESSAGES_RU,
  ...WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_RU,
  ...MANAGED_MCP_MESSAGES_RU,
  ...TRAJECTORY_EXECUTION_MESSAGES_RU,
  ...TRAJECTORY_FILTER_MESSAGES_RU,
  ...TRAJECTORY_WINDOW_MESSAGES_RU,
  ...ARCHIVED_SESSIONS_MESSAGES_RU,
};
