import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
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
  MANAGED_OUTBOUND_LIMIT,
  validManagedReceipt,
} from '@qwen-code/channel-base';
import type { ManagedReceipt } from '@qwen-code/channel-base';
import type { EmailSettings } from './config.js';
import { EmailStateStore, isMessageId, validState } from './state.js';
import type { ReplyRoute } from './state.js';

export type { ManagedReceipt };

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
  /**
   * Set while the instance-scoped stall holds this claim: the stall
   * flag is in-memory, so the marker is what re-arms it after a
   * restart, and the claim itself never drops while it is set.
   */
  held?: boolean;
}

export interface ManagedOutboundSegment {
  deliveryId: string;
  ordinal: number;
  messageId: string;
  /**
   * Set once the provider answered. A crash before the control plane's
   * own answer replays this receipt idempotently — never a uniform
   * unknown — so a delivery the server already settled still converges.
   */
  receipt?: ManagedReceipt;
}

export interface ManagedEmailState {
  version: 1;
  uidValidity: string;
  generation: number;
  lastUid: number;
  /**
   * Consecutive instance-scoped refusal verdicts. Every determinant of
   * each comes from the channel instance row, not the message, so a
   * streak indicts the instance's workspace binding, not the mail: the
   * first still drops as the poison message it may be (R3-1), and past
   * the limit the claim is held and the poll stalls instead of
   * destroying every inbound message behind one routine log line
   * (R5-1). Persisted so a restart resumes the episode instead of
   * paying the first-occurrence sacrifice again (R10-1): only the held
   * claim's own fresh admission proves the binding answers again and
   * resets it, and a mailbox epoch change clears it with the rest of
   * the old generation's claims.
   */
  instanceRefusals?: number;
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
    (state.instanceRefusals === undefined ||
      (Number.isSafeInteger(state.instanceRefusals) &&
        state.instanceRefusals >= 0)) &&
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
    state.outbound.length <= MANAGED_OUTBOUND_LIMIT &&
    state.outbound.every(
      (entry) =>
        entry &&
        typeof entry.deliveryId === 'string' &&
        entry.deliveryId.length > 0 &&
        Number.isSafeInteger(entry.ordinal) &&
        entry.ordinal >= 0 &&
        isMessageId(entry.messageId) &&
        validManagedReceipt(entry.receipt),
    )
  );
}

export class ManagedEmailStateStore {
  readonly directory: string;
  readonly file: string;

  constructor(
    name: string,
    cwd: string,
    settings: EmailSettings,
    identityKey = '',
  ) {
    // The same directory as the Legacy adapter for the same mailbox: its
    // lock keeps one owner per mailbox, managed or Legacy. Identity keying
    // changes only the ledger FILE beneath it, never this shared lock — a
    // per-destination lock would let a managed and a Legacy owner (or two
    // registrations) run concurrently on one mailbox. Credentials never
    // define identity.
    this.directory = new EmailStateStore(name, cwd, settings).directory;
    const ledgerKey = createHash('sha256')
      .update(identityKey)
      .digest('hex')
      .slice(0, 16);
    this.file = join(this.directory, `managed-state-${ledgerKey}.json`);
  }

  load(): ManagedEmailState | undefined {
    // Name the file and keep the cause, and keep an I/O failure distinguishable
    // from a corrupt state: the directory now holds a ledger per registration,
    // so the operator must know WHICH file is unreadable (e.g. EISDIR) versus
    // merely invalid, while a sibling registration's healthy ledger sits beside
    // it. Mirrors the WeCom / DingTalk / GitHub stores this change parallels.
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(
        `Managed email state at ${this.file} could not be read; restore it before restarting.`,
        { cause: error },
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Managed email state at ${this.file} is not valid JSON; restore it before restarting.`,
        { cause: error },
      );
    }
    if (!validManagedState(value)) {
      throw new Error(
        `Managed email state at ${this.file} is invalid; restore it before restarting.`,
      );
    }
    return value;
  }

  /**
   * The pre-registration-identity ledger this mailbox used before the upgrade.
   * A sibling `managed-state.json` is stranded by the upgrade: its
   * staged-but-unadmitted claims were never seen by the control plane (only
   * `submitInbound` makes a claim visible), and the fresh ledger's cursor starts
   * at the current mailbox tip, so the claims' older UIDs are never re-fetched.
   * Report the path and its pending / outbound counts so the drop is explicit,
   * never silent. Detection is NOT gated on the identity-keyed ledger being
   * absent: a rollback to the pre-upgrade build can stage fresh claims into
   * `managed-state.json` after a keyed ledger already exists, and those must
   * still be reported. The caller archives the file once the start succeeds
   * (`archiveStrandedLegacy`). The legacy ledger is NOT adopted — adopting it
   * would replay one registration's pending into another, the cross-ownership
   * hazard the identity keying prevents.
   *
   * `readable` distinguishes a legacy whose contents could not be read or
   * parsed (counts unknown, reported as 0 but flagged) from one that parsed to
   * an empty ledger: an unreadable legacy certainly strands whatever it held,
   * so the caller must not render it as a quiescent "nothing was lost".
   *
   * `lastUid` and `generation` are read for the notice and the generation seed,
   * never adopted as pending state: the fresh ledger restarts the cursor at the
   * mailbox tip (so the offline window after the legacy cursor is skipped, even
   * for a quiescent 0/0 legacy) and at generation 1 (so a mailbox that already
   * re-keyed must seed the monotonic counter back, or the control plane refuses
   * the lower generation on every start).
   */
  strandedLegacyLedger():
    | {
        path: string;
        pending: number;
        outbound: number;
        readable: boolean;
        lastUid: number | undefined;
        generation: number | undefined;
      }
    | undefined {
    const legacyPath = join(this.directory, 'managed-state.json');
    if (!existsSync(legacyPath)) return undefined;
    let pending = 0;
    let outbound = 0;
    let readable = true;
    let lastUid: number | undefined;
    let generation: number | undefined;
    try {
      const value = JSON.parse(readFileSync(legacyPath, 'utf8')) as {
        pending?: unknown[];
        outbound?: unknown[];
        lastUid?: unknown;
        generation?: unknown;
      } | null;
      const pendingList = value?.pending;
      const outboundList = value?.outbound;
      pending = Array.isArray(pendingList) ? pendingList.length : 0;
      // Only segments whose delivery status is UNKNOWN count toward the
      // outbound loss: a definitive receipt (accepted/rejected) proves the
      // outcome, but an absent receipt — or one whose outcome is 'unknown' —
      // does not, so both still count (mirrors the GitHub store; an
      // {outcome:'unknown'} receipt is not a known outcome).
      outbound = Array.isArray(outboundList)
        ? outboundList.filter((segment) => {
            const receipt =
              segment && typeof segment === 'object'
                ? (segment as { receipt?: { outcome?: unknown } }).receipt
                : undefined;
            return !(
              receipt &&
              (receipt.outcome === 'accepted' || receipt.outcome === 'rejected')
            );
          }).length
        : 0;
      lastUid = typeof value?.lastUid === 'number' ? value.lastUid : undefined;
      generation =
        typeof value?.generation === 'number' ? value.generation : undefined;
    } catch {
      // A corrupt or unreadable legacy still strands; flag it so the caller
      // reports unknown counts and a possible loss, never a silent "empty".
      readable = false;
    }
    return {
      path: legacyPath,
      pending,
      outbound,
      readable,
      lastUid,
      generation,
    };
  }

  /**
   * Archive a reported legacy ledger so it is not re-announced on every later
   * start (and a second registration of the mailbox is not told the first
   * registration's claims were its own). Renaming — not deleting — keeps the
   * stranded claims inspectable, and a rollback that stages a fresh
   * `managed-state.json` is detected again on the next upgrade. This never
   * adopts the claims into the keyed ledger. Returns the archived path, or
   * undefined when there is nothing to archive or the rename fails (the file
   * then stays and is reported again next start — degraded, never a startup
   * failure).
   */
  archiveStrandedLegacy(): string | undefined {
    const legacyPath = join(this.directory, 'managed-state.json');
    if (!existsSync(legacyPath)) return undefined;
    const archived = `${legacyPath}.stranded-${randomUUID()}`;
    try {
      renameSync(legacyPath, archived);
      return archived;
    } catch {
      return undefined;
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
