/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end roundtrip: write a `system/compact_boundary` marker through
 * the transcript writer handle, read it back via `TranscriptRepository`, then confirm
 * `findCompressionBoundary` re-anchors on the same marker.
 *
 * This is the full guarantee that drives the "transcript JSONL is the single
 * source of truth for the compression boundary" invariant — if it breaks, the
 * pipeline falls back to `initial_history` and resumed sessions re-compress
 * the entire pre-compact prefix.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../protocol/transcript/message.js';
import { createTestTranscriptWriter } from '../services/transcript/testing/fixtures.js';
import { TranscriptRepository } from '../services/transcript/repository.js';
import type { Config } from '../config/config.js';
import { HookEventName } from '../hooks/types.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';
import {
  HookOutputAttachment,
  HookSuccessAttachment,
} from '../attachments/models/hook-attachments.js';
import { createUserMessage } from '../protocol/transcript/conversions.js';
import { applyPostCompact } from './apply-post-compact.js';
import { retainCompactionPrefix } from './compaction-prefix.js';
import { buildPostCompactHistory } from './compact-utils.js';
import { normalizeMessagesForAPI } from '../protocol/provider/request-converter.js';
import { makeUser, makeAssistant } from './test-helpers.js';
import {
  createCompactBoundaryMessage,
  findCompressionBoundary,
} from './boundary.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createWriter(sessionId: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compaction-roundtrip-'));
  tempDirs.push(dir);

  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const { writer } = await createTestTranscriptWriter({
    filePath,
    sessionId,
    cwd: '/workspace/project',
    entrypoint: 'cli',
    version: '1.2.3',
    gitBranch: 'feat/test',
    flushIntervalMs: 0,
  });
  return { writer, filePath };
}

describe('compact_boundary transcript roundtrip', () => {
  it.each(
    [
      { toolCount: 1, followup: false },
      { toolCount: 1, followup: true },
      { toolCount: 2, followup: false },
      { toolCount: 2, followup: true },
    ].flatMap((scenario) => [
      { ...scenario, newHook: false },
      { ...scenario, newHook: true },
    ]),
  )(
    'restores $toolCount retained tool results (followup=$followup, newHook=$newHook)',
    async ({ toolCount, followup, newHook }) => {
      const { writer, filePath } = await createWriter(randomUUID());
      const prefix = createAttachmentMessage(
        new HookOutputAttachment({
          type: 'hook_output',
          hookEventName: HookEventName.SessionStart,
          output: 'RETAINED_PREFIX',
        }),
      );
      const calls = Array.from({ length: toolCount }, (_, i) => ({
        ...makeAssistant([
          {
            type: 'tool_use' as const,
            id: `kept-${i}`,
            name: 'Read',
            input: { file_path: `/missing-${i}` },
          },
        ]),
        responseGroupId: 'retained-group',
      }));
      const results = calls.map((call, i) => ({
        ...makeUser([
          {
            type: 'tool_result' as const,
            tool_use_id: `kept-${i}`,
            content: `RETAINED_RESULT_${i}`,
          },
        ]),
        sourceToolAssistantUUID: call.uuid,
      }));
      const retained = [...calls, ...results];
      const prior = [
        makeUser('old task'),
        prefix,
        makeAssistant([{ type: 'text', text: 'old answer' }]),
        ...retained,
      ];
      let parent = await writer.recordMessages(prior);
      const next = buildPostCompactHistory('SUMMARY', [], new Set(), {
        trigger: 'manual',
        preTokens: 1000,
      });
      retainCompactionPrefix(prior, next, retained);
      next.push(...retained);
      if (newHook)
        next.push(
          createAttachmentMessage(
            new HookOutputAttachment({
              type: 'hook_output',
              hookEventName: HookEventName.SessionStart,
              output: 'FRESH_COMPACT_HOOK',
            }),
          ),
        );
      try {
        await applyPostCompact(prior, next, {
          replaceMessages: () => {},
          pushAttachments: () => {},
          transcriptParentUuid: () => parent,
          setTranscriptParentUuid: (uuid) => {
            parent = uuid;
          },
          transcriptWriter: writer,
          attachmentCtx: createAttachmentContext(path.dirname(filePath)),
          config: {
            getApprovedPlanPath: () => null,
            isPlanMode: () => false,
          } as unknown as Config,
        });
        if (followup) {
          const continued = [
            makeUser('continue'),
            makeAssistant([{ type: 'text', text: 'continued' }]),
          ];
          await writer.recordMessages(continued, parent);
          next.push(...continued);
        }
      } finally {
        await writer.close();
      }
      const resumed = await new TranscriptRepository().resolveSession(filePath);
      expect(normalizeMessagesForAPI(resumed!.messages)).toEqual(
        normalizeMessagesForAPI(next),
      );
      const rows = (await fs.readFile(filePath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      for (const message of retained)
        expect(rows.filter((row) => row.uuid === message.uuid)).toHaveLength(1);
    },
  );

  it('persists a retained prefix hook exactly once and restores its user placement', async () => {
    const { writer, filePath } = await createWriter(randomUUID());
    const context = createAttachmentMessage(
      new HookOutputAttachment({
        type: 'hook_output',
        hookEventName: HookEventName.SessionStart,
        output: 'PREFIX_HOOK_ONCE',
      }),
    );
    const prior = [
      createUserMessage('old question'),
      context,
      makeAssistant([{ type: 'text', text: 'old answer' }]),
    ];
    let parent = await writer.recordMessages(prior);
    const next = buildPostCompactHistory('new summary', [], new Set(), {
      trigger: 'auto',
      preTokens: 1000,
    });
    retainCompactionPrefix(prior, next);
    try {
      await applyPostCompact(prior, next, {
        replaceMessages: () => {},
        pushAttachments: () => {},
        transcriptParentUuid: () => parent,
        setTranscriptParentUuid: (uuid) => {
          parent = uuid;
        },
        transcriptWriter: writer,
        attachmentCtx: createAttachmentContext(path.dirname(filePath)),
        config: {
          getApprovedPlanPath: () => null,
          isPlanMode: () => false,
        } as unknown as Config,
      });
    } finally {
      await writer.close();
    }
    const disk = (await fs.readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const copied = next.find(
      (m) => m.isCompactionPrefix && !m.isCompactSummary,
    )!;
    expect(disk.filter((m) => m.uuid === copied.uuid)).toHaveLength(1);
    const resumed = await new TranscriptRepository().resolveSession(filePath);
    expect(normalizeMessagesForAPI(resumed!.messages)).toEqual(
      normalizeMessagesForAPI(next),
    );
  });
  it.each([
    { followup: false, replacedHistory: false },
    { followup: true, replacedHistory: false },
    { followup: false, replacedHistory: true },
  ])(
    'restores compact hook outputs after writer close ($followup, $replacedHistory)',
    async ({ followup, replacedHistory }) => {
      const sessionId = randomUUID();
      const { writer, filePath } = await createWriter(sessionId);
      const previous = createUserMessage('Explain the event loop.');
      const boundary = createCompactBoundaryMessage({
        trigger: 'manual',
        preTokens: 100,
        postTokens: 20,
        messagesSummarized: 1,
      });
      const summary = createUserMessage('Summary: discussed the event loop.', {
        isCompactSummary: true,
      });
      const context = createAttachmentMessage(
        new HookOutputAttachment({
          type: 'hook_output',
          hookEventName: HookEventName.SessionStart,
          output: 'COMPACT_CONTEXT_TOKEN=violet-8392',
        }),
      );
      const stdout = createAttachmentMessage(
        new HookSuccessAttachment({
          type: 'hook_success',
          hookEvent: HookEventName.SessionStart,
          hookName: 'SessionStart:compact',
          toolUseID: '',
          content: 'COMPACT_STDOUT_TOKEN=green-5721',
        }),
      );
      const newHistory = [boundary, summary, context, stdout];
      let runtime: Message[] = [];
      try {
        let parentUuid = await writer.recordMessages([previous]);
        await applyPostCompact(
          replacedHistory ? newHistory : [previous],
          newHistory,
          {
            replaceMessages: (messages) => {
              runtime = messages;
            },
            pushAttachments: (messages) => {
              runtime.push(...messages);
            },
            transcriptParentUuid: () => parentUuid,
            setTranscriptParentUuid: (uuid) => {
              parentUuid = uuid;
            },
            transcriptWriter: writer,
            attachmentCtx: createAttachmentContext(
              path.dirname(filePath),
              sessionId,
            ),
            config: {
              getApprovedPlanPath: () => null,
              isPlanMode: () => true,
            } as unknown as Config,
          },
        );
        if (followup) {
          const next = createUserMessage(
            'Continue without repeating hook output.',
          );
          runtime.push(next);
          await writer.recordMessages([next], parentUuid);
        }
      } finally {
        await writer.close();
      }

      const disk = (await fs.readFile(filePath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        disk.filter((message) => message.uuid === context.uuid),
      ).toHaveLength(1);
      expect(
        disk.filter((message) => message.uuid === stdout.uuid),
      ).toHaveLength(1);
      expect(
        disk.find((message) => message.uuid === context.uuid)?.parentUuid,
      ).toBe(summary.uuid);
      expect(
        disk.find((message) => message.uuid === stdout.uuid)?.parentUuid,
      ).toBe(context.uuid);
      const restored = await new TranscriptRepository().resolveSession(
        filePath,
      );
      expect(restored?.messages.map((message) => message.uuid)).toEqual(
        runtime.map((message) => message.uuid),
      );
      expect(restored?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            uuid: context.uuid,
            attachment: expect.objectContaining({
              type: 'hook_output',
              output: 'COMPACT_CONTEXT_TOKEN=violet-8392',
            }),
          }),
          expect.objectContaining({
            uuid: stdout.uuid,
            attachment: expect.objectContaining({
              type: 'hook_success',
              content: 'COMPACT_STDOUT_TOKEN=green-5721',
            }),
          }),
        ]),
      );
    },
  );

  it('persists a hook attachment kept verbatim by partial compaction only once', async () => {
    const sessionId = randomUUID();
    const { writer, filePath } = await createWriter(sessionId);
    const previous = createUserMessage('Explain the event loop.');
    let parentUuid = await writer.recordMessages([previous]);

    // Written by an earlier compaction, then kept verbatim by `up_to`.
    const keptHook = createAttachmentMessage(
      new HookOutputAttachment({
        type: 'hook_output',
        hookEventName: HookEventName.SessionStart,
        output: 'KEPT_CONTEXT_TOKEN=violet-0001',
      }),
    );
    parentUuid = await writer.recordMessages([keptHook], parentUuid);

    const boundary = createCompactBoundaryMessage({
      trigger: 'manual',
      preTokens: 100,
      postTokens: 20,
      messagesSummarized: 1,
    });
    const summary = createUserMessage('Summary: partial compaction.', {
      isCompactSummary: true,
    });
    const context = createAttachmentMessage(
      new HookOutputAttachment({
        type: 'hook_output',
        hookEventName: HookEventName.SessionStart,
        output: 'FRESH_CONTEXT_TOKEN=green-0002',
      }),
    );
    // `up_to` shape: [boundary, summary, ...toKeep], pipeline appends hooks last.
    const newHistory: Message[] = [boundary, summary, keptHook, context];
    try {
      await applyPostCompact([previous, keptHook], newHistory, {
        replaceMessages: () => {},
        pushAttachments: () => {},
        transcriptParentUuid: () => parentUuid,
        setTranscriptParentUuid: (uuid) => {
          parentUuid = uuid;
        },
        transcriptWriter: writer,
        attachmentCtx: createAttachmentContext(
          path.dirname(filePath),
          sessionId,
        ),
        config: {
          getApprovedPlanPath: () => null,
          isPlanMode: () => true,
        } as unknown as Config,
      });
    } finally {
      await writer.close();
    }

    const disk = (await fs.readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(disk.filter((m) => m.uuid === keptHook.uuid)).toHaveLength(1);
    expect(disk.filter((m) => m.uuid === context.uuid)).toHaveLength(1);
    expect(disk.find((m) => m.uuid === context.uuid)?.parentUuid).toBe(
      summary.uuid,
    );

    const restored = await new TranscriptRepository().resolveSession(filePath);
    const chainUuids = restored?.chain.map((entry) => entry.uuid) ?? [];
    expect(new Set(chainUuids).size).toBe(chainUuids.length);
    expect(chainUuids.filter((uuid) => uuid === keptHook.uuid)).toHaveLength(0);
  });

  it("restores 'from' partial-compact hook output without dropping the kept half", async () => {
    const sessionId = randomUUID();
    const { writer, filePath } = await createWriter(sessionId);
    // `from` keeps the OLD half and summarizes the NEW half.
    const keptUser = createUserMessage('Oldest question');
    let parentUuid = await writer.recordMessages([keptUser]);
    const summarized = createUserMessage('Newest question');
    parentUuid = await writer.recordMessages([summarized], parentUuid);

    const boundary = createCompactBoundaryMessage({
      trigger: 'manual',
      preTokens: 100,
      postTokens: 20,
      messagesSummarized: 1,
    });
    const summary = createUserMessage('Summary: newest half.', {
      isCompactSummary: true,
    });
    const context = createAttachmentMessage(
      new HookOutputAttachment({
        type: 'hook_output',
        hookEventName: HookEventName.SessionStart,
        output: 'FROM_CONTEXT_TOKEN=amber-0003',
      }),
    );
    // `from` shape: [...toKeep, boundary, summary], pipeline appends hooks last.
    const newHistory: Message[] = [keptUser, boundary, summary, context];
    try {
      await applyPostCompact([keptUser, summarized], newHistory, {
        replaceMessages: () => {},
        pushAttachments: () => {},
        transcriptParentUuid: () => parentUuid,
        setTranscriptParentUuid: (uuid) => {
          parentUuid = uuid;
        },
        transcriptWriter: writer,
        attachmentCtx: createAttachmentContext(
          path.dirname(filePath),
          sessionId,
        ),
        config: {
          getApprovedPlanPath: () => null,
          isPlanMode: () => true,
        } as unknown as Config,
      });
    } finally {
      await writer.close();
    }

    const disk = (await fs.readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(disk.filter((m) => m.uuid === context.uuid)).toHaveLength(1);
    // A boundary here would restart the runtime chain and drop the kept half,
    // so this mode deliberately persists the hook output on its own.
    expect(disk.some((m) => m.uuid === boundary.uuid)).toBe(false);

    const restored = await new TranscriptRepository().resolveSession(filePath);
    const uuids = restored?.messages.map((message) => message.uuid) ?? [];
    expect(uuids).toContain(keptUser.uuid);
    expect(uuids).toContain(context.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
  });

  it('persists the boundary marker so findCompressionBoundary anchors on resume', async () => {
    const sessionId = randomUUID();
    const { writer, filePath } = await createWriter(sessionId);

    const preUser = makeUser([{ type: 'text' as const, text: 'pre-compact' }]);
    const preAssistant = makeAssistant([
      { type: 'text' as const, text: 'old reply' },
    ]);
    const boundary = createCompactBoundaryMessage({
      trigger: 'manual',
      preTokens: 50_000,
      postTokens: 7_500,
      messagesSummarized: 12,
    });
    const snapshot: Message = {
      ...makeUser([
        {
          type: 'text' as const,
          text: '<state_snapshot>compressed history</state_snapshot>',
        },
      ]),
      isCompactSummary: true,
    };
    const postUser = makeUser([
      { type: 'text' as const, text: 'follow-up question' },
    ]);
    const postAssistant = makeAssistant([
      { type: 'text' as const, text: 'follow-up reply' },
    ]);

    await writer.recordMessages([
      preUser,
      preAssistant,
      boundary,
      snapshot,
      postUser,
      postAssistant,
    ]);
    await writer.close();

    const result = await new TranscriptRepository().resolveSession(filePath);

    expect(result?.compatible.hasCompactBoundary).toBe(true);

    const ordered: readonly Message[] = result?.messages ?? [];

    const reloadedBoundary = ordered.find(
      (m) => m.type === 'system' && m.subtype === 'compact_boundary',
    );
    expect(reloadedBoundary).toBeDefined();
    expect(
      (reloadedBoundary as { compactMetadata?: unknown }).compactMetadata,
    ).toEqual({
      trigger: 'manual',
      preTokens: 50_000,
      postTokens: 7_500,
      messagesSummarized: 12,
    });

    const detected = findCompressionBoundary(ordered);
    expect(detected.source).toBe('compact_boundary');
    expect(detected.contents.map((m) => m.type)).toEqual([
      'user',
      'user',
      'assistant',
    ]);
  });
});
