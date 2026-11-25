/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  collectGitContext,
  takeSystemContextPrefetch,
} from '../../context/system-context.js';
import type { Message } from '../../protocol/transcript/message.js';
import { getCwd, runWithShellSession } from '../../utils/Shell.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  SessionContextAttachment,
  isSessionContextMessage,
  SESSION_CONTEXT_FIELDS,
  sessionContextSchema,
  type SessionContext,
  type SessionContextInput,
  type SessionContextReason,
} from '../models/session-context-attachment.js';
import type { AttachmentToolUseContext } from '../types.js';

/**
 * Git describes the start of the retained conversation, not each tool round.
 * Only missing/unreadable history triggers Git collection. Other context fields
 * are compared with the last announcement. Empty contexts are baselines too.
 */
export async function getSessionContextAttachments(
  ctx: AttachmentToolUseContext,
  messages: readonly Message[],
  options: {
    sessionId: string;
    isSubagent?: boolean;
    omitGitStatus?: boolean;
    /** Authoritative non-Git snapshot. Omission preserves inherited values. */
    sessionContext?: SessionContextInput;
    reason?: SessionContextReason;
    /** Utility requests reuse an existing announcement without updating it. */
    isAuxiliary?: boolean;
    signal?: AbortSignal;
  },
): Promise<SessionContextAttachment[]> {
  if (!ctx.config) return [];
  const cwd = runWithShellSession(ctx.config, getCwd);
  // Consume even on resume: a startup prefetch must not survive until a later
  // compaction and masquerade as the freshly collected post-compact state.
  const prefetch = options.isSubagent
    ? undefined
    : takeSystemContextPrefetch(options.sessionId, cwd);
  const parsedPrevious = sessionContextSchema.safeParse(
    messages.findLast(isSessionContextMessage)?.attachment.context,
  );
  const previous = parsedPrevious.success ? parsedPrevious.data : undefined;
  if (previous && options.isAuxiliary) return [];
  const { gitStatus: retainedGit, ...retainedContext } = previous ?? {};
  const context: SessionContext = sessionContextSchema.parse(
    options.sessionContext?.context ?? retainedContext,
  );
  delete context.gitStatus;
  // Never let a context refresh or omission policy replace retained Git.
  if (previous) {
    if (retainedGit !== undefined) context.gitStatus = retainedGit;
  } else if (!options.omitGitStatus) {
    try {
      const { gitStatus } = await (prefetch ??
        collectGitContext(cwd, options.signal));
      if (gitStatus !== undefined) context.gitStatus = gitStatus;
    } catch (error) {
      options.signal?.throwIfAborted();
      runLogger.warn('[SessionContext] Failed to collect Git context:', error);
    }
  }
  if (
    previous &&
    SESSION_CONTEXT_FIELDS.every((field) => previous[field] === context[field])
  )
    return [];
  return [
    new SessionContextAttachment({
      type: 'session_context',
      context,
      ...(previous && {
        changed: true,
        reason:
          options.sessionContext?.reason ?? options.reason ?? 'session_start',
      }),
    }),
  ];
}
