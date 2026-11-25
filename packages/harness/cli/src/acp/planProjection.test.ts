/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { todosToPlanEntries } from './planProjection.js';

describe('todosToPlanEntries', () => {
  it('maps todo state to ACP plan entries', () => {
    expect(
      todosToPlanEntries({
        todos: [
          { description: 'Design', status: 'completed' },
          { description: 'Build', status: 'in_progress' },
          { description: 'Verify', status: 'pending' },
        ],
      }),
    ).toEqual([
      { content: 'Design', priority: 'medium', status: 'completed' },
      { content: 'Build', priority: 'medium', status: 'in_progress' },
      { content: 'Verify', priority: 'medium', status: 'pending' },
    ]);
  });

  it('returns null for non-todo inputs', () => {
    expect(todosToPlanEntries({})).toBeNull();
    expect(todosToPlanEntries({ todos: 'nope' })).toBeNull();
  });
});
