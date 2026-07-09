import { describe, expect, it } from 'vitest';
import {
  getArtifactsByTurn,
  getFileChangesByTurn,
  getScheduledTasksByTurn,
} from './turnOutputSelectors';
import type { ACPToolCall, Message } from '../../adapters/types';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';

type ToolGroupMessage = Extract<Message, { role: 'tool_group' }>;

function userMessage(id: string, content: string): Message {
  return { id, role: 'user', content };
}

function toolGroup(id: string, tools: ACPToolCall[]): ToolGroupMessage {
  return { id, role: 'tool_group', tools };
}

describe('turnOutputSelectors', () => {
  it('groups artifacts by the turn that recorded them', () => {
    const messages = [
      userMessage('u1', 'make report'),
      toolGroup('tg1', [
        {
          callId: 'call-1',
          toolName: 'record_artifact',
          status: 'completed',
          args: { workspacePath: 'reports/a.html' },
        },
      ]),
    ];
    const artifacts = [
      {
        id: 'artifact-1',
        title: 'Report',
        workspacePath: 'reports/a.html',
      },
    ] as DaemonSessionArtifact[];

    expect(getArtifactsByTurn(messages, artifacts).get('u1')).toEqual(
      artifacts,
    );
  });

  it('merges multiple edits for the same file in one turn', () => {
    const messages = [
      userMessage('u1', 'edit file'),
      toolGroup('tg1', [
        {
          callId: 'edit-1',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/app.ts' },
          rawOutput: {
            originalContent: 'one\n',
            newContent: 'one\ntwo\n',
            diffStat: { model_added_lines: 1, model_removed_lines: 0 },
          },
        },
        {
          callId: 'edit-2',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/app.ts' },
          rawOutput: {
            originalContent: 'one\ntwo\n',
            newContent: 'one\ntwo\nthree\n',
            diffStat: { model_added_lines: 1, model_removed_lines: 0 },
          },
        },
      ]),
    ];

    const changes = getFileChangesByTurn(messages, new Map()).get('u1');
    expect(changes).toHaveLength(1);
    expect(changes?.[0]).toMatchObject({
      path: 'src/app.ts',
      additions: 2,
      deletions: 0,
    });
    expect(changes?.[0]?.diffs).toEqual([
      {
        oldText: 'one\n',
        newText: 'one\ntwo\nthree\n',
        fullContent: true,
      },
    ]);
  });

  it('uses final full-content diff stats for repeated edits', () => {
    const messages = [
      userMessage('u1', 'edit file twice'),
      toolGroup('tg1', [
        {
          callId: 'edit-1',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/app.ts' },
          rawOutput: {
            originalContent: 'one\n',
            newContent: 'one\ntwo\n',
            diffStat: { model_added_lines: 1, model_removed_lines: 0 },
          },
        },
        {
          callId: 'edit-2',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/app.ts' },
          rawOutput: {
            originalContent: 'one\ntwo\n',
            newContent: 'one\n',
            diffStat: { model_added_lines: 0, model_removed_lines: 1 },
          },
        },
      ]),
    ];

    const change = getFileChangesByTurn(messages, new Map()).get('u1')?.[0];
    expect(change).toMatchObject({
      additions: 0,
      deletions: 0,
    });
    expect(change?.diffs).toEqual([
      {
        oldText: 'one\n',
        newText: 'one\n',
        fullContent: true,
      },
    ]);
  });

  it('omits stats for repeated partial diffs without full content', () => {
    const messages = [
      userMessage('u1', 'edit file twice'),
      toolGroup('tg1', [
        {
          callId: 'edit-1',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/app.ts' },
          content: [{ type: 'diff', oldText: 'one\n', newText: 'one\ntwo\n' }],
        },
        {
          callId: 'edit-2',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/app.ts' },
          content: [{ type: 'diff', oldText: 'one\ntwo\n', newText: 'one\n' }],
        },
      ]),
    ];

    const change = getFileChangesByTurn(messages, new Map()).get('u1')?.[0];
    expect(change?.additions).toBeUndefined();
    expect(change?.deletions).toBeUndefined();
    expect(change?.diffs).toEqual([
      { oldText: 'one\n', newText: 'one\ntwo\n' },
      { oldText: 'one\ntwo\n', newText: 'one\n' },
    ]);
  });

  it('keeps partial diffs after a full-content diff', () => {
    const messages = [
      userMessage('u1', 'write then edit file'),
      toolGroup('tg1', [
        {
          callId: 'write-1',
          toolName: 'write_file',
          status: 'completed',
          args: { file_path: 'src/app.ts', content: 'one\n' },
        },
        {
          callId: 'edit-1',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/app.ts' },
          content: [{ type: 'diff', oldText: 'one\n', newText: 'two\n' }],
        },
      ]),
    ];

    const change = getFileChangesByTurn(messages, new Map()).get('u1')?.[0];
    expect(change?.additions).toBeUndefined();
    expect(change?.deletions).toBeUndefined();
    expect(change?.diffs).toEqual([
      { oldText: '', newText: 'one\n', fullContent: true },
      { oldText: 'one\n', newText: 'two\n' },
    ]);
  });

  it('omits stats for large full-content diffs', () => {
    const oldContent = Array.from({ length: 1001 }, (_, index) => `${index}`)
      .join('\n')
      .concat('\n');
    const newContent = Array.from({ length: 1001 }, (_, index) => `${index}x`)
      .join('\n')
      .concat('\n');
    const messages = [
      userMessage('u1', 'edit large file'),
      toolGroup('tg1', [
        {
          callId: 'edit-1',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/app.ts' },
          rawOutput: {
            originalContent: oldContent,
            newContent,
          },
        },
      ]),
    ];

    const change = getFileChangesByTurn(messages, new Map()).get('u1')?.[0];
    expect(change?.additions).toBeUndefined();
    expect(change?.deletions).toBeUndefined();
    expect(change?.diffs).toEqual([
      { oldText: oldContent, newText: newContent, fullContent: true },
    ]);
  });

  it('omits stats for unrelated partial diffs', () => {
    const messages = [
      userMessage('u1', 'edit file twice'),
      toolGroup('tg1', [
        {
          callId: 'edit-1',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/app.ts' },
          content: [{ type: 'diff', oldText: 'one\n', newText: 'two\n' }],
        },
        {
          callId: 'edit-2',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/app.ts' },
          content: [{ type: 'diff', oldText: 'three\n', newText: 'four\n' }],
        },
      ]),
    ];

    const change = getFileChangesByTurn(messages, new Map()).get('u1')?.[0];
    expect(change?.additions).toBeUndefined();
    expect(change?.deletions).toBeUndefined();
    expect(change?.diffs).toEqual([
      { oldText: 'one\n', newText: 'two\n' },
      { oldText: 'three\n', newText: 'four\n' },
    ]);
  });

  it('does not match two different relative paths by suffix', () => {
    const messages = [
      userMessage('u1', 'edit file'),
      toolGroup('tg1', [
        {
          callId: 'edit-1',
          toolName: 'edit',
          status: 'completed',
          args: { file_path: 'src/a/b/c.ts' },
          rawOutput: { diffStat: { model_added_lines: 1 } },
        },
      ]),
    ];
    const artifactsByTurn = new Map([
      [
        'u1',
        [
          { id: 'a1', workspacePath: 'evil/a/b/c.ts' },
        ] as DaemonSessionArtifact[],
      ],
    ]);

    const change = getFileChangesByTurn(messages, artifactsByTurn).get(
      'u1',
    )?.[0];
    expect(change?.isArtifact).toBe(false);
  });

  it('extracts write_file changes from args content', () => {
    const messages = [
      userMessage('u1', 'write file'),
      toolGroup('tg1', [
        {
          callId: 'write-1',
          toolName: 'write_file',
          status: 'completed',
          args: {
            file_path: 'src/generated.ts',
            content: 'export const value = 1;\nconsole.log(value);\n',
          },
        },
      ]),
    ];

    const change = getFileChangesByTurn(messages, new Map()).get('u1')?.[0];
    expect(change).toMatchObject({
      path: 'src/generated.ts',
      status: 'created',
      additions: 2,
      deletions: 0,
    });
    expect(change?.diffs).toEqual([
      {
        oldText: '',
        newText: 'export const value = 1;\nconsole.log(value);\n',
        fullContent: true,
      },
    ]);
  });

  it('extracts completed cron_create tasks', () => {
    const messages = [
      userMessage('u1', 'schedule'),
      toolGroup('tg1', [
        {
          callId: 'cron-call',
          toolName: 'cron_create',
          status: 'completed',
          args: { cron: '0 9 * * *', prompt: 'standup', recurring: true },
          rawOutput: {
            llmContent: 'Scheduled recurring job cron_123 (0 9 * * *).',
          },
        },
      ]),
    ];

    expect(getScheduledTasksByTurn(messages).get('u1')?.[0]).toMatchObject({
      id: 'cron_123',
      title: 'standup',
    });
  });

  it('ignores unrelated scheduled output', () => {
    const messages = [
      userMessage('u1', 'schedule'),
      toolGroup('tg1', [
        {
          callId: 'cron-call',
          toolName: 'cron_create',
          status: 'completed',
          args: { cron: '0 9 * * *', prompt: 'standup', recurring: true },
          rawOutput: {
            llmContent: 'Scheduled cleanup completed.',
          },
        },
      ]),
    ];

    expect(getScheduledTasksByTurn(messages).get('u1')?.[0]).toMatchObject({
      id: 'cron-call',
      title: 'standup',
    });
  });
});
