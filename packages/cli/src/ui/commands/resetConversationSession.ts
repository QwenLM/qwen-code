/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  uiTelemetryService,
  refreshSessionRegistryEntry,
  getOriginalCwd,
  setCwdAndNotify,
  HookEventName,
  type SessionEndReason,
  type SessionStartSource,
} from '@qwen-code/core';
import { MessageType } from '../types.js';
import type { CommandContext } from './types.js';

interface ResetConversationSessionOptions {
  sessionEndReason: SessionEndReason;
  sessionStartSource: SessionStartSource;
}

export async function resetConversationSession(
  context: CommandContext,
  options: ResetConversationSessionOptions,
): Promise<void> {
  const config = context.services.agentContext?.config;

  const hookSystem = config?.getHookSystem();
  if (hookSystem) {
    await hookSystem.fireSessionEndEvent(options.sessionEndReason);
  }

  // Output-style selections are pending until an explicit conversation reset.
  // Resolve before clearing history so a loading failure leaves it recoverable.
  // The prompt cache is invalidated only for the fresh conversation.
  await config?.resetOutputStyleForNewSession();

  config?.injectionService.clear();

  // The topic title/intent is session-scoped state (see TopicState). A fresh
  // /clear or /new session must not inherit the previous session's topic,
  // otherwise session-identity consumers (agent-team naming, StatusLine session
  // name) keep reporting the old session's title after the reset.
  config?.topicState.reset();

  // Shell cwd cleanup: the Bash tool's persistent cwd lives as module-level
  // state in core's Shell.ts and survives session resets. A `cd` from the
  // previous session would otherwise leak into the fresh session, diverging
  // from a real CLI restart. Reset it to the original launch directory
  // (which worktree flows keep in sync via setOriginalCwd). Notify CWD
  // observers before SessionStart so relative FileChanged watcher paths are
  // synchronously rebased without waiting for external CwdChanged hooks.
  setCwdAndNotify(getOriginalCwd());

  // Goal cleanup: /clear starts a fresh session, so any goal's in-memory /
  // persisted state must be wiped before Config switches to the new id.
  const goalManager = config?.getGoalManager();
  goalManager?.clearGoal({
    reason: 'user',
  });

  config?.resetPermissionSession();

  let newSessionId: string | undefined;
  if (config) {
    newSessionId = randomUUID();
    config.setSessionId(newSessionId);
    // The process keeps the same peer socket across `/clear` and `/new`, so
    // replace its published identity in place instead of leaving peers with
    // the outgoing session's id and name.
    refreshSessionRegistryEntry({ sessionId: newSessionId, name: undefined });
  }

  if (context.setMessages) {
    context.ui.setDebugMessage('Clearing terminal and resetting chat.');
    context.setMessages(() => []);
  } else {
    context.ui.setDebugMessage('Clearing terminal.');
  }

  let result;
  if (hookSystem) {
    result = await hookSystem.fireSessionStartEvent(
      options.sessionStartSource,
      config?.getModel(),
    );
  }

  await new Promise((resolve) => setImmediate(resolve));

  uiTelemetryService.clear(newSessionId);
  context.ui.clear();

  if (result?.systemMessage) {
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: result.systemMessage,
      },
      Date.now(),
    );
  }

  const additionalContext = result?.getAdditionalContext();
  if (additionalContext && context.queueHookContext) {
    context.queueHookContext(
      additionalContext,
      HookEventName.SessionStart,
      'additionalContext',
    );
  }

  const stdoutForModel = result?.getStdoutForModel(HookEventName.SessionStart);
  if (stdoutForModel && !result?.suppressOutput && context.queueHookContext) {
    context.queueHookContext(
      stdoutForModel,
      HookEventName.SessionStart,
      'stdout',
    );
  }
}
