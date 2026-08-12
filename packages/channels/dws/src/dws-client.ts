/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { dwsProcessEnvironment } from './dws-environment.js';
import {
  startDwsEventProcess,
  type DwsEventProcessStarter,
  type DwsEventSubscription,
} from './dws-event-stream.js';

const DWS_PROCESS_TIMEOUT_MS = 45_000;
const DWS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_COMMENT_PAGES = 100;
const MAX_WIKI_PAGES = 100;
const MAX_WIKI_NODES = 10_000;

export interface DwsIdentity {
  userId?: string;
  openDingTalkId?: string;
}

export interface DwsDocumentComment {
  key: string;
  content: string;
  authorId: string;
  authorName: string;
  mentionedUserIds: string[];
  selectedText?: string;
  createdAt?: string;
  replies: DwsDocumentComment[];
}

export type DwsImSource = { kind: 'at' } | { kind: 'direct'; userId: string };

export type DwsImTarget =
  | { kind: 'group'; conversationId: string }
  | { kind: 'direct'; openDingTalkId: string };

export interface DwsImMessage {
  type: 'user_im_message_receive_at' | 'user_im_message_receive_o2o';
  eventId: string;
  messageId: string;
  conversationId: string;
  content: string;
  senderId: string;
  senderName: string;
}

export interface DwsClientLike {
  assertAuthenticated(signal?: AbortSignal): Promise<DwsIdentity>;
  subscribeToIm(
    source: DwsImSource,
    onMessage: (message: DwsImMessage) => void | Promise<void>,
    onError: (error: Error) => void,
  ): Promise<DwsEventSubscription>;
  sendImMessage(
    target: DwsImTarget,
    content: string,
    idempotencyKey: string,
  ): Promise<void>;
  replyToImMessage(
    conversationId: string,
    messageId: string,
    senderId: string,
    content: string,
    idempotencyKey: string,
  ): Promise<void>;
  listWikiDocuments(
    wikiSpaceId: string,
    signal?: AbortSignal,
  ): Promise<string[]>;
  listUnresolvedComments(
    documentId: string,
    signal?: AbortSignal,
  ): Promise<DwsDocumentComment[]>;
  readDocument(documentId: string, signal?: AbortSignal): Promise<string>;
  replyToComment(
    documentId: string,
    commentKey: string,
    content: string,
  ): Promise<void>;
}

export interface DwsClientOptions {
  executable: string;
  profile?: string;
}

export type DwsCommandRunner = (
  executable: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;

function runDwsProcess(
  executable: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        env: dwsProcessEnvironment(),
        maxBuffer: DWS_MAX_OUTPUT_BYTES,
        timeout: DWS_PROCESS_TIMEOUT_MS,
        windowsHide: true,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: unknown })
            .code;
          reject(
            new Error(
              `DWS command failed${code === undefined ? '' : ` (${String(code)})`}.`,
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return undefined;
}

function nestedRecord(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (isRecord(candidate)) return candidate;
  }
  return undefined;
}

function findScalar(
  value: unknown,
  keys: ReadonlySet<string>,
): string | number | boolean | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findScalar(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, candidate] of Object.entries(value)) {
    if (
      keys.has(key) &&
      (typeof candidate === 'string' ||
        typeof candidate === 'number' ||
        typeof candidate === 'boolean')
    ) {
      return candidate;
    }
  }
  for (const candidate of Object.values(value)) {
    const found = findScalar(candidate, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseJson(text: string, description: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`DWS returned invalid JSON for ${description}.`);
  }
}

function parseOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('DWS returned an empty response.');
  const parsed = parseJson(trimmed, 'a command response');
  if (isRecord(parsed) && parsed['success'] === false) {
    throw new Error('DWS request failed.');
  }
  return parsed;
}

function commentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  return firstString(value, ['text', 'content', 'plainText']) ?? '';
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  for (const item of values) {
    const id =
      typeof item === 'string' || typeof item === 'number'
        ? String(item).trim()
        : isRecord(item)
          ? firstString(item, ['userId', 'uid', 'id', 'openDingTalkId'])
          : undefined;
    if (id) result.push(id);
  }
  return [...new Set(result)];
}

function parseComment(value: unknown): DwsDocumentComment | undefined {
  if (!isRecord(value)) return undefined;
  const key = firstString(value, ['commentKey', 'commentId', 'id']);
  if (!key) return undefined;
  const author = nestedRecord(value, ['author', 'creator', 'user', 'operator']);
  const authorId =
    firstString(value, [
      'creatorUid',
      'creatorUserId',
      'userId',
      'uid',
      'creatorStaffId',
      'commentStaffId',
      'creatorId',
      'authorId',
      'operatorId',
    ]) ??
    (author
      ? firstString(author, ['userId', 'uid', 'unionId', 'staffId', 'id'])
      : undefined) ??
    'unknown';
  const authorName =
    firstString(value, [
      'creatorName',
      'authorName',
      'userName',
      'operatorName',
    ]) ??
    (author
      ? firstString(author, ['name', 'displayName', 'nick', 'userName'])
      : undefined) ??
    authorId;
  const rawReplies =
    value['replies'] ?? value['replyList'] ?? value['children'] ?? [];
  const replies = Array.isArray(rawReplies)
    ? rawReplies
        .map(parseComment)
        .filter((item): item is DwsDocumentComment => item !== undefined)
    : [];
  const created =
    value['createdAt'] ?? value['createTime'] ?? value['createdTime'];
  return {
    key,
    content: commentText(value['content'] ?? value['text'] ?? value['body']),
    authorId,
    authorName,
    mentionedUserIds: stringList(
      value['mentionedUserIds'] ??
        value['mentionedUids'] ??
        value['atUserIds'] ??
        [],
    ),
    selectedText: firstString(value, [
      'selectedText',
      'quote',
      'referencedText',
    ]),
    createdAt:
      typeof created === 'string' || typeof created === 'number'
        ? String(created)
        : undefined,
    replies,
  };
}

function findCommentList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  for (const key of ['commentList', 'comments', 'items', 'list']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  for (const key of ['result', 'data', 'content']) {
    const found = findCommentList(value[key]);
    if (found) return found;
  }
  return undefined;
}

function findWikiNodeList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  for (const key of ['nodes', 'nodeList', 'items', 'list']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  for (const key of ['result', 'data', 'content']) {
    const found = findWikiNodeList(value[key]);
    if (found) return found;
  }
  return undefined;
}

function findMarkdown(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const direct = firstString(value, ['markdown']);
  if (direct !== undefined) return direct;
  for (const key of ['result', 'data', 'content']) {
    const found = findMarkdown(value[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function unwrapEvent(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const data = value['data'];
  if (typeof data === 'string') {
    const parsed = parseJson(data, 'an event payload');
    if (isRecord(parsed)) return parsed;
  }
  if (isRecord(data)) return data;
  return value;
}

function messageContent(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return value;
    return firstString(parsed, ['content', 'text']) ?? value;
  } catch {
    return value;
  }
}

export function parseDwsImEvent(line: string): DwsImMessage {
  const outer = parseJson(line, 'an event');
  const event = unwrapEvent(outer);
  if (!event) throw new Error('DWS event payload is not an object.');
  const payload = nestedRecord(event, ['payload']);
  const body =
    nestedRecord(event, ['body']) ??
    (payload ? nestedRecord(payload, ['body']) : undefined);
  const type = firstString(event, ['type', 'event_type', 'eventType']);
  if (
    type !== 'user_im_message_receive_at' &&
    type !== 'user_im_message_receive_o2o'
  ) {
    throw new Error(`Unsupported DWS event type: ${type ?? 'unknown'}.`);
  }
  const messageId =
    firstString(event, ['message_id', 'messageId', 'openMessageId']) ??
    (body ? firstString(body, ['openMessageId', 'messageId']) : undefined);
  const conversationId =
    firstString(event, [
      'conversation_id',
      'conversationId',
      'openConversationId',
    ]) ??
    (body
      ? firstString(body, ['openConversationId', 'conversationId'])
      : undefined);
  const senderId =
    firstString(event, [
      'sender_open_dingtalk_id',
      'senderOpenDingTalkId',
      'sender_id',
      'senderId',
    ]) ??
    (body
      ? firstString(body, ['senderOpenDingTalkId', 'senderId'])
      : undefined);
  if (!messageId || !conversationId || !senderId) {
    throw new Error(
      'DWS message event is missing message, conversation, or sender identity.',
    );
  }
  return {
    type,
    eventId: firstString(event, ['event_id', 'eventId', 'id']) ?? messageId,
    messageId,
    conversationId,
    content: messageContent(event['content'] ?? body?.['content']),
    senderId,
    senderName:
      firstString(event, ['sender', 'sender_name', 'senderName']) ??
      (body ? firstString(body, ['sender', 'senderName']) : undefined) ??
      senderId,
  };
}

function eventKey(source: DwsImSource): string {
  switch (source.kind) {
    case 'at':
      return 'user_im_message_receive_at';
    case 'direct':
      return 'user_im_message_receive_o2o';
    default:
      throw new Error('Unsupported DWS IM source.');
  }
}

export class DwsClient implements DwsClientLike {
  private readonly executable: string;
  private readonly profile?: string;
  private readonly runner: DwsCommandRunner;
  private readonly eventStarter: DwsEventProcessStarter;

  constructor(
    options: DwsClientOptions,
    runner: DwsCommandRunner = runDwsProcess,
    eventStarter: DwsEventProcessStarter = startDwsEventProcess,
  ) {
    this.executable = options.executable;
    this.profile = options.profile?.trim() || undefined;
    this.runner = runner;
    this.eventStarter = eventStarter;
  }

  async assertAuthenticated(signal?: AbortSignal): Promise<DwsIdentity> {
    const response = await this.run(['auth', 'status'], signal);
    const authenticated = findScalar(response, new Set(['authenticated']));
    if (authenticated !== true) {
      throw new Error(
        'DWS is not authenticated. Run `dws auth login` for the selected profile.',
      );
    }
    const userId = findScalar(
      response,
      new Set(['userId', 'user_id', 'uid', 'staffId', 'staff_id']),
    );
    const openDingTalkId = findScalar(
      response,
      new Set(['openDingTalkId', 'open_dingtalk_id']),
    );
    return {
      userId:
        typeof userId === 'string' || typeof userId === 'number'
          ? String(userId)
          : undefined,
      openDingTalkId:
        typeof openDingTalkId === 'string' || typeof openDingTalkId === 'number'
          ? String(openDingTalkId)
          : undefined,
    };
  }

  async subscribeToIm(
    source: DwsImSource,
    onMessage: (message: DwsImMessage) => void | Promise<void>,
    onError: (error: Error) => void,
  ): Promise<DwsEventSubscription> {
    const args = [
      ...this.profileArgs(),
      'event',
      'consume',
      eventKey(source),
      '--format',
      'compact',
    ];
    if (source.kind === 'direct') args.push('--user', source.userId);
    return this.eventStarter(
      this.executable,
      args,
      async (line) => onMessage(parseDwsImEvent(line)),
      onError,
    );
  }

  async sendImMessage(
    target: DwsImTarget,
    content: string,
    idempotencyKey: string,
  ): Promise<void> {
    const targetArgs =
      target.kind === 'group'
        ? ['--group', target.conversationId]
        : ['--open-dingtalk-id', target.openDingTalkId];
    await this.run([
      'chat',
      'message',
      'send',
      ...targetArgs,
      '--text',
      content,
      '--uuid',
      idempotencyKey,
    ]);
  }

  async replyToImMessage(
    conversationId: string,
    messageId: string,
    senderId: string,
    content: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.run([
      'chat',
      'message',
      'reply',
      '--conversation-id',
      conversationId,
      '--ref-msg-id',
      messageId,
      '--ref-sender',
      senderId,
      '--text',
      content,
      '--uuid',
      idempotencyKey,
    ]);
  }

  async listUnresolvedComments(
    documentId: string,
    signal?: AbortSignal,
  ): Promise<DwsDocumentComment[]> {
    const comments: DwsDocumentComment[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
      signal?.throwIfAborted();
      const args = [
        'doc',
        'comment',
        'list',
        '--node',
        documentId,
        '--resolve-status',
        'unresolved',
        '--limit',
        '50',
      ];
      if (cursor) args.push('--cursor', cursor);
      const response = await this.run(args, signal);
      const commentList = findCommentList(response);
      if (!commentList) {
        throw new Error('DWS comment response did not contain a comment list.');
      }
      for (const item of commentList) {
        const parsed = parseComment(item);
        if (parsed) comments.push(parsed);
      }
      const next = findScalar(response, new Set(['nextToken', 'nextCursor']));
      if (typeof next !== 'string' || !next) return comments;
      if (seenCursors.has(next)) {
        throw new Error('DWS returned a repeated comment pagination cursor.');
      }
      seenCursors.add(next);
      cursor = next;
    }
    throw new Error(
      `DWS comment pagination exceeded ${MAX_COMMENT_PAGES} pages.`,
    );
  }

  async listWikiDocuments(
    wikiSpaceId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const documents: string[] = [];
    const seenDocuments = new Set<string>();
    const folders: Array<string | undefined> = [undefined];
    const seenFolders = new Set<string>();
    let nodeCount = 0;

    for (let folderIndex = 0; folderIndex < folders.length; folderIndex++) {
      const folder = folders[folderIndex];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let completed = false;
      for (let page = 0; page < MAX_WIKI_PAGES; page++) {
        signal?.throwIfAborted();
        const args = [
          'wiki',
          'node',
          'list',
          '--workspace',
          wikiSpaceId,
          '--limit',
          '50',
        ];
        if (folder) args.push('--folder', folder);
        if (cursor) args.push('--cursor', cursor);
        const response = await this.run(args, signal);
        const nodes = findWikiNodeList(response);
        if (!nodes) {
          throw new Error(
            'DWS knowledge-base response did not contain a node list.',
          );
        }
        for (const item of nodes) {
          if (!isRecord(item)) continue;
          const nodeId = firstString(item, ['nodeId', 'id']);
          if (!nodeId) continue;
          nodeCount++;
          if (nodeCount > MAX_WIKI_NODES) {
            throw new Error(
              `DWS knowledge base contains more than ${MAX_WIKI_NODES} nodes.`,
            );
          }
          const extension = firstString(item, ['extension'])?.toLowerCase();
          const contentType = firstString(item, ['contentType'])?.toUpperCase();
          if (
            (extension === 'adoc' || contentType === 'ALIDOC') &&
            !seenDocuments.has(nodeId)
          ) {
            seenDocuments.add(nodeId);
            documents.push(nodeId);
          }
          if (item['hasChildren'] === true && !seenFolders.has(nodeId)) {
            seenFolders.add(nodeId);
            folders.push(nodeId);
          }
        }
        const next = findScalar(
          response,
          new Set(['nextPageToken', 'pageToken', 'nextToken', 'nextCursor']),
        );
        if (typeof next !== 'string' || !next) {
          completed = true;
          break;
        }
        if (seenCursors.has(next)) {
          throw new Error('DWS returned a repeated knowledge-base cursor.');
        }
        seenCursors.add(next);
        cursor = next;
      }
      if (!completed) {
        throw new Error(
          `DWS knowledge-base pagination exceeded ${MAX_WIKI_PAGES} pages.`,
        );
      }
    }
    return documents;
  }

  async readDocument(
    documentId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.run(
      ['doc', 'read', '--node', documentId],
      signal,
    );
    const markdown = findMarkdown(response);
    if (markdown === undefined) {
      throw new Error(
        'DWS document response did not contain Markdown content.',
      );
    }
    return markdown;
  }

  async replyToComment(
    documentId: string,
    commentKey: string,
    content: string,
  ): Promise<void> {
    await this.run([
      'doc',
      'comment',
      'reply',
      '--node',
      documentId,
      '--comment-key',
      commentKey,
      '--content',
      content,
    ]);
  }

  private profileArgs(): string[] {
    return this.profile ? ['--profile', this.profile] : [];
  }

  private async run(command: string[], signal?: AbortSignal): Promise<unknown> {
    const args = [...this.profileArgs(), ...command, '--format', 'json'];
    const result = signal
      ? await this.runner(this.executable, args, signal)
      : await this.runner(this.executable, args);
    return parseOutput(result.stdout);
  }
}
