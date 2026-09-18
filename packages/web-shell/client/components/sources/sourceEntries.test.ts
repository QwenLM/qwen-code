import { describe, expect, it } from 'vitest';
import type {
  DaemonSessionAttachmentReference,
  SessionSource,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall, Message } from '../../adapters/types';
import { getSourceEntries, getSourcesByTurn, sourceKey } from './sourceEntries';

const cwd = '/workspace';
const link: SessionSource = {
  id: 'a'.repeat(64),
  kind: 'link',
  title: 'Web guide',
  locator: { type: 'url', url: 'https://example.com/guide' },
  createdAt: '2025-01-01',
  updatedAt: '2025-01-01',
};
const file: SessionSource = {
  ...link,
  id: 'b'.repeat(64),
  kind: 'file',
  title: 'Guide file',
  locator: { type: 'workspace_file', workspacePath: 'docs/guide.md' },
  workspaceCwd: cwd,
};
const attachment: DaemonSessionAttachmentReference = {
  attachmentId: 'photo.png',
  type: 'image',
  mimeType: 'image/png',
  size: 1,
};
const user = (id: string): Message => ({
  role: 'user',
  id,
  content: 'Question.',
});
function record(
  source: SessionSource,
  options: Partial<ACPToolCall> = {},
): Message {
  return {
    role: 'tool_group',
    id: `tools-${source.id}`,
    tools: [
      {
        callId: 'call',
        toolName: 'record_source',
        status: 'completed',
        args: { title: source.title, locator: source.locator },
        rawOutput: `Reference added: ${source.id}`,
        ...options,
      },
    ],
  };
}
const ids = (
  map: ReadonlyMap<
    string,
    readonly ReturnType<typeof getSourceEntries>[number][]
  >,
  turn: string,
) => map.get(turn)?.map(sourceKey) ?? [];

describe('turn source associations', () => {
  it('counts explicitly reused sources in every turn, in panel order, without relying on timestamps', () => {
    const entries = getSourceEntries([link, file], []);
    const map = getSourcesByTurn(
      [
        user('one'),
        record(file),
        record(link),
        record(link),
        user('two'),
        record(link),
      ],
      entries,
      cwd,
      'session',
    );
    expect(ids(map, 'one')).toEqual([link.id, file.id]);
    expect(ids(map, 'two')).toEqual([link.id]);
    expect(link.updatedAt).toBe('2025-01-01');
  });

  it('never counts a footnote, a bare link or an unassociated panel entry', () => {
    const map = getSourcesByTurn(
      [
        user('one'),
        {
          role: 'assistant',
          id: 'answer',
          content:
            'See [guide](https://example.com/guide)[^1].\n\n[^1]: A note.',
        },
      ],
      getSourceEntries([link, file], []),
      cwd,
      'session',
    );
    expect(ids(map, 'one')).toEqual([]);
  });

  it.each(['pending', 'in_progress', 'failed'] as const)(
    'excludes %s tool registrations',
    (status) => {
      expect(
        ids(
          getSourcesByTurn(
            [user('one'), record(link, { status })],
            getSourceEntries([link], []),
            cwd,
            'session',
          ),
          'one',
        ),
      ).toEqual([]);
    },
  );

  it('excludes cancelled, nested and unrelated tools and records without a loaded turn', () => {
    const tools = [
      record(link),
      user('one'),
      record(link, { wasCancelled: true }),
      record(link, { parentToolCallId: 'agent' }),
      record(link, { toolName: 'web_search' }),
    ];
    expect(
      ids(
        getSourcesByTurn(tools, getSourceEntries([link], []), cwd, 'session'),
        'one',
      ),
    ).toEqual([]);
  });

  it('intersects old records with the current panel and never reconstructs deleted sources', () => {
    expect(
      ids(
        getSourcesByTurn(
          [user('one'), record(link)],
          getSourceEntries([file], []),
          cwd,
          'session',
        ),
        'one',
      ),
    ).toEqual([]);
  });

  it('falls back to normalized locators for forked IDs with matching workspace authority', () => {
    const copied = { ...file, id: 'c'.repeat(64) };
    const messages = [
      user('one'),
      record(file, {
        args: {
          locator: {
            type: 'workspace_file',
            workspacePath: 'docs/./extra/../guide.md',
          },
        },
      }),
    ];
    expect(
      ids(
        getSourcesByTurn(messages, getSourceEntries([copied], []), cwd, 'fork'),
        'one',
      ),
    ).toEqual([copied.id]);
    expect(
      ids(
        getSourcesByTurn(
          messages,
          getSourceEntries([copied], []),
          '/other',
          'fork',
        ),
        'one',
      ),
    ).toEqual([]);
    expect(
      ids(
        getSourcesByTurn(
          messages,
          getSourceEntries([copied], []),
          undefined,
          'fork',
        ),
        'one',
      ),
    ).toEqual([]);
  });

  it('normalizes URL locators without stripping anchors or merging distinct locations', () => {
    const copy = { ...link, id: 'd'.repeat(64) };
    const messages = [
      user('one'),
      record(link, {
        rawOutput: undefined,
        args: {
          locator: { type: 'url', url: 'https://EXAMPLE.com:443/guide' },
        },
      }),
    ];
    expect(
      ids(
        getSourcesByTurn(messages, getSourceEntries([copy], []), cwd, 'fork'),
        'one',
      ),
    ).toEqual([copy.id]);
    expect(
      ids(
        getSourcesByTurn(
          messages,
          getSourceEntries(
            [
              {
                ...copy,
                locator: {
                  type: 'url',
                  url: 'https://example.com/guide#other',
                },
              },
            ],
            [],
          ),
          cwd,
          'fork',
        ),
        'one',
      ),
    ).toEqual([]);
  });

  it('uses the same registered/attachment fallback deduplication as the Sources panel', () => {
    const registered: SessionSource = {
      ...file,
      locator: { type: 'attachment', attachmentId: attachment.attachmentId },
    };
    const orphan = { ...attachment, attachmentId: 'other.png' };
    const entries = getSourceEntries(
      [registered],
      [attachment, attachment, orphan],
    );
    expect(entries).toHaveLength(2);
    const messages: Message[] = [
      {
        ...user('one'),
        role: 'user',
        images: [
          {
            data: '',
            mimeType: 'image/png',
            attachmentId: attachment.attachmentId,
          },
          { data: '', mimeType: 'image/png', attachmentId: 'other.png' },
          { data: '', mimeType: 'image/png', attachmentId: 'unknown.png' },
        ],
      },
    ];
    expect(
      ids(getSourcesByTurn(messages, entries, cwd, 'session'), 'one'),
    ).toEqual([registered.id, 'attachment:other.png']);
  });

  it('accepts host references only for the specified session, loaded turn and existing source', () => {
    const map = getSourcesByTurn(
      [user('one'), user('two')],
      getSourceEntries([link, file], []),
      cwd,
      'session',
      [
        { sessionId: 'session', turnId: 'one', sourceId: link.id },
        { sessionId: 'session', turnId: 'one', sourceId: link.id },
        { sessionId: 'other', turnId: 'two', sourceId: file.id },
        { sessionId: 'session', turnId: 'unloaded', sourceId: file.id },
        { sessionId: 'session', turnId: 'two', sourceId: 'deleted' },
      ],
    );
    expect(ids(map, 'one')).toEqual([link.id]);
    expect(ids(map, 'two')).toEqual([]);
    expect(map.has('unloaded')).toBe(false);
  });
});
