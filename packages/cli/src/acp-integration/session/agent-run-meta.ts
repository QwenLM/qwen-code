/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Reading the run frame a dispatched turn arrives with.
 *
 * Its own module because it is the boundary check that decides which thread an
 * agent's tools act on, and a check nobody can exercise is a check nobody can
 * trust. Session.ts is thirty thousand lines; this is thirty.
 */

import { DAEMON_AGENT_RUN_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';
import type { AgentRunContext } from '@qwen-code/qwen-code-core';

/**
 * The workspace-agent run this prompt is a turn of, if it is one.
 *
 * The bridge strips this key from every caller and re-injects it only from the
 * daemon dispatcher's request context, so reaching here means the daemon said
 * it. Validated field by field anyway: a frame built from a half-formed record
 * would name a thread that may not be the one the envelope describes, and the
 * thread tools would act on it.
 */
export function parsePromptAgentRun(params: {
  // Deliberately `unknown` rather than a record: the ACP `PromptRequest`
  // declares `_meta` with its own shape, and naming a stricter one here made
  // the real request unassignable. Any declared shape satisfies this, and the
  // check below is what establishes the shape anyway.
  _meta?: unknown;
}): AgentRunContext | undefined {
  const meta = params._meta as Record<string, unknown> | undefined;
  const value = meta?.[DAEMON_AGENT_RUN_META_KEY];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const run = value as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof run[key] === 'string' && (run[key] as string).length > 0
      ? (run[key] as string)
      : undefined;
  const workspaceId = text('workspaceId');
  const agentId = text('agentId');
  const runId = text('runId');
  const threadId = text('threadId');
  const rootThreadId = text('rootThreadId');
  const attempt = run['attempt'];
  if (
    !workspaceId ||
    !agentId ||
    !runId ||
    !threadId ||
    !rootThreadId ||
    typeof attempt !== 'number' ||
    !Number.isInteger(attempt) ||
    attempt < 1
  ) {
    return undefined;
  }
  const through = run['contextThroughSequence'];
  return {
    workspaceId,
    agentId,
    runId,
    threadId,
    rootThreadId,
    attempt,
    ...(typeof through === 'number' && Number.isInteger(through)
      ? { contextThroughSequence: through }
      : {}),
  };
}
