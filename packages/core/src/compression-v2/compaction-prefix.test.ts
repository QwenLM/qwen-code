/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { retainCompactionPrefix } from './compaction-prefix.js';
import { buildPostCompactHistory } from './compact-utils.js';
import {
  normalizeMessagesForAPI,
  convertMessages,
} from '../protocol/provider/request-converter.js';
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
} from '../protocol/transcript/conversions.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import {
  SkillListingAttachment,
  PostCompactRestoredFilesAttachment,
} from '../attachments/types.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';
import { finalizePostCompact } from './post-compact-finalize.js';
import type { Config } from '../config/config.js';
import type { Message } from './message-types.js';

function fixture() {
  const first = createAssistantMessage({
    messageId: 'old',
    model: 'test',
    blocks: [{ type: 'text', text: 'old response' }],
    stopReason: 'end_turn',
  });
  const kept = createAssistantMessage({
    model: 'test',
    messageId: 'kept',
    blocks: [
      {
        type: 'tool_use',
        id: 'read-kept',
        name: 'Read',
        input: { file_path: '/tmp/kept.ts' },
      },
    ],
  });
  const result = createToolResultMessage(
    [
      {
        type: 'tool_result',
        tool_use_id: 'read-kept',
        content: 'KEPT_RESULT',
        is_error: false,
      },
    ],
    kept.uuid,
  );
  const listing = createAttachmentMessage(
    new SkillListingAttachment({
      type: 'skill_listing',
      names: ['inspect'],
      skillCount: 1,
      isInitial: true,
      content: '- inspect: inspect files',
    }),
  );
  const sections = [
    listing,
    ...['Environment', 'Auto Mode', 'hook', 'Agent tool', 'gitStatus'].map(
      (text) =>
        createUserMessage(`<system-reminder>${text}</system-reminder>`, {
          isMeta: true,
        }),
    ),
  ];
  const startup = createUserMessage(
    '<system-reminder>agentsMd</system-reminder>',
    { isMeta: true },
  );
  const history = [
    createUserMessage('M1_TASK'),
    ...sections,
    first,
    createUserMessage('M8_TASK'),
    kept,
    result,
  ];
  return { history, sections, startup, kept, result };
}

function compact(history: Message[]) {
  const next = buildPostCompactHistory('SUMMARY', [], new Set(), {
    trigger: 'auto',
    preTokens: 10000,
  });
  retainCompactionPrefix(history, next);
  return next;
}

describe('segmented user context assembly', () => {
  it(
    'preserves the user prefix, with recovery outside the retained tool result',
    () => {
      const { history, startup, kept, result } = fixture();
      const before = normalizeMessagesForAPI([startup, ...history]);
      const prefixContent = before[0].content;
      if (!Array.isArray(prefixContent)) throw new Error('Expected prefix blocks');
      const expected = prefixContent.filter(
        (b: { text?: string }) => b.text?.trim() !== 'M1_TASK',
      );
      const next = compact(history);
      next.push(kept, result);
      const recovery = createAttachmentMessage(
        new PostCompactRestoredFilesAttachment({
          type: 'post_compact_restored_files',
          files: [
            {
              filePath: '/tmp/restored.ts',
              content: 'RECOVERED_FILE',
              truncated: false,
            },
          ],
        }),
      );
      next.push(recovery);
      const after = normalizeMessagesForAPI([startup, ...next]);
      expect(after[0].role).toBe('user');
      const restoredContent = after[0].content;
      if (!Array.isArray(restoredContent)) throw new Error('Expected restored blocks');
      expect(
        restoredContent
          .slice(0, expected.length)
          .map((b: { text: string }) => b.text.trim()),
      ).toEqual(expected.map((b: { text: string }) => b.text.trim()));
      expect(JSON.stringify(after[0])).toContain('RECOVERED_FILE');
      expect(after[2]).toMatchObject({ role: 'tool', toolCallId: 'read-kept', content: [{ type: 'text', text: 'KEPT_RESULT' }] });
      expect(next.at(-2)).toBe(result);
      const wire = convertMessages(after);
      expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
      expect(wire[2].content).toMatchObject([{ type: 'text', text: 'KEPT_RESULT' }]);
      expect(JSON.stringify(after).match(/RECOVERED_FILE/g)).toHaveLength(1);
      expect(JSON.stringify(after).match(/KEPT_RESULT/g)).toHaveLength(1);
      // Metadata survives JSONL round-trip, without provider-visible flags.
      expect(
        normalizeMessagesForAPI([startup, ...JSON.parse(JSON.stringify(next))]),
      ).toEqual(after);
      expect(JSON.stringify(wire)).not.toContain('isCompactionPrefix');
    },
  );

  it('does not capture user tasks, old tools, or repeat prefixes on the next compaction', () => {
    const { history, sections, kept, result } = fixture();
    const next = compact(history);
    expect(
      next.filter((m) => m.isCompactionPrefix && !m.isCompactSummary),
    ).toHaveLength(sections.length);
    expect(JSON.stringify(next)).not.toContain('M1_TASK');
    next.push(kept, result);
    const again = compact(next);
    expect(
      again.filter((m) => m.isCompactionPrefix && !m.isCompactSummary),
    ).toHaveLength(sections.length);
  });

  it('restores retained listing baselines rather than re-announcing an unchanged skill at the tool tail', async () => {
    const { history } = fixture();
    const next = compact(history);
    const ctx = createAttachmentContext('/tmp');
    const config = {
      getApprovedPlanPath: () => null,
      isPlanMode: () => false,
      isWorkflowsEnabled: () => false,
      getModel: () => 'test',
      getToolRegistry: () => ({ hasToolEnabled: () => true }),
      getSkillManager: () => ({
        getActiveSkillsWithTimestamp: () => [],
        getModelVisibleSkills: () => [
          {
            name: 'inspect',
            description: 'inspect files',
            location: '/tmp/inspect',
            body: '',
          },
        ],
        isAdminEnabled: () => true,
        getUsageScore: () => 0,
        getSkillVisibilityOverride: () => undefined,
      }),
      getSkillVisibilityOverrides: () => ({}),
      getSkillListingMaxDescChars: () => 160,
      getSkillListingBudgetFraction: () => 0.05,
    } as unknown as Config;
    const restored = await finalizePostCompact({
      workingHistory: history,
      newHistory: next,
      targetDir: '/tmp',
      ctx,
      config,
    });
    expect(
      restored.attachmentMessages.filter(
        (m) => m.attachment.type === 'skill_listing',
      ),
    ).toEqual([]);
    expect([...ctx.sentSkillNames.get('main')!]).toEqual(['inspect']);
  });
});
