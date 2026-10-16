/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  parseHostedApprovalSelection,
  hostedTurnApproval,
} from './hosted-approval-selection.js';

function committed(selection?: unknown, promptId = 'prompt') {
  const bytes = Buffer.from(
    JSON.stringify({
      promptId,
      ...(selection === undefined ? {} : { approvalSelection: selection }),
    }),
  );
  return {
    authority: {
      committedSequence: 1,
      eventsInSequenceRange: () => [
        {
          kind: 'input.accepted',
          payload: {
            inputId: 'prompt',
            source: 'hosted-harness',
            admissionRef: {
              resourceId: 'admission',
              kind: 'managed-admission',
              schemaVersion: 1,
              byteLength: bytes.length,
              digest: '0'.repeat(64),
            },
          },
        },
      ],
    },
    resources: { read: async () => bytes },
  } as unknown as ManagedSession;
}

describe('Hosted approval selection', () => {
  it('permits legacy callers and exact supported modes at revision zero', () => {
    expect(parseHostedApprovalSelection(undefined)).toBeUndefined();
    for (const mode of ['default', 'auto-edit', 'yolo'])
      expect(parseHostedApprovalSelection({ mode, revision: 0 })).toEqual({
        mode,
        revision: 0,
      });
  });
  it.each([
    null,
    [],
    {},
    { mode: ['yolo'], revision: 1 },
    { mode: 'yolo ', revision: 1 },
    { mode: 'auto', revision: 1 },
    { mode: 'yolo', revision: -1 },
    { mode: 'yolo', revision: 1.5 },
    { mode: 'yolo', revision: Number.MAX_SAFE_INTEGER + 1 },
    { mode: 'yolo', revision: '1' },
    { mode: 'yolo', revision: 1, extra: true },
  ])('rejects an invalid snapshot %j', (value) => {
    expect(() => parseHostedApprovalSelection(value)).toThrow(
      'Invalid Hosted approval selection',
    );
  });
  it('uses the committed Turn override and retains the initial timeout', async () => {
    const initial = { mode: 'default' as const, timeoutMs: 12345 };
    expect(
      await hostedTurnApproval(
        committed({ mode: 'yolo', revision: 2 }),
        'prompt',
        initial,
      ),
    ).toEqual({ mode: 'yolo', timeoutMs: 12345 });
    expect(await hostedTurnApproval(committed(), 'prompt', initial)).toEqual(
      initial,
    );
  });
  it('refuses mismatched prompts and conflicting revision-zero snapshots', async () => {
    const initial = { mode: 'default' as const, timeoutMs: 1000 };
    await expect(
      hostedTurnApproval(
        committed({ mode: 'yolo', revision: 1 }, 'other'),
        'prompt',
        initial,
      ),
    ).rejects.toThrow();
    await expect(
      hostedTurnApproval(
        committed({ mode: 'yolo', revision: 0 }),
        'prompt',
        initial,
      ),
    ).rejects.toThrow();
  });
});
