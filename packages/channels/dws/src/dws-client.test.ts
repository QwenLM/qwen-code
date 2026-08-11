/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DwsClient,
  parseDwsImEvent,
  type DwsCommandRunner,
} from './dws-client.js';
import type {
  DwsEventProcessStarter,
  DwsEventSubscription,
} from './dws-event-stream.js';

function json(value: unknown): string {
  return JSON.stringify(value);
}

function subscription(): DwsEventSubscription {
  return { stop: vi.fn(), closed: new Promise(() => undefined) };
}

describe('DwsClient', () => {
  it('checks the selected profile for both DWS user identities', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({
        authenticated: true,
        userId: 'user-1',
        openDingTalkId: 'open-user-1',
      }),
      stderr: '',
    });
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:user' },
      runner,
    );

    await expect(client.assertAuthenticated()).resolves.toEqual({
      userId: 'user-1',
      openDingTalkId: 'open-user-1',
    });
    expect(runner).toHaveBeenCalledWith('/opt/dws', [
      '--profile',
      'corp:user',
      'auth',
      'status',
      '--format',
      'json',
    ]);
  });

  it('rejects an unauthenticated DWS profile', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({ authenticated: false }),
      stderr: '',
    });
    const client = new DwsClient({ executable: 'dws' }, runner);

    await expect(client.assertAuthenticated()).rejects.toThrow(
      'DWS is not authenticated',
    );
  });

  it('normalizes the snake-case user identity returned by DWS', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({ authenticated: true, user_id: 'user-1' }),
      stderr: '',
    });
    const client = new DwsClient({ executable: 'dws' }, runner);

    await expect(client.assertAuthenticated()).resolves.toEqual({
      userId: 'user-1',
      openDingTalkId: undefined,
    });
  });

  it('subscribes to a selected group and normalizes compact events', async () => {
    let onLine!: (line: string) => void | Promise<void>;
    const eventStarter = vi.fn<DwsEventProcessStarter>(
      async (_executable, _args, lineHandler) => {
        onLine = lineHandler;
        return subscription();
      },
    );
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:user' },
      vi.fn(),
      eventStarter,
    );
    const onMessage = vi.fn();

    await client.subscribeToIm(
      { kind: 'group', conversationId: 'cid-1' },
      onMessage,
      vi.fn(),
    );
    await onLine(
      json({
        type: 'user_im_message_receive_group',
        event_id: 'event-1',
        message_id: 'message-1',
        conversation_id: 'cid-1',
        content: '{"content":"/qwen check this"}',
        sender_open_dingtalk_id: 'open-alice',
        sender: 'Alice',
      }),
    );

    expect(eventStarter).toHaveBeenCalledWith(
      '/opt/dws',
      [
        '--profile',
        'corp:user',
        'event',
        'consume',
        'user_im_message_receive_group',
        '--format',
        'compact',
        '--group',
        'cid-1',
      ],
      expect.any(Function),
      expect.any(Function),
    );
    expect(onMessage).toHaveBeenCalledWith({
      type: 'user_im_message_receive_group',
      eventId: 'event-1',
      messageId: 'message-1',
      conversationId: 'cid-1',
      content: '/qwen check this',
      senderId: 'open-alice',
      senderName: 'Alice',
    });
  });

  it('parses the NDJSON envelope emitted by the default event format', () => {
    expect(
      parseDwsImEvent(
        json({
          data: json({
            type: 'user_im_message_receive_at',
            message_id: 'message-1',
            conversation_id: 'cid-1',
            content: 'help me',
            sender_open_dingtalk_id: 'open-alice',
            sender: 'Alice',
          }),
        }),
      ),
    ).toMatchObject({
      type: 'user_im_message_receive_at',
      eventId: 'message-1',
      content: 'help me',
    });
  });

  it('extracts message identity from the nested DWS payload body', () => {
    expect(
      parseDwsImEvent(
        json({
          data: json({
            type: 'user_im_message_receive_group',
            event_id: 'event-1',
            payload: {
              body: {
                openMessageId: 'message-1',
                openConversationId: 'cid-1',
                content: '{"content":"/qwen check this"}',
                senderOpenDingTalkId: 'open-alice',
                sender: 'Alice',
              },
            },
          }),
        }),
      ),
    ).toEqual({
      type: 'user_im_message_receive_group',
      eventId: 'event-1',
      messageId: 'message-1',
      conversationId: 'cid-1',
      content: '/qwen check this',
      senderId: 'open-alice',
      senderName: 'Alice',
    });
  });

  it('uses DWS idempotency keys for message sends and replies', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({ success: true }),
      stderr: '',
    });
    const client = new DwsClient({ executable: '/opt/dws' }, runner);

    await client.sendImMessage(
      { kind: 'group', conversationId: 'cid-1' },
      'hello $(id)',
      'uuid-send',
    );
    await client.replyToImMessage(
      'cid-1',
      'message-1',
      'open-alice',
      'done',
      'uuid-reply',
    );

    expect(runner.mock.calls[0]).toEqual([
      '/opt/dws',
      [
        'chat',
        'message',
        'send',
        '--group',
        'cid-1',
        '--text',
        'hello $(id)',
        '--uuid',
        'uuid-send',
        '--format',
        'json',
      ],
    ]);
    expect(runner.mock.calls[1]?.[1]).toEqual([
      'chat',
      'message',
      'reply',
      '--conversation-id',
      'cid-1',
      '--ref-msg-id',
      'message-1',
      '--ref-sender',
      'open-alice',
      '--text',
      'done',
      '--uuid',
      'uuid-reply',
      '--format',
      'json',
    ]);
  });

  it('paginates unresolved comments and preserves root and reply identity', async () => {
    const runner = vi.fn<DwsCommandRunner>(async (_executable, args) => {
      if (args.includes('--cursor')) {
        return {
          stdout: json({
            result: {
              commentList: [
                {
                  commentKey: 'root-2',
                  content: '/qwen second',
                  creator: { userId: 'bob', name: 'Bob' },
                },
              ],
            },
          }),
          stderr: '',
        };
      }
      return {
        stdout: json({
          result: {
            commentList: [
              {
                commentKey: 'root-1',
                content: '/qwen first',
                mentionedUserIds: ['user-self'],
                selectedText: 'selected paragraph',
                creatorId: 'alice',
                creatorName: 'Alice',
                replies: [
                  {
                    commentKey: 'reply-1',
                    content: '/qwen follow up',
                    mentionedUserIds: ['user-other'],
                    author: { id: 'carol', name: 'Carol' },
                  },
                ],
              },
            ],
            nextToken: 'page-2',
          },
        }),
        stderr: '',
      };
    });
    const client = new DwsClient({ executable: 'dws' }, runner);

    const comments = await client.listUnresolvedComments('doc-1');

    expect(comments.map((item) => item.key)).toEqual(['root-1', 'root-2']);
    expect(comments[0]?.mentionedUserIds).toEqual(['user-self']);
    expect(comments[0]?.replies[0]).toMatchObject({
      key: 'reply-1',
      authorId: 'carol',
      mentionedUserIds: ['user-other'],
    });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1]?.[1]).toContain('page-2');
  });

  it('normalizes author identities from the current DWS comment response', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({
        success: true,
        result: {
          commentList: [
            {
              commentKey: 'comment-with-uid',
              content: '@Qwen review this',
              creatorUid: 'creator-uid',
              creatorStaffId: 'creator-staff-id',
              creatorName: 'Alice',
            },
            {
              commentKey: 'comment-with-creator-staff-id',
              content: '@Qwen use staff identity',
              creatorStaffId: 'creator-staff-id',
              creatorName: 'Bob',
            },
          ],
        },
      }),
      stderr: '',
    });
    const client = new DwsClient({ executable: 'dws' }, runner);

    const comments = await client.listUnresolvedComments('doc-1');

    expect(
      comments.map(({ key, authorId, authorName }) => ({
        key,
        authorId,
        authorName,
      })),
    ).toEqual([
      {
        key: 'comment-with-uid',
        authorId: 'creator-uid',
        authorName: 'Alice',
      },
      {
        key: 'comment-with-creator-staff-id',
        authorId: 'creator-staff-id',
        authorName: 'Bob',
      },
    ]);
  });

  it('falls back to the comment staff identity', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({
        result: {
          commentList: [
            {
              commentKey: 'comment-with-comment-staff-id',
              content: '@Qwen use comment identity',
              commentStaffId: 'comment-staff-id',
              creatorName: 'Carol',
            },
          ],
        },
      }),
      stderr: '',
    });
    const client = new DwsClient({ executable: 'dws' }, runner);

    await expect(client.listUnresolvedComments('doc-1')).resolves.toEqual([
      expect.objectContaining({
        authorId: 'comment-staff-id',
        authorName: 'Carol',
      }),
    ]);
  });

  it('rejects a comment response without a comment list', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({ success: true }),
      stderr: '',
    });
    const client = new DwsClient({ executable: 'dws' }, runner);

    await expect(client.listUnresolvedComments('doc-1')).rejects.toThrow(
      'did not contain a comment list',
    );
  });

  it('recursively discovers paginated documents in a knowledge base', async () => {
    const runner = vi.fn<DwsCommandRunner>(async (_executable, args) => {
      const folderIndex = args.indexOf('--folder');
      const folder = folderIndex < 0 ? undefined : args[folderIndex + 1];
      if (folder === 'folder-1') {
        return {
          stdout: json({
            nodes: [
              {
                nodeId: 'doc-nested',
                nodeType: 'file',
                contentType: 'ALIDOC',
                hasChildren: false,
              },
            ],
          }),
          stderr: '',
        };
      }
      if (args.includes('--cursor')) {
        return {
          stdout: json({
            nodes: [
              {
                nodeId: 'sheet-1',
                nodeType: 'file',
                extension: 'axls',
                hasChildren: false,
              },
            ],
          }),
          stderr: '',
        };
      }
      return {
        stdout: json({
          nodes: [
            {
              nodeId: 'doc-root',
              nodeType: 'file',
              extension: 'adoc',
              hasChildren: false,
            },
            {
              nodeId: 'folder-1',
              nodeType: 'folder',
              hasChildren: true,
            },
          ],
          nextPageToken: 'root-page-2',
        }),
        stderr: '',
      };
    });
    const client = new DwsClient({ executable: 'dws' }, runner);

    await expect(client.listWikiDocuments('wiki-1')).resolves.toEqual([
      'doc-root',
      'doc-nested',
    ]);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(runner.mock.calls[1]?.[1]).toContain('root-page-2');
    expect(runner.mock.calls[2]?.[1]).toContain('folder-1');
  });

  it('rejects a knowledge-base response without a node list', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({ success: true }),
      stderr: '',
    });
    const client = new DwsClient({ executable: 'dws' }, runner);

    await expect(client.listWikiDocuments('wiki-1')).rejects.toThrow(
      'did not contain a node list',
    );
  });

  it('reads document Markdown and replies without shell interpolation', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({ result: { data: { markdown: '# Decision' } } }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({ success: true }),
        stderr: '',
      });
    const client = new DwsClient({ executable: '/opt/dws' }, runner);

    await expect(client.readDocument('doc-1')).resolves.toBe('# Decision');
    await client.replyToComment('doc;one-arg', 'comment-1', 'done $(id)');

    expect(runner.mock.calls[1]).toEqual([
      '/opt/dws',
      [
        'doc',
        'comment',
        'reply',
        '--node',
        'doc;one-arg',
        '--comment-key',
        'comment-1',
        '--content',
        'done $(id)',
        '--format',
        'json',
      ],
    ]);
  });
});
