/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SystemPrompt } from '../prompts/types.js';
import type { Message, UserMessage } from '../protocol/transcript/message.js';
import type { TaskTrigger } from '../core/task-trigger.js';
import type { QueryState } from './state.js';

/** Business facts at the first selected model, before result handling. */
export interface TaskStartedFacts {
  readonly occurredAt: number;
  readonly taskId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly commandInvocationId?: string;
  readonly trigger: TaskTrigger;
  readonly promptText: string;
  readonly priorHistory: readonly Message[];
  readonly initialMessages: readonly Message[];
  readonly currentMessage?: UserMessage;
  readonly currentMessageUuid?: string;
  readonly systemPrompt?: SystemPrompt;
  readonly permissionMode?: string;
  readonly model: string;
  readonly thinkingBudget?: number;
  readonly reasoningEffort?: string;
  readonly isSubagent: boolean;
  readonly goal?: Readonly<{ id?: string; active: boolean }>;
}

/** A detached, recursively frozen snapshot; transcript input is serializable. */
export function immutableSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

export function captureTaskStarted(
  state: QueryState,
): TaskStartedFacts | undefined {
  const { input, lifecycle, model } = state;
  if (state.task.started || !lifecycle || !model) return undefined;
  state.task.started = true;
  const { params } = input;
  let goal: TaskStartedFacts['goal'];
  try {
    const manager =
      params.isSubagent === true ? undefined : input.config.getGoalManager();
    if (manager)
      goal = { id: manager.getGoalId(), active: manager.isGoalActive };
  } catch {
    // An unavailable optional goal manager does not prevent task startup.
  }
  const initialMessages = state.task.initialMessages ?? [];
  const frozenInitialMessages = Object.isFrozen(initialMessages)
    ? initialMessages
    : immutableSnapshot(initialMessages);
  return Object.freeze({
    ...immutableSnapshot({
      occurredAt: Date.now(),
      taskId: lifecycle.requestSetId,
      sessionId: input.sessionId,
      promptId: params.promptId,
      commandInvocationId: params.commandInvocationId,
      trigger: state.task.trigger!,
      promptText: input.promptText,
      priorHistory: params.messages ?? [],
      currentMessage: state.userMessage,
      currentMessageUuid: params.userMessage?.uuid,
      systemPrompt: model.systemPrompt,
      permissionMode: params.permissionMode,
      model: model.key,
      thinkingBudget: model.initialThinkingBudget,
      reasoningEffort: model.resolution.config.reasoning?.effort,
      isSubagent: params.isSubagent === true,
      goal,
    }),
    initialMessages: frozenInitialMessages,
  });
}
