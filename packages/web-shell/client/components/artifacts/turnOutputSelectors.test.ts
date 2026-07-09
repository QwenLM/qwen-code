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
    expect(changes?.[0]?.diffs).toHaveLength(2);
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
});
