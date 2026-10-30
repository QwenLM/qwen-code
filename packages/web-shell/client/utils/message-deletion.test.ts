import { describe, expect, it } from 'vitest';
import {
  createDaemonTranscriptStore,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import type { Message } from '../adapters/types';
import {
  messageDeletionGroups,
  restoreLocalDeletionBlocks,
  removeDeletedMessageBlocks,
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

  it('matches prompt-only live anchors with record-backed replay anchors', () => {
    const local = block('local', 'local-command:stats');
    const store = createDaemonTranscriptStore({
      blocks: [{ ...block('replay', 'p'), sourceRecordIds: ['record-p'] }],
    });
    restoreLocalDeletionBlocks(store, [local, block('live', 'p')]);
    expect(store.getSnapshot().blocks.map((item) => item.id)).toEqual([
      'local',
      'replay',
    ]);
  });

  it('uses current order when a failed reload cache has no surviving anchors', () => {
    const local = block('local', 'local-command:stats');
    const store = createDaemonTranscriptStore();
    restoreLocalDeletionBlocks(store, [
      block('old-a', 'old-a'),
      local,
      block('old-b', 'old-b'),
    ]);
    store.reset({ blocks: [block('new-a', 'new-a'), block('new-b', 'new-b')] });
    restoreLocalDeletionBlocks(store, [
      local,
      block('live-a', 'new-a'),
      block('live-b', 'new-b'),
    ]);
    expect(store.getSnapshot().blocks.map((item) => item.id)).toEqual([
      'local',
      'new-a',
      'new-b',
    ]);
  });

  it.each([
    { kind: 'user', type: 'user.text.delta', field: 'activeUserBlockId' },
    {
      kind: 'assistant',
      type: 'assistant.text.delta',
      field: 'activeAssistantBlockId',
    },
    {
      kind: 'thought',
      type: 'thought.text.delta',
      field: 'activeThoughtBlockId',
    },
  ] as const)(
    'preserves the surviving streaming $kind anchor',
    ({ kind, type, field }) => {
      const store = createDaemonTranscriptStore();
      store.dispatch([
        { type: 'user.text.delta', promptId: 'old', text: 'old' },
      ]);
      store.dispatch([
        { type: 'user.text.delta', promptId: 'live', text: 'live' },
      ]);
      store.dispatch([{ type, promptId: 'live', text: 'first' }]);
      const active = store.getSnapshot()[field];
      expect(active).toBeDefined();
      removeDeletedMessageBlocks(store, [], ['old']);
      expect(store.getSnapshot()[field]).toBe(active);
      store.dispatch([{ type, promptId: 'live', text: 'next' }]);
      expect(
        store.getSnapshot().blocks.filter((item) => item.kind === kind),
      ).toHaveLength(1);
      removeDeletedMessageBlocks(store, [], ['live']);
      expect(store.getSnapshot()[field]).toBeUndefined();
    },
  );

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

  it('keeps local blocks after the replay head when live tail identities change', () => {
    const head = {
      ...block('head', 'old'),
      promptId: undefined,
      sourceRecordIds: ['r1'],
    };
    const local = block('local', 'local-command:stats');
    const store = createDaemonTranscriptStore({
      blocks: [
        head,
        {
          ...block('tail-replay', 'new'),
          promptId: undefined,
          sourceRecordIds: ['r2'],
        },
      ],
    });
    restoreLocalDeletionBlocks(store, [head, local, block('tail-live', 'p2')]);
    expect(store.getSnapshot().blocks.map((item) => item.id)).toEqual([
      'head',
      'local',
      'tail-replay',
    ]);
  });

  it('prunes confirmed deletion immediately while retaining other turns and local commands', () => {
    const local = {
      ...block('echo', ''),
      promptId: undefined,
      meta: { localCommandId: 'local-command:extension' },
    };
    const first = {
      ...block('first', ''),
      promptId: undefined,
      sourceRecordIds: ['r1'],
    };
    const firstReply = {
      ...block('answer', ''),
      kind: 'assistant' as const,
      promptId: undefined,
      sourceRecordIds: ['r1-answer'],
    };
    const next = {
      ...block('next', ''),
      promptId: undefined,
      sourceRecordIds: ['r2'],
    };
    const store = createDaemonTranscriptStore({
      blocks: [
        first,
        local,
        firstReply,
        {
          ...block('notice', ''),
          kind: 'status',
          promptId: undefined,
          source: 'background_notification',
          sourceRecordIds: ['notice-record'],
        },
        next,
        block('answer2', 'p2'),
      ],
    });
    removeDeletedMessageBlocks(store, ['r1'], ['p1']);
    expect(store.getSnapshot().blocks.map((item) => item.id)).toEqual([
      'echo',
      'notice',
      'next',
      'answer2',
    ]);
    restoreLocalDeletionBlocks(store, store.getSnapshot().blocks);
    expect(store.getSnapshot().blocks.map((item) => item.id)).toEqual([
      'echo',
      'notice',
      'next',
      'answer2',
    ]);
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
    restoreLocalDeletionBlocks(store, afterFailure);
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
