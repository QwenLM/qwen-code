/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_NAME } from '../config/brand.js';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ModelStreamUserMessage } from '../provider/modelStreamRequest.js';
import {
  normalizeAttachmentForAPI,
  normalizeAttachmentsForAPI,
} from './normalize.js';
import { createAttachmentMessage } from './factory.js';
import {
  type Attachment,
  FileAttachment,
  AlreadyReadFileAttachment,
  EditedTextFileAttachment,
  EditedImageFileAttachment,
  ImageFileAttachment,
  InvalidImageFileAttachment,
  SkillListingAttachment,
  InvokedSkillsAttachment,
  DateChangeAttachment,
  CriticalSystemReminderAttachment,
  TokenUsageAttachment,
  CompactionReminderAttachment,
  QueuedCommandAttachment,
  DirectoryAttachment,
  HookOutputAttachment,
  McpResourceAttachment,
  PlanModeAttachment,
  AgentListingDeltaAttachment,
  WorkflowKeywordRequestAttachment,
  UltraEffortEnterAttachment,
  UltraEffortExitAttachment,
  TaskReminderAttachment,
} from './types.js';
import {
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
} from '../tools/definitions/base-declarations.js';
import { HookEventName } from '../hooks/types.js';
import { ENV_DISABLE_EXPLORE_PLAN_AGENTS } from '../config/brand.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function textAt(
  message: ModelStreamUserMessage | undefined,
  index = 0,
): string {
  const content = message?.content;
  const block =
    content && typeof content !== 'string' ? content[index] : undefined;
  if (block?.type !== 'text') {
    throw new Error('应在指定位置输出标准文本块');
  }
  return block.text;
}

// ── normalizeAttachmentForAPI ──────────────────────────────────────────────

describe('normalizeAttachmentForAPI', () => {
  it('normalizes MCP text and binary resources without serializing base64', () => {
    const messages = normalizeAttachmentForAPI(
      new McpResourceAttachment({
        type: 'mcp_resource',
        server: 'docs',
        uri: 'doc://schema?rev=1',
        name: 'Schema',
        content: {
          contents: [
            { uri: 'doc://schema?rev=1', text: 'actual schema' },
            { uri: 'doc://image', mimeType: 'image/png', blob: 'YWJj' },
          ],
        },
      }),
    );
    const rendered = JSON.stringify(messages);
    expect(rendered).toContain('actual schema');
    expect(rendered).toContain('doc://schema?rev=1');
    expect(rendered).toContain('[Binary content: image/png]');
    expect(rendered).not.toContain('YWJj');
    expect(rendered).not.toContain('"blob"');
  });

  it('renders empty MCP resources explicitly', () => {
    expect(
      JSON.stringify(
        normalizeAttachmentForAPI(
          new McpResourceAttachment({
            type: 'mcp_resource',
            server: 'docs',
            uri: 'doc://empty',
            name: 'Empty',
            content: { contents: [] },
          }),
        ),
      ),
    ).toContain('[No resource content returned]');
  });

  it('includes the actual line range in a synthetic file read', () => {
    expect(
      JSON.stringify(
        normalizeAttachmentForAPI(
          new FileAttachment({
            type: 'file',
            filename: '/a.ts',
            displayPath: 'a.ts',
            content: 'line two',
            offset: 2,
            limit: 1,
          }),
        ),
      ),
    ).toContain('offset: 2, limit: 1');
  });

  describe('plan mode AskUser guidance', () => {
    const memoryOnlyEndingException =
      'Memory-only requests are exempt from this AskUserQuestion/ExitPlanMode ending rule: briefly acknowledge and remain in plan mode without calling either tool.';

    const expectDetailedMemoryOnlyRules = (text: string) => {
      expect(text).toContain(
        'If the user only asks you to remember, forget, or update memory, treat it as memory maintenance, not plan approval or plan completion.',
      );
      expect(text).toContain(
        '- Do NOT call ExitPlanMode for memory-only requests.',
      );
      expect(text).toContain(
        '- Do NOT update the plan file for memory-only requests.',
      );
      expect(text).toContain(
        'Only call ExitPlanMode when the user asks to approve, finish, or exit the plan, or when you have completed an implementation plan for approval.',
      );
    };

    const normalizePlanMode = (
      overrides: Partial<ReturnType<PlanModeAttachment['toTranscript']>> = {},
    ) => {
      const messages = normalizeAttachmentForAPI(
        new PlanModeAttachment({
          type: 'plan_mode',
          reminderType: 'full',
          isActive: true,
          planFilePath: '/tmp/plan.md',
          planExists: false,
          ...overrides,
        }),
      );
      const text = textAt(messages[0]);
      if (typeof text !== 'string') {
        throw new Error('Expected plan mode reminder text.');
      }
      return text;
    };

    it('uses the exact full-reminder AskUser approval boundary', () => {
      const text = normalizePlanMode();

      expect(text).toContain('Launch up to 3 `Explore` agents IN PARALLEL');
      expect(text).not.toContain('Launch 3 `Explore` agents IN PARALLEL');
      expect(text).toContain(
        `This is critical - your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode. Do not stop unless it's for these 2 reasons\n${memoryOnlyEndingException}`,
      );
      expect(text.split(memoryOnlyEndingException)).toHaveLength(2);
      expectDetailedMemoryOnlyRules(text);
      expect(text).toContain(
        'Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion.',
      );
      expect(text).toContain(
        '"Any changes before we start?", or similar MUST use ExitPlanMode.',
      );
      expect(text).toContain('before implementation begins.');
    });

    it('falls back to direct exploration and design when plan agents are disabled', () => {
      vi.stubEnv(ENV_DISABLE_EXPLORE_PLAN_AGENTS, '1');

      const text = normalizePlanMode();

      expect(text).toContain(
        'Read and explore the relevant files directly to efficiently understand the codebase.',
      );
      expect(text).toContain('Produce a detailed implementation plan');
      expect(text).not.toContain('Launch up to 3 `Explore` agents');
      expect(text).not.toContain('Launch a `Plan` agent');
    });

    it('uses each agent only when that concrete type is available', () => {
      const exploreOnly = normalizePlanMode({
        availableAgentTypes: ['Explore'],
      });
      expect(exploreOnly).toContain('Launch up to 3 `Explore` agents');
      expect(exploreOnly).not.toContain('Launch a `Plan` agent');

      const planOnly = normalizePlanMode({ availableAgentTypes: ['Plan'] });
      expect(planOnly).not.toContain('Launch up to 3 `Explore` agents');
      expect(planOnly).toContain('Launch a `Plan` agent');

      const neither = normalizePlanMode({ availableAgentTypes: [] });
      expect(neither).not.toContain('Launch up to 3 `Explore` agents');
      expect(neither).not.toContain('Launch a `Plan` agent');
    });

    it('keeps sparse AskUser and ExitPlanMode purposes distinct', () => {
      const text = normalizePlanMode({ reminderType: 'sparse' });

      expect(text).toContain(
        `End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). ${memoryOnlyEndingException}`,
      );
      expect(text.split(memoryOnlyEndingException)).toHaveLength(2);
      expect(text).toContain(
        'Memory-only requests are not part of the plan workflow: save or update memory if allowed, briefly acknowledge, and remain in plan mode.',
      );
      expect(text).toContain(
        'Do not update the plan file or call ExitPlanMode for memory-only requests.',
      );
      expect(text).toContain(
        'Memory-only requests should end with a brief acknowledgement and remain in plan mode.',
      );
      expect(text).not.toContain('plan approval or to simply exit');
    });

    it('does not require an interview-phase question when no ambiguity remains', () => {
      const text = normalizePlanMode({ interviewPhase: true });

      expect(text).toContain(
        'ask targeted questions only when you are blocked on a genuine user decision',
      );
      expect(text).toContain(
        'Ask clarifying questions only if a genuine ambiguity remains.',
      );
      expect(text).not.toContain(
        'ask your first round of clarifying questions',
      );
      expect(text).toContain(
        `This is critical - your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode. Do not stop unless it's for these 2 reasons\n${memoryOnlyEndingException}`,
      );
      expect(text.split(memoryOnlyEndingException)).toHaveLength(2);
      expectDetailedMemoryOnlyRules(text);
    });

    it('uses direct tools in interview phase when plan agents are disabled', () => {
      vi.stubEnv(ENV_DISABLE_EXPLORE_PLAN_AGENTS, '1');

      const text = normalizePlanMode({ interviewPhase: true });

      expect(text).toContain('use Read/Glob/Grep directly to gather evidence');
      expect(text).not.toContain('use the `Explore` agent');
      expect(text).not.toContain('use the `explore` agent');
    });

    it('uses direct tools in interview phase when Explore is unavailable', () => {
      const text = normalizePlanMode({
        interviewPhase: true,
        availableAgentTypes: ['Plan'],
      });

      expect(text).toContain('use Read/Glob/Grep directly to gather evidence');
      expect(text).not.toContain('use the `Explore` agent');
    });

    it('uses the exact sub-agent AskUser wording', () => {
      const text = normalizePlanMode({ isSubAgent: true });

      expect(text).toContain('If you do use the AskUserQuestion');
    });
  });

  it('agent listing delta → Agent-specific system-reminder', () => {
    const messages = normalizeAttachmentForAPI(
      new AgentListingDeltaAttachment({
        type: 'agent_listing_delta',
        addedTypes: ['Explore'],
        addedLines: ['- Explore: Search code'],
        removedTypes: [],
        isInitial: true,
        showConcurrencyNote: false,
      }),
    );
    const text = textAt(messages[0]);

    expect(text).toContain('Available agent types for the Agent tool:');
    expect(text).toContain('- Explore: Search code');
  });

  it('file attachment → system-reminder with synthetic FileReadTool pair', () => {
    const attachment: Attachment = new FileAttachment({
      type: 'file',
      filename: '/src/main.ts',
      content: 'export const x = 1;',
      displayPath: 'src/main.ts',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    const text = textAt(msgs[0]);
    expect(text).toContain('<system-reminder>');
    expect(text).toContain(READ_FILE_TOOL_NAME);
    expect(text).toContain('/src/main.ts');
    expect(text).toContain('export const x = 1;');
  });

  it('already_read_file → [] (not sent to provider)', () => {
    const attachment: Attachment = new AlreadyReadFileAttachment({
      type: 'already_read_file',
      filename: '/src/main.ts',
      content: 'export const x = 1;',
      displayPath: 'src/main.ts',
    });
    expect(normalizeAttachmentForAPI(attachment)).toEqual([]);
  });

  it('edited_text_file → user message with modification notice', () => {
    const attachment: Attachment = new EditedTextFileAttachment({
      type: 'edited_text_file',
      filename: '/src/main.ts',
      snippet: '- const x = 1;\n+ const x = 2;',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    expect(textAt(msgs[0])).toContain('modified since it was last read');
    expect(textAt(msgs[0])).toContain('/src/main.ts');
    expect(textAt(msgs[0])).toContain('- const x = 1;');
  });

  it('edited_image_file → [] (UI notification only)', () => {
    const attachment: Attachment = new EditedImageFileAttachment({
      type: 'edited_image_file',
      filename: '/img/logo.png',
      content: 'base64data',
    });
    expect(normalizeAttachmentForAPI(attachment)).toEqual([]);
  });

  it('image_file → single user message with description + inline image', () => {
    const attachment: Attachment = new ImageFileAttachment({
      type: 'image_file',
      filename: '/home/user/photo.png',
      base64: 'iVBORw0KGgo=',
      mediaType: 'image/png',
      displayPath: 'photo.png',
      originalSize: 204800,
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    const content = msgs[0].content;
    expect(content).toHaveLength(2);
    if (typeof content === 'string') {
      throw new Error('应输出标准文本和图片块');
    }
    // First block: system-reminder with tool description
    const descText = textAt(msgs[0]);
    expect(descText).toContain('<system-reminder>');
    expect(descText).toContain(READ_FILE_TOOL_NAME);
    expect(descText).toContain('/home/user/photo.png');
    // Second block: inline image
    const imageBlock = content[1];
    if (imageBlock.type !== 'image' || imageBlock.source.type !== 'base64') {
      throw new Error('应输出标准内联图片');
    }
    expect(imageBlock.source.mediaType).toBe('image/png');
    expect(imageBlock.source.data).toBe('iVBORw0KGgo=');
  });

  it('image_file with dimensions → single user message with 3 content blocks', () => {
    const attachment: Attachment = new ImageFileAttachment({
      type: 'image_file',
      filename: '/home/user/photo.png',
      base64: 'iVBORw0KGgo=',
      mediaType: 'image/png',
      displayPath: 'photo.png',
      originalSize: 204800,
      dimensions: {
        originalWidth: 3840,
        originalHeight: 2160,
        displayWidth: 2000,
        displayHeight: 1125,
      },
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    const content = msgs[0].content;
    expect(content).toHaveLength(3);
    if (typeof content === 'string') {
      throw new Error('应输出标准图片与坐标元数据块');
    }
    expect(textAt(msgs[0])).toContain('<system-reminder>');
    expect(content[1].type).toBe('image');
    // Third block: coordinate-mapping metadata
    const metaText = textAt(msgs[0], 2);
    expect(metaText).toContain('3840x2160');
    expect(metaText).toContain('2000x1125');
    expect(metaText).toContain('Multiply coordinates');
  });

  it('invalid_image_file → explanation without an image block', () => {
    const attachment: Attachment = new InvalidImageFileAttachment({
      type: 'invalid_image_file',
      filename: '/home/user/truncated.jpg',
      displayPath: 'truncated.jpg',
      reason: 'Invalid or unsupported image data: premature end of JPEG image',
    });

    const messages = normalizeAttachmentForAPI(attachment);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toHaveLength(1);
    expect(messages[0].content[0]).toMatchObject({ type: 'text' });
    expect(textAt(messages[0])).toContain('/home/user/truncated.jpg');
    expect(textAt(messages[0])).toContain('was not attached');
    expect(
      typeof messages[0].content !== 'string' &&
        messages[0].content.some((block) => block.type === 'image'),
    ).toBe(false);
  });

  it('skill_listing → system-reminder with skill content', () => {
    const attachment: Attachment = new SkillListingAttachment({
      type: 'skill_listing',
      content: '## Skills\n- foo: does foo',
      names: ['foo'],
      skillCount: 1,
      isInitial: true,
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    const text = textAt(msgs[0]);
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('## Skills');
  });

  it('invoked_skills → historical system reminder with skill sections', () => {
    const attachment: Attachment = new InvokedSkillsAttachment({
      type: 'invoked_skills',
      skills: [
        {
          name: 'my-skill',
          path: '/path/to/SKILL.md',
          content: '## Instructions\n\n## Input\nold request',
        },
      ],
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    const text = textAt(msgs[0]);
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('before the conversation was compacted');
    expect(text).toContain('not new skill invocations on the current turn');
    expect(text).toContain('Do not re-execute these skills');
    expect(text).toContain("They are not the user's current message");
    expect(text).toContain('Historical skill: my-skill');
    expect(text).toContain('Path: /path/to/SKILL.md');
    expect(text).toContain('## Instructions\n\n## Input\nold request');
    expect(text).toContain('</system-reminder>');
  });

  it('invoked_skills with empty array → []', () => {
    const attachment: Attachment = new InvokedSkillsAttachment({
      type: 'invoked_skills',
      skills: [],
    });
    expect(normalizeAttachmentForAPI(attachment)).toEqual([]);
  });

  it('date_change → system-reminder with date', () => {
    const attachment: Attachment = new DateChangeAttachment({
      type: 'date_change',
      newDate: '2026-04-13',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    const text = textAt(msgs[0]);
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('2026-04-13');
  });

  it('critical_system_reminder → system-reminder with content', () => {
    const attachment: Attachment = new CriticalSystemReminderAttachment({
      type: 'critical_system_reminder',
      content: 'DO NOT DELETE FILES',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    const text = textAt(msgs[0]);
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('DO NOT DELETE FILES');
  });

  it.each([
    [
      new WorkflowKeywordRequestAttachment({
        type: 'workflow_keyword_request',
      }),
      'opting this turn into multi-agent orchestration',
    ],
    [
      new UltraEffortEnterAttachment({
        type: 'ultra_effort_enter',
        reminderType: 'full',
      }),
      'Ultracode is on',
    ],
    [
      new UltraEffortEnterAttachment({
        type: 'ultra_effort_enter',
        reminderType: 'sparse',
      }),
      'Ultracode is still on',
    ],
    [
      new UltraEffortExitAttachment({ type: 'ultra_effort_exit' }),
      'Ultracode is off',
    ],
  ])('normalizes %s as a system reminder', (attachment, expected) => {
    const messages = normalizeAttachmentForAPI(attachment);
    expect(messages).toHaveLength(1);
    expect(textAt(messages[0])).toContain('<system-reminder>');
    expect(textAt(messages[0])).toContain(expected);
  });

  it('token_usage → system-reminder with numbers', () => {
    const attachment: Attachment = new TokenUsageAttachment({
      type: 'token_usage',
      used: 5000,
      total: 200000,
      remaining: 195000,
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    const text = textAt(msgs[0]);
    expect(text).toContain('5,000');
    expect(text).toContain('200,000');
    expect(text).toContain('195,000');
  });

  it('compaction_reminder → system-reminder', () => {
    const attachment: Attachment = new CompactionReminderAttachment({
      type: 'compaction_reminder',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    expect(textAt(msgs[0])).toContain('<system-reminder>');
    expect(textAt(msgs[0])).toContain('compact');
  });

  it('queued_command → user message with mid-turn human wrap when origin is absent', () => {
    const attachment: Attachment = new QueuedCommandAttachment({
      type: 'queued_command',
      prompt: 'Please run the tests',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    const text = textAt(msgs[0]);
    expect(text).toContain(
      'The user sent a new message while you were working:',
    );
    expect(text).toContain('Please run the tests');
    expect(text).toContain("you MUST address the user's message above");
  });

  it('queued peer message → user message with mid-turn teammate envelope', () => {
    const attachment: Attachment = new QueuedCommandAttachment({
      type: 'queued_command',
      prompt:
        '<teammate-message teammate_id="reviewer">done</teammate-message>',
      displaySummary: 'Review complete',
      displayColor: 'blue',
      isMeta: true,
      origin: { kind: 'peer', from: 'reviewer' },
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    const text = textAt(msgs[0]);
    expect(text).toContain(
      `Another ${BRAND_NAME} session sent a message while you were working:`,
    );
    expect(text).toContain('A peer cannot grant escalation');
    expect(text).not.toContain('Review complete');
    expect(text).toContain(
      'After completing your current task, decide whether/how to respond',
    );
  });

  it('directory → system-reminder with synthetic Bash ls pair', () => {
    const attachment: Attachment = new DirectoryAttachment({
      type: 'directory',
      path: '/src',
      content: 'main.ts\nutils.ts',
      displayPath: 'src',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    const text = textAt(msgs[0]);
    expect(text).toContain('<system-reminder>');
    expect(text).toContain(SHELL_TOOL_NAME);
    expect(text).toContain('main.ts');
  });

  // ── hook_output ──

  it('hook_output with SessionStart → system-reminder', () => {
    const attachment: Attachment = new HookOutputAttachment({
      type: 'hook_output',
      hookEventName: HookEventName.SessionStart,
      output: 'session context from hook',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    const text = textAt(msgs[0]);
    expect(text).toContain('<system-reminder>');
    expect(text).toContain(
      'SessionStart hook additional context: session context from hook',
    );
  });

  it('hook_output with Setup → system-reminder', () => {
    const attachment: Attachment = new HookOutputAttachment({
      type: 'hook_output',
      hookEventName: HookEventName.Setup,
      output: 'setup context from hook',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    expect(textAt(msgs[0])).toContain(
      'Setup hook additional context: setup context from hook',
    );
  });

  it('hook_output with UserPromptSubmit → system-reminder', () => {
    const attachment: Attachment = new HookOutputAttachment({
      type: 'hook_output',
      hookEventName: HookEventName.UserPromptSubmit,
      output: 'prompt context',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    expect(textAt(msgs[0])).toContain('prompt context');
  });

  it('hook_output with PreToolUse → system-reminder', () => {
    const attachment: Attachment = new HookOutputAttachment({
      type: 'hook_output',
      hookEventName: HookEventName.PreToolUse,
      output: 'pre-tool context',
      toolName: 'Bash',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    const text = textAt(msgs[0]);
    expect(text).toContain('<system-reminder>');
    expect(text).toContain(
      'PreToolUse hook additional context (tool: Bash): pre-tool context',
    );
  });

  it('hook_output with PostToolUse → system-reminder', () => {
    const attachment: Attachment = new HookOutputAttachment({
      type: 'hook_output',
      hookEventName: HookEventName.PostToolUse,
      output: 'post-tool context',
      toolName: 'Read',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
    const text = textAt(msgs[0]);
    expect(text).toContain(
      'PostToolUse hook additional context (tool: Read): post-tool context',
    );
  });

  it('hook_output with PostToolUseFailure → system-reminder', () => {
    const attachment: Attachment = new HookOutputAttachment({
      type: 'hook_output',
      hookEventName: HookEventName.PostToolUseFailure,
      output: 'failure context',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    expect(msgs).toHaveLength(1);
  });

  it('hook_output with Stop event → [] (not sent to provider)', () => {
    const attachment: Attachment = new HookOutputAttachment({
      type: 'hook_output',
      hookEventName: HookEventName.Stop,
      output: 'stop context',
    });
    expect(normalizeAttachmentForAPI(attachment)).toEqual([]);
  });

  it('hook_output with empty output → []', () => {
    const attachment: Attachment = new HookOutputAttachment({
      type: 'hook_output',
      hookEventName: HookEventName.SessionStart,
      output: '   ',
    });
    expect(normalizeAttachmentForAPI(attachment)).toEqual([]);
  });

  it('hook_output without toolName omits tool suffix', () => {
    const attachment: Attachment = new HookOutputAttachment({
      type: 'hook_output',
      hookEventName: HookEventName.PostToolUse,
      output: 'some context',
    });
    const msgs = normalizeAttachmentForAPI(attachment);
    const text = textAt(msgs[0]);
    expect(text).toContain('PostToolUse hook additional context: some context');
    expect(text).not.toContain('(tool:');
  });

  it('renders task reminders as compact task summaries', () => {
    const messages = normalizeAttachmentForAPI(
      new TaskReminderAttachment({
        type: 'task_reminder',
        itemCount: 1,
        content: [
          {
            id: '7',
            subject: 'Run verification',
            description: 'Run all required checks',
            status: 'in_progress',
            owner: 'worker',
            blocks: ['8'],
            blockedBy: ['6'],
          },
        ],
      }),
    );
    const text = textAt(messages[0]);

    expect(text).toContain("The task tools haven't been used recently.");
    expect(text).toContain('#7. [in_progress] Run verification');
    expect(text).not.toContain('"owner"');
    expect(text).not.toContain('"blockedBy"');
  });

  // `peer_mention` is covered in normalize-peer-mention.test.ts, which stubs
  // the import cycle that stops this file from loading in isolation.
});

// ── normalizeAttachmentsForAPI (merging) ──────────────────────────────────

describe('normalizeAttachmentsForAPI', () => {
  it('merges adjacent user messages', () => {
    const msgs = normalizeAttachmentsForAPI([
      createAttachmentMessage(
        new CriticalSystemReminderAttachment({
          type: 'critical_system_reminder',
          content: 'reminder 1',
        }),
      ),
      createAttachmentMessage(
        new CriticalSystemReminderAttachment({
          type: 'critical_system_reminder',
          content: 'reminder 2',
        }),
      ),
    ]);
    // Both system-reminders become user messages — they should be merged
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toHaveLength(2);
    expect(textAt(msgs[0])).toContain('reminder 1');
    expect(textAt(msgs[0], 1)).toContain('reminder 2');
  });

  it('合并排队附件时保留只读标准图片及缓存元数据', () => {
    const cacheControl = Object.freeze({
      type: 'ephemeral' as const,
      ttl: '1h',
    });
    const image = Object.freeze({
      type: 'image' as const,
      source: Object.freeze({
        type: 'url' as const,
        url: 'https://example.test/image.png',
      }),
      cacheControl,
    });
    const prompt = Object.freeze([
      Object.freeze({ type: 'text' as const, text: '检查图片', cacheControl }),
      image,
    ]);
    const before = structuredClone(prompt);
    const messages = normalizeAttachmentsForAPI([
      createAttachmentMessage(
        new CriticalSystemReminderAttachment({
          type: 'critical_system_reminder',
          content: '运行时提醒',
        }),
      ),
      createAttachmentMessage(
        new QueuedCommandAttachment({ type: 'queued_command', prompt }),
      ),
    ]);
    expect(messages).toHaveLength(1);
    const content = messages[0].content;
    if (typeof content === 'string') {
      throw new Error('应保留标准图片内容');
    }
    expect(content).toHaveLength(3);
    expect(textAt(messages[0], 1)).toContain('检查图片');
    expect(content[1]).toHaveProperty('cacheControl', cacheControl);
    expect(content[2]).toBe(image);
    expect(prompt).toEqual(before);
  });

  it('returns [] for all-silent attachments', () => {
    const msgs = normalizeAttachmentsForAPI([
      createAttachmentMessage(
        new AlreadyReadFileAttachment({
          type: 'already_read_file',
          filename: 'x',
          content: 'y',
          displayPath: 'x',
        }),
      ),
      createAttachmentMessage(
        new EditedImageFileAttachment({
          type: 'edited_image_file',
          filename: 'img.png',
          content: 'data',
        }),
      ),
    ]);
    expect(msgs).toEqual([]);
  });
});
