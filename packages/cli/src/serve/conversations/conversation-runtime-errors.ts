/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type ConversationRuntimeOwnershipErrorCode =
  | 'conversation_runtime_in_use'
  | 'conversation_runtime_unavailable'
  | 'conversation_root_compromised'
  | 'conversation_runtime_ownership_compromised';

const DEFAULT_MESSAGES: Record<ConversationRuntimeOwnershipErrorCode, string> =
  {
    conversation_runtime_in_use:
      'The Conversations runtime is owned by another daemon.',
    conversation_runtime_unavailable:
      'The Conversations runtime is temporarily unavailable.',
    conversation_root_compromised:
      'The Conversations root could not be verified.',
    conversation_runtime_ownership_compromised:
      'The Conversations runtime ownership state could not be verified.',
  };

export class ConversationRuntimeOwnershipError extends Error {
  readonly status = 503;

  constructor(
    readonly code: ConversationRuntimeOwnershipErrorCode,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(DEFAULT_MESSAGES[code], options);
    this.name = 'ConversationRuntimeOwnershipError';
  }
}

export function conversationRuntimeInUseError(): ConversationRuntimeOwnershipError {
  return new ConversationRuntimeOwnershipError(
    'conversation_runtime_in_use',
    true,
  );
}

export function conversationRuntimeUnavailableError(
  cause?: unknown,
): ConversationRuntimeOwnershipError {
  return new ConversationRuntimeOwnershipError(
    'conversation_runtime_unavailable',
    true,
    { cause },
  );
}

export function conversationRuntimeOwnershipCompromisedError(
  cause?: unknown,
): ConversationRuntimeOwnershipError {
  return new ConversationRuntimeOwnershipError(
    'conversation_runtime_ownership_compromised',
    false,
    { cause },
  );
}

export function conversationRootCompromisedError(
  cause?: unknown,
): ConversationRuntimeOwnershipError {
  return new ConversationRuntimeOwnershipError(
    'conversation_root_compromised',
    false,
    { cause },
  );
}
