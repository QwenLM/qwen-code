/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Usage } from '@agentclientprotocol/sdk';

import type { ApprovalModeValue } from './approvalModeValueTypes.js';

// ---------------------------------------------------------------------------
// Private / Qwen-specific types (not part of ACP spec)
// ---------------------------------------------------------------------------

// Default auth method for ACP authenticate requests.
// Value matches AuthType.USE_OPENAI from @qwen-code/qwen-code-core.
// Cannot import directly because this file is used in the webview bundle
// where core (Node.js-only) is excluded as external.
export const authMethod = 'openai';

/**
 * Authenticate update notification (Qwen extension, not ACP spec).
 * Sent by agent during the OAuth flow.
 */
export interface AuthenticateUpdateNotification {
  _meta: {
    authUri: string;
  };
}

export interface SessionUpdateMeta {
  usage?: Usage | null;
  durationMs?: number | null;
  timestamp?: number | null;
}

export {
  ApprovalMode,
  APPROVAL_MODE_MAP,
  APPROVAL_MODE_INFO,
  getApprovalModeInfoFromString,
} from './approvalModeTypes.js';

export const NEXT_APPROVAL_MODE: {
  [k in ApprovalModeValue]: ApprovalModeValue;
} = {
  default: 'auto-edit',
  'auto-edit': 'yolo',
  plan: 'yolo',
  yolo: 'default',
};

// Ask User Question types
export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionRequest {
  sessionId: string;
  questions: Question[];
  metadata?: {
    source?: string;
  };
}
