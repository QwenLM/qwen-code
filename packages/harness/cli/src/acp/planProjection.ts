/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as acp from '@agentclientprotocol/sdk';

export function todosToPlanEntries(input: unknown): acp.PlanEntry[] | null {
  if (!input || typeof input !== 'object' || !('todos' in input)) {
    return null;
  }

  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) {
    return null;
  }

  return todos
    .filter(
      (todo): todo is { description: string; status?: string } =>
        todo !== null &&
        typeof todo === 'object' &&
        'description' in todo &&
        typeof todo.description === 'string',
    )
    .map((todo) => ({
      content: todo.description,
      priority: 'medium',
      status:
        todo.status === 'completed'
          ? 'completed'
          : todo.status === 'in_progress'
            ? 'in_progress'
            : 'pending',
    }));
}
