/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  parseHostedApprovalSelection,
  readHostedTurnApprovalSelection,
  hostedTurnApproval,
  createHostedLiveApprovalReader,
} from './hosted-approval-selection.js';

function committed(
  selection?: unknown,
  promptId = 'prompt',
  source = 'hosted-harness',
) {
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
            source,
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
    { mode: 'AUTO', revision: 1 },
    { mode: 'auto', revision: 0 },
    {
      mode: 'default',
      revision: 0,
      permissionRules: { allow: ['Read'], ask: [], deny: [] },
    },
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
  it('keeps Plan independent of the execution policy and requires a positive snapshot revision', async () => {
    for (const mode of ['default', 'auto-edit', 'auto', 'yolo']) {
      expect(
        parseHostedApprovalSelection({ mode, revision: 1, planMode: true }),
      ).toEqual({ mode, revision: 1, planMode: true });
      expect(
        await hostedTurnApproval(
          committed({ mode, revision: 1, planMode: true }),
          'prompt',
          { mode: 'default', timeoutMs: 1000 },
        ),
      ).toEqual({ mode, timeoutMs: 1000 });
    }
    for (const planMode of [false, null, 'true', 1])
      expect(() =>
        parseHostedApprovalSelection({ mode: 'yolo', revision: 1, planMode }),
      ).toThrow();
    expect(() =>
      parseHostedApprovalSelection({
        mode: 'yolo',
        revision: 0,
        planMode: true,
      }),
    ).toThrow();
  });
  it('snapshots rules and refuses a same-revision rewrite or an active policy replacement', async () => {
    const permissionRules = {
      allow: ['Bash(git status*)'],
      ask: ['Write'],
      deny: [],
    };
    const selected = { mode: 'auto' as const, revision: 2, permissionRules };
    expect(
      await hostedTurnApproval(committed(selected), 'prompt', {
        mode: 'default',
        timeoutMs: 1000,
      }),
    ).toEqual({ mode: 'auto', timeoutMs: 1000, permissionRules });
    let current = selected;
    const read = createHostedLiveApprovalReader(
      { mode: 'auto', timeoutMs: 1000, permissionRules },
      selected,
      async () => current,
    );
    await expect(read()).resolves.toMatchObject({ permissionRules });
    current = {
      ...selected,
      revision: 3,
      permissionRules: { allow: [], ask: [], deny: [] },
    };
    await expect(read()).rejects.toThrow('regressed');
    expect(permissionRules.allow).toEqual(['Bash(git status*)']);
  });
  it.each(['monitor', 'automation', 'session_message'])(
    'seeds a %s wake from SQL while preserving a normal Turn admission',
    async (source) => {
      const permissionRules = {
        allow: ['Read'],
        ask: ['Bash'],
        deny: ['Write'],
      };
      const current = vi.fn(async () => ({
        mode: 'auto' as const,
        revision: 4,
        permissionRules,
      }));
      const wake = committed(undefined, 'prompt', source);
      const selected = await readHostedTurnApprovalSelection(
        wake,
        'prompt',
        current,
      );
      expect(selected).toEqual({ mode: 'auto', revision: 4, permissionRules });
      await expect(
        hostedTurnApproval(
          wake,
          'prompt',
          { mode: 'default', timeoutMs: 1000 },
          selected,
        ),
      ).resolves.toEqual({ mode: 'auto', timeoutMs: 1000, permissionRules });
      current.mockClear();
      const admitted = committed({ mode: 'default', revision: 2 });
      expect(
        await readHostedTurnApprovalSelection(admitted, 'prompt', current),
      ).toEqual({ mode: 'default', revision: 2 });
      expect(current).not.toHaveBeenCalled();
    },
  );
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
  it('reads the current policy in both directions without changing the Turn snapshot or timeout', async () => {
    const admission = {
      mode: 'auto-edit' as const,
      revision: 3,
      planMode: true as const,
    };
    let selected = {
      mode: 'yolo' as 'default' | 'auto-edit' | 'yolo',
      revision: 4,
    };
    const read = createHostedLiveApprovalReader(
      { mode: 'auto-edit', timeoutMs: 12345 },
      admission,
      async () => selected,
    );
    await expect(read()).resolves.toEqual({ mode: 'yolo', timeoutMs: 12345 });
    selected = { mode: 'default', revision: 5 };
    await expect(read()).resolves.toEqual({
      mode: 'default',
      timeoutMs: 12345,
    });
    expect(admission).toEqual({
      mode: 'auto-edit',
      revision: 3,
      planMode: true,
    });
    selected = { mode: 'yolo', revision: 4 };
    await expect(read()).rejects.toThrow('regressed');
  });
  it.each([
    undefined,
    { mode: 'default' as const, revision: 1 },
    { mode: 'yolo' as const, revision: 2 },
  ])(
    'refuses missing or regressed live policy %j without a fallback',
    async (selection) => {
      const read = createHostedLiveApprovalReader(
        { mode: 'default', timeoutMs: 1000 },
        { mode: 'default', revision: 2 },
        async () => selection,
      );
      await expect(read()).rejects.toThrow('missing or regressed');
    },
  );
  it('does not fall back after a policy transport failure', async () => {
    const read = createHostedLiveApprovalReader(
      { mode: 'yolo', timeoutMs: 1000 },
      undefined,
      async () => {
        throw new Error('writer fenced');
      },
    );
    await expect(read()).rejects.toThrow('writer fenced');
  });
  it('serializes concurrent policy queries before comparing their revisions', async () => {
    let release!: (selection: { mode: 'default'; revision: number }) => void;
    const firstQuery = new Promise<{ mode: 'default'; revision: number }>(
      (resolve) => {
        release = resolve;
      },
    );
    const query = vi
      .fn()
      .mockReturnValueOnce(firstQuery)
      .mockResolvedValueOnce({ mode: 'yolo', revision: 1 });
    const read = createHostedLiveApprovalReader(
      { mode: 'default', timeoutMs: 1000 },
      undefined,
      query,
    );
    const first = read();
    const second = read();
    await Promise.resolve();
    expect(query).toHaveBeenCalledOnce();
    release({ mode: 'default', revision: 0 });
    await expect(first).resolves.toEqual({ mode: 'default', timeoutMs: 1000 });
    await expect(second).resolves.toEqual({ mode: 'yolo', timeoutMs: 1000 });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('keeps the serialized reader usable after a failed query', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport down'))
      .mockResolvedValueOnce({ mode: 'yolo', revision: 1 });
    const read = createHostedLiveApprovalReader(
      { mode: 'default', timeoutMs: 1000 },
      undefined,
      query,
    );
    const first = read();
    const second = read();
    await expect(first).rejects.toThrow('transport down');
    await expect(second).resolves.toEqual({ mode: 'yolo', timeoutMs: 1000 });
  });
});
