/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns context environment variables to inject into shell subprocesses.
 *
 * Reads dynamic context (session ID, agent ID, prompt ID) from
 * AsyncLocalStorage at call time, falling back to process.env for the
 * session ID (set by Config at session start in the single-session CLI).
 * This enables downstream scripts to identify which session, agent, and
 * prompt triggered their execution — useful for tracing, audit logging,
 * and business context correlation.
 *
 * The ALS-first lookup matters in daemon mode: one process hosts many
 * sessions, but only the first Config ever claims the process-global
 * env slot (`sessionEnvClaimed` in config.ts), so process.env alone
 * would report a stale session ID for every later session.
 *
 * Must be called at spawn time within the executing async context to
 * capture the correct session/agent/prompt frame.
 */

import { getCurrentAgentId } from '../agents/runtime/agent-context.js';
import { promptIdContext } from './promptIdContext.js';
import { sessionIdContext } from './sessionIdContext.js';
import {
  isShellTracePropagationEnabled,
  getTraceContext,
  formatTraceparent,
} from '../telemetry/trace-context.js';

export function getShellContextEnvVars(): Record<string, string> {
  const env: Record<string, string> = {};

  // Prefer the per-async-context session ID (set by multi-session hosts
  // like the daemon) over the process-global env slot, which only ever
  // reflects the first session created in this process.
  const sessionId =
    sessionIdContext.getStore() ?? process.env['QWEN_CODE_SESSION_ID'];
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
