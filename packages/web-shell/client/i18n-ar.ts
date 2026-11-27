import type { Messages } from './i18n.js';
import { BROWSER_NOTIFICATION_MESSAGES_AR } from './browser-notifications/messages.js';
import { COLLAB_MESSAGES_AR } from './components/workspace-agents/messages.js';
import { FILES_MESSAGES_AR } from './components/artifacts/files-messages.js';
import { LIVE_MESSAGES_AR } from './live/messages.js';
import { MANAGED_LIFECYCLE_MESSAGES_AR } from './components/managed/managed-lifecycle-messages.js';
import { MANAGED_MCP_MESSAGES_AR } from './components/managed/managed-mcp-messages.js';
import { MANAGED_TASK_MESSAGES_AR } from './components/managed/managed-task-messages.js';
import { MCP_APP_MESSAGES_AR } from './mcp-app/messages.js';
import { MESSAGE_DELETION_MESSAGES_AR } from './components/message-deletion-messages.js';
import { SETTINGS_MESSAGES_AR } from './settings/messages.js';
import { TOKEN_USAGE_MESSAGES_AR } from './components/artifacts/token-usage-messages.js';
import { TRAJECTORY_EXECUTION_MESSAGES_AR } from './trajectory/execution-messages.js';
import { TRAJECTORY_FILTER_MESSAGES_AR } from './trajectory/filter-messages.js';
import { TRAJECTORY_WINDOW_MESSAGES_AR } from './trajectory/window-messages.js';
import { VOICE_MESSAGES_AR } from './voice/messages.js';
import { WORKSPACE_REGISTRATION_MESSAGES_AR } from './components/managed/managed-workspace-messages.js';
import { AR_INTERACTIVE_MESSAGES } from './i18n/ar-interactive.js';
import { AR_TRANSCRIPT_MESSAGES } from './i18n/ar-transcript.js';

export const AR: Messages = {
  ...AR_TRANSCRIPT_MESSAGES,
  ...AR_INTERACTIVE_MESSAGES,
  ...BROWSER_NOTIFICATION_MESSAGES_AR,
  ...COLLAB_MESSAGES_AR,
  ...FILES_MESSAGES_AR,
  ...LIVE_MESSAGES_AR,
  ...MANAGED_LIFECYCLE_MESSAGES_AR,
  ...MANAGED_MCP_MESSAGES_AR,
  ...MANAGED_TASK_MESSAGES_AR,
  ...MCP_APP_MESSAGES_AR,
  ...MESSAGE_DELETION_MESSAGES_AR,
  ...SETTINGS_MESSAGES_AR,
  ...TOKEN_USAGE_MESSAGES_AR,
  ...TRAJECTORY_EXECUTION_MESSAGES_AR,
  ...TRAJECTORY_FILTER_MESSAGES_AR,
  ...TRAJECTORY_WINDOW_MESSAGES_AR,
  ...VOICE_MESSAGES_AR,
  ...WORKSPACE_REGISTRATION_MESSAGES_AR,
};
