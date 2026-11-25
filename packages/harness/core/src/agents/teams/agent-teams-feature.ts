/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_AGENT_TEAMS } from '../../config/brand.js';
import { isAgentSessionsEnabled } from '../agent-session-feature.js';

export const IN_PROCESS_TEAMMATE_TASK_TYPE = 'in_process_teammate' as const;

export function isAgentTeamsEnabled(): boolean {
  const value = process.env[ENV_AGENT_TEAMS];
  return value === '1' || value === 'true';
}

export function isInProcessTeammateFeatureEnabled(): boolean {
  return isAgentSessionsEnabled() && isAgentTeamsEnabled();
}

export function deriveSessionTeamName(sessionId: string): string {
  const normalized = sessionId.replace(/[^a-zA-Z0-9]/g, '');
  return `session-${normalized.slice(0, 8)}`;
}
