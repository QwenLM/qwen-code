/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import {
  findRestorableManagedApproval,
  restorableManagedApprovalCallIds,
} from './managed-approval-restore.js';

describe('findRestorableManagedApproval', () => {
  const last: Content = {
    role: 'model',
    parts: [
      {
        functionCall: {
          id: 'fc-wait-1',
          name: 'run_shell_command',
          args: { command: 'ls' },
        },
      },
    ],
  };

  it('restores the waited tool call and nothing else', () => {
    expect(findRestorableManagedApproval(last, 'fc-wait-1')).toEqual({
      functionCalls: [last.parts![0]!.functionCall],
    });
    expect(restorableManagedApprovalCallIds(last, 'fc-wait-1')).toEqual(
      new Set(['fc-wait-1']),
    );
  });

  it('rejects a mixed dangling batch or a different id', () => {
    expect(findRestorableManagedApproval(last, 'fc-other')).toBeUndefined();
    expect(
      findRestorableManagedApproval(
        {
          role: 'model',
          parts: [
            last.parts![0],
            {
              functionCall: {
                id: 'fc-2',
                name: 'read_file',
                args: { path: 'a.ts' },
              },
            },
          ],
        },
        'fc-wait-1',
      ),
    ).toBeUndefined();
  });

  it('does not restore a user turn or a finished assistant turn', () => {
    expect(
      findRestorableManagedApproval(
        { role: 'user', parts: [{ text: 'go' }] },
        'fc-wait-1',
      ),
    ).toBeUndefined();
    expect(
      findRestorableManagedApproval(
        { role: 'model', parts: [{ text: 'done' }] },
        'fc-wait-1',
      ),
    ).toBeUndefined();
  });
});
