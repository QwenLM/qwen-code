/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const INVOCATION_CONTEXT_META_KEY = 'qwen-code/invocation';
export const PRIVATE_PARENT_CAPABILITY_META_KEY =
  'qwen-code/private-parent-capability';
export const PRIVATE_ACP_CAPABILITY_ENV = 'QWEN_CODE_PRIVATE_ACP_CAPABILITY';

export interface InvocationContextV1 {
  readonly version: 1;
  readonly sessionId: string;
  readonly promptId: string;
  readonly originatorClientId?: string;
  readonly workflowModeWriteAllowed?: boolean;
}

export interface ChannelWorkflowOrigin {
  readonly channelName: string;
  readonly chatId: string;
  readonly senderId: string;
  readonly threadId?: string;
  readonly isGroup?: boolean;
  readonly messageRoute?: string;
  readonly userInitiated?: true;
  readonly backgroundWorkflowBlocked?: true;
}

const invocationContextKeys = new Set([
  'version',
  'sessionId',
  'promptId',
  'originatorClientId',
  'workflowModeWriteAllowed',
]);

const invocationContextStorage = new AsyncLocalStorage<{
  invocation?: InvocationContextV1;
  channelWorkflowOrigin?: ChannelWorkflowOrigin;
  backgroundWorkflowBlocked?: true;
}>();

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseInvocationContext(
  value: unknown,
): InvocationContextV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !invocationContextKeys.has(key))) {
    return undefined;
  }
  if (
    record['version'] !== 1 ||
    !isNonBlankString(record['sessionId']) ||
    !isNonBlankString(record['promptId'])
  ) {
    return undefined;
  }

  let originatorClientId: string | undefined;
  if (Object.hasOwn(record, 'originatorClientId')) {
    if (!isNonBlankString(record['originatorClientId'])) {
      return undefined;
    }
    originatorClientId = record['originatorClientId'];
  }
  if (
    Object.hasOwn(record, 'workflowModeWriteAllowed') &&
    typeof record['workflowModeWriteAllowed'] !== 'boolean'
  ) {
    return undefined;
  }

  return Object.freeze({
    version: 1,
    sessionId: record['sessionId'],
    promptId: record['promptId'],
    ...(originatorClientId ? { originatorClientId } : {}),
    ...(typeof record['workflowModeWriteAllowed'] === 'boolean'
      ? { workflowModeWriteAllowed: record['workflowModeWriteAllowed'] }
      : {}),
  });
}

/**
 * `backgroundWorkflowBlocked` marks a Channel session turn that has no
 * launch origin (an origin-less channel prompt, or a cron, notification or
 * runtime goal turn of a session a channel drives). Its background workflow
 * would have no chat to report to or ask approvals in, so it must run in
 * the foreground. It is kept apart from the origin on purpose: the workflow
 * registry records the origin as a run's delivery target.
 */
export function runWithInvocationContext<T>(
  context: InvocationContextV1 | undefined,
  callback: () => T,
  channelWorkflowOrigin?: ChannelWorkflowOrigin,
  backgroundWorkflowBlocked = false,
): T {
  return invocationContextStorage.run(
    {
      invocation: context,
      channelWorkflowOrigin,
      ...(backgroundWorkflowBlocked
        ? { backgroundWorkflowBlocked: true as const }
        : {}),
    },
    callback,
  );
}

export function getInvocationContext(): InvocationContextV1 | undefined {
  return invocationContextStorage.getStore()?.invocation;
}

export function getChannelWorkflowOrigin(): ChannelWorkflowOrigin | undefined {
  return invocationContextStorage.getStore()?.channelWorkflowOrigin;
}

/**
 * Whether this turn must keep workflows in the foreground: its Channel
 * origin cannot receive a background result, or it is a Channel session
 * turn with no origin at all.
 */
export function isBackgroundWorkflowBlocked(): boolean {
  const store = invocationContextStorage.getStore();
  return (
    store?.backgroundWorkflowBlocked === true ||
    store?.channelWorkflowOrigin?.backgroundWorkflowBlocked === true
  );
}
