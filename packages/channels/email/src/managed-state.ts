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
import type { EmailSettings } from './config.js';
import { EmailStateStore, isMessageId, validState } from './state.js';
import type { ReplyRoute } from './state.js';

// H5b/H5c: the managed email adapter's own locked state. It keeps what the
// Legacy state keeps for the same reasons — the mailbox generation, the
// cursor, the in-flight claims, the dedupe window and the reply routes —
// and adds the account generation the control plane knows, the admitted
// input of each in-flight event and the outbound segments awaiting their
// receipt. Every claim persists before its side effect.

export interface ManagedPendingEvent {
  uid: number;
  eventId: string;
  inputId?: string;
}

export interface ManagedOutboundSegment {
  deliveryId: string;
  ordinal: number;
  messageId: string;
}

export interface ManagedEmailState {
  version: 1;
  uidValidity: string;
  generation: number;
  lastUid: number;
  pending: ManagedPendingEvent[];
  outbound: ManagedOutboundSegment[];
  recent: string[];
  routes: ReplyRoute[];
}

export const MANAGED_PENDING_LIMIT = 32;

const isUid = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) > 0 &&
  Number(value) <= 0xffffffff;

export function validManagedState(value: unknown): value is ManagedEmailState {
  if (!value || typeof value !== 'object') return false;
  const state = value as ManagedEmailState;
  // The dedupe window and the routes keep the Legacy shape exactly; the
  // Legacy validator checks them against an equivalent envelope.
  const legacyShape = {
    version: 1,
    uidValidity: state.uidValidity,
    lastUid: state.lastUid,
    pending: [],
    outboundPending: [],
    recent: state.recent,
    routes: state.routes,
  };
  return (
    state.version === 1 &&
    Number.isSafeInteger(state.generation) &&
    state.generation >= 1 &&
    validState(legacyShape) &&
    Array.isArray(state.pending) &&
    state.pending.length <= MANAGED_PENDING_LIMIT &&
    state.pending.every(
      (entry) =>
        entry &&
        isUid(entry.uid) &&
        entry.uid <= state.lastUid &&
        typeof entry.eventId === 'string' &&
        entry.eventId.length > 0 &&
        (entry.inputId === undefined || typeof entry.inputId === 'string'),
    ) &&
    Array.isArray(state.outbound) &&
    state.outbound.length <= 64 &&
    state.outbound.every(
      (entry) =>
        entry &&
        typeof entry.deliveryId === 'string' &&
        entry.deliveryId.length > 0 &&
        Number.isSafeInteger(entry.ordinal) &&
        entry.ordinal >= 0 &&
        isMessageId(entry.messageId),
    )
  );
}

export class ManagedEmailStateStore {
  readonly directory: string;
  readonly file: string;

  constructor(name: string, cwd: string, settings: EmailSettings) {
    // The same directory as the Legacy adapter for the same mailbox: its
    // lock keeps one owner per mailbox, managed or Legacy.
    this.directory = new EmailStateStore(name, cwd, settings).directory;
    this.file = join(this.directory, 'managed-state.json');
  }

  load(): ManagedEmailState | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!validManagedState(value)) throw new Error('invalid state');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(
        'Managed email state is unreadable or invalid; restore it before restarting.',
      );
    }
  }

  save(state: ManagedEmailState): void {
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
      throw new Error(
        'Managed email state could not be saved; admission stopped.',
      );
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
