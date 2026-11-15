import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  getGlobalQwenDir,
  getWorkspaceScopeDirName,
} from '@qwen-code/channel-base';
import type { EmailSettings } from './config.js';
import { normalizeAddress } from './config.js';

export interface ReplyRoute {
  sender: string;
  threadId: string;
  parent: string;
  references: string[];
  subject: string;
  ids: string[];
}

export interface EmailState {
  version: 1;
  uidValidity: string;
  lastUid: number;
  pending: number[];
  outboundPending: string[];
  recent: string[];
  routes: ReplyRoute[];
}

export const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export const isMessageId = (value: unknown): value is string =>
  typeof value === 'string' && /^<[^<>\s\p{Cc}]{1,998}>$/u.test(value);
const isUid = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) > 0 &&
  Number(value) <= 0xffffffff;
const strings = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((entry) => typeof entry === 'string');

export function validState(value: unknown): value is EmailState {
  if (!value || typeof value !== 'object') return false;
  const state = value as EmailState;
  return (
    state.version === 1 &&
    typeof state.uidValidity === 'string' &&
    /^\d+$/.test(state.uidValidity) &&
    isUid(Number(state.uidValidity)) &&
    (state.lastUid === 0 || isUid(state.lastUid)) &&
    Array.isArray(state.pending) &&
    state.pending.length <= 33 &&
    state.pending.every((uid) => isUid(uid) && uid <= state.lastUid) &&
    strings(state.outboundPending, 64) &&
    state.outboundPending.every(isMessageId) &&
    strings(state.recent, 1024) &&
    state.recent.every((id) => /^[a-f0-9]{64}$/.test(id)) &&
    Array.isArray(state.routes) &&
    state.routes.length <= 256 &&
    state.routes.every(
      (route) =>
        route &&
        typeof route.sender === 'string' &&
        normalizeAddress(route.sender) === route.sender &&
        typeof route.threadId === 'string' &&
        /^[a-f0-9]{64}$/.test(route.threadId) &&
        isMessageId(route.parent) &&
        strings(route.references, 30) &&
        route.references.length > 0 &&
        route.references.every(isMessageId) &&
        typeof route.subject === 'string' &&
        route.subject.length <= 200 &&
        !/[\r\n\0]/.test(route.subject) &&
        strings(route.ids, 64) &&
        route.ids.length > 0 &&
        route.ids.every(isMessageId),
    )
  );
}

export class EmailStateStore {
  readonly directory: string;
  readonly file: string;

  constructor(name: string, cwd: string, settings: EmailSettings) {
    // Keep standalone and daemon storage identical; credentials never define identity.
    const key = digest(
      JSON.stringify([
        name,
        settings.imapHost.toLowerCase(),
        settings.imapPort,
        settings.imapUser,
        settings.folder,
        settings.address,
      ]),
    );
    this.directory = join(
      getGlobalQwenDir(),
      'channels',
      getWorkspaceScopeDirName(cwd),
      `email-${key}`,
    );
    this.file = join(this.directory, 'state.json');
  }

  load(): EmailState | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!validState(value)) throw new Error('invalid state');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(
        'Email state is unreadable or invalid; restore it before restarting.',
      );
    }
  }

  save(state: EmailState): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(state));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.file);
    } catch {
      throw new Error('Email state could not be saved; admission stopped.');
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
