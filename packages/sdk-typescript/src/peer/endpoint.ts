/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A program's place among the Qwen Code sessions running as this user.
 *
 * Starting an endpoint binds an inbox and publishes a session record, so
 * the program shows up in `qwen sessions ps` and in every session's
 * `list_agents`, can be addressed by name from `send_message`, and can
 * address sessions the same way. It also keeps a small ledger of what it
 * sent, so the receipts that come back can be read as state changes rather
 * than as a stream of unrelated notices.
 *
 * What the endpoint is trusted to do is not decided here. A message it
 * sends to a session is held for that session's user to review unless the
 * connection presents a controller token the user minted for this program
 * (`qwen sessions controllers add`). Nothing in the record — its `kind`, its
 * `name` — changes that.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { PeerSendError, sendPeerFrame } from './client.js';
import {
  advertisablePeerAddress,
  reachableEntries,
  resolvePeerTarget,
  suggestPeerNames,
  type PeerDirectoryEntry,
} from './directory.js';
import { describeError, PeerEndpointError } from './errors.js';
import {
  buildDeliveryStatusFrame,
  buildUserFrame,
  canonicalizeMsgId,
  type PeerControlFrame,
  type PeerDeliveryStatus,
  type PeerDropReason,
  type PeerFrame,
  type PeerMessagePriority,
  type PeerModeClass,
  type PeerUserFrame,
} from './frames.js';
import { readPidNamespaceId, readProcStartToken } from './identity.js';
import { startPeerInbox, type PeerInbox } from './inbox.js';
import { boundSessionName, flattenPeerLabel, peerRef } from './label.js';
import {
  isValidSessionKind,
  readLiveSessionRecords,
  removeOwnRecord,
  removeOwnRecordSync,
  resolveQwenHome,
  SESSION_REGISTRY_SCHEMA_VERSION,
  sessionRegistryDir,
  writeOwnRecord,
} from './registry.js';

/**
 * Sends remembered for their receipts. The oldest is forgotten first, so an
 * unanswered send stops being tracked after this many later ones.
 */
export const MAX_TRACKED_SENDS = 200;

/**
 * Received message ids remembered with the answer they got, so a sender
 * that retries an id is told the same thing again rather than having the
 * message handled twice.
 */
export const MAX_REMEMBERED_MESSAGES = 200;

export interface PeerEndpointOptions {
  /**
   * What sessions call this program. Flattened to one line and cut to 40
   * characters; it need not be unique.
   */
  name: string;
  /** What registered, for listings. Default `external`. */
  kind?: string;
  /** The working directory to record. Default `process.cwd()`. */
  cwd?: string;
  /** A stable id for this endpoint. Default: a fresh UUID. */
  sessionId?: string;
  /** Free text recorded as the writer's version. */
  version?: string;
  /** The Qwen home to join. Default `QWEN_HOME`, else `~/.qwen`. */
  qwenHome?: string;
  /** Bind the inbox exactly here instead of choosing a path. */
  socketPath?: string;
  /**
   * A controller token minted with `qwen sessions controllers add`. When
   * set, every send presents it, and sessions deliver what this program
   * sends without holding it for review.
   */
  controllerToken?: string;
  /**
   * Called for each message a session sends here. Without it, the endpoint
   * answers every message `refused`.
   */
  onMessage?: (message: PeerInboundMessage) => void | Promise<void>;
  /** Called when a receipt moves one of this endpoint's sends. */
  onReceipt?: (receipt: PeerReceipt) => void;
  /** Called when `onMessage` or `onReceipt` throws or rejects. */
  onError?: (error: Error) => void;
  /** Keep the process running while the endpoint is open. Default true. */
  keepAlive?: boolean;
  /**
   * Remove the record and the socket when the process exits through
   * `process.exit` or an empty event loop. Default true. A process killed
   * by a signal it does not handle leaves both behind; the next Qwen Code
   * session that lists the directory clears the record once the start
   * token proves this process is gone.
   */
  closeOnExit?: boolean;
}

export interface PeerInboundMessage {
  msgId: string;
  content: string;
  priority: PeerMessagePriority;
  /** The sender's inbox path. */
  from?: string;
  /** The name the sender gave. A claim. */
  fromName?: string;
  /** The review class the sender asserted. A claim. */
  fromMode?: PeerModeClass;
}

export interface PeerReceipt {
  msgId: string;
  /** The address the message was sent to, as {@link PeerEndpoint.send} took it. */
  address: string;
  status: PeerDeliveryStatus;
  previous: PeerDeliveryStatus | 'pending';
  /** Free text the recipient wrote for a person. Never parse it. */
  reason?: string;
  dropReason?: PeerDropReason;
}

/** A running session this endpoint can send to. */
export interface PeerSessionSummary {
  sessionId: string;
  name: string;
  ref: string;
  /** The shortest address that selects exactly this session. */
  address: string;
  cwd: string;
  pid: number;
  kind: string;
  startedAt: number;
}

export interface PeerSendOptions {
  /** `name`, `name [ref]`, `[ref]` or a bare ref. */
  to: string;
  content: string;
  priority?: PeerMessagePriority;
  /**
   * The review class to assert. A program that is not a coding session has
   * no honest value to give; leave it out, and use a controller token to be
   * delivered without review.
   */
  fromMode?: PeerModeClass;
}

export type PeerSendResult =
  | { kind: 'sent'; msgId: string; peer: PeerSessionSummary }
  /** The address names this endpoint. */
  | { kind: 'self' }
  | { kind: 'not-found'; suggestions: string[] }
  /** The address could mean several sessions; retry with one of these. */
  | { kind: 'ambiguous'; matches: string[] }
  | {
      kind: 'failed';
      peer: PeerSessionSummary;
      /** The errno behind the failure, when there is one. */
      code?: string;
      reason: string;
      /**
       * Present when the frame may still be read (the recipient accepted the
       * connection and stopped reading), so a receipt can still arrive.
       */
      msgId?: string;
    };

export interface AwaitReceiptOptions {
  /** Default 30 seconds. */
  timeoutMs?: number;
  /**
   * Wait past `held` for a decision. Without it, the first receipt of any
   * kind resolves the wait.
   */
  final?: boolean;
}

/** Receipt transitions a sent message can make; anything else is a repeat. */
const RECEIPT_TRANSITIONS: Record<
  PeerDeliveryStatus | 'pending',
  ReadonlySet<PeerDeliveryStatus>
> = {
  pending: new Set([
    'held',
    'delivered',
    'denied',
    'refused',
    'expired',
    'misaddressed',
    'dropped',
  ]),
  held: new Set(['delivered', 'denied', 'expired', 'misaddressed']),
  delivered: new Set(['expired', 'misaddressed']),
  denied: new Set(),
  refused: new Set(),
  expired: new Set(),
  misaddressed: new Set(),
  dropped: new Set(),
};

/**
 * Errnos that prove a frame never reached the recipient, so the ledger
 * forgets it. A timeout is not one: the bytes may sit in the recipient's
 * buffer and be read, and receipted, later.
 */
const NEVER_WRITTEN_CODES = new Set<string | undefined>([
  undefined,
  'ENOENT',
  'ECONNREFUSED',
  'EMSGSIZE',
  'EAGAIN',
  'EBUSY',
]);

interface TrackedSend {
  msgId: string;
  address: string;
  state: PeerDeliveryStatus | 'pending';
  last?: PeerReceipt;
  forgotten?: boolean;
  waiters: Set<() => void>;
}

/** Turn a send failure into something a caller can act on. */
export function describeSendFailure(error: unknown): string {
  if (error instanceof PeerSendError) {
    switch (error.code) {
      case 'ENOENT':
      case 'ECONNREFUSED':
        return 'that session has exited and its address is stale; list the sessions again';
      case 'EAGAIN':
      case 'EBUSY':
        return 'that session is alive but momentarily busy; retry shortly';
      case 'ETIMEDOUT':
        return 'that session accepted the connection but had not read the message after 5 seconds; it may still read it, so wait for a receipt rather than re-sending';
      default:
        return error.message;
    }
  }
  return describeError(error);
}

export class PeerEndpoint {
  readonly sessionId: string;
  readonly name: string;
  readonly ref: string;
  readonly kind: string;
  readonly cwd: string;
  /**
   * The token this endpoint's inbox requires. Anyone who can read the
   * registry can read it; never print it where a model or a log sees it.
   */
  readonly ipcToken: string;
  /** Where this endpoint reads and writes session records. */
  readonly registryDir: string;
  readonly startedAt: number;

  private readonly options: PeerEndpointOptions;
  private inbox!: PeerInbox;
  private recordFile!: string;
  private exitHook: (() => void) | undefined;
  private closed = false;
  private readonly sends = new Map<string, TrackedSend>();
  private readonly answered = new Map<string, PeerDeliveryStatus>();

  private constructor(
    options: PeerEndpointOptions,
    name: string,
    kind: string,
    sessionId: string,
  ) {
    this.options = options;
    this.name = name;
    this.kind = kind;
    this.sessionId = sessionId;
    this.ref = peerRef(sessionId);
    this.cwd = options.cwd ?? process.cwd();
    this.ipcToken = randomBytes(32).toString('hex');
    this.registryDir = sessionRegistryDir(resolveQwenHome(options.qwenHome));
    this.startedAt = Date.now();
  }

  /**
   * Bind an inbox and publish this endpoint's record.
   *
   * The inbox is bound first: a record is listed the moment it lands, and
   * one that named no inbox yet would be a session nobody can reach. If the
   * record cannot be written, the inbox is closed again and nothing is left
   * behind.
   */
  static async start(options: PeerEndpointOptions): Promise<PeerEndpoint> {
    const name = boundSessionName(options.name ?? '');
    if (name.length === 0) {
      throw new PeerEndpointError(
        'invalid-name',
        'a peer endpoint needs a name that is not blank once flattened to one line',
      );
    }
    const kind = options.kind ?? 'external';
    if (!isValidSessionKind(kind)) {
      throw new PeerEndpointError(
        'invalid-kind',
        `"${kind}" is not a kind: use lowercase letters, digits and dashes, starting with a letter, at most 16 characters`,
      );
    }
    const sessionId = options.sessionId ?? randomUUID();
    if (sessionId.trim().length === 0) {
      throw new PeerEndpointError(
        'invalid-session-id',
        'a peer endpoint needs a session id that is not blank',
      );
    }

    // On Linux a record without both of these is worse than none: readers
    // cannot tell it from another namespace's, so they never list it and
    // never clear it away. They are re-read once because the first read
    // can land on a moment of descriptor pressure.
    let procStart = readProcStartToken(process.pid);
    let pidNs = readPidNamespaceId();
    if (
      process.platform === 'linux' &&
      (procStart === null || pidNs === null)
    ) {
      procStart = readProcStartToken(process.pid);
      pidNs = readPidNamespaceId();
      if (procStart === null || pidNs === null) {
        throw new PeerEndpointError(
          'registry-unwritable',
          'could not read this process start token or PID namespace, and a record without them could not be told apart from another process',
        );
      }
    }

    const endpoint = new PeerEndpoint(options, name, kind, sessionId);
    endpoint.inbox = await startPeerInbox({
      ...(options.socketPath !== undefined
        ? { socketPath: options.socketPath }
        : {}),
      requiredToken: endpoint.ipcToken,
      onFrame: (frame) => endpoint.handleFrame(frame),
      keepAlive: options.keepAlive ?? true,
    });
    try {
      endpoint.recordFile = await writeOwnRecord(endpoint.registryDir, {
        schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
        pid: process.pid,
        procStart,
        pidNs,
        sessionId,
        cwd: endpoint.cwd,
        name,
        startedAt: endpoint.startedAt,
        qwenVersion: options.version ?? null,
        kind,
        ipcPath: endpoint.inbox.socketPath,
        ipcToken: endpoint.ipcToken,
      });
    } catch (error) {
      await endpoint.inbox.close();
      throw new PeerEndpointError(
        'registry-unwritable',
        `could not write the session record in ${endpoint.registryDir}: ${describeError(error)}`,
      );
    }

    if (options.closeOnExit ?? true) {
      const hook = () => endpoint.closeSync();
      endpoint.exitHook = hook;
      process.once('exit', hook);
    }
    return endpoint;
  }

  /** The socket this endpoint listens on. */
  get ipcPath(): string {
    return this.inbox.socketPath;
  }

  /** The record file this endpoint published. */
  get recordPath(): string {
    return this.recordFile;
  }

  /**
   * The sessions this endpoint can send to right now: live, answering a
   * dial, and not this endpoint. A session whose `agents.crossSessionMessaging`
   * is off has no inbox and is not listed.
   */
  async list(): Promise<PeerSessionSummary[]> {
    this.assertOpen();
    const peers = this.othersIn(await this.directory());
    return peers.flatMap((peer) => {
      const address = advertisablePeerAddress(peer, peers);
      return address === undefined ? [] : [summarize(peer, address)];
    });
  }

  /**
   * Send `content` to the session `to` names.
   *
   * `sent` means the frame was written, not that anyone read it; the
   * receipts that follow say what became of it (see
   * {@link PeerEndpoint.awaitReceipt}).
   */
  async send(options: PeerSendOptions): Promise<PeerSendResult> {
    this.assertOpen();
    const directory = await this.directory();
    const peers = this.othersIn(directory);
    const resolved = resolvePeerTarget(peers, options.to);

    if (resolved.kind === 'none') {
      const incarnations = [
        this.selfEntry(),
        ...directory.filter((peer) => peer.sessionId === this.sessionId),
      ];
      if (resolvePeerTarget(incarnations, options.to).kind !== 'none') {
        return { kind: 'self' };
      }
      return {
        kind: 'not-found',
        suggestions: suggestPeerNames(peers, options.to),
      };
    }
    if (resolved.kind === 'ambiguous') {
      return {
        kind: 'ambiguous',
        matches: resolved.matches.map(
          (peer) =>
            advertisablePeerAddress(peer, peers) ??
            `${peer.name} [${peer.ref}]`,
        ),
      };
    }

    const peer = resolved.peer;
    const summary = summarize(
      peer,
      advertisablePeerAddress(peer, peers) ?? options.to.trim(),
    );
    if (options.content.length === 0) {
      return {
        kind: 'failed',
        peer: summary,
        reason: 'the message is empty; there is nothing to deliver',
      };
    }

    const frame = buildUserFrame({
      content: options.content,
      from: this.ipcPath,
      replyToken: this.ipcToken,
      fromName: this.name,
      // Pins the frame to the session the address resolved to. Addresses
      // are keyed by PID and PIDs are reused: a different session found at
      // that address later answers `misaddressed` instead of acting on a
      // message meant for its predecessor.
      toSessionId: peer.sessionId,
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.fromMode !== undefined ? { fromMode: options.fromMode } : {}),
    });
    const authToken = this.options.controllerToken ?? peer.ipcToken;
    // Tracked before the write: a recipient that is slow to read can still
    // receipt a frame whose send timed out here.
    this.track(frame.msgId, summary.address);
    try {
      await sendPeerFrame(
        peer.ipcPath,
        frame,
        authToken !== undefined ? { authToken } : {},
      );
      return { kind: 'sent', msgId: frame.msgId, peer: summary };
    } catch (error) {
      const code = error instanceof PeerSendError ? error.code : undefined;
      const unwritten = NEVER_WRITTEN_CODES.has(code);
      if (unwritten) this.forget(frame.msgId);
      return {
        kind: 'failed',
        peer: summary,
        ...(code !== undefined ? { code } : {}),
        reason: describeSendFailure(error),
        ...(unwritten ? {} : { msgId: frame.msgId }),
      };
    }
  }

  /**
   * The receipt for a message this endpoint sent.
   *
   * Resolves at once when one has already arrived. With `final`, waits past
   * `held` for the decision. Resolves `undefined` on timeout, when the id is
   * not one this endpoint is tracking, and when the endpoint closes.
   */
  awaitReceipt(
    msgId: string,
    options: AwaitReceiptOptions = {},
  ): Promise<PeerReceipt | undefined> {
    const entry = this.sends.get(canonicalizeMsgId(msgId));
    if (!entry) return Promise.resolve(undefined);
    const final = options.final ?? false;
    const satisfied = () =>
      entry.last !== undefined &&
      (!final || (entry.state !== 'pending' && entry.state !== 'held'));
    if (satisfied()) return Promise.resolve(entry.last);
    if (this.closed) return Promise.resolve(undefined);

    return new Promise((resolve) => {
      const finish = (receipt: PeerReceipt | undefined) => {
        clearTimeout(timer);
        entry.waiters.delete(wake);
        resolve(receipt);
      };
      const wake = () => {
        if (satisfied()) finish(entry.last);
        else if (this.closed || entry.forgotten) finish(undefined);
      };
      const timer = setTimeout(
        () => finish(undefined),
        options.timeoutMs ?? 30_000,
      );
      entry.waiters.add(wake);
    });
  }

  /**
   * Stop listening and remove this endpoint's record and socket. Pending
   * {@link PeerEndpoint.awaitReceipt} calls resolve `undefined`. Safe to
   * call more than once.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.beginClose();
    await this.inbox.close();
    await removeOwnRecord(this.recordFile, this.sessionId);
  }

  private closeSync(): void {
    if (this.closed) return;
    this.beginClose();
    this.inbox.closeSync();
    removeOwnRecordSync(this.recordFile, this.sessionId);
  }

  private beginClose(): void {
    this.closed = true;
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook);
      this.exitHook = undefined;
    }
    for (const entry of this.sends.values()) wakeAll(entry);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new PeerEndpointError('closed', 'this peer endpoint is closed');
    }
  }

  private async directory(): Promise<PeerDirectoryEntry[]> {
    return reachableEntries(await readLiveSessionRecords(this.registryDir));
  }

  /**
   * Everyone but this endpoint. Excluded by session id, so another process
   * running with the same id — which an endpoint given a stable
   * `sessionId` can be — is excluded too, rather than messaged as a peer.
   */
  private othersIn(
    directory: readonly PeerDirectoryEntry[],
  ): PeerDirectoryEntry[] {
    return directory.filter((peer) => peer.sessionId !== this.sessionId);
  }

  private selfEntry(): PeerDirectoryEntry {
    return {
      sessionId: this.sessionId,
      name: this.name,
      ref: this.ref,
      cwd: flattenPeerLabel(this.cwd),
      pid: process.pid,
      kind: this.kind,
      ipcPath: this.ipcPath,
      ipcToken: this.ipcToken,
      startedAt: this.startedAt,
    };
  }

  private track(msgId: string, address: string): void {
    this.sends.set(canonicalizeMsgId(msgId), {
      msgId,
      address,
      state: 'pending',
      waiters: new Set(),
    });
    while (this.sends.size > MAX_TRACKED_SENDS) {
      const oldest = this.sends.keys().next().value;
      if (oldest === undefined) break;
      this.forget(oldest);
    }
  }

  private forget(msgId: string): void {
    const key = canonicalizeMsgId(msgId);
    const entry = this.sends.get(key);
    if (!entry) return;
    this.sends.delete(key);
    entry.forgotten = true;
    wakeAll(entry);
  }

  private handleFrame(frame: PeerFrame): void {
    if (this.closed) return;
    if (frame.type === 'control') {
      this.applyReceipt(frame);
    } else {
      this.receive(frame);
    }
  }

  private applyReceipt(frame: PeerControlFrame): void {
    this.settle(frame.origMsgId, frame);
    if (frame.status !== 'dropped') return;
    // One drop receipt can stand for a burst. The transition table only
    // lets a still-pending message become dropped, so an id in the list
    // that already moved on is left where it is.
    for (const msgId of frame.droppedMsgIds ?? []) this.settle(msgId, frame);
  }

  private settle(msgId: string, frame: PeerControlFrame): void {
    const entry = this.sends.get(canonicalizeMsgId(msgId));
    // A receipt names an id, and anything that can reach this inbox can
    // write one for any id. Only ids this endpoint sent are answered for,
    // and only a receipt that moves the message is reported.
    if (!entry || !RECEIPT_TRANSITIONS[entry.state].has(frame.status)) return;
    const receipt: PeerReceipt = {
      msgId: entry.msgId,
      address: entry.address,
      status: frame.status,
      previous: entry.state,
      ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
      ...(frame.dropReason !== undefined
        ? { dropReason: frame.dropReason }
        : {}),
    };
    entry.state = frame.status;
    entry.last = receipt;
    wakeAll(entry);
    const onReceipt = this.options.onReceipt;
    if (onReceipt) this.invoke(() => onReceipt(receipt));
  }

  private receive(frame: PeerUserFrame): void {
    const key = canonicalizeMsgId(frame.msgId);
    const answered = this.answered.get(key);
    if (answered !== undefined) {
      this.reply(frame, answered);
      return;
    }
    // A frame pinned to another session was written for whoever held this
    // address before. Not remembered: the id belongs to that session.
    if (
      frame.toSessionId !== undefined &&
      frame.toSessionId !== this.sessionId
    ) {
      this.reply(frame, 'misaddressed');
      return;
    }
    const onMessage = this.options.onMessage;
    const status: PeerDeliveryStatus = onMessage ? 'delivered' : 'refused';
    this.answered.set(key, status);
    while (this.answered.size > MAX_REMEMBERED_MESSAGES) {
      const oldest = this.answered.keys().next().value;
      if (oldest === undefined) break;
      this.answered.delete(oldest);
    }
    // Answered before the handler runs, so the sender is not kept waiting
    // on whatever the handler does with the message.
    this.reply(frame, status);
    if (!onMessage) return;
    const message: PeerInboundMessage = {
      msgId: frame.msgId,
      content: frame.message.content,
      priority: frame.priority,
      ...(frame.from !== undefined ? { from: frame.from } : {}),
      ...(frame.fromName !== undefined
        ? { fromName: flattenPeerLabel(frame.fromName) }
        : {}),
      ...(frame.fromMode !== undefined ? { fromMode: frame.fromMode } : {}),
    };
    this.invoke(() => onMessage(message));
  }

  /**
   * Best-effort: a sender that has exited, or that gave no address, simply
   * never hears back.
   */
  private reply(frame: PeerUserFrame, status: PeerDeliveryStatus): void {
    if (!frame.from) return;
    sendPeerFrame(
      frame.from,
      buildDeliveryStatusFrame({
        status,
        origMsgId: frame.msgId,
        from: this.ipcPath,
      }),
      frame.replyToken !== undefined ? { authToken: frame.replyToken } : {},
    ).catch(() => {});
  }

  private invoke(callback: () => void | Promise<void>): void {
    try {
      const result = callback();
      if (result instanceof Promise) {
        result.catch((error: unknown) => this.reportError(error));
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    const onError = this.options.onError;
    if (!onError) return;
    try {
      onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Nowhere left to report it.
    }
  }
}

function wakeAll(entry: TrackedSend): void {
  for (const wake of [...entry.waiters]) wake();
}

function summarize(
  peer: PeerDirectoryEntry,
  address: string,
): PeerSessionSummary {
  return {
    sessionId: peer.sessionId,
    name: peer.name,
    ref: peer.ref,
    address,
    cwd: peer.cwd,
    pid: peer.pid,
    kind: peer.kind,
    startedAt: peer.startedAt,
  };
}
