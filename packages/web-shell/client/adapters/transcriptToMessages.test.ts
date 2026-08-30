import { describe, expect, it } from 'vitest';
import type {
  DaemonShellTranscriptBlock,
  DaemonStatusTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
  DaemonUserShellTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { transcriptBlocksToDaemonMessages } from './transcriptToMessages.js';

function textBlock(
  id: string,
  kind: 'user' | 'assistant' | 'thought',
  text: string,
  createdAt: number,
  streaming = false,
  overrides: Partial<DaemonTextTranscriptBlock> = {},
): DaemonTextTranscriptBlock {
  return {
    id,
    kind,
    text,
    streaming,
    clientReceivedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe('Assistant branch anchors', () => {
  it('preserves the checkpoint on the rendered Assistant message', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('assistant-1', 'assistant', 'answer', 1, false, {
        branchRecordId: 'checkpoint-1',
      }),
    ]);

    expect(messages[0]).toMatchObject({
      role: 'assistant',
      branchRecordId: 'checkpoint-1',
    });
  });

  it('does not anchor an insight-only block onto the previous reply', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('assistant-1', 'assistant', 'first answer', 1),
      textBlock(
        'insight-1',
        'assistant',
        '{"insight_ready":{"path":"/tmp/report.md"}}',
        2,
        false,
        { branchRecordId: 'checkpoint-2' },
      ),
    ]);

    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'first answer',
    });
    expect(messages[0]).not.toHaveProperty('branchRecordId');
    expect(messages.some((message) => message.role === 'insight_ready')).toBe(
      true,
    );
    expect(messages.some((message) => 'branchRecordId' in message)).toBe(false);
  });

  it("anchors a checkpoint onto the insight block's own text segment", () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('assistant-1', 'assistant', 'first answer', 1),
      textBlock(
        'insight-1',
        'assistant',
        '{"insight_ready":{"path":"/tmp/report.md"}} done',
        2,
        false,
        { branchRecordId: 'checkpoint-2' },
      ),
    ]);

    expect(messages[0]).not.toHaveProperty('branchRecordId');
    const anchored = messages.find(
      (message) => message.role === 'assistant' && message.content === 'done',
    );
    expect(anchored).toMatchObject({
      role: 'assistant',
      content: 'done',
      branchRecordId: 'checkpoint-2',
    });
  });
});

function statusBlock(
  id: string,
  text: string,
  createdAt: number,
  overrides: Partial<DaemonStatusTranscriptBlock> = {},
): DaemonStatusTranscriptBlock {
  return {
    id,
    kind: 'status',
    text,
    clientReceivedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function promptCancelledBlock(
  id: string,
  createdAt: number,
): DaemonTranscriptBlock {
  return {
    id,
    kind: 'prompt_cancelled',
    clientReceivedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

function shellBlock(
  id: string,
  text: string,
  createdAt: number,
  overrides: Partial<DaemonShellTranscriptBlock> = {},
): DaemonShellTranscriptBlock {
  return {
    id,
    kind: 'shell',
    text,
    clientReceivedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function userShellBlock(
  id: string,
  text: string,
  command: string,
  createdAt: number,
  overrides: Partial<DaemonUserShellTranscriptBlock> = {},
): DaemonUserShellTranscriptBlock {
  return {
    id,
    kind: 'user_shell',
    text,
    command,
    clientReceivedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function toolBlock(
  id: string,
  toolCallId: string,
  status: string,
  createdAt: number,
  overrides: Partial<DaemonToolTranscriptBlock> = {},
): DaemonToolTranscriptBlock {
  return {
    id,
    kind: 'tool',
    toolCallId,
    title: overrides.title ?? 'Tool',
    status,
    toolName: overrides.toolName ?? 'Read',
    toolKind: overrides.toolKind,
    preview: overrides.preview ?? { kind: 'generic' },
    rawInput: overrides.rawInput,
    rawOutput: overrides.rawOutput,
    content: overrides.content,
    locations: overrides.locations,
    details: overrides.details,
    parentToolCallId: overrides.parentToolCallId,
    subagentType: overrides.subagentType,
    clientReceivedAt: createdAt,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
  };
}

describe('transcriptBlocksToDaemonMessages', () => {
  it('preserves user source metadata', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('user-1', 'user', 'scheduled prompt', 1, false, {
        meta: { source: 'cron' },
      }),
    ]);

    expect(messages[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      content: 'scheduled prompt',
      source: 'cron',
    });
  });

  it('normalizes an unchanged tool block content to a stable reference', () => {
    const block = toolBlock('t1', 'call-1', 'running', 0, {
      content: [{ type: 'content', content: { type: 'text', text: 'body' } }],
    });
    const first = transcriptBlocksToDaemonMessages([block]);
    const second = transcriptBlocksToDaemonMessages([block]);

    const firstContent = (first[0] as { tools: { content: unknown }[] })
      .tools[0].content;
    const secondContent = (second[0] as { tools: { content: unknown }[] })
      .tools[0].content;
    // The normalizer caches by the original block reference, so a block that
    // did not change yields the same content array across frames,
    // allowing MessageItem's JSON cache to avoid re-serializing the output.
    expect(secondContent).toBe(firstContent);
    expect(Object.isFrozen(firstContent)).toBe(true);
  });

  it('renormalizes content when a caller replaces the tool block', () => {
    const block = toolBlock('t1', 'call-1', 'running', 0, {
      content: [{ type: 'content', content: { type: 'text', text: 'before' } }],
    });
    const first = transcriptBlocksToDaemonMessages([block]);
    const content = block.content as Array<{
      type: 'content';
      content: { type: 'text'; text: string };
    }>;
    content[0].content.text = 'after';
    const second = transcriptBlocksToDaemonMessages([{ ...block }]);

    expect(
      (first[0] as { tools: { content: unknown }[] }).tools[0].content,
    ).toMatchObject([{ content: { text: 'before' } }]);
    expect(
      (second[0] as { tools: { content: unknown }[] }).tools[0].content,
    ).toMatchObject([{ content: { text: 'after' } }]);
  });

  it('preserves user file attachment metadata', () => {
    const data = new Blob(['line one']);
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('user-1', 'user', 'check this', 1, false, {
        files: [
          {
            name: 'app.log',
            mimeType: 'text/plain',
            data,
            text: 'line one',
            attachmentId: 'app.log',
          },
        ],
      }),
    ]);

    expect(messages[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      content: 'check this',
      files: [
        {
          name: 'app.log',
          mimeType: 'text/plain',
          data,
          text: 'line one',
          attachmentId: 'app.log',
        },
      ],
    });
  });

  it('preserves literal attachment-looking user text', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('user-1', 'user', 'check this\n\n@attachment:///data.json', 1),
    ]);

    expect(messages[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      content: 'check this\n\n@attachment:///data.json',
    });
    expect(messages[0]).not.toHaveProperty('files');
  });

  it('preserves user input annotations metadata', () => {
    const inputAnnotations = [
      {
        type: 'reference' as const,
        start: 0,
        end: 14,
        text: '@dataset:users',
        reference: {
          id: 'dataset:users',
          kind: 'dataset',
          label: 'Dataset',
          value: 'users',
          serialized: '@dataset:users',
        },
      },
    ];
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('user-1', 'user', '@dataset:users', 1, false, {
        meta: { inputAnnotations },
      }),
    ]);

    expect(messages[0]).toMatchObject({
      id: 'user-1',
      role: 'user',
      content: '@dataset:users',
      inputAnnotations,
    });
  });

  it('renders live background task notifications as system messages', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock(
        'bg-1',
        'assistant',
        'Background agent "general-purpose: 查询百度云活动信息" completed.',
        1,
        false,
        {
          meta: {
            source: 'background_notification',
            qwenDiscreteMessage: true,
            backgroundTask: { taskId: 'task-1', status: 'completed' },
          },
        },
      ),
      textBlock('assistant-1', 'assistant', '正常回复', 2),
    ]);

    expect(messages).toEqual([
      {
        id: 'bg-1',
        role: 'system',
        content:
          'Background agent "general-purpose: 查询百度云活动信息" completed.',
        variant: 'info',
        source: 'background_notification',
        data: { taskId: 'task-1', status: 'completed' },
        timestamp: 1,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '正常回复',
        isStreaming: false,
        timestamp: 2,
      },
    ]);
  });

  it('keeps vision bridge notices separate from assistant output', () => {
    const notice = {
      status: 'skipped',
      convertedCount: 0,
      omittedCount: 0,
      modelName: 'qwen3.6-plus',
      modelEndpoint: 'idealab.alibaba-inc.com',
      egressOccurred: true,
    };
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('assistant-0', 'assistant', 'Earlier reply', 0),
      textBlock(
        'vision-notice',
        'assistant',
        'Vision bridge cancelled.',
        1,
        false,
        {
          meta: {
            source: 'vision_bridge_notice',
            qwenDiscreteMessage: true,
            visionBridgeNotice: notice,
          },
        },
      ),
      textBlock('assistant-1', 'assistant', 'Normal reply', 2),
    ]);

    expect(messages).toEqual([
      {
        id: 'assistant-0',
        role: 'assistant',
        content: 'Earlier reply',
        isStreaming: false,
        timestamp: 0,
      },
      {
        id: 'vision-notice',
        role: 'system',
        content: 'Vision bridge cancelled.',
        variant: 'info',
        source: 'vision_bridge_notice',
        data: notice,
        timestamp: 1,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Normal reply',
        isStreaming: false,
        timestamp: 2,
      },
    ]);
  });

  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'completed'],
  ] as const)(
    'projects a background agent %s notification onto its tool',
    (notificationStatus, expectedStatus) => {
      const messages = transcriptBlocksToDaemonMessages([
        toolBlock('agent-block', 'agent-call', 'completed', 1, {
          toolName: 'agent',
          rawInput: { run_in_background: true },
          rawOutput: { type: 'task_execution', status: 'background' },
        }),
        textBlock(
          'agent-terminal',
          'assistant',
          'background agent finished',
          2,
          false,
          {
            meta: {
              source: 'background_notification',
              qwenDiscreteMessage: true,
              backgroundTask: {
                kind: 'agent',
                status: notificationStatus,
                taskId: 'agent-task',
                toolUseId: 'agent-call',
              },
            },
          },
        ),
      ]);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: 'tool_group',
        tools: [{ callId: 'agent-call', status: expectedStatus, endTime: 2 }],
      });
      expect(messages[1]).toMatchObject({
        role: 'system',
        source: 'background_notification',
        data: {
          kind: 'agent',
          status: notificationStatus,
          taskId: 'agent-task',
          toolUseId: 'agent-call',
        },
      });
      if (notificationStatus === 'cancelled') {
        expect(
          messages[0]?.role === 'tool_group'
            ? messages[0].tools[0]?.rawOutput
            : undefined,
        ).toMatchObject({ status: 'cancelled' });
      }
    },
  );

  it('projects a replayed user background agent notification onto its tool', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-block', 'agent-call', 'completed', 1, {
        toolName: 'agent',
        rawInput: { run_in_background: true },
        rawOutput: { type: 'task_execution', status: 'background' },
      }),
      textBlock(
        'agent-terminal',
        'user',
        'background agent finished',
        2,
        false,
        {
          meta: {
            source: 'background_notification',
            qwenDiscreteMessage: true,
            backgroundTask: {
              kind: 'agent',
              status: 'completed',
              taskId: 'agent-task',
              toolUseId: 'agent-call',
            },
          },
        },
      ),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [{ callId: 'agent-call', status: 'completed', endTime: 2 }],
    });
    expect(messages[1]).toMatchObject({
      role: 'system',
      source: 'background_notification',
      data: {
        kind: 'agent',
        status: 'completed',
        taskId: 'agent-task',
        toolUseId: 'agent-call',
      },
    });
  });

  it('does not apply a non-agent background notification to an agent tool', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-block', 'agent-call', 'completed', 1, {
        toolName: 'agent',
        rawOutput: { type: 'task_execution', status: 'background' },
      }),
      textBlock('shell-terminal', 'assistant', 'shell completed', 2, false, {
        meta: {
          source: 'background_notification',
          qwenDiscreteMessage: true,
          backgroundTask: {
            kind: 'shell',
            status: 'completed',
            toolUseId: 'agent-call',
          },
        },
      }),
    ]);

    expect(messages).toMatchObject([
      { role: 'tool_group', tools: [{ status: 'pending' }] },
      {
        role: 'system',
        source: 'background_notification',
        data: {
          kind: 'shell',
          status: 'completed',
          toolUseId: 'agent-call',
        },
      },
    ]);
  });

  it('renders replayed background notifications without task metadata', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('bg-replay', 'user', 'Monitor completed.', 1, false, {
        meta: {
          source: 'background_notification',
          qwenDiscreteMessage: true,
        },
      }),
    ]);

    expect(messages).toEqual([
      {
        id: 'bg-replay',
        role: 'system',
        content: 'Monitor completed.',
        variant: 'info',
        source: 'background_notification',
        timestamp: 1,
      },
    ]);
  });

  it('renders daemon plan status blocks as plan messages', () => {
    const plan = {
      sessionUpdate: 'plan',
      entries: [
        {
          content: '检查项目结构',
          priority: 'medium',
          status: 'pending',
          _meta: { qwenTodo: { id: 'inspect' } },
        },
        {
          content: '运行类型检查',
          priority: 'high',
          status: 'in_progress',
          _meta: {
            qwenTodo: { id: 'typecheck', blockedBy: ['inspect'] },
          },
        },
      ],
    };

    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('plan-1', `plan: ${JSON.stringify(plan)}`, 1),
    ]);

    expect(messages).toEqual([
      {
        id: 'plan-1',
        role: 'plan',
        timestamp: 1,
        todos: [
          {
            id: 'inspect',
            content: '检查项目结构',
            priority: 'medium',
            status: 'pending',
          },
          {
            id: 'typecheck',
            content: '运行类型检查',
            priority: 'high',
            status: 'in_progress',
            blockedBy: ['inspect'],
          },
        ],
      },
    ]);
  });

  it('localizes structured session branch status blocks', () => {
    const messages = transcriptBlocksToDaemonMessages(
      [
        statusBlock('branch-1', 'Branched conversation "old"', 1, {
          source: 'session_branched',
          data: {
            sourceSessionId: 'source',
            newSessionId: 'new',
            displayName: 'support-branch-new3 (Branch 2)',
          },
        }),
      ],
      {
        labels: {
          branchSuccess: (name) =>
            `已复制会话，新会话名称为： "${name}"，当前已切换到新的会话。`,
        },
      },
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content:
          '已复制会话，新会话名称为： "support-branch-new3 (Branch 2)"，当前已切换到新的会话。',
        source: 'session_branched',
        data: {
          sourceSessionId: 'source',
          newSessionId: 'new',
          displayName: 'support-branch-new3 (Branch 2)',
        },
      }),
    ]);
  });

  it('shows structured mid-turn inserted text without a status prefix', () => {
    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('mid-1', '你好', 1, {
        source: 'mid_turn_message_injected',
        data: { sessionId: 's1', messages: ['你好'] },
      }),
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: '你好',
        source: 'mid_turn_message_injected',
        data: { sessionId: 's1', messages: ['你好'] },
      }),
    ]);
  });

  it('extracts images from mid-turn injected message items', () => {
    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('mid-1', 'look at this', 1, {
        source: 'mid_turn_message_injected',
        data: {
          sessionId: 's1',
          messages: ['look at this'],
          items: [
            {
              content: [
                { type: 'image', data: 'base64data', mimeType: 'image/png' },
              ],
            },
          ],
        },
      }),
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: 'look at this',
        source: 'mid_turn_message_injected',
        images: [{ data: 'base64data', mimeType: 'image/png' }],
      }),
    ]);
  });

  it('extracts file attachments from mid-turn injected message items', () => {
    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('mid-1', 'explain this', 1, {
        source: 'mid_turn_message_injected',
        data: {
          sessionId: 's1',
          messages: ['explain this'],
          items: [
            {
              content: [
                {
                  type: 'resource',
                  attachmentId: 'notes.txt',
                  mimeType: 'text/plain',
                  size: 5,
                },
              ],
            },
          ],
        },
      }),
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: 'explain this',
        source: 'mid_turn_message_injected',
        files: [
          {
            name: 'notes.txt',
            attachmentId: 'notes.txt',
            mimeType: 'text/plain',
          },
        ],
      }),
    ]);
  });

  it('shows the degraded-media notice when the echo text is empty', () => {
    // When the stored media is gone at drain, the daemon echoes an empty
    // messages array whose items carry only the placeholder text block; the
    // notice must be surfaced instead of rendering an empty bubble.
    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('mid-1', '', 1, {
        source: 'mid_turn_message_injected',
        data: {
          sessionId: 's1',
          messages: [''],
          messageIds: ['mid-gone'],
          items: [
            {
              content: [
                {
                  type: 'text',
                  text: '[Attachment is no longer available]',
                },
              ],
            },
          ],
        },
      }),
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: '[Attachment is no longer available]',
        source: 'mid_turn_message_injected',
      }),
    ]);
  });

  it('keeps mid-turn injected echoes that look like status noise', () => {
    // User content that merely starts like a filtered status line must not be
    // dropped by the noise filter.
    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('mid-1', 'Model switched: check this too', 1, {
        source: 'mid_turn_message_injected',
        data: {
          sessionId: 's1',
          messages: ['Model switched: check this too'],
        },
      }),
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: 'Model switched: check this too',
        source: 'mid_turn_message_injected',
      }),
    ]);
  });

  it('keeps mid-turn injected echoes that start like plan JSON', () => {
    // User content starting with the plan projection shape must not be
    // misrendered as a plan card (which also drops the attached images).
    const planLikeText =
      'plan: {"sessionUpdate":"plan","entries":[{"content":"step"}]}';
    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('mid-1', planLikeText, 1, {
        source: 'mid_turn_message_injected',
        data: {
          sessionId: 's1',
          messages: [planLikeText],
          items: [
            {
              content: [
                { type: 'image', data: 'base64data', mimeType: 'image/png' },
              ],
            },
          ],
        },
      }),
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        content: planLikeText,
        source: 'mid_turn_message_injected',
        images: [{ data: 'base64data', mimeType: 'image/png' }],
      }),
    ]);
  });

  it('keeps replayed mid-turn user blocks as inserted messages', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('mid-1', 'user', 'with image', 1, false, {
        meta: {
          source: 'mid_turn_message_injected',
          qwenDiscreteMessage: true,
        },
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      }),
      textBlock('mid-2', 'user', 'text only', 2, false, {
        meta: {
          source: 'mid_turn_message_injected',
          qwenDiscreteMessage: true,
        },
      }),
    ]);

    expect(messages).toMatchObject([
      {
        role: 'system',
        content: 'with image',
        source: 'mid_turn_message_injected',
        images: [{ data: 'AQID', mimeType: 'image/png' }],
      },
      {
        role: 'system',
        content: 'text only',
        source: 'mid_turn_message_injected',
      },
    ]);
  });

  it('ignores daemon plan entries without content', () => {
    const plan = {
      sessionUpdate: 'plan',
      entries: [
        { content: '', priority: 'high', status: 'in_progress' },
        { content: '运行类型检查', priority: 'high', status: 'in_progress' },
      ],
    };

    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('plan-1', `plan: ${JSON.stringify(plan)}`, 1),
    ]);

    expect(messages).toEqual([
      {
        id: 'plan-1',
        role: 'plan',
        timestamp: 1,
        todos: [
          {
            id: 'plan-1',
            content: '运行类型检查',
            priority: 'high',
            status: 'in_progress',
          },
        ],
      },
    ]);
  });

  it('merges adjacent TodoWrite calls into one tool group like any tool', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('todo-1', 'todo-call-1', 'completed', 1, {
        title: 'Update Todos',
        toolName: 'TodoWrite',
        rawInput: {
          todos: [
            {
              content: '检查项目结构',
              priority: 'medium',
              status: 'completed',
            },
          ],
        },
      }),
      toolBlock('todo-2', 'todo-call-2', 'completed', 2, {
        title: 'Update Todos',
        toolName: 'TodoWrite',
        rawInput: {
          todos: [
            {
              content: '运行类型检查',
              priority: 'high',
              status: 'in_progress',
            },
          ],
        },
      }),
    ]);

    // TodoWrite is an ordinary tool: adjacent calls share one group box.
    expect(messages).toEqual([
      {
        id: 'tg-todo-1',
        role: 'tool_group',
        timestamp: 1,
        tools: [
          expect.objectContaining({
            callId: 'todo-call-1',
            toolName: 'TodoWrite',
          }),
          expect.objectContaining({
            callId: 'todo-call-2',
            toolName: 'TodoWrite',
          }),
        ],
      },
    ]);
  });

  it('merges adjacent top-level tool blocks into one tool_group', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, { toolName: 'Read' }),
      toolBlock('t2', 'tc2', 'completed', 2, { toolName: 'Grep' }),
    ]);

    expect(messages).toEqual([
      {
        id: 'tg-t1',
        role: 'tool_group',
        timestamp: 1,
        tools: [
          expect.objectContaining({ callId: 'tc1', toolName: 'Read' }),
          expect.objectContaining({ callId: 'tc2', toolName: 'Grep' }),
        ],
      },
    ]);
  });

  it('starts a new tool_group after intervening assistant text', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, { toolName: 'Read' }),
      textBlock('a1', 'assistant', 'found it, editing now', 2),
      toolBlock('t2', 'tc2', 'completed', 3, { toolName: 'Edit' }),
    ]);

    expect(messages).toMatchObject([
      { role: 'tool_group', tools: [{ callId: 'tc1' }] },
      { role: 'assistant', content: 'found it, editing now' },
      { role: 'tool_group', tools: [{ callId: 'tc2' }] },
    ]);
  });

  it('carries token usage from an assistant block onto the message', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'final answer', 1, false, {
        usage: { inputTokens: 200, outputTokens: 80 },
      }),
    ]);

    expect(messages).toMatchObject([
      {
        role: 'assistant',
        content: 'final answer',
        usage: { inputTokens: 200, outputTokens: 80 },
      },
    ]);
  });

  it('sums usage when consecutive assistant blocks merge into one message', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'hi ', 1, false, {
        usage: { inputTokens: 100, outputTokens: 40 },
      }),
      textBlock('a2', 'assistant', 'there', 2, false, {
        usage: { inputTokens: 20, outputTokens: 8 },
      }),
    ]);

    expect(messages).toMatchObject([
      {
        role: 'assistant',
        content: 'hi there',
        usage: { inputTokens: 120, outputTokens: 48 },
      },
    ]);
  });

  it('leaves usage undefined when no assistant block reports it', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'no usage here', 1),
    ]);

    expect((messages[0] as { usage?: unknown }).usage).toBeUndefined();
  });

  it('carries cached-read tokens through onto the message', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'answer', 1, false, {
        usage: { inputTokens: 200, outputTokens: 80, cachedTokens: 150 },
      }),
    ]);

    expect(messages).toMatchObject([
      {
        role: 'assistant',
        usage: { inputTokens: 200, outputTokens: 80, cachedTokens: 150 },
      },
    ]);
  });

  it('starts a new tool_group after an intervening thought block', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, { toolName: 'Read' }),
      textBlock('th1', 'thought', 'next I should grep', 2),
      toolBlock('t2', 'tc2', 'completed', 3, { toolName: 'Grep' }),
    ]);

    expect(messages).toMatchObject([
      { role: 'tool_group', tools: [{ callId: 'tc1' }] },
      { role: 'thinking', content: 'next I should grep' },
      { role: 'tool_group', tools: [{ callId: 'tc2' }] },
    ]);
  });

  it('keeps merged groups intact when a member tool completes later', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'in_progress', 1, { toolName: 'Read' }),
      toolBlock('t2', 'tc2', 'in_progress', 2, { toolName: 'Grep' }),
      toolBlock('t1-done', 'tc1', 'completed', 3, {
        toolName: 'Read',
        updatedAt: 4,
      }),
    ]);

    expect(messages).toHaveLength(1);
    const tools =
      messages[0].role === 'tool_group' ? messages[0].tools : undefined;
    expect(tools).toHaveLength(2);
    expect(tools?.[0]).toMatchObject({ callId: 'tc1', status: 'completed' });
    expect(tools?.[1]).toMatchObject({ callId: 'tc2', status: 'in_progress' });
  });

  it('never merges subagent calls into or after a regular tool_group', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, { toolName: 'Read' }),
      toolBlock('agent-1', 'agent-call-1', 'in_progress', 2, {
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('t2', 'tc2', 'completed', 3, { toolName: 'Grep' }),
    ]);

    expect(messages).toMatchObject([
      { role: 'tool_group', tools: [{ callId: 'tc1' }] },
      { role: 'tool_group', tools: [{ callId: 'agent-call-1' }] },
      { role: 'tool_group', tools: [{ callId: 'tc2' }] },
    ]);
  });

  it('merges todo_write updates with adjacent tool calls like any tool', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, { toolName: 'Read' }),
      toolBlock('todo-1', 'todo-call-1', 'completed', 2, {
        toolName: 'todo_write',
        toolKind: 'think',
        rawInput: { todos: [{ id: '1', content: 'A', status: 'in_progress' }] },
      }),
      toolBlock('t2', 'tc2', 'completed', 3, { toolName: 'Edit' }),
    ]);

    expect(messages).toMatchObject([
      {
        role: 'tool_group',
        tools: [
          { callId: 'tc1' },
          { callId: 'todo-call-1' },
          { callId: 'tc2' },
        ],
      },
    ]);
  });

  it('does not merge real tool calls into synthetic raw-shell groups', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('u1', 'user', 'run it', 1),
      shellBlock('sh1', 'raw shell output\n', 2),
      toolBlock('t1', 'tc1', 'completed', 3, { toolName: 'Read' }),
    ]);

    expect(messages).toMatchObject([
      { role: 'user', content: 'run it' },
      { id: 'sh1', role: 'tool_group', tools: [{ toolName: 'shell' }] },
      { id: 'tg-t1', role: 'tool_group', tools: [{ callId: 'tc1' }] },
    ]);
  });

  it('preserves tool block titles on message tool calls', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('ask-1', 'ask-call-1', 'completed', 1, {
        toolName: 'AskUserQuestion',
        title: 'Ask user 2 questions',
        rawOutput:
          'User has provided the following answers:\n\n**班级**: 一班\n**学号**: 001',
      }),
    ]);

    expect(messages).toMatchObject([
      {
        role: 'tool_group',
        tools: [
          {
            callId: 'ask-call-1',
            toolName: 'AskUserQuestion',
            title: 'Ask user 2 questions',
          },
        ],
      },
    ]);
  });

  it('renders insight progress messages', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock(
        'insight-1',
        'assistant',
        '{"insight_progress":{"stage":"scan","progress":0.5,"detail":"reading"}}',
        1,
      ),
    ]);

    expect(messages).toEqual([
      {
        id: 'insight-1-ip',
        role: 'insight_progress',
        timestamp: 1,
        stage: 'scan',
        progress: 0.5,
        detail: 'reading',
      },
    ]);
  });

  it('renders terminal insight messages with surrounding text', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock(
        'insight-1',
        'assistant',
        'before {"insight_ready":{"path":"/tmp/report.md"}} middle {"insight_error":{"error":"boom"}} after',
        1,
      ),
    ]);

    expect(messages).toEqual([
      {
        id: 'insight-1-t-0',
        role: 'assistant',
        content: 'before',
        timestamp: 1,
      },
      {
        id: 'insight-1-ir-0',
        role: 'insight_ready',
        path: '/tmp/report.md',
        timestamp: 1,
      },
      {
        id: 'insight-1-t-2',
        role: 'assistant',
        content: 'middle',
        timestamp: 1,
      },
      {
        id: 'insight-1-ie-0',
        role: 'insight_error',
        error: 'boom',
        timestamp: 1,
      },
      {
        id: 'insight-1-t-4',
        role: 'assistant',
        content: 'after',
        timestamp: 1,
      },
    ]);
  });

  it('keeps malformed insight JSON as assistant text', () => {
    const content = 'before {"insight_ready": bad} after';
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('insight-1', 'assistant', content, 1),
    ]);

    expect(messages).toMatchObject([
      { id: 'insight-1', role: 'assistant', content },
    ]);
  });

  it('keeps parented assistant chunks inside a subagent', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: 分析项目',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      textBlock('assistant-sub', 'assistant', 'subagent output', 20, true, {
        parentToolCallId: 'agent-1',
      }),
      toolBlock('read-sub', 'read-1', 'completed', 30, {
        title: 'Read file',
        toolName: 'Read',
        parentToolCallId: 'agent-1',
      }),
      toolBlock('agent-end', 'agent-1', 'completed', 40, {
        title: 'Agent: 分析项目',
        toolName: 'agent',
        rawOutput: { type: 'task_execution' },
      }),
      textBlock('assistant-main', 'assistant', 'main output', 50, false),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [
        {
          callId: 'agent-1',
          status: 'completed',
          subContent: 'subagent output',
          subTools: [{ callId: 'read-1', status: 'completed' }],
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      id: 'assistant-main',
      role: 'assistant',
      content: 'main output',
    });
  });

  it('keeps parented compacted replay subagent content nested', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-completed', 'agent-1', 'completed', 10, {
        title: 'Agent: 查询官网活动',
        toolName: 'agent',
        rawOutput: {
          type: 'task_execution',
          result: 'subagent final answer',
        },
        updatedAt: 100,
      }),
      textBlock('sub-thought', 'thought', 'subagent thinking', 20, false, {
        parentToolCallId: 'agent-1',
      }),
      textBlock('sub-assistant', 'assistant', 'subagent answer', 30, false, {
        parentToolCallId: 'agent-1',
      }),
      toolBlock('sub-fetch', 'fetch-1', 'completed', 40, {
        title: 'WebFetch',
        toolName: 'WebFetch',
        parentToolCallId: 'agent-1',
      }),
      textBlock('main-assistant', 'assistant', 'main answer', 110),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [
        {
          callId: 'agent-1',
          status: 'completed',
          subContent: 'subagent thinkingsubagent answer',
          subTools: [{ callId: 'fetch-1', status: 'completed' }],
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      id: 'main-assistant',
      role: 'assistant',
      content: 'main answer',
    });
    expect(
      messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.includes('subagent answer'),
      ),
    ).toBe(false);
  });

  it('keeps parallel top-level subagents as sibling tool messages', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-1', 'agent-call-1', 'in_progress', 10, {
        title: 'Agent: Correctness review agent',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-2', 'agent-call-2', 'in_progress', 20, {
        title: 'Agent: Security review agent',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-3', 'agent-call-3', 'in_progress', 30, {
        title: 'Agent: Performance review agent',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages).toMatchObject([
      {
        role: 'tool_group',
        tools: [{ callId: 'agent-call-1' }],
      },
      {
        role: 'tool_group',
        tools: [{ callId: 'agent-call-2' }],
      },
      {
        role: 'tool_group',
        tools: [{ callId: 'agent-call-3' }],
      },
    ]);
    expect(
      messages[0]?.role === 'tool_group' && messages[0].tools[0],
    ).not.toHaveProperty('subTools');
    expect(
      messages[1]?.role === 'tool_group' && messages[1].tools[0],
    ).not.toHaveProperty('subTools');
    expect(
      messages[2]?.role === 'tool_group' && messages[2].tools[0],
    ).not.toHaveProperty('subTools');
  });

  it('merges parallel subagent completion by callId instead of stack order', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-1-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: first',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-2-start', 'agent-2', 'in_progress', 20, {
        title: 'Agent: second',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-1-end', 'agent-1', 'completed', 30, {
        title: 'Agent: first done',
        toolName: 'agent',
        rawOutput: {
          type: 'task_execution',
          result: 'first result',
        },
        updatedAt: 35,
      }),
      toolBlock('agent-2-end', 'agent-2', 'completed', 40, {
        title: 'Agent: second done',
        toolName: 'agent',
        rawOutput: {
          type: 'task_execution',
          result: 'second result',
        },
        updatedAt: 45,
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages).toMatchObject([
      {
        id: 'tg-agent-1-start',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-1',
            status: 'completed',
            title: 'Agent: first done',
            rawOutput: { result: 'first result' },
          },
        ],
      },
      {
        id: 'tg-agent-2-start',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-2',
            status: 'completed',
            title: 'Agent: second done',
            rawOutput: { result: 'second result' },
          },
        ],
      },
    ]);
  });

  it('merges cancelled parallel subagent by callId without closing sibling', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-1-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: first',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-2-start', 'agent-2', 'in_progress', 20, {
        title: 'Agent: second',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-1-cancel', 'agent-1', 'cancelled', 30, {
        title: 'Agent: first',
        toolName: 'agent',
        details: 'Agent was cancelled by user',
        updatedAt: 35,
      }),
      toolBlock('agent-2-end', 'agent-2', 'completed', 40, {
        title: 'Agent: second done',
        toolName: 'agent',
        rawOutput: {
          type: 'task_execution',
          result: 'second result',
        },
        updatedAt: 45,
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages).toMatchObject([
      {
        id: 'tg-agent-1-start',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-1',
            status: 'completed',
            endTime: 35,
            rawOutput: {
              status: 'cancelled',
              reason: 'Agent was cancelled by user',
              text: 'Agent was cancelled by user',
            },
          },
        ],
      },
      {
        id: 'tg-agent-2-start',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-2',
            status: 'completed',
            title: 'Agent: second done',
            endTime: 45,
            rawOutput: { result: 'second result' },
          },
        ],
      },
    ]);
  });

  it('keeps background subagent launches pending and resumes main thread', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: Correctness review',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-background', 'agent-1', 'completed', 20, {
        title: 'Agent: Correctness review',
        toolName: 'agent',
        rawOutput: {
          type: 'task_execution',
          taskDescription: 'Agent 1: Correctness review',
          status: 'background',
        },
        updatedAt: 25,
      }),
      textBlock('thought-main', 'thought', 'wait for background agent', 30),
      textBlock('assistant-main', 'assistant', 'main continues', 40),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      id: 'tg-agent-start',
      role: 'tool_group',
      tools: [
        {
          callId: 'agent-1',
          status: 'pending',
          rawOutput: {
            status: 'background',
            taskDescription: 'Agent 1: Correctness review',
          },
        },
      ],
    });
    expect(
      messages[0].role === 'tool_group'
        ? messages[0].tools[0].endTime
        : undefined,
    ).toBeUndefined();
    expect(messages[1]).toMatchObject({
      id: 'thought-main',
      role: 'thinking',
      content: 'wait for background agent',
    });
    expect(messages[2]).toMatchObject({
      id: 'assistant-main',
      role: 'assistant',
      content: 'main continues',
    });
  });

  it('keeps merged background subagent blocks from capturing main-thread text', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-background', 'agent-1', 'completed', 20, {
        title: 'Agent: Correctness review',
        toolName: 'agent',
        rawInput: {
          description: 'Agent 1: Correctness review',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
        rawOutput: {
          type: 'task_execution',
          taskDescription: 'Agent 1: Correctness review',
          status: 'background',
        },
        updatedAt: 25,
      }),
      textBlock('thought-main', 'thought', 'server diff looks clean', 30),
      textBlock('assistant-main', 'assistant', 'waiting for agents', 40),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      id: 'tg-agent-background',
      role: 'tool_group',
      tools: [
        {
          callId: 'agent-1',
          status: 'pending',
          rawOutput: {
            status: 'background',
            taskDescription: 'Agent 1: Correctness review',
          },
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      id: 'thought-main',
      role: 'thinking',
      content: 'server diff looks clean',
    });
    expect(messages[2]).toMatchObject({
      id: 'assistant-main',
      role: 'assistant',
      content: 'waiting for agents',
    });
  });

  it('keeps unparented assistant text in the main transcript', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-1', 'agent-call-1', 'in_progress', 10, {
        title: 'Agent: first',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-2', 'agent-call-2', 'in_progress', 20, {
        title: 'Agent: second',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      textBlock('a1', 'assistant', 'unparented stream', 30),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [{ callId: 'agent-call-1' }],
    });
    expect(messages[1]).toMatchObject({
      role: 'tool_group',
      tools: [{ callId: 'agent-call-2' }],
    });
    const assistant = messages.find((message) => message.role === 'assistant');
    expect(assistant).toMatchObject({ content: 'unparented stream' });
    expect(
      messages[1]?.role === 'tool_group' && messages[1].tools[0],
    ).not.toHaveProperty('subContent');
  });

  it('merges streaming assistant chunks into one message', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'hello ', 1, true),
      textBlock('a2', 'assistant', 'world', 2, false),
    ]);

    expect(messages).toEqual([
      {
        id: 'a1',
        role: 'assistant',
        content: 'hello world',
        isStreaming: false,
        timestamp: 1,
      },
    ]);
  });

  it('creates standalone user_shell message for user shell output', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('u1', 'user', '! ls', 1),
      userShellBlock('sh1', 'file1.ts\nfile2.ts\n', 'ls', 2),
      statusBlock('st1', 'Shell command exited with code 0', 3),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: 'user', content: '! ls' });
    expect(messages[1]).toMatchObject({
      id: 'sh1',
      role: 'user_shell',
      command: 'ls',
      output: 'file1.ts\nfile2.ts\n',
    });
    expect(messages[2]).toMatchObject({
      role: 'system',
      content: 'Shell command exited with code 0',
    });
  });

  it('filters language_changed daemon debug noise', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'debug-1',
        kind: 'debug',
        debugReason: 'unrecognized_event',
        text:
          'language_changed (unrecognized daemon event): ' +
          '{"sessionId":"dd699cc0-6ef7-4882-92d9-1076ac5b87e9",' +
          '"language":"en","outputLanguage":"English","refreshed":true}',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      } as DaemonTranscriptBlock,
    ]);

    expect(messages).toEqual([]);
  });

  it('filters legacy unrecognized-event blocks that carry no debugReason', () => {
    // `WebShellTranscript` takes already-projected blocks from its caller, so
    // blocks projected or persisted by an SDK older than `debugReason` still
    // arrive with no reason. They must keep being filtered — and not only the
    // two event types that used to be suppressed by name.
    const legacy = (id: string, text: string) =>
      ({
        id,
        kind: 'debug',
        text,
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }) as DaemonTranscriptBlock;

    const messages = transcriptBlocksToDaemonMessages([
      legacy(
        'legacy-1',
        'language_changed (unrecognized daemon event): {"language":"en"}',
      ),
      legacy(
        'legacy-2',
        'session_cwd_changed (unrecognized daemon event): {"cwd":"/work"}',
      ),
      legacy(
        'legacy-3',
        'some_future_event (unrecognized daemon event): {"a":1}',
      ),
    ]);

    expect(messages).toEqual([]);
  });

  it('filters unrecognized session_update kinds the daemon adds later', () => {
    // The event kind here is deliberately one no normalizer case handles: the
    // filter must key off `debugReason`, not a list of known-noisy prefixes.
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'debug-2',
        kind: 'debug',
        debugReason: 'unrecognized_session_update',
        text: 'some_future_kind: {"payload":{"nested":"json"}}',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      } as DaemonTranscriptBlock,
    ]);

    expect(messages).toEqual([]);
  });

  it('keys the filter off the unrecognized_ category prefix, not the enum', () => {
    // A newer SDK may stamp reasons this build's `DaemonUiDebugReason` does
    // not list; the category prefix is the contract. `unrecognized_*` noise
    // hides, `malformed_*` defect signals keep rendering.
    const block = (id: string, debugReason: string, text: string) =>
      ({
        id,
        kind: 'debug',
        debugReason,
        text,
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }) as DaemonTranscriptBlock;

    const messages = transcriptBlocksToDaemonMessages([
      block(
        'future-unrecognized',
        'unrecognized_tool_frame',
        'tool_frame: {"frameId":"f1"}',
      ),
      block(
        'future-malformed',
        'malformed_tool_frame',
        'tool_frame: broken frame payload',
      ),
    ]);

    expect(messages.map((m) => m.id)).toEqual(['future-malformed']);
  });

  it('keeps malformed-payload debug blocks visible', () => {
    // A frame the client *does* know about arrived broken — that is a real
    // defect signal, not forward-compatibility noise.
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'debug-3',
        kind: 'debug',
        debugReason: 'malformed_payload',
        text: 'memory_changed: malformed memory_changed payload',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      } as DaemonTranscriptBlock,
    ]);

    expect(messages).toEqual([
      {
        id: 'debug-3',
        role: 'system',
        content: 'memory_changed: malformed memory_changed payload',
        variant: 'info',
        timestamp: 1,
      },
    ]);
  });

  it('filters legacy usage_update and a2ui blocks that carry no debugReason', () => {
    // The original spam report. #8790 stopped the SDK inserting new
    // `usage_update` blocks, but a transcript persisted or projected before
    // that still holds them, and `WebShellTranscript` renders whatever its
    // caller passes — so without this the reported spam returns on upgrade.
    const legacy = (id: string, text: string) =>
      ({
        id,
        kind: 'debug',
        text,
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }) as DaemonTranscriptBlock;

    const messages = transcriptBlocksToDaemonMessages([
      legacy('legacy-usage', 'usage_update: {"used":46351,"size":1000000}'),
      legacy('legacy-a2ui', 'a2ui: {"surfaceId":"s1","commands":[]}'),
    ]);

    expect(messages).toEqual([]);
  });

  it('filters legacy projections whose payload is not an object', () => {
    // `DaemonEvent.data` is `unknown`, and `stringifyJson` returns strings
    // verbatim, primitives as `42` / `true` / `null`, and `''` for undefined.
    // Keying the match on a leading `{` let all of those through.
    const legacy = (id: string, payload: string) =>
      ({
        id,
        kind: 'debug',
        text: `some_future_event (unrecognized daemon event): ${payload}`,
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      }) as DaemonTranscriptBlock;

    const messages = transcriptBlocksToDaemonMessages([
      legacy('obj', '{"a":1}'),
      legacy('arr', '[1,2]'),
      legacy('str', 'plain text payload'),
      legacy('num', '42'),
      legacy('bool', 'true'),
      legacy('null', 'null'),
      legacy('empty', ''),
    ]);

    expect(messages).toEqual([]);
  });

  it('only matches the legacy shape, never a quoted marker or a status block', () => {
    // The text match is a compatibility shim, so it must be scoped to `debug`
    // blocks and anchored to the whole projection. Matching the marker as a
    // substring would hide any block that merely relays it.
    const block = (
      id: string,
      kind: string,
      text: string,
      extra: Record<string, unknown> = {},
    ) =>
      ({
        id,
        kind,
        text,
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
        ...extra,
      }) as DaemonTranscriptBlock;

    const messages = transcriptBlocksToDaemonMessages([
      // A status line is real content even when it quotes the marker.
      block(
        'status-1',
        'status',
        'peer reported (unrecognized daemon event): malformed frame',
      ),
      // A legacy malformed payload relaying an upstream message.
      block(
        'legacy-malformed',
        'debug',
        'permission_request: {"message":"peer said (unrecognized daemon event): x"}',
      ),
      // A client-dispatched summary that happens to quote it.
      block(
        'client-1',
        'debug',
        'Model switch failed: upstream said (unrecognized daemon event): x',
        { source: 'model_switch_summary' },
      ),
      // A status block whose text starts with a suppressed session-update kind.
      block('status-2', 'status', 'usage_update: {"used":1}'),
    ]);

    expect(messages.map((m) => m.id)).toEqual([
      'status-1',
      'legacy-malformed',
      'client-1',
      'status-2',
    ]);
  });

  it('does not let the legacy prefixes swallow prose or classified blocks', () => {
    // The prefix list is a compatibility shim for a specific projection
    // shape, not a content filter: it must not hide a block the normalizer
    // explicitly classified, nor text that merely starts with the word.
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'malformed-1',
        kind: 'debug',
        debugReason: 'malformed_payload',
        text: 'usage_update: {"used":1}',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      } as DaemonTranscriptBlock,
      {
        id: 'prose-1',
        kind: 'debug',
        text: 'usage_update: rejected by the proxy',
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      } as DaemonTranscriptBlock,
    ]);

    expect(messages.map((m) => m.id)).toEqual(['malformed-1', 'prose-1']);
  });

  it('keeps client-dispatched debug blocks that carry no debugReason', () => {
    // Web Shell dispatches its own `debug` event for the model-switch summary.
    // Only the normalizer stamps `debugReason`, so client-side debug blocks
    // must not be swept up by the unrecognized-event filter.
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'debug-4',
        kind: 'debug',
        text: 'Model switched to qwen3-coder-plus',
        source: 'model_switch_summary',
        data: { modelId: 'qwen3-coder-plus' },
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      } as DaemonTranscriptBlock,
    ]);

    expect(messages).toEqual([
      {
        id: 'debug-4',
        role: 'system',
        content: 'Model switched to qwen3-coder-plus',
        variant: 'info',
        timestamp: 1,
        source: 'model_switch_summary',
        data: { modelId: 'qwen3-coder-plus' },
      },
    ]);
  });

  it('filters SDK model switch status noise', () => {
    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('st1', 'Model switched: qwen3-coder-plus(openai)', 1),
    ]);

    expect(messages).toEqual([]);
  });

  it('preserves structured status source and data', () => {
    const data = {
      kind: 'set',
      condition: 'ship goal sync',
      setAt: 1234,
    };
    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('goal-1', '', 1, {
        source: 'goal',
        data,
      }),
    ]);

    expect(messages).toEqual([
      {
        id: 'goal-1',
        role: 'system',
        content: '',
        variant: 'info',
        source: 'goal',
        data,
        timestamp: 1,
      },
    ]);
  });

  it('appends shell output to preceding tool_group', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, {
        toolName: 'bash',
        toolKind: 'execute',
      }),
      shellBlock('sh1', 'output text', 2),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [
        {
          callId: 'tc1',
          rawOutput: 'output text',
        },
      ],
    });
  });

  it('keeps shell output attached when the tool later completes', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'in_progress', 1, {
        toolName: 'bash',
        toolKind: 'execute',
      }),
      shellBlock('sh1', 'output text', 2),
      toolBlock('t2', 'tc1', 'completed', 3, {
        toolName: 'bash',
        toolKind: 'execute',
        title: 'Shell complete',
        updatedAt: 4,
      }),
    ]);

    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool).toMatchObject({
      callId: 'tc1',
      title: 'Shell complete',
      status: 'completed',
      rawOutput: 'output text',
      endTime: 4,
    });
  });

  it('does not stringify structured raw output before shell text', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, {
        toolName: 'bash',
        toolKind: 'execute',
        rawOutput: { type: 'structured' },
      }),
      shellBlock('sh1', 'output text', 2),
    ]);

    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool?.rawOutput).toBe('output text');
  });

  it('concatenates multiple shell blocks after user message', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('u1', 'user', '! find .', 1),
      shellBlock('sh1', 'chunk1\n', 2),
      shellBlock('sh2', 'chunk2\n', 3),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: 'tool_group',
      tools: [{ rawOutput: 'chunk1\nchunk2\n' }],
    });
  });

  it('attaches shell output to the running execute tool in a merged group', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc-bash', 'running', 1, {
        toolName: 'bash',
        toolKind: 'execute',
      }),
      toolBlock('t2', 'tc-read', 'completed', 2, { toolName: 'Read' }),
      shellBlock('sh1', 'bash output', 3),
    ]);

    expect(messages).toHaveLength(1);
    const tools =
      messages[0].role === 'tool_group' ? messages[0].tools : undefined;
    expect(tools?.[0]).toMatchObject({
      callId: 'tc-bash',
      rawOutput: 'bash output',
    });
    expect(tools?.[1]?.rawOutput).toBeUndefined();
  });

  it('attaches shell output to the most recent running execute tool', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc-bash-1', 'completed', 1, {
        toolName: 'bash',
        toolKind: 'execute',
        rawOutput: 'first output',
      }),
      toolBlock('t2', 'tc-bash-2', 'running', 2, {
        toolName: 'bash',
        toolKind: 'execute',
      }),
      shellBlock('sh1', 'second output', 3),
    ]);

    expect(messages).toHaveLength(1);
    const tools =
      messages[0].role === 'tool_group' ? messages[0].tools : undefined;
    expect(tools?.[0]).toMatchObject({
      callId: 'tc-bash-1',
      rawOutput: 'first output',
    });
    expect(tools?.[1]).toMatchObject({
      callId: 'tc-bash-2',
      rawOutput: 'second output',
    });
  });

  it('falls back to the last execute tool when every status is terminal', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc-bash', 'completed', 1, {
        toolName: 'bash',
        toolKind: 'execute',
      }),
      toolBlock('t2', 'tc-read', 'completed', 2, { toolName: 'Read' }),
      shellBlock('sh1', 'replayed output', 3),
    ]);

    expect(messages).toHaveLength(1);
    const tools =
      messages[0].role === 'tool_group' ? messages[0].tools : undefined;
    expect(tools?.[0]).toMatchObject({
      callId: 'tc-bash',
      rawOutput: 'replayed output',
    });
    expect(tools?.[1]?.rawOutput).toBeUndefined();
  });

  it('merges thought across interleaved tool blocks but splits content after tools', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('t1', 'thought', 'thinking part 1', 1),
      toolBlock('tool1', 'tc1', 'completed', 2, { toolName: 'Read' }),
      textBlock('t2', 'thought', ' thinking part 2', 3),
      textBlock('a1', 'assistant', 'response part 1', 4),
      toolBlock('tool2', 'tc2', 'completed', 5, { toolName: 'Edit' }),
      textBlock('a2', 'assistant', ' response part 2', 6),
    ]);

    expect(messages).toMatchObject([
      { role: 'thinking', content: 'thinking part 1' },
      { role: 'tool_group', tools: [{ callId: 'tc1' }] },
      { role: 'thinking', content: ' thinking part 2' },
      { role: 'assistant', content: 'response part 1' },
      { role: 'tool_group', tools: [{ callId: 'tc2' }] },
      { role: 'assistant', content: ' response part 2' },
    ]);
  });

  it('keeps thought blocks after tool groups in transcript order', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('t1', 'thought', 'first thought', 1),
      toolBlock('tool1', 'tc1', 'completed', 2, { toolName: 'Read' }),
      textBlock('t2', 'thought', 'second thought', 3),
      toolBlock('tool2', 'tc2', 'completed', 4, { toolName: 'ListFiles' }),
      textBlock('t3', 'thought', 'third thought', 5),
      toolBlock('tool3', 'tc3', 'completed', 6, { toolName: 'Glob' }),
      textBlock('t4', 'thought', 'final thought', 7),
    ]);

    expect(messages).toMatchObject([
      { role: 'thinking', content: 'first thought' },
      { role: 'tool_group', tools: [{ callId: 'tc1' }] },
      { role: 'thinking', content: 'second thought' },
      { role: 'tool_group', tools: [{ callId: 'tc2' }] },
      { role: 'thinking', content: 'third thought' },
      { role: 'tool_group', tools: [{ callId: 'tc3' }] },
      { role: 'thinking', content: 'final thought' },
    ]);
  });

  it('preserves title, args, and rawOutput on completed parallel agents', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-1', 'call-1', 'completed', 10, {
        title: 'Agent: 分析项目核心原理',
        toolName: 'agent',
        rawInput: {
          description: '分析项目核心原理',
          prompt: '请分析...',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
        rawOutput: {
          type: 'task_execution',
          subagentName: 'general-purpose',
          taskDescription: '分析项目核心原理',
          status: 'background',
        },
        updatedAt: 11,
      }),
      toolBlock('agent-2', 'call-2', 'completed', 10, {
        title: 'Agent: 分析项目使用场景和性能',
        toolName: 'agent',
        rawInput: {
          description: '分析项目使用场景和性能',
          prompt: '请分析...',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
        rawOutput: {
          type: 'task_execution',
          subagentName: 'general-purpose',
          taskDescription: '分析项目使用场景和性能',
          status: 'background',
        },
        updatedAt: 11,
      }),
    ]);

    expect(messages).toHaveLength(2);
    const tool1 =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    const tool2 =
      messages[1].role === 'tool_group' ? messages[1].tools[0] : undefined;
    expect(tool1).toMatchObject({
      callId: 'call-1',
      title: 'Agent: 分析项目核心原理',
      args: { description: '分析项目核心原理' },
      rawOutput: { taskDescription: '分析项目核心原理' },
    });
    expect(tool2).toMatchObject({
      callId: 'call-2',
      title: 'Agent: 分析项目使用场景和性能',
      args: { description: '分析项目使用场景和性能' },
      rawOutput: { taskDescription: '分析项目使用场景和性能' },
    });
  });

  it('keeps cancelled subagent tools complete with cancellation reason', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: Analyze TanStack Virtual architecture',
        toolName: 'agent',
        rawInput: {
          description: 'Analyze TanStack Virtual architecture',
          subagent_type: 'general-purpose',
        },
      }),
      toolBlock('agent-end', 'agent-1', 'cancelled', 20, {
        title: 'Agent: Analyze TanStack Virtual architecture',
        toolName: 'agent',
        details: 'Agent was cancelled by user',
        updatedAt: 30,
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [
        {
          callId: 'agent-1',
          status: 'completed',
          endTime: 30,
          rawOutput: {
            status: 'cancelled',
            reason: 'Agent was cancelled by user',
            text: 'Agent was cancelled by user',
          },
        },
      ],
    });
  });

  it('does not merge assistant text across user message boundaries', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'first reply', 1),
      toolBlock('tool1', 'tc1', 'completed', 2, { toolName: 'Read' }),
      textBlock('u1', 'user', 'follow up', 3),
      textBlock('a2', 'assistant', 'second reply', 4),
    ]);

    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
    expect(assistantMsgs[0]).toMatchObject({ content: 'first reply' });
    expect(assistantMsgs[1]).toMatchObject({ content: 'second reply' });
  });

  it('skips non-agent permission blocks', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'let me run that', 1),
      {
        id: 'perm-1',
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 'sess-1',
        title: 'Allow Bash?',
        options: [{ optionId: 'opt-1', label: 'Allow', raw: {} }],
        toolCall: { toolCallId: 'tc-1', rawInput: { command: 'ls' } },
        preview: { kind: 'generic' as const },
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      },
      textBlock('a2', 'assistant', ' done', 3),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'let me run that done',
    });
  });

  it('does not synthesize a generic tool card for AskUserQuestion permissions', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'I will ask for student info.', 1),
      {
        id: 'perm-ask-1',
        kind: 'permission',
        requestId: 'req-ask-1',
        sessionId: 'sess-1',
        title: 'Ask user 4 questions',
        options: [{ optionId: 'proceed_once', label: 'Submit', raw: {} }],
        toolCall: {
          toolCallId: 'ask-call-1',
          kind: 'think',
          status: 'pending',
          title: 'Ask user 4 questions',
          rawInput: {
            questions: [
              {
                header: '姓名',
                question: '请输入学生的姓名：',
                options: [{ label: '张三', description: '示例姓名' }],
              },
            ],
          },
        },
        preview: { kind: 'generic' as const },
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'I will ask for student info.',
    });
  });

  it('uses AskUserQuestion permission title for the completed tool block', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'perm-ask-1',
        kind: 'permission',
        requestId: 'req-ask-1',
        sessionId: 'sess-1',
        title: 'Ask user 4 questions',
        options: [{ optionId: 'proceed_once', label: 'Submit', raw: {} }],
        toolCall: {
          toolCallId: 'ask-call-1',
          kind: 'think',
          status: 'pending',
          title: 'Ask user 4 questions',
          rawInput: {
            questions: [
              {
                header: '姓名',
                question: '请输入学生的姓名：',
                options: [{ label: '张三', description: '示例姓名' }],
              },
            ],
          },
        },
        preview: { kind: 'generic' as const },
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 2,
        resolved: 'selected:proceed_once',
      },
      toolBlock('ask-tool-1', 'ask-call-1', 'completed', 3, {
        toolName: 'ask_user_question',
        title: 'ask_user_question',
        rawOutput: 'User has provided the following answers:\n\n**姓名**: 张三',
      }),
    ]);

    expect(messages).toMatchObject([
      {
        role: 'tool_group',
        tools: [
          {
            callId: 'ask-call-1',
            title: 'Ask user 4 questions',
            args: {
              questions: [
                {
                  header: '姓名',
                  question: '请输入学生的姓名：',
                  options: [{ label: '张三', description: '示例姓名' }],
                },
              ],
            },
            rawOutput:
              'User has provided the following answers:\n\n**姓名**: 张三',
          },
        ],
      },
    ]);
  });

  it('uses text content as raw output when a tool has no raw output', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('ask-failed', 'ask-call-failed', 'failed', 1, {
        toolName: 'ask_user_question',
        title: 'ask_user_question',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Question 1: "options" must contain between 2 and 4 options.',
            },
          },
        ] as DaemonToolTranscriptBlock['content'],
      }),
    ]);

    expect(messages).toMatchObject([
      {
        role: 'tool_group',
        tools: [
          {
            callId: 'ask-call-failed',
            status: 'failed',
            rawOutput:
              'Question 1: "options" must contain between 2 and 4 options.',
          },
        ],
      },
    ]);
  });

  it('prefers AskUserQuestion failure text over echoed input', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('ask-failed', 'ask-call-failed', 'failed', 1, {
        toolName: 'ask_user_question',
        title: 'ask_user_question',
        rawInput: {
          questions: [
            {
              header: '学生姓名',
              question: '请输入学生姓名',
              options: [
                {
                  label: '输入姓名',
                  description: '请输入学生的完整姓名',
                },
              ],
            },
          ],
        },
        rawOutput: JSON.stringify({
          questions: [
            {
              header: '学生姓名',
              question: '请输入学生姓名',
            },
          ],
        }),
        details: JSON.stringify({
          questions: [
            {
              header: '学生姓名',
              question: '请输入学生姓名',
            },
          ],
        }),
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Question 1: "options" must contain between 2 and 4 options.',
            },
          },
        ] as DaemonToolTranscriptBlock['content'],
      }),
    ]);

    expect(messages).toMatchObject([
      {
        role: 'tool_group',
        tools: [
          {
            callId: 'ask-call-failed',
            status: 'failed',
            rawOutput:
              'Question 1: "options" must contain between 2 and 4 options.',
          },
        ],
      },
    ]);
  });

  it('does not render pending permission blocks as tool messages', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'perm-agent-1',
        kind: 'permission',
        requestId: 'req-agent-1',
        sessionId: 'sess-1',
        title: '查询阿里云官网活动',
        options: [{ optionId: 'opt-1', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'agent-call-1',
          kind: 'other',
          status: 'pending',
          title: '查询阿里云官网活动',
          rawInput: {
            description: '查询阿里云官网活动',
            prompt: '请查询阿里云官网当前的活动信息。',
            subagent_type: 'general-purpose',
          },
        },
        preview: { kind: 'generic' as const },
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'perm-agent-2',
        kind: 'permission',
        requestId: 'req-agent-2',
        sessionId: 'sess-1',
        title: '查询百度云官网活动',
        options: [{ optionId: 'opt-1', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'agent-call-2',
          kind: 'other',
          status: 'pending',
          title: '查询百度云官网活动',
          rawInput: {
            description: '查询百度云官网活动',
            prompt: '请查询百度云官网当前的活动信息。',
            subagent_type: 'general-purpose',
          },
        },
        preview: { kind: 'generic' as const },
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    expect(messages).toEqual([]);
  });

  it('merges the real subagent tool update after a permission block', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'perm-agent-1',
        kind: 'permission',
        requestId: 'req-agent-1',
        sessionId: 'sess-1',
        title: 'Agent A',
        options: [{ optionId: 'opt-1', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'agent-1',
          rawInput: { subagent_type: 'Explore', prompt: 'a' },
        },
        preview: { kind: 'generic' as const },
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      toolBlock('t1', 'agent-1', 'in_progress', 2, {
        toolName: 'Agent',
        title: 'Agent A running',
        rawInput: { subagent_type: 'Explore', prompt: 'a' },
      }),
      toolBlock('t2', 'sub-a1', 'completed', 3, {
        toolName: 'web_fetch',
        parentToolCallId: 'agent-1',
        rawOutput: 'data-a',
      }),
    ]);

    expect(messages).toHaveLength(1);
    const agent =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agent).toMatchObject({
      callId: 'agent-1',
      toolName: 'Agent',
      title: 'Agent A running',
      status: 'in_progress',
    });
    expect(agent?.subTools).toHaveLength(1);
    expect(agent?.subTools?.[0]).toMatchObject({ callId: 'sub-a1' });
  });

  it('does not duplicate a permission block when the synthetic agent tool already exists', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'agent-1', 'confirming', 1, {
        toolName: 'Agent',
        title: 'Agent A',
        rawInput: { subagent_type: 'Explore', prompt: 'a' },
      }),
      {
        id: 'perm-agent-1',
        kind: 'permission',
        requestId: 'req-agent-1',
        sessionId: 'sess-1',
        title: 'Agent A',
        options: [{ optionId: 'opt-1', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'agent-1',
          rawInput: { subagent_type: 'Explore', prompt: 'a' },
        },
        preview: { kind: 'generic' as const },
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      },
      toolBlock('t2', 'sub-a1', 'completed', 3, {
        toolName: 'web_fetch',
        parentToolCallId: 'agent-1',
        rawOutput: 'data-a',
      }),
    ]);

    expect(messages).toHaveLength(1);
    const agent =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agent).toMatchObject({
      callId: 'agent-1',
      toolName: 'Agent',
      title: 'Agent A',
      status: 'pending',
    });
    expect(agent?.subTools).toHaveLength(1);
    expect(agent?.subTools?.[0]).toMatchObject({ callId: 'sub-a1' });
  });

  it('keeps existing subagent status after approved permission resolves', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'agent-1', 'in_progress', 1, {
        toolName: 'Agent',
        title: 'Agent A',
        rawInput: { subagent_type: 'Explore', prompt: 'a' },
      }),
      {
        id: 'perm-agent-1',
        kind: 'permission',
        requestId: 'req-agent-1',
        sessionId: 'sess-1',
        title: 'Agent A',
        options: [{ optionId: 'opt-1', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'agent-1',
          rawInput: { subagent_type: 'Explore', prompt: 'a' },
        },
        preview: { kind: 'generic' as const },
        resolved: 'selected:allow',
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      },
    ]);

    const agent =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agent).toMatchObject({
      callId: 'agent-1',
      status: 'in_progress',
    });
  });

  it('uses resolved approved permission as agent placeholder until final update', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'perm-1',
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 'sess-1',
        title: 'Agent A',
        options: [{ optionId: 'opt-1', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'agent-1',
          rawInput: { subagent_type: 'Explore', prompt: 'a' },
        },
        preview: { kind: 'generic' as const },
        resolved: 'selected:allow',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      textBlock('thought-1', 'thought', 'inside agent', 3, false, {
        parentToolCallId: 'agent-1',
      }),
      toolBlock('child-1', 'child-tool-1', 'completed', 4, {
        toolName: 'web_fetch',
        parentToolCallId: 'agent-1',
        rawOutput: 'child output',
      }),
      toolBlock('t1', 'agent-1', 'completed', 5, {
        toolName: 'agent',
        title: 'Agent A',
        rawInput: { subagent_type: 'Explore', prompt: 'a' },
        rawOutput: { type: 'task_execution', result: 'done' },
        updatedAt: 6,
      }),
    ]);

    expect(messages).toHaveLength(1);
    const agent =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agent?.callId).toBe('agent-1');
    expect(agent?.status).toBe('completed');
    expect(agent?.subContent).toBe('inside agent');
    expect(agent?.subTools?.[0]).toMatchObject({
      callId: 'child-tool-1',
      toolName: 'web_fetch',
    });
  });

  it('does not put approved background permission placeholders on the active subagent stack', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'perm-1',
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 'sess-1',
        title: 'Agent A',
        options: [{ optionId: 'opt-1', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'agent-1',
          rawInput: {
            subagent_type: 'Explore',
            prompt: 'a',
            run_in_background: true,
          },
        },
        preview: { kind: 'generic' as const },
        resolved: 'selected:allow',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      textBlock('thought-1', 'thought', 'background agent is running', 3),
      textBlock('assistant-1', 'assistant', 'main turn continues', 4),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [
        {
          callId: 'agent-1',
          status: 'pending',
        },
      ],
    });
    const agent =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agent?.subContent).toBeUndefined();
    expect(messages[1]).toMatchObject({
      role: 'thinking',
      content: 'background agent is running',
    });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'main turn continues',
    });
  });

  it('keeps approved regular tool permission visible until tool update arrives', () => {
    const pendingMessages = transcriptBlocksToDaemonMessages([
      {
        id: 'perm-1',
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 'sess-1',
        title:
          'Fetching content from https://www.aliyun.com/activity (format: markdown)',
        options: [{ optionId: 'proceed_once', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'webfetch-1',
          kind: 'fetch',
          rawInput: {
            url: 'https://www.aliyun.com/activity',
            prompt: 'list activities',
            format: 'markdown',
          },
        },
        preview: { kind: 'generic' as const },
        resolved: 'selected:proceed_once',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    expect(pendingMessages).toHaveLength(1);
    const pendingTool =
      pendingMessages[0].role === 'tool_group'
        ? pendingMessages[0].tools[0]
        : undefined;
    expect(pendingTool).toMatchObject({
      callId: 'webfetch-1',
      toolName: 'web_fetch',
      status: 'in_progress',
      kind: 'fetch',
    });

    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'perm-1',
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 'sess-1',
        title:
          'Fetching content from https://www.aliyun.com/activity (format: markdown)',
        options: [{ optionId: 'proceed_once', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'webfetch-1',
          kind: 'fetch',
          rawInput: {
            url: 'https://www.aliyun.com/activity',
            prompt: 'list activities',
            format: 'markdown',
          },
        },
        preview: { kind: 'generic' as const },
        resolved: 'selected:proceed_once',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 2,
      },
      toolBlock('t1', 'webfetch-1', 'completed', 3, {
        toolName: 'web_fetch',
        toolKind: 'fetch',
        title: 'WebFetch result',
        rawOutput: 'Content processed successfully.',
        updatedAt: 4,
      }),
    ]);

    expect(messages).toHaveLength(1);
    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool).toMatchObject({
      callId: 'webfetch-1',
      toolName: 'web_fetch',
      status: 'completed',
      rawOutput: 'Content processed successfully.',
    });
  });

  it('treats compound allow permission resolutions as approved', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'perm-1',
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 'sess-1',
        title: 'Fetch page',
        options: [{ optionId: 'allow_once', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'webfetch-1',
          kind: 'fetch',
          rawInput: {
            url: 'https://example.com',
            prompt: 'read',
          },
        },
        preview: { kind: 'generic' as const },
        resolved: 'selected:allow_once',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool).toMatchObject({
      callId: 'webfetch-1',
      status: 'in_progress',
    });
  });

  it('treats switch-to-default permission resolutions as approved', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'perm-1',
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 'sess-1',
        title: 'Present HTML',
        options: [
          {
            optionId: 'proceed_once_and_switch_to_default',
            label: 'Switch to Default Mode and allow once (recommended)',
            raw: { kind: 'allow_once' },
          },
        ],
        toolCall: {
          toolCallId: 'mcp-1',
          kind: 'other',
          _meta: { toolName: 'mcp__agentic-pai__present_html' },
          rawInput: { path: 'interactive.html' },
        },
        preview: { kind: 'generic' as const },
        resolved: 'selected:proceed_once_and_switch_to_default',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool).toMatchObject({
      callId: 'mcp-1',
      status: 'in_progress',
    });
  });

  it.each([
    'selected:proceed_once',
    'selected:proceed_once_and_switch_to_default',
  ])(
    'does not overwrite a completed tool with a later %s permission block',
    (resolved) => {
      const messages = transcriptBlocksToDaemonMessages([
        toolBlock('tool-1', 'mcp-1', 'completed', 1, {
          toolName: 'mcp__agentic-pai__present_html',
          rawOutput: '{"approved":true}',
          updatedAt: 3,
        }),
        {
          id: 'perm-1',
          kind: 'permission',
          requestId: 'req-1',
          sessionId: 'sess-1',
          title: 'Present HTML',
          options: [
            {
              optionId: resolved.slice('selected:'.length),
              label: 'Allow',
              raw: { kind: 'allow_once' },
            },
          ],
          toolCall: {
            toolCallId: 'mcp-1',
            kind: 'other',
            _meta: { toolName: 'mcp__agentic-pai__present_html' },
            rawInput: { path: 'interactive.html' },
          },
          preview: { kind: 'generic' as const },
          resolved,
          clientReceivedAt: 2,
          createdAt: 2,
          updatedAt: 4,
        },
      ]);

      const tool =
        messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
      expect(tool).toMatchObject({
        callId: 'mcp-1',
        status: 'completed',
        rawOutput: '{"approved":true}',
        endTime: 3,
      });
    },
  );

  it('renders rejected permission as completed agent card', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('t1', 'thought', 'first thinking', 1),
      {
        id: 'perm-1',
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 'sess-1',
        title: '查询阿里云官网活动',
        options: [{ optionId: 'opt-1', label: 'Allow', raw: {} }],
        toolCall: {
          toolCallId: 'agent-1',
          rawInput: { subagent_type: 'general-purpose', prompt: 'query' },
        },
        preview: { kind: 'generic' as const },
        resolved: 'selected:cancel',
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 3,
      },
      textBlock('t2', 'thought', 'second thinking', 4),
      textBlock('a1', 'assistant', 'response text', 5),
    ]);

    expect(messages).toHaveLength(4);
    // First: thinking message
    expect(messages[0]).toMatchObject({
      role: 'thinking',
      content: 'first thinking',
    });
    // Second: completed agent card (not pending)
    const agentGroup = messages[1];
    expect(agentGroup.role).toBe('tool_group');
    if (agentGroup.role === 'tool_group') {
      expect(agentGroup.tools[0]).toMatchObject({
        callId: 'agent-1',
        status: 'failed',
        endTime: 3,
      });
    }
    // Third: second thinking, fourth: response (not absorbed into agent subContent)
    expect(messages[2]).toMatchObject({
      role: 'thinking',
      content: 'second thinking',
    });
    expect(messages[3]).toMatchObject({
      role: 'assistant',
      content: 'response text',
    });
  });

  it('does not treat negative approval words as approved permissions', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'perm-1',
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 'sess-1',
        title: 'Agent A',
        options: [{ optionId: 'opt-1', label: 'Deny', raw: {} }],
        toolCall: {
          toolCallId: 'agent-1',
          rawInput: { subagent_type: 'Explore', prompt: 'a' },
        },
        preview: { kind: 'generic' as const },
        resolved: 'selected:not_approved',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    const agent =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agent).toMatchObject({
      callId: 'agent-1',
      status: 'failed',
      endTime: 2,
    });
  });

  it('splits thought across permission boundary when content already exists', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('t1', 'thought', 'first thinking', 1),
      textBlock('a1', 'assistant', 'let me try this', 2),
      {
        id: 'perm-1',
        kind: 'permission',
        requestId: 'req-1',
        sessionId: 'sess-1',
        title: 'Allow Skill?',
        options: [{ optionId: 'opt-1', label: 'Allow', raw: {} }],
        toolCall: { toolCallId: 'tc-1', rawInput: { skill: 'codegraph' } },
        preview: { kind: 'generic' as const },
        clientReceivedAt: 3,
        createdAt: 3,
        updatedAt: 3,
      },
      textBlock('t2', 'thought', 'second thinking', 4),
      textBlock('a2', 'assistant', 'different approach', 5),
    ]);

    expect(messages).toMatchObject([
      { role: 'thinking', content: 'first thinking' },
      { role: 'assistant', content: 'let me try this' },
      { role: 'thinking', content: 'second thinking' },
      { role: 'assistant', content: 'different approach' },
    ]);
  });

  it('converts error blocks to system error messages', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'err-1',
        kind: 'error' as const,
        text: 'Connection lost',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(messages).toEqual([
      {
        id: 'err-1',
        role: 'system',
        content: 'Connection lost',
        variant: 'error',
        retryable: false,
        timestamp: 1,
      },
    ]);
  });

  it('marks turn_error blocks as retryable system errors', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'err-1',
        kind: 'error' as const,
        source: 'turn_error' as const,
        text: 'Request failed',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(messages).toEqual([
      {
        id: 'err-1',
        role: 'system',
        content: 'Request failed',
        variant: 'error',
        retryable: true,
        source: 'turn_error',
        timestamp: 1,
      },
    ]);
  });

  it('renders loop detection errors from a structured localized label', () => {
    const messages = transcriptBlocksToDaemonMessages(
      [
        {
          id: 'err-loop',
          kind: 'error' as const,
          source: 'turn_error' as const,
          errorKind: 'loop_detected' as const,
          text: 'internal fallback',
          clientReceivedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      { labels: { loopDetected: 'Localized loop guidance.' } },
    );

    expect(messages[0]).toMatchObject({
      content: 'Localized loop guidance.',
      retryable: false,
      source: 'turn_error',
    });
  });

  it('renders model stream interruption errors from structured errorKind labels', () => {
    const messages = transcriptBlocksToDaemonMessages(
      [
        {
          id: 'err-1',
          kind: 'error' as const,
          source: 'turn_error' as const,
          errorKind: 'model_stream_interrupted' as const,
          text: 'terminated',
          data: { diagnosticId: 'abc' },
          clientReceivedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      {
        labels: {
          modelStreamInterrupted: 'Localized stream interruption.',
        },
      },
    );

    expect(messages).toEqual([
      {
        id: 'err-1',
        role: 'system',
        content: 'Localized stream interruption.',
        variant: 'error',
        retryable: true,
        source: 'turn_error',
        data: {
          diagnosticId: 'abc',
          errorKind: 'model_stream_interrupted',
        },
        timestamp: 1,
      },
    ]);
  });

  it('upgrades older daemon terminated turn errors to localized text', () => {
    const messages = transcriptBlocksToDaemonMessages(
      [
        {
          id: 'err-1',
          kind: 'error' as const,
          source: 'turn_error' as const,
          text: 'terminated',
          clientReceivedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      {
        labels: {
          modelStreamInterrupted: 'Localized stream interruption.',
        },
      },
    );

    expect(messages[0]).toMatchObject({
      content: 'Localized stream interruption.',
      retryable: true,
      source: 'turn_error',
    });
  });

  it('does not add data solely for structured errorKind labels', () => {
    const messages = transcriptBlocksToDaemonMessages(
      [
        {
          id: 'err-1',
          kind: 'error' as const,
          source: 'turn_error' as const,
          errorKind: 'model_stream_interrupted' as const,
          text: 'terminated',
          clientReceivedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      {
        labels: {
          modelStreamInterrupted: 'Localized stream interruption.',
        },
      },
    );

    expect(messages[0]).toMatchObject({
      content: 'Localized stream interruption.',
      retryable: true,
      source: 'turn_error',
    });
    expect(messages[0]).not.toHaveProperty('data');
  });

  it('preserves non-object error data when adding structured errorKind', () => {
    const messages = transcriptBlocksToDaemonMessages(
      [
        {
          id: 'err-1',
          kind: 'error' as const,
          source: 'turn_error' as const,
          errorKind: 'model_stream_interrupted' as const,
          text: 'terminated',
          data: 'diagnostic text',
          clientReceivedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      {
        labels: {
          modelStreamInterrupted: 'Localized stream interruption.',
        },
      },
    );

    expect(messages[0]).toMatchObject({
      data: {
        value: 'diagnostic text',
        errorKind: 'model_stream_interrupted',
      },
    });
  });

  it('converts debug blocks to system messages with info variant', () => {
    const messages = transcriptBlocksToDaemonMessages([
      {
        id: 'dbg-1',
        kind: 'debug' as const,
        text: 'Session initialized',
        clientReceivedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(messages).toEqual([
      {
        id: 'dbg-1',
        role: 'system',
        content: 'Session initialized',
        variant: 'info',
        timestamp: 1,
      },
    ]);
  });

  it('creates thinking message for thought-only blocks', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('t1', 'thought', 'let me think about this', 1),
    ]);

    expect(messages).toEqual([
      {
        id: 't1',
        role: 'thinking',
        content: 'let me think about this',
        isStreaming: false,
        timestamp: 1,
      },
    ]);
  });

  it('handles nested subagent via parentToolCallId', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('parent-start', 'parent-1', 'in_progress', 10, {
        title: 'Agent: outer',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      {
        id: 'child-start',
        kind: 'tool' as const,
        toolCallId: 'child-1',
        title: 'Agent: inner',
        status: 'in_progress',
        toolName: 'agent',
        preview: { kind: 'generic' as const },
        rawInput: { subagent_type: 'Explore' },
        parentToolCallId: 'parent-1',
        clientReceivedAt: 20,
        createdAt: 20,
        updatedAt: 20,
      },
      toolBlock('read-inner', 'read-1', 'completed', 30, {
        toolName: 'Read',
        title: 'Read file.ts',
        parentToolCallId: 'child-1',
      }),
      {
        id: 'child-end',
        kind: 'tool' as const,
        toolCallId: 'child-1',
        title: 'Agent: inner',
        status: 'completed',
        toolName: 'agent',
        preview: { kind: 'generic' as const },
        rawOutput: { type: 'task_execution' },
        parentToolCallId: 'parent-1',
        clientReceivedAt: 40,
        createdAt: 40,
        updatedAt: 40,
      },
      toolBlock('parent-end', 'parent-1', 'completed', 50, {
        title: 'Agent: outer',
        toolName: 'agent',
        rawOutput: { type: 'task_execution' },
      }),
    ]);

    expect(messages).toHaveLength(1);
    const parentTool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(parentTool?.callId).toBe('parent-1');
    expect(parentTool?.subTools).toHaveLength(1);
    const childTool = parentTool?.subTools?.[0];
    expect(childTool?.callId).toBe('child-1');
    expect(childTool?.subTools).toHaveLength(1);
    expect(childTool?.subTools?.[0]?.callId).toBe('read-1');
  });

  it('user message resets assistant merge state', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'first', 1),
      textBlock('u1', 'user', 'question', 2),
      textBlock('a2', 'assistant', 'second', 3),
    ]);

    expect(messages).toEqual([
      {
        id: 'a1',
        role: 'assistant',
        content: 'first',
        isStreaming: false,
        timestamp: 1,
      },
      { id: 'u1', role: 'user', content: 'question', timestamp: 2 },
      {
        id: 'a2',
        role: 'assistant',
        content: 'second',
        isStreaming: false,
        timestamp: 3,
      },
    ]);
  });

  it('keeps thought and assistant as separate messages without tools', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('t1', 'thought', 'analyzing...', 1),
      textBlock('a1', 'assistant', 'here is my answer', 2),
    ]);

    expect(messages).toEqual([
      {
        id: 't1',
        role: 'thinking',
        content: 'analyzing...',
        isStreaming: false,
        timestamp: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'here is my answer',
        isStreaming: false,
        timestamp: 2,
      },
    ]);
  });

  it('returns empty array for empty blocks', () => {
    const messages = transcriptBlocksToDaemonMessages([]);
    expect(messages).toEqual([]);
  });

  it('keeps status blocks in the main transcript while subagent is active', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: analyze',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      statusBlock('st1', 'Working on it...', 20),
      toolBlock('agent-end', 'agent-1', 'completed', 30, {
        title: 'Agent: analyze',
        toolName: 'agent',
        rawOutput: { type: 'task_execution' },
      }),
    ]);

    expect(messages).toHaveLength(2);
    const agentTool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agentTool?.subContent).toBeUndefined();
    expect(messages[1]).toMatchObject({
      id: 'st1',
      role: 'system',
      content: 'Working on it...',
      variant: 'info',
    });
  });

  it('renders prompt cancellation blocks as system messages', () => {
    const messages = transcriptBlocksToDaemonMessages([
      promptCancelledBlock('cancel-1', 20),
    ]);

    expect(messages).toEqual([
      {
        id: 'cancel-1',
        role: 'system',
        content: 'Request cancelled.',
        variant: 'info',
        source: 'prompt_cancelled',
        timestamp: 20,
      },
    ]);
  });

  it('renders localized prompt cancellation messages', () => {
    const messages = transcriptBlocksToDaemonMessages(
      [promptCancelledBlock('cancel-1', 20)],
      { labels: { promptCancelled: '请求已取消。' } },
    );

    expect(messages).toEqual([
      {
        id: 'cancel-1',
        role: 'system',
        content: '请求已取消。',
        variant: 'info',
        source: 'prompt_cancelled',
        timestamp: 20,
      },
    ]);
  });

  it('keeps assistant text after a completed agent in the main transcript', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-1', 'call-1', 'completed', 10, {
        title: 'Agent: quick',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
        rawOutput: { type: 'task_execution' },
        updatedAt: 20,
      }),
      textBlock('a1', 'assistant', 'after agent', 25),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [{ callId: 'call-1', status: 'completed' }],
    });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'after agent',
    });
  });

  it('creates sibling tool groups for top-level subagents', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-1-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: first',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-2-start', 'agent-2', 'in_progress', 20, {
        title: 'Agent: second',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [{ callId: 'agent-1' }],
    });
    expect(messages[1]).toMatchObject({
      role: 'tool_group',
      tools: [{ callId: 'agent-2' }],
    });
  });

  it('cancelled agent without details returns rawOutput as-is', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: working',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-end', 'agent-1', 'cancelled', 20, {
        title: 'Agent: working',
        toolName: 'agent',
        updatedAt: 25,
      }),
    ]);

    expect(messages).toHaveLength(1);
    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool?.status).toBe('completed');
    expect(tool?.endTime).toBe(25);
    expect(tool?.rawOutput).toBeUndefined();
  });

  it('cancelled agent with existing rawOutput object spreads and adds status/reason', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: analyze',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-end', 'agent-1', 'cancelled', 20, {
        title: 'Agent: analyze',
        toolName: 'agent',
        rawOutput: { type: 'task_execution', subagentName: 'general-purpose' },
        details: 'User cancelled',
        updatedAt: 30,
      }),
    ]);

    expect(messages).toHaveLength(1);
    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool?.rawOutput).toEqual({
      type: 'task_execution',
      subagentName: 'general-purpose',
      status: 'cancelled',
      reason: 'User cancelled',
    });
  });

  it('inferToolKind uses toolKind over toolName when both present', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, {
        toolName: 'bash',
        toolKind: 'search',
      }),
    ]);

    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool?.kind).toBe('search');
  });

  it('inferToolKind uses exact match for grep and glob', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, { toolName: 'grep' }),
      toolBlock('t2', 'tc2', 'completed', 2, { toolName: 'glob' }),
      toolBlock('t3', 'tc3', 'completed', 3, { toolName: 'mygrep' }),
    ]);

    expect(messages).toHaveLength(1);
    const tools =
      messages[0].role === 'tool_group' ? messages[0].tools : undefined;
    expect(tools?.[0]?.kind).toBe('search');
    expect(tools?.[1]?.kind).toBe('search');
    expect(tools?.[2]?.kind).toBeUndefined();
  });

  it('getToolRawOutput fallback returns rawOutput ?? details for non-cancelled', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, {
        toolName: 'Read',
        rawOutput: undefined,
        details: 'some detail info',
      }),
    ]);

    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool?.rawOutput).toBe('some detail info');
  });

  it('does not use content text as generic raw output', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, {
        toolName: 'custom_tool',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'rendered elsewhere' },
          },
        ] as DaemonToolTranscriptBlock['content'],
      }),
    ]);

    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool?.rawOutput).toBeUndefined();
    expect(tool?.content).toEqual([
      {
        type: 'content',
        content: { type: 'text', text: 'rendered elsewhere' },
      },
    ]);
  });

  it('mergeToolCall updates fields from completion block', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: work',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-end', 'agent-1', 'completed', 20, {
        title: 'Agent: work done',
        toolName: 'agent',
        rawOutput: {
          type: 'task_execution',
          executionMode: 'background',
          totalTokens: 500,
        },
        updatedAt: 25,
      }),
    ]);

    expect(messages).toHaveLength(1);
    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool?.title).toBe('Agent: work done');
    expect(tool?.status).toBe('completed');
    expect(tool?.endTime).toBe(25);
    expect(tool?.executionMode).toBe('background');
    expect(tool?.rawOutput).toEqual({
      type: 'task_execution',
      executionMode: 'background',
      totalTokens: 500,
    });
  });

  it('rejects an unknown executionMode literal from task_execution rawOutput', () => {
    // Only the two known literals may flow through as authoritative; any
    // other value (corrupted recording, future runtime mode) must fall back
    // to the compatibility heuristic instead of forcing a classification.
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: work',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
        rawOutput: { type: 'task_execution', executionMode: 'detached' },
      }),
    ]);

    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool?.executionMode).toBeUndefined();
    expect(tool?.rawOutput).toEqual({
      type: 'task_execution',
      executionMode: 'detached',
    });
  });

  it('accepts the foreground executionMode literal over the frozen heuristic', () => {
    // Shaped as a downgraded nested agent's block in the child session's
    // transcript: top-level-shaped (no parentToolCallId) with an empty arg
    // object. Without the authoritative literal, the frozen compatibility
    // heuristic's defaultsToBackground branch would classify exactly this
    // block background and hide the inline result — the literal must win so
    // the downgrade direction stays pinned end-to-end.
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: work',
        toolName: 'agent',
        rawInput: {},
        rawOutput: { type: 'task_execution', executionMode: 'foreground' },
      }),
    ]);

    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool?.executionMode).toBe('foreground');
    expect(tool?.status).toBe('in_progress');
  });

  it('does not merge assistant across error block', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'analyzing...', 1),
      {
        id: 'err-1',
        kind: 'error' as const,
        text: 'Connection lost',
        clientReceivedAt: 2,
        createdAt: 2,
        updatedAt: 2,
      },
      textBlock('a2', 'assistant', 'recovered', 3),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'analyzing...',
    });
    expect(messages[1]).toMatchObject({
      role: 'system',
      content: 'Connection lost',
      variant: 'error',
    });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'recovered',
    });
  });

  it('does not merge assistant across plan status block', () => {
    const plan = {
      sessionUpdate: 'plan',
      entries: [{ content: 'Step 1', status: 'in_progress' }],
    };
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'let me plan', 1),
      statusBlock('plan-1', `plan: ${JSON.stringify(plan)}`, 2),
      textBlock('a2', 'assistant', 'executing', 3),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'let me plan',
    });
    expect(messages[1]).toMatchObject({ role: 'plan' });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'executing',
    });
  });

  it('does not merge assistant across system status block', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'working...', 1),
      statusBlock('st1', 'Model switched to opus', 2),
      textBlock('a2', 'assistant', 'continuing', 3),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'working...',
    });
    expect(messages[1]).toMatchObject({
      role: 'system',
      content: 'Model switched to opus',
    });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: 'continuing',
    });
  });

  it('does not merge assistant across standalone shell block', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'before shell', 1),
      textBlock('u1', 'user', '! ls', 2),
      shellBlock('sh1', 'file.ts\n', 3),
      textBlock('a2', 'assistant', 'after shell', 4),
    ]);

    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs).toHaveLength(2);
    expect(assistantMsgs[0]).toMatchObject({ content: 'before shell' });
    expect(assistantMsgs[1]).toMatchObject({ content: 'after shell' });
  });

  it('failed subAgent keeps parented content and allows assistant to return to main thread', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: investigate',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      textBlock('sub-a1', 'assistant', 'Looking into it', 15, false, {
        parentToolCallId: 'agent-1',
      }),
      toolBlock('agent-end', 'agent-1', 'failed', 20, {
        title: 'Agent: investigate',
        toolName: 'agent',
        rawOutput: { error: 'Context limit exceeded' },
        updatedAt: 25,
      }),
      textBlock('a1', 'assistant', 'The agent failed, let me try directly', 30),
    ]);

    expect(messages).toHaveLength(2);
    const agentTool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agentTool?.status).toBe('failed');
    expect(agentTool?.endTime).toBe(25);
    expect(agentTool?.subContent).toBe('Looking into it');
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'The agent failed, let me try directly',
    });
  });

  it('status mapping covers running, pending, failed, and canceled (alternate spelling)', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'running', 1, { toolName: 'Bash' }),
      toolBlock('t2', 'tc2', 'pending', 2, { toolName: 'Read' }),
      toolBlock('t3', 'tc3', 'failed', 3, { toolName: 'Edit' }),
      toolBlock('t4', 'tc4', 'canceled', 4, {
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
        updatedAt: 5,
      }),
    ]);

    // tc1-tc3 are adjacent regular tools and share one group; the trailing
    // subagent call stays in its own single-tool group.
    expect(messages).toHaveLength(2);
    const tools =
      messages[0].role === 'tool_group' ? messages[0].tools : undefined;
    const tool4 =
      messages[1].role === 'tool_group' ? messages[1].tools[0] : undefined;
    expect(tools?.[0]?.status).toBe('in_progress');
    expect(tools?.[1]?.status).toBe('pending');
    expect(tools?.[2]?.status).toBe('failed');
    expect(tool4?.status).toBe('completed');
    expect(tool4?.endTime).toBe(5);
  });

  it('parented blocks after completed subAgent remain nested', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-1', 'call-1', 'completed', 10, {
        title: 'Agent: fast',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
        rawOutput: { type: 'task_execution' },
        updatedAt: 30,
      }),
      textBlock('a1', 'assistant', 'inside agent', 25, false, {
        parentToolCallId: 'call-1',
      }),
      textBlock('a2', 'assistant', 'after agent', 35),
    ]);

    expect(messages).toHaveLength(2);
    const agentTool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agentTool?.subContent).toBe('inside agent');
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'after agent',
    });
  });

  it('identifies subAgent by toolName task and rawOutput.type task_execution', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('task-start', 'task-1', 'in_progress', 10, {
        title: 'Task: build',
        toolName: 'task',
      }),
      textBlock('sub-text', 'assistant', 'Building...', 15, false, {
        parentToolCallId: 'task-1',
      }),
      toolBlock('sub-tool', 'sub-tc', 'completed', 20, {
        toolName: 'Bash',
        parentToolCallId: 'task-1',
      }),
      toolBlock('task-end', 'task-1', 'completed', 30, {
        title: 'Task: build',
        toolName: 'task',
        rawOutput: { type: 'task_execution', result: 'Build passed' },
        updatedAt: 35,
      }),
    ]);

    expect(messages).toHaveLength(1);
    const taskTool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(taskTool?.toolName).toBe('task');
    expect(taskTool?.status).toBe('completed');
    expect(taskTool?.subContent).toBe('Building...');
    expect(taskTool?.subTools).toHaveLength(1);
    expect(taskTool?.subTools?.[0].callId).toBe('sub-tc');

    const taskExecByRawOutput = transcriptBlocksToDaemonMessages([
      toolBlock('exec-start', 'exec-1', 'in_progress', 10, {
        title: 'Custom Tool',
        toolName: 'my_runner',
        rawOutput: { type: 'task_execution' },
      }),
      textBlock('sub-text2', 'assistant', 'Running...', 15, false, {
        parentToolCallId: 'exec-1',
      }),
      toolBlock('exec-end', 'exec-1', 'completed', 20, {
        toolName: 'my_runner',
        rawOutput: { type: 'task_execution', result: 'done' },
        updatedAt: 25,
      }),
    ]);

    expect(taskExecByRawOutput).toHaveLength(1);
    const execTool =
      taskExecByRawOutput[0].role === 'tool_group'
        ? taskExecByRawOutput[0].tools[0]
        : undefined;
    expect(execTool?.subContent).toBe('Running...');
  });

  it('passes content but not locations or preview to DaemonMessageToolCall', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'tc1', 'completed', 1, {
        toolName: 'Edit',
        content: [
          {
            type: 'diff',
            path: '/path/file.ts',
            oldText: 'old',
            newText: 'new',
          },
        ] as DaemonToolTranscriptBlock['content'],
        locations: [{ file: '/path/file.ts', line: 10 }],
        preview: { kind: 'generic', summary: 'Edit file.ts' },
      }),
    ]);

    const tool =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(tool).toBeDefined();
    expect(tool?.callId).toBe('tc1');
    expect(tool?.content).toEqual([
      {
        type: 'diff',
        path: '/path/file.ts',
        oldText: 'old',
        newText: 'new',
      },
    ]);
    expect('locations' in tool!).toBe(false);
    expect('preview' in tool!).toBe(false);
  });

  it('Agent tool with confirming status (from permission_request) nests sub-tools via parentToolCallId', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'agent-call-1', 'confirming', 100, {
        toolName: 'Agent',
        title: 'Query website',
        rawInput: {
          description: 'Query website',
          prompt: 'fetch data',
          subagent_type: 'Explore',
        },
      }),
      toolBlock('t2', 'sub-tool-1', 'completed', 200, {
        toolName: 'web_fetch',
        title: 'Fetch page',
        parentToolCallId: 'agent-call-1',
        rawOutput: 'page content',
      }),
      toolBlock('t3', 'sub-tool-2', 'in_progress', 300, {
        toolName: 'web_fetch',
        title: 'Fetch another page',
        parentToolCallId: 'agent-call-1',
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('tool_group');
    const agent =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agent).toBeDefined();
    expect(agent!.callId).toBe('agent-call-1');
    expect(agent!.toolName).toBe('Agent');
    expect(agent!.status).toBe('pending');
    expect(agent!.subTools).toHaveLength(2);
    expect(agent!.subTools![0].callId).toBe('sub-tool-1');
    expect(agent!.subTools![1].callId).toBe('sub-tool-2');
  });

  it('two parallel Agents from permission_request each nest their own sub-tools', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'agent-1', 'confirming', 100, {
        toolName: 'Agent',
        title: 'Agent A',
        rawInput: { subagent_type: 'Explore', prompt: 'a' },
      }),
      toolBlock('t2', 'agent-2', 'confirming', 100, {
        toolName: 'Agent',
        title: 'Agent B',
        rawInput: { subagent_type: 'Explore', prompt: 'b' },
      }),
      toolBlock('t3', 'sub-a1', 'completed', 200, {
        toolName: 'web_fetch',
        parentToolCallId: 'agent-1',
        rawOutput: 'data-a',
      }),
      toolBlock('t4', 'sub-b1', 'completed', 200, {
        toolName: 'web_fetch',
        parentToolCallId: 'agent-2',
        rawOutput: 'data-b',
      }),
    ]);

    expect(messages).toHaveLength(2);
    const agentA =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    const agentB =
      messages[1].role === 'tool_group' ? messages[1].tools[0] : undefined;
    expect(agentA!.callId).toBe('agent-1');
    expect(agentA!.subTools).toHaveLength(1);
    expect(agentA!.subTools![0].callId).toBe('sub-a1');
    expect(agentB!.callId).toBe('agent-2');
    expect(agentB!.subTools).toHaveLength(1);
    expect(agentB!.subTools![0].callId).toBe('sub-b1');
  });

  it('nests parented text inside the matching parallel subagent', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'agent-1', 'running', 100, {
        toolName: 'Agent',
        title: 'Agent A',
        rawInput: { subagent_type: 'Explore', prompt: 'a' },
      }),
      toolBlock('t2', 'agent-2', 'running', 100, {
        toolName: 'Agent',
        title: 'Agent B',
        rawInput: { subagent_type: 'Security', prompt: 'b' },
      }),
      textBlock('th1', 'thought', 'A thinking. ', 150, false, {
        parentToolCallId: 'agent-1',
      }),
      textBlock('msg1', 'assistant', 'B answer. ', 160, false, {
        parentToolCallId: 'agent-2',
      }),
    ]);

    expect(messages).toHaveLength(2);
    const agentA =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    const agentB =
      messages[1].role === 'tool_group' ? messages[1].tools[0] : undefined;
    expect(agentA?.subContent).toBe('A thinking. ');
    expect(agentB?.subContent).toBe('B answer. ');
    expect(messages.find((message) => message.role === 'assistant')).toBe(
      undefined,
    );
  });

  it('nests parented shell tools inside the matching failed subagent', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-failed', 'agent-1', 'failed', 100, {
        toolName: 'agent',
        title: 'Agent: review PR',
        rawOutput: { type: 'task_execution', result: 'failed' },
      }),
      toolBlock('shell-child', 'shell-1', 'completed', 110, {
        toolName: 'run_shell_command',
        title: 'Shell: git diff',
        rawInput: {
          command: 'git diff FETCH_HEAD...HEAD',
          description: '获取 PR diff',
        },
        rawOutput: 'No such file or directory',
        parentToolCallId: 'agent-1',
      }),
    ]);

    expect(messages).toHaveLength(1);
    const agent =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agent?.callId).toBe('agent-1');
    expect(agent?.subTools).toHaveLength(1);
    expect(agent?.subTools?.[0]).toMatchObject({
      callId: 'shell-1',
      toolName: 'run_shell_command',
      rawOutput: 'No such file or directory',
    });
  });

  it('nests parented replay text after a completed subagent update', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'agent-1', 'completed', 100, {
        toolName: 'Agent',
        title: 'Agent A',
        rawInput: { subagent_type: 'Explore', prompt: 'a' },
        rawOutput: { type: 'task_execution', result: 'done' },
        updatedAt: 120,
      }),
      textBlock('th1', 'thought', 'late parented thought', 150, false, {
        parentToolCallId: 'agent-1',
      }),
    ]);

    expect(messages).toHaveLength(1);
    const agent =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    expect(agent?.subContent).toBe('late parented thought');
  });

  it('keeps unparented thought text in the main transcript', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('t1', 'agent-1', 'running', 100, {
        toolName: 'Agent',
        title: 'Agent A',
        rawInput: { subagent_type: 'Explore', prompt: 'a' },
      }),
      toolBlock('t2', 'agent-2', 'running', 100, {
        toolName: 'Agent',
        title: 'Agent B',
        rawInput: { subagent_type: 'Security', prompt: 'b' },
      }),
      textBlock('th1', 'thought', 'I need to review the PR diff.', 150),
    ]);

    expect(messages).toHaveLength(3);
    const thinking = messages.find((message) => message.role === 'thinking');
    expect(thinking).toMatchObject({
      content: 'I need to review the PR diff.',
    });
    const agentA =
      messages[0].role === 'tool_group' ? messages[0].tools[0] : undefined;
    const agentB =
      messages[1].role === 'tool_group' ? messages[1].tools[0] : undefined;
    expect(agentA!.subContent).toBeUndefined();
    expect(agentB!.subContent).toBeUndefined();
  });
});
