import { describe, expect, it } from 'vitest';
import {
  createDaemonTranscriptStore,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import type { Message } from '../adapters/types';
import {
  messageDeletionGroups,
  restoreLocalDeletionBlocks,
} from './message-deletion';

const groups = [
  {
    id: 'a',
    promptId: 'pa',
    promptIds: ['pa', 'pa-retry'],
    recordIds: ['ra', 'ra-answer'],
  },
  { id: 'b', promptId: 'pb', recordIds: ['rb'] },
];

describe('message deletion identity', () => {
  it('links thought, tools, split replies and continuation aliases to one prompt', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'question', promptId: 'pa' },
      { id: 't', role: 'thinking', content: 'thinking' },
      { id: 'tools', role: 'tool_group', tools: [] },
      { id: 'answer', role: 'assistant', content: 'answer', promptId: 'pa' },
      {
        id: 'retry',
        role: 'assistant',
        content: 'continued',
        promptId: 'pa-retry',
      },
    ];
    expect([...messageDeletionGroups(messages, groups).values()]).toEqual(
      Array(5).fill('a'),
    );
  });

  it('maps replayed records without transport prompt IDs', () => {
    expect([
      ...messageDeletionGroups(
        [
          {
            id: 'u',
            role: 'user',
            content: 'question',
            sourceRecordIds: ['ra'],
          },
          {
            id: 'a',
            role: 'assistant',
            content: 'answer',
            sourceRecordIds: ['ra-answer'],
          },
        ],
        groups,
      ).values(),
    ]).toEqual(['a', 'a']);
  });

  it('does not attach unknown prompts to the preceding group', () => {
    const result = messageDeletionGroups(
      [
        { id: 'u', role: 'user', content: 'question', promptId: 'pa' },
        { id: 'unknown', role: 'user', content: 'unmapped' },
        { id: 'unknown-answer', role: 'assistant', content: 'answer' },
      ],
      groups,
    );
    expect([...result.entries()]).toEqual([['u', 'a']]);
  });

  it('uses explicit local execution identity when asynchronous results interleave', () => {
    const messages: Message[] = [
      {
        id: 's',
        role: 'user',
        content: '/stats',
        localCommandId: 'local-command:s',
      },
      {
        id: 'c',
        role: 'user',
        content: '/context',
        localCommandId: 'local-command:c',
      },
      {
        id: 'sr',
        role: 'system',
        content: 'stats',
        variant: 'info',
        localCommandId: 'local-command:s',
      },
      {
        id: 'cr',
        role: 'system',
        content: 'context',
        variant: 'info',
        localCommandId: 'local-command:c',
      },
    ];
    expect([...messageDeletionGroups(messages, []).values()]).toEqual([
      'local-command:s',
      'local-command:c',
      'local-command:s',
      'local-command:c',
    ]);
  });
});

describe('local history restoration', () => {
  const block = (id: string, promptId: string): DaemonTranscriptBlock => ({
    id,
    kind: 'user',
    text: promptId,
    promptId,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  it('keeps local blocks between surviving prompts and preserves IDs on replay collisions', () => {
    const local = block('user-2', 'local-command:tools');
    const before = [
      block('user-1', 'A'),
      local,
      block('user-3', 'B'),
      block('user-4', 'C'),
    ];
    const store = createDaemonTranscriptStore({
      blocks: [block('user-1', 'A'), block('user-2', 'B')],
    });
    restoreLocalDeletionBlocks(store, before);
    expect(store.getSnapshot().blocks.map((item) => item.promptId)).toEqual([
      'A',
      'local-command:tools',
      'B',
    ]);
    expect(store.getSnapshot().blocks[1]!.id).toBe(local.id);
    expect(
      new Set(store.getSnapshot().blocks.map((item) => item.id)).size,
    ).toBe(3);
    restoreLocalDeletionBlocks(store, before);
    expect(store.getSnapshot().blocks).toHaveLength(3);
  });

  it('retains local messages when reload fails without any server blocks', () => {
    const local = block('local', 'local-command:tools');
    const store = createDaemonTranscriptStore();
    restoreLocalDeletionBlocks(store, [
      block('before', 'A'),
      local,
      block('after', 'B'),
    ]);
    expect(store.getSnapshot().blocks).toEqual([local]);
    const afterFailure = store.getSnapshot().blocks;
    store.reset({
      blocks: [block('new-before', 'A'), block('new-after', 'B')],
    });
    restoreLocalDeletionBlocks(store, afterFailure);
    expect(store.getSnapshot().blocks.map((item) => item.promptId)).toEqual([
      'A',
      'local-command:tools',
      'B',
    ]);
  });
});

it('keeps a local read-only result from taking ownership of subsequent model output', () => {
  const messages: Message[] = [
    { id: 'u', role: 'user', content: 'question', promptId: 'pa' },
    {
      id: 'local-echo',
      role: 'user',
      content: '/stats',
      localCommandId: 'local-command:stats',
    },
    {
      id: 'status',
      role: 'system',
      variant: 'info',
      content: 'stats',
      localCommandId: 'local-command:stats',
    },
    { id: 'tools', role: 'tool_group', tools: [] },
    { id: 'reply', role: 'assistant', content: 'reply' },
  ];
  const map = messageDeletionGroups(messages, groups);
  expect(map.get('status')).toBe('local-command:stats');
  expect(map.get('tools')).toBe('a');
  expect(map.get('reply')).toBe('a');
});
