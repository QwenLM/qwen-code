/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns context environment variables to inject into shell subprocesses.
 *
 * Reads dynamic context (agent ID, prompt ID) from AsyncLocalStorage at
 * call time, and session ID from process.env (set by Config at session
 * start). This enables downstream scripts to identify which session,
 * agent, and prompt triggered their execution — useful for tracing,
 * audit logging, and business context correlation.
 *
 * Must be called at spawn time within the executing async context to
 * capture the correct agent/prompt frame.
 */

import { getCurrentAgentId } from '../agents/runtime/agent-context.js';
import { promptIdContext } from './promptIdContext.js';
import {
  isShellTracePropagationEnabled,
  getTraceContext,
  formatTraceparent,
} from '../telemetry/trace-context.js';

export function getShellContextEnvVars(): Record<string, string> {
  const env: Record<string, string> = {};

  const sessionId = process.env['QWEN_CODE_SESSION_ID'];
  if (sessionId) {
    env['QWEN_CODE_SESSION_ID'] = sessionId;
  }

  // For agent/prompt IDs: explicitly set empty string when no ALS context
  // exists, so that stale values inherited from a parent qwen-code process
  // (via process.env spread) are overwritten rather than leaked.
  const agentId = getCurrentAgentId();
  env['QWEN_CODE_AGENT_ID'] = agentId ?? '';

  const promptId = promptIdContext.getStore();
  env['QWEN_CODE_PROMPT_ID'] = promptId ?? '';

  if (isShellTracePropagationEnabled()) {
    const ctx = getTraceContext();
    env['TRACEPARENT'] = ctx ? formatTraceparent(ctx) : '';
    env['TRACESTATE'] = '';
  }

  return env;
}
