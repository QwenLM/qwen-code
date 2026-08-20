/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export const TODO_STOP_GUARD_MAX_ATTEMPTS = 2;

export type TodoStopGuardContinuation = {
  attempt: number;
  maxAttempts: number;
  unfinishedCount: number;
  toolClosure?: true;
};

export type TodoStopGuardDecision =
  | { kind: 'inactive' }
  | { kind: 'deferred' }
  | ({ kind: 'continue' } & TodoStopGuardContinuation)
  | ({ kind: 'exhausted' } & TodoStopGuardContinuation);

type StructuredTodo = {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

function parseStructuredTodos(value: unknown): StructuredTodo[] | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  if (record['type'] !== 'todo_list' || !Array.isArray(record['todos'])) {
    return null;
  }

  for (const item of record['todos']) {
    if (typeof item !== 'object' || item === null) return null;
    const todo = item as Record<string, unknown>;
    if (
      typeof todo['id'] !== 'string' ||
      typeof todo['content'] !== 'string' ||
      (todo['status'] !== 'pending' &&
        todo['status'] !== 'in_progress' &&
        todo['status'] !== 'completed')
    ) {
      return null;
    }
  }

  return record['todos'] as StructuredTodo[];
}

export class DaemonTodoStopGuard {
  #armed = false;
  #unfinishedCount = 0;
  #attempts = 0;
  #suspended = false;
  #retryPaused = false;
  #awaitingQueuedPrompt = false;
  #exhaustionReported = false;

  constructor(readonly enabled: boolean) {}

  get hasTrustedUnfinishedState(): boolean {
    return (
      this.enabled &&
      this.#armed &&
      !this.#suspended &&
      this.#unfinishedCount > 0
    );
  }

  get isHardSuspended(): boolean {
    return this.enabled && this.#suspended;
  }

  get hasCommittedContinuation(): boolean {
    return this.enabled && this.#attempts > 0;
  }

  get blocksUnrelatedAutomaticTurns(): boolean {
    return (
      this.enabled &&
      this.#armed &&
      !this.#suspended &&
      this.#unfinishedCount > 0
    );
  }

  get needsStopInspection(): boolean {
    return (
      this.enabled &&
      this.#armed &&
      !this.#suspended &&
      !this.#retryPaused &&
      !this.#awaitingQueuedPrompt &&
      this.#unfinishedCount > 0
    );
  }

  clearTrust(): void {
    this.#armed = false;
    this.#unfinishedCount = 0;
    this.#attempts = 0;
    this.#suspended = false;
    this.#retryPaused = false;
    this.#awaitingQueuedPrompt = false;
    this.#exhaustionReported = false;
  }

  startOrdinaryPrompt(): void {
    this.clearTrust();
  }

  resumeTrustedPrompt(): void {
    this.#awaitingQueuedPrompt = false;
    this.#retryPaused = false;
  }

  blockUntilOrdinaryPromptStarts(): void {
    this.clearTrust();
    this.#suspended = true;
  }

  acceptMidTurnUserInput(): void {
    if (!this.enabled || this.#suspended) return;
    if (!this.#armed && this.#attempts === 0) return;
    this.#attempts = 0;
    this.#retryPaused = false;
    this.#awaitingQueuedPrompt = false;
    this.#exhaustionReported = false;
  }

  observeTodoWrite(resultDisplay: unknown, allowArm: boolean): boolean {
    if (!this.enabled) return false;

    const todos = parseStructuredTodos(resultDisplay);
    if (todos === null) return false;

    if (!allowArm) {
      this.blockUntilOrdinaryPromptStarts();
      return true;
    }

    this.#unfinishedCount = todos.filter(
      (todo) => todo.status === 'pending' || todo.status === 'in_progress',
    ).length;
    this.#exhaustionReported = false;

    if (this.#unfinishedCount === 0) {
      this.#armed = false;
      return true;
    }

    if (!this.#suspended) this.#armed = true;
    return true;
  }

  suspend(): void {
    if (!this.enabled) return;
    this.#suspended = true;
    this.#awaitingQueuedPrompt = false;
  }

  pauseForTrustedRetry(): void {
    if (!this.#armed) return;
    this.#retryPaused = true;
    this.#awaitingQueuedPrompt = false;
  }

  awaitQueuedPrompt(): boolean {
    if ((!this.#armed && this.#attempts === 0) || this.#suspended) return false;
    this.#awaitingQueuedPrompt = true;
    return true;
  }

  decide(hasRelevantBackgroundInput: boolean): TodoStopGuardDecision {
    if (!this.needsStopInspection) return { kind: 'inactive' };
    if (hasRelevantBackgroundInput) return { kind: 'deferred' };

    if (this.#attempts >= TODO_STOP_GUARD_MAX_ATTEMPTS) {
      return {
        kind: 'exhausted',
        attempt: this.#attempts,
        maxAttempts: TODO_STOP_GUARD_MAX_ATTEMPTS,
        unfinishedCount: this.#unfinishedCount,
      };
    }

    return {
      kind: 'continue',
      attempt: this.#attempts + 1,
      maxAttempts: TODO_STOP_GUARD_MAX_ATTEMPTS,
      unfinishedCount: this.#unfinishedCount,
    };
  }

  decideToolClosure(
    currentAttempt: number,
    hasRelevantBackgroundInput: boolean,
  ): TodoStopGuardDecision {
    if (this.#unfinishedCount > 0) {
      return this.decide(hasRelevantBackgroundInput);
    }
    if (
      !this.enabled ||
      this.#suspended ||
      this.#retryPaused ||
      this.#awaitingQueuedPrompt ||
      this.#attempts !== currentAttempt
    ) {
      return { kind: 'inactive' };
    }
    if (hasRelevantBackgroundInput) return { kind: 'deferred' };
    if (currentAttempt >= TODO_STOP_GUARD_MAX_ATTEMPTS) {
      return { kind: 'inactive' };
    }
    return {
      kind: 'continue',
      attempt: currentAttempt + 1,
      maxAttempts: TODO_STOP_GUARD_MAX_ATTEMPTS,
      unfinishedCount: 0,
      toolClosure: true,
    };
  }

  commitContinuation(attempt: number): boolean {
    const canCloseTools =
      this.enabled &&
      this.#unfinishedCount === 0 &&
      this.#attempts > 0 &&
      !this.#suspended &&
      !this.#retryPaused &&
      !this.#awaitingQueuedPrompt;
    if (
      (!this.needsStopInspection && !canCloseTools) ||
      attempt !== this.#attempts + 1 ||
      attempt > TODO_STOP_GUARD_MAX_ATTEMPTS
    ) {
      return false;
    }
    this.#attempts = attempt;
    return true;
  }

  markExhaustionReported(): boolean {
    if (this.#exhaustionReported) return false;
    this.#exhaustionReported = true;
    this.#suspended = true;
    return true;
  }
}
