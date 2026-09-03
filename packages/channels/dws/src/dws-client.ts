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
const DWS_PROCESS_FORCE_KILL_DELAY_MS = 5_000;
const MINIMUM_DWS_VERSION = [1, 0, 57] as const;
const DWS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_PAGES = 100;
const MAX_TODO_PAGES = 50;
const TODO_PAGE_SIZE = 20;
export interface DwsIdentity {
  profile?: string;
  selfSenderIds?: string[];
}

export type DwsImSource =
  | { kind: 'at' }
  | { kind: 'direct' }
  | { kind: 'group-all' }
  | { kind: 'group'; conversationId: string };

export type DwsImTarget =
  | { kind: 'group'; conversationId: string }
  | { kind: 'direct'; openDingTalkId: string };

export interface DwsImMessage {
  type:
    | 'user_im_message_receive_at'
    | 'user_im_message_receive_o2o'
    | 'user_im_message_receive_o2o_all'
    | 'user_im_message_receive_group'
    | 'user_im_message_receive_group_all';
  eventId: string;
  messageId: string;
  conversationId: string;
  content: string;
  senderId: string;
  senderName: string;
  referencedText?: string;
  eventTime?: number;
}

export interface DwsImDispatch {
  admitted: Promise<void>;
  completed: Promise<void>;
}

export type DwsImMessageResult = void | Promise<void> | DwsImDispatch;

export interface DwsTodoTask {
  taskId: string;
  title: string;
  creatorId?: string;
  creatorName?: string;
  data: Record<string, unknown>;
}

export interface DwsMessageHistoryPage {
  messages: DwsImMessage[];
  nextCursor?: string;
}

export interface DwsClientLike {
  assertCompatible?(signal?: AbortSignal): Promise<void>;
  assertAuthenticated(signal?: AbortSignal): Promise<DwsIdentity>;
  subscribeToIm(
    source: DwsImSource,
    onMessage: (message: DwsImMessage) => DwsImMessageResult,
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
  addImReaction(
    conversationId: string,
    messageId: string,
    reactionName: string,
  ): Promise<void>;
  removeImReaction(
    conversationId: string,
    messageId: string,
    reactionName: string,
  ): Promise<void>;
  listDirectMessages(
    startTime: number,
    endTime: number,
    signal?: AbortSignal,
    cursor?: string,
  ): Promise<DwsMessageHistoryPage>;
  listMentionedMessages(
    startTime: number,
    endTime: number,
    signal?: AbortSignal,
    cursor?: string,
  ): Promise<DwsMessageHistoryPage>;
  readDocument(documentId: string, signal?: AbortSignal): Promise<string>;
  replyToComment(
    documentId: string,
    commentKey: string,
    content: string,
  ): Promise<void>;
  listTodoTasks(signal?: AbortSignal): Promise<DwsTodoTask[]>;
  getTodoTask(taskId: string, signal?: AbortSignal): Promise<DwsTodoTask>;
  addTodoComment(taskId: string, content: string): Promise<void>;
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

export type DwsCommandOutcome = 'not_sent' | 'unknown';

export class DwsCommandError extends Error {
  constructor(
    message: string,
    readonly outcome: DwsCommandOutcome,
  ) {
    super(message);
    this.name = 'DwsCommandError';
  }
}

/**
 * The errno family `uv_spawn` reports when it fails BEFORE the child ever
 * runs. Nothing was sent, so the caller can retry the whole task without
 * risking a duplicate delivery. The resource errnos matter as much as the
 * path ones: under fd or memory exhaustion the daemon never starts `dws`, and
 * classifying that as `unknown` makes the reply paths in dws-channel.ts drop a
 * user's answer permanently on one log line.
 *
 * Everything else the callback can report happened with a child already
 * running — a non-zero exit (`code` is a number), a timeout kill (`code` is
 * null), an abort (`ABORT_ERR`), a `maxBuffer` overrun
 * (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) — so whether the command sent
 * anything is genuinely unknown and a retry could duplicate it.
 */
const DWS_NOT_SENT_ERROR_CODES = new Set([
  'E2BIG',
  'EACCES',
  'EAGAIN',
  'EBUSY',
  'EFAULT',
  'EIO',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENAMETOOLONG',
  'ENFILE',
  'ENOENT',
  'ENOEXEC',
  'ENOMEM',
  'ENOSYS',
  'ENOTDIR',
  'EPERM',
  'ETXTBSY',
]);

/**
 * Classify an `execFile` callback error by its `code`. Exported so the
 * spawn-failure table can be driven directly: the resource errnos need fd or
 * memory exhaustion to reproduce through a real spawn, which no unit test can
 * stage safely.
 */
export function classifyDwsCommandFailure(code: unknown): DwsCommandOutcome {
  return typeof code === 'string' && DWS_NOT_SENT_ERROR_CODES.has(code)
    ? 'not_sent'
    : 'unknown';
}

function runDwsProcess(
  executable: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
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
        clearTimeout(forceKillTimer);
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: unknown })
            .code;
          const outcome = classifyDwsCommandFailure(code);
          reject(
            new DwsCommandError(
              `DWS command failed${code === undefined ? '' : ` (${String(code)})`}.`,
              outcome,
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, DWS_PROCESS_TIMEOUT_MS + DWS_PROCESS_FORCE_KILL_DELAY_MS);
    forceKillTimer.unref?.();
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
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        pending.push(current[index]);
      }
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, candidate] of Object.entries(current)) {
      if (
        keys.has(key) &&
        (typeof candidate === 'string' ||
          typeof candidate === 'number' ||
          typeof candidate === 'boolean')
      ) {
        return candidate;
      }
    }
    const values = Object.values(current);
    for (let index = values.length - 1; index >= 0; index--) {
      pending.push(values[index]);
    }
  }
  return undefined;
}

function findExactOpenDingTalkId(
  value: unknown,
  userId: string,
): string | undefined {
  const matches = new Set<string>();
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        pending.push(current[index]);
      }
      continue;
    }
    if (!isRecord(current)) continue;
    if (firstString(current, ['userId', 'user_id']) === userId) {
      const openDingTalkId = firstString(current, [
        'openDingTalkId',
        'open_dingtalk_id',
      ]);
      if (openDingTalkId) matches.add(openDingTalkId);
    }
    const values = Object.values(current);
    for (let index = values.length - 1; index >= 0; index--) {
      pending.push(values[index]);
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

interface DwsProfileEntry {
  profile: string;
  current: boolean;
}

function collectProfiles(
  value: unknown,
  profiles: DwsProfileEntry[] = [],
): DwsProfileEntry[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectProfiles(item, profiles);
    }
    return profiles;
  }
  if (!isRecord(value)) return profiles;
  const explicit = firstString(value, ['profile']);
  const corpId = firstString(value, ['corpId', 'corp_id']);
  const profile = explicit ?? corpId;
  if (profile) {
    profiles.push({
      profile,
      current: value['isCurrent'] === true || value['is_current'] === true,
    });
  }
  for (const candidate of Object.values(value)) {
    collectProfiles(candidate, profiles);
  }
  return profiles;
}

function resolveProfile(
  value: unknown,
  selected?: string,
): DwsProfileEntry | undefined {
  const profiles = collectProfiles(value);
  const candidates = selected
    ? profiles.filter((item) => item.profile === selected)
    : profiles.filter((item) => item.current);
  const unique = [
    ...new Map(candidates.map((item) => [item.profile, item])).values(),
  ];
  return unique.length === 1 ? unique[0] : undefined;
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
  if (!trimmed) {
    throw new DwsCommandError('DWS returned an empty response.', 'unknown');
  }
  let parsed: unknown;
  try {
    parsed = parseJson(trimmed, 'a command response');
  } catch (error) {
    throw new DwsCommandError(
      error instanceof Error ? error.message : 'DWS returned invalid JSON.',
      'unknown',
    );
  }
  if (isRecord(parsed) && parsed['success'] === false) {
    throw new Error('DWS request failed.');
  }
  return parsed;
}

function parseVersion(value: unknown): number[] | undefined {
  const version = findScalar(value, new Set(['version']));
  if (typeof version !== 'string') return undefined;
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/u);
  return match ? match.slice(1).map(Number) : undefined;
}

function versionAtLeast(actual: number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index++) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function findConversationList(value: unknown): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  const conversations = value['conversationMessagesList'];
  if (Array.isArray(conversations)) return conversations;
  for (const key of ['result', 'data', 'content']) {
    const found = findConversationList(value[key]);
    if (found) return found;
  }
  return undefined;
}

function formatDwsDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(' ');
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

function findTodoCards(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value['todoCards'])) return value['todoCards'];
  for (const key of ['result', 'data', 'content']) {
    const found = findTodoCards(value[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findTodoDetail(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value['todoDetailModel'])) return value['todoDetailModel'];
  if (firstString(value, ['taskId', 'task_id'])) return value;
  for (const key of ['result', 'data', 'content']) {
    const found = findTodoDetail(value[key]);
    if (found) return found;
  }
  return undefined;
}

function parseTodoTask(
  value: unknown,
  fallbackTaskId?: string,
): DwsTodoTask | undefined {
  if (!isRecord(value)) return undefined;
  const creator = nestedRecord(value, [
    'creator',
    'creatorInfo',
    'creatorUser',
  ]);
  const taskId =
    firstString(value, ['taskId', 'task_id', 'id']) ?? fallbackTaskId;
  if (!taskId) return undefined;
  return {
    taskId,
    title: firstString(value, ['subject', 'title', 'name']) ?? taskId,
    creatorId:
      firstString(value, [
        'creatorId',
        'creator_id',
        'creator',
        'creatorUserId',
        'creatorUid',
        'creatorStaffId',
      ]) ??
      (creator
        ? firstString(creator, [
            'userId',
            'uid',
            'staffId',
            'openDingTalkId',
            'id',
          ])
        : undefined),
    creatorName:
      firstString(value, ['creatorName', 'creator_name']) ??
      (creator
        ? firstString(creator, ['name', 'nick', 'displayName'])
        : undefined),
    data: value,
  };
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

function messageContent(value: unknown, structured = false): string {
  if (typeof value !== 'string') return '';
  if (!structured) return value;
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

function quotedMessageText(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const quoted = record?.[key];
  if (!isRecord(quoted)) return undefined;
  const content = messageContent(quoted['content'], true).trim();
  return content || undefined;
}

function eventTime(
  ...records: Array<Record<string, unknown> | undefined>
): number | undefined {
  for (const record of records) {
    if (!record) continue;
    const value =
      record['event_time'] ??
      record['eventTime'] ??
      record['timestamp'] ??
      record['create_time'] ??
      record['createTime'];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1_000_000_000_000 ? value * 1_000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function parseDwsImEvent(line: string): DwsImMessage {
  const outer = parseJson(line, 'an event');
  const outerRecord = isRecord(outer) ? outer : undefined;
  const event = unwrapEvent(outer);
  if (!event) throw new Error('DWS event payload is not an object.');
  const payload = nestedRecord(event, ['payload']);
  const body =
    nestedRecord(event, ['body']) ??
    (payload ? nestedRecord(payload, ['body']) : undefined);
  const type = firstString(event, ['type', 'event_type', 'eventType']);
  if (
    type !== 'user_im_message_receive_at' &&
    type !== 'user_im_message_receive_o2o' &&
    type !== 'user_im_message_receive_o2o_all' &&
    type !== 'user_im_message_receive_group' &&
    type !== 'user_im_message_receive_group_all'
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
    content:
      typeof event['content'] === 'string'
        ? messageContent(event['content'])
        : messageContent(body?.['content'], true),
    senderId,
    senderName:
      firstString(event, ['sender', 'sender_name', 'senderName']) ??
      (body ? firstString(body, ['sender', 'senderName']) : undefined) ??
      senderId,
    referencedText:
      quotedMessageText(event, 'quoted_message') ??
      quotedMessageText(event, 'quotedMessage') ??
      quotedMessageText(body, 'quoted_message') ??
      quotedMessageText(body, 'quotedMessage'),
    eventTime: eventTime(event, body, outerRecord),
  };
}

function eventKey(source: DwsImSource): string {
  switch (source.kind) {
    case 'at':
      return 'user_im_message_receive_at';
    case 'direct':
      return 'user_im_message_receive_o2o_all';
    case 'group-all':
      return 'user_im_message_receive_group_all';
    case 'group':
      return 'user_im_message_receive_group';
    default:
      throw new Error('Unsupported DWS IM source.');
  }
}

export class DwsClient implements DwsClientLike {
  private readonly executable: string;
  private profile?: string;
  private profileResolved = false;
  private readonly runner: DwsCommandRunner;
  private readonly eventStarter: DwsEventProcessStarter;

  constructor(
    options: DwsClientOptions,
    runner: DwsCommandRunner = runDwsProcess,
    eventStarter: DwsEventProcessStarter = startDwsEventProcess,
  ) {
    this.executable = options.executable;
    this.profile = options.profile?.trim() || undefined;
    if (this.profile?.includes(',')) {
      throw new Error(
        'DWS channel profile must select exactly one login profile.',
      );
    }
    this.runner = runner;
    this.eventStarter = eventStarter;
  }

  async assertCompatible(signal?: AbortSignal): Promise<void> {
    const response = await this.run(['version'], signal, false);
    const version = parseVersion(response);
    if (!version || !versionAtLeast(version, MINIMUM_DWS_VERSION)) {
      throw new Error(
        'DWS channel requires dws 1.0.57 or newer on the daemon PATH.',
      );
    }
  }

  async assertAuthenticated(signal?: AbortSignal): Promise<DwsIdentity> {
    if (!this.profileResolved) {
      const selected = this.profile;
      const profiles = await this.run(['profile', 'list'], signal, false);
      const resolved = resolveProfile(profiles, selected);
      if (!resolved) {
        throw new Error(
          selected
            ? 'DWS profile must exactly match one entry from `dws profile list`.'
            : 'DWS has no active profile. Run `dws auth login` or configure an exact login profile.',
        );
      }
      this.profile = resolved.profile;
      this.profileResolved = true;
    }
    const response = await this.run(['auth', 'status'], signal);
    const authenticated = findScalar(response, new Set(['authenticated']));
    if (authenticated !== true) {
      throw new Error(
        'DWS is not authenticated. Run `dws auth login` for the selected profile.',
      );
    }
    const resolvedSelfSenderId = findScalar(
      response,
      new Set([
        'openDingTalkId',
        'open_dingtalk_id',
        'senderOpenDingTalkId',
        'sender_open_dingtalk_id',
      ]),
    );
    let selfSenderId =
      typeof resolvedSelfSenderId === 'string' && resolvedSelfSenderId.trim()
        ? resolvedSelfSenderId
        : undefined;
    if (!selfSenderId) {
      const userId = findScalar(response, new Set(['userId', 'user_id']));
      const userName = findScalar(response, new Set(['userName', 'user_name']));
      if (
        typeof userId === 'string' &&
        userId.trim() &&
        typeof userName === 'string' &&
        userName.trim()
      ) {
        const exactUserId = userId.trim();
        const query = userName.trim();
        let contacts: unknown;
        try {
          contacts = await this.run(
            ['contact', 'user', 'search', '--query', query],
            signal,
          );
        } catch {
          signal?.throwIfAborted();
        }
        selfSenderId = findExactOpenDingTalkId(contacts, exactUserId);
      }
    }
    return {
      profile: this.profile,
      selfSenderIds: selfSenderId ? [selfSenderId] : undefined,
    };
  }

  async subscribeToIm(
    source: DwsImSource,
    onMessage: (message: DwsImMessage) => DwsImMessageResult,
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
    if (source.kind === 'group') {
      args.push('--group', source.conversationId);
    }
    return this.eventStarter(
      this.executable,
      args,
      (line) => {
        const message = parseDwsImEvent(line);
        const result = onMessage(message);
        if (!result || !('admitted' in result)) return result;
        if (source.kind !== 'direct') return result.completed;
        const reportError = (error: unknown): void => {
          try {
            onError(error instanceof Error ? error : new Error(String(error)));
          } catch {
            return;
          }
        };
        const admissionSucceeded = result.admitted.then(
          () => true,
          () => false,
        );
        void result.completed.catch(async (error: unknown) => {
          if (await admissionSucceeded) reportError(error);
        });
        return result.admitted;
      },
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

  async addImReaction(
    conversationId: string,
    messageId: string,
    reactionName: string,
  ): Promise<void> {
    await this.run([
      'chat',
      'message',
      'add-emoji',
      '--conversation-id',
      conversationId,
      '--msg-id',
      messageId,
      '--emoji',
      reactionName,
    ]);
  }

  async removeImReaction(
    conversationId: string,
    messageId: string,
    reactionName: string,
  ): Promise<void> {
    await this.run([
      'chat',
      'message',
      'remove-emoji',
      '--conversation-id',
      conversationId,
      '--msg-id',
      messageId,
      '--emoji',
      reactionName,
    ]);
  }

  async listDirectMessages(
    startTime: number,
    endTime: number,
    signal?: AbortSignal,
    initialCursor = '0',
  ): Promise<DwsMessageHistoryPage> {
    const messages: DwsImMessage[] = [];
    const seenCursors = new Set<string>([initialCursor]);
    let cursor = initialCursor;
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      signal?.throwIfAborted();
      const response = await this.run(
        [
          'chat',
          'message',
          'list-all',
          '--start',
          formatDwsDateTime(startTime),
          '--end',
          formatDwsDateTime(endTime),
          '--limit',
          '50',
          '--cursor',
          cursor,
        ],
        signal,
      );
      const conversations = findConversationList(response);
      if (!conversations) {
        throw new Error(
          'DWS message-history response did not contain a conversation list.',
        );
      }
      for (const conversation of conversations) {
        if (!isRecord(conversation) || conversation['singleChat'] !== true) {
          continue;
        }
        const entries = conversation['messages'];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (!isRecord(entry)) continue;
          const messageId = firstString(entry, ['openMessageId', 'messageId']);
          const conversationId = firstString(entry, [
            'openConversationId',
            'conversationId',
          ]);
          const senderId = firstString(entry, [
            'senderOpenDingTalkId',
            'senderId',
          ]);
          if (!messageId || !conversationId || !senderId) continue;
          messages.push({
            type: 'user_im_message_receive_o2o_all',
            eventId: messageId,
            messageId,
            conversationId,
            content: messageContent(entry['content']),
            senderId,
            senderName:
              firstString(entry, ['sender', 'senderName']) ?? senderId,
            eventTime: eventTime(entry),
          });
        }
      }
      if (findScalar(response, new Set(['hasMore'])) !== true) {
        return { messages };
      }
      const next = findScalar(response, new Set(['nextCursor']));
      if (typeof next !== 'string' || !next || seenCursors.has(next)) {
        throw new Error('DWS returned an invalid message pagination cursor.');
      }
      seenCursors.add(next);
      if (page === MAX_MESSAGE_PAGES - 1) {
        return { messages, nextCursor: next };
      }
      cursor = next;
    }
    return { messages };
  }

  async listMentionedMessages(
    startTime: number,
    endTime: number,
    signal?: AbortSignal,
    cursor = '0',
  ): Promise<DwsMessageHistoryPage> {
    const response = await this.run(
      [
        'chat',
        'message',
        'list-mentions',
        '--start',
        formatDwsDateTime(startTime),
        '--end',
        formatDwsDateTime(endTime),
        '--limit',
        '50',
        '--cursor',
        cursor,
      ],
      signal,
    );
    const conversations = findConversationList(response);
    if (!conversations) {
      if (
        findScalar(response, new Set(['success'])) === true &&
        findScalar(response, new Set(['hasMore'])) !== true
      ) {
        return { messages: [] };
      }
      throw new Error(
        'DWS mention-history response did not contain a conversation list.',
      );
    }
    const messages: DwsImMessage[] = [];
    for (const conversation of conversations) {
      if (!isRecord(conversation) || conversation['singleChat'] !== false) {
        continue;
      }
      const entries = conversation['messages'];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const messageId = firstString(entry, ['openMessageId', 'messageId']);
        const conversationId = firstString(entry, [
          'openConversationId',
          'conversationId',
        ]);
        const senderId = firstString(entry, [
          'senderOpenDingTalkId',
          'senderId',
        ]);
        if (!messageId || !conversationId || !senderId) continue;
        messages.push({
          type: 'user_im_message_receive_at',
          eventId: messageId,
          messageId,
          conversationId,
          content: messageContent(entry['content']),
          senderId,
          senderName: firstString(entry, ['sender', 'senderName']) ?? senderId,
          referencedText: quotedMessageText(entry, 'quotedMessage'),
          eventTime: eventTime(entry),
        });
      }
    }
    const next = findScalar(response, new Set(['nextCursor']));
    if (findScalar(response, new Set(['hasMore'])) !== true) {
      return { messages };
    }
    if (typeof next !== 'string' || !next || next === cursor) {
      throw new Error(
        'DWS mention-history response did not contain a valid next cursor.',
      );
    }
    return { messages, nextCursor: next };
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

  async listTodoTasks(signal?: AbortSignal): Promise<DwsTodoTask[]> {
    const tasks = new Map<string, DwsTodoTask>();
    for (let page = 1; page <= MAX_TODO_PAGES; page++) {
      signal?.throwIfAborted();
      const response = await this.run(
        [
          'todo',
          'task',
          'list',
          '--page',
          String(page),
          '--size',
          String(TODO_PAGE_SIZE),
          '--status',
          'false',
          '--role-types',
          'executor',
        ],
        signal,
      );
      const cards = findTodoCards(response);
      if (!cards) {
        throw new Error('DWS todo response did not contain a todoCards list.');
      }
      for (const card of cards) {
        const task = parseTodoTask(card);
        if (!task) {
          throw new Error('DWS todo response contained a task without taskId.');
        }
        tasks.set(task.taskId, task);
      }
      if (findScalar(response, new Set(['hasMore'])) !== true) {
        return [...tasks.values()];
      }
      if (cards.length === 0) {
        throw new Error(
          'DWS todo pagination returned an empty page with hasMore.',
        );
      }
    }
    throw new Error(`DWS todo pagination exceeded ${MAX_TODO_PAGES} pages.`);
  }

  async getTodoTask(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<DwsTodoTask> {
    const response = await this.run(
      ['todo', 'task', 'get', '--task-id', taskId],
      signal,
    );
    const task = parseTodoTask(findTodoDetail(response), taskId);
    if (!task) {
      throw new Error('DWS todo detail response did not contain task data.');
    }
    return task;
  }

  async addTodoComment(taskId: string, content: string): Promise<void> {
    await this.run([
      'todo',
      'comment',
      'add',
      '--task-id',
      taskId,
      '--content',
      content,
    ]);
  }

  private profileArgs(): string[] {
    return this.profile ? ['--profile', this.profile] : [];
  }

  private async run(
    command: string[],
    signal?: AbortSignal,
    scoped = true,
  ): Promise<unknown> {
    const args = [
      ...(scoped ? this.profileArgs() : []),
      ...command,
      '--format',
      'json',
    ];
    const result = signal
      ? await this.runner(this.executable, args, signal)
      : await this.runner(this.executable, args);
    return parseOutput(result.stdout);
  }
}
