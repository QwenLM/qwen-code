// Force strict mode and setup for ESM
"use strict";
import {
  DropNoticeThrottle,
  DropReceiptCoalescer,
  getPeerControllerRegistryPath,
  readPeerControllerRegistrySync,
  resolveControllerToken,
  startPeerInbox
} from "./chunk-47GVX3K4.js";
import {
  InboundGate,
  MAX_HELD_MESSAGES,
  PEER_ADMISSION_LIMITS,
  canonicalizeMsgId,
  drainSendPacer,
  forgetSendPacerMessages,
  peerSenderKey,
  refundSendPacerMessage,
  refundSendPacerToken,
  sendDeliveryStatus,
  settleSentPeerMessage
} from "./chunk-O4A2B6V2.js";
import {
  formatPeerDisplay,
  formatPeerEnvelope
} from "./chunk-GHG4PQY2.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  MESSAGING_SOCKET_ENV,
  MESSAGING_TOKEN_ENV,
  clearInheritedPeerMessagingEnv
} from "./chunk-V5U2NZNJ.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/peerMessaging/peer-messaging.ts
init_esbuild_shims();
import { randomBytes } from "node:crypto";
var debugLogger = createDebugLogger("PEER_MESSAGING");
var MAX_ACCEPTED_BACKLOG = MAX_HELD_MESSAGES;
var CLOSE_DROP_FLUSH_BOUND_MS = 1e3;
var MAX_UNHEARD_DROP_NOTICES = 20;
var RECEIVER_REFILL_MS = PEER_ADMISSION_LIMITS.bucketCapacity / PEER_ADMISSION_LIMITS.refillPerSecond * 1e3;
var PeerMessaging = class _PeerMessaging {
  static {
    __name(this, "PeerMessaging");
  }
  inbox = null;
  gate = null;
  updateSessionRegistryIpcPath = /* @__PURE__ */ __name(async () => {
  }, "updateSessionRegistryIpcPath");
  getSessionId = null;
  ownsSessionId = null;
  settleSentMessage = settleSentPeerMessage;
  reassertSessionRecord = null;
  drainMirror = drainSendPacer;
  forgetMirror = forgetSendPacerMessages;
  refundMirror = refundSendPacerMessage;
  refundMirrorToken = refundSendPacerToken;
  receiptListeners = /* @__PURE__ */ new Set();
  dropListeners = /* @__PURE__ */ new Set();
  /** Notices raised before anything subscribed; see `onDropped`. */
  unheardDrops = [];
  /** Folds dropped receipts so a flood draws few connections, not many. */
  dropReceipts = null;
  submitFn = null;
  buffered = [];
  controllerRegistryPath = null;
  validControllerIds = null;
  /**
   * Accepted frames whose 'delivered' receipt has not been earned yet:
   * still buffered here or still queued in the session's input queue.
   * Settled with a corrective receipt at close.
   */
  outstanding = [];
  queuedPeerCount = null;
  heldListeners = /* @__PURE__ */ new Set();
  listedHeld = null;
  closed = false;
  // Options are consumed by `start`, which wires them into the gate and the
  // inbox; the instance itself holds none of them.
  constructor() {
  }
  /**
   * Bind the socket and start accepting messages.
   *
   * Returns null when the inbox could not be bound. Callers treat that as
   * "this session is not reachable" and carry on — it is never fatal.
   */
  static async start(options) {
    if (options.getSessionId && options.ownsSessionId) {
      throw new Error(
        "PeerMessaging: pass getSessionId or ownsSessionId, not both"
      );
    }
    const messaging = new _PeerMessaging();
    const controllerRegistryPath = options.controllerRegistryPath ?? getPeerControllerRegistryPath();
    messaging.controllerRegistryPath = controllerRegistryPath;
    const dropReceipts = new DropReceiptCoalescer(
      ({ frame, reason, droppedMsgIds }) => {
        if (!frame.from) return;
        return sendDeliveryStatus(
          frame.from,
          {
            status: "dropped",
            origMsgId: frame.msgId,
            from: messaging.inbox?.socketPath,
            dropReason: reason,
            droppedMsgIds
          },
          frame.replyToken
        );
      },
      options.dropReceiptTrailMs !== void 0 ? { trailMs: options.dropReceiptTrailMs } : {}
    );
    messaging.dropReceipts = dropReceipts;
    const dropNotices = new DropNoticeThrottle(
      (notice) => messaging.emitDropped(notice)
    );
    const gate = new InboundGate({
      getApprovalMode: options.getApprovalMode,
      getPolicySetting: options.getPolicySetting,
      ...options.getHeldExpiryMs !== void 0 ? { getHeldExpiryMs: options.getHeldExpiryMs } : {},
      ...options.getPolicyScope ? { getPolicyScope: options.getPolicyScope } : {},
      isControllerValid: /* @__PURE__ */ __name((id) => messaging.validControllerIds?.has(id) ?? true, "isControllerValid"),
      ...options.admission ? { admission: options.admission } : {},
      getSessionId: options.getSessionId,
      ...options.ownsSessionId ? { ownsSessionId: options.ownsSessionId } : {},
      deliver: /* @__PURE__ */ __name((frame, origin) => messaging.deliver(frame, origin), "deliver"),
      reportDropped: /* @__PURE__ */ __name((frame, reason, origin) => dropReceipts.note(frame, origin ?? { selfSent: false }, reason), "reportDropped"),
      onDropped: /* @__PURE__ */ __name((frame, origin, reason) => dropNotices.note(frame, origin, reason), "onDropped"),
      reportStatus: /* @__PURE__ */ __name((frame, status) => {
        if (!frame.from) return;
        return sendDeliveryStatus(
          frame.from,
          {
            status,
            origMsgId: frame.msgId,
            from: messaging.inbox?.socketPath
          },
          frame.replyToken
        );
      }, "reportStatus"),
      onHeldChange: /* @__PURE__ */ __name((held) => messaging.emitHeldChange(held), "onHeldChange")
    });
    messaging.gate = gate;
    messaging.getSessionId = options.getSessionId ?? null;
    messaging.ownsSessionId = options.ownsSessionId ?? null;
    messaging.settleSentMessage = options.settleSentMessage ?? settleSentPeerMessage;
    messaging.reassertSessionRecord = options.reassertSessionRecord ?? null;
    messaging.drainMirror = options.drainMirror ?? drainSendPacer;
    messaging.forgetMirror = options.forgetMirror ?? forgetSendPacerMessages;
    messaging.refundMirror = options.refundMirror ?? refundSendPacerMessage;
    messaging.refundMirrorToken = options.refundMirrorToken ?? refundSendPacerToken;
    clearInheritedPeerMessagingEnv();
    const ipcToken = options.ipcToken ?? randomBytes(32).toString("hex");
    const childToken = options.childToken ?? randomBytes(32).toString("hex");
    const inbox = await startPeerInbox({
      ...options.socketPath !== void 0 ? { socketPath: options.socketPath } : {},
      requiredToken: ipcToken,
      childToken,
      // Read from disk per auth line rather than captured here: a grant
      // the user mints or revokes mid-session must take effect on the
      // next connection, with nothing to restart.
      resolveController: /* @__PURE__ */ __name((presented) => resolveControllerToken(presented, controllerRegistryPath), "resolveController"),
      onFrame: /* @__PURE__ */ __name((frame, auth, controller) => messaging.onFrame(frame, {
        selfSent: auth === "child",
        ...controller ? { controller } : {}
      }), "onFrame")
    });
    if (!inbox) return null;
    messaging.inbox = inbox;
    messaging.updateSessionRegistryIpcPath = options.updateSessionRegistryIpcPath;
    await messaging.updateSessionRegistryIpcPath(inbox.socketPath, ipcToken);
    process.env[MESSAGING_SOCKET_ENV] = inbox.socketPath;
    process.env[MESSAGING_TOKEN_ENV] = childToken;
    return messaging;
  }
  get socketPath() {
    return this.inbox?.socketPath;
  }
  /**
   * Register the TUI's submit function and flush anything accepted before
   * the queue existed.
   */
  setSubmitFn(fn) {
    if (this.closed) return;
    this.withControllerValidity(() => {
      this.submitFn = fn;
      while (this.buffered.length > 0) {
        const head = this.buffered[0];
        if (!head || !this.submit(head.frame, head.origin)) break;
        this.buffered.shift();
      }
    });
  }
  /**
   * Register a counter for the peer entries still waiting in the
   * session's input queue. At close, that many of the most recently
   * submitted frames are settled alongside the buffered ones: the queue
   * drains in order, so the unconsumed tail is exactly the queue's
   * current depth.
   */
  setQueuedPeerCount(fn) {
    this.queuedPeerCount = fn;
  }
  getHeld() {
    return this.withControllerValidity(() => this.gate?.getHeld() ?? []);
  }
  /**
   * How long a held message has to live, in milliseconds, or null when
   * holds do not expire. Used by `/peers` to show what is left.
   */
  getHeldExpiryMs() {
    return this.gate?.getHeldExpiryMs() ?? null;
  }
  /**
   * Remember the held entries the `/peers` listing just showed the user.
   *
   * Accept/deny decisions are bound to this snapshot: the held set moves
   * between listing and decision (arrivals, evictions, releases), and a
   * handle that uniquely named the message the user reviewed must not
   * resolve to a different one by decide time. The snapshot pins each
   * entry's `heldAt` as well as its id: once an id's eviction tombstone
   * is pruned from the gate's bounded settled-memory, a peer can re-send
   * it with a swapped body, and only the fresh hold timestamp tells the
   * re-admitted entry apart from the one the user reviewed.
   */
  recordHeldListing(heldEntries) {
    this.listedHeld = heldEntries.map((entry) => ({
      id: entry.frame.msgId,
      heldAt: entry.heldAt
    }));
  }
  /**
   * True when the held set no longer matches the last recorded listing.
   *
   * Entries *leaving* the set are not a change. The expiry timer removes
   * them with no peer or user activity -- a fourth mover the rationale
   * above does not name -- and a shrinking set can never make a printed
   * handle resolve to a different message: `resolveHeld` prefix-matches
   * over the current set, so removing entries only narrows it. Bouncing
   * those refuses a decision that would have been correct, and tells the
   * user the list changed when what they can still uniquely name is
   * exactly what they reviewed.
   *
   * Dropping an expired entry is safe because the gate tombstones it
   * before it leaves the set, so a re-admitted id arrives with a fresh
   * `heldAt` and still mismatches the pin below.
   *
   * What must still bounce: an arrival, and a re-sent id whose body may
   * have been swapped, which the `heldAt` pin is what catches.
   */
  heldSetChangedSinceListing() {
    const listed = this.listedHeld;
    if (listed === null) return true;
    const pinned = new Map(listed.map((entry) => [entry.id, entry.heldAt]));
    const current = this.getHeld();
    if (current.some((entry) => pinned.get(entry.frame.msgId) !== entry.heldAt))
      return true;
    const liveIds = current.map(
      (entry) => canonicalizeMsgId(entry.frame.msgId)
    );
    const liveSet = new Set(liveIds);
    for (const id of pinned.keys()) {
      const departed = canonicalizeMsgId(id);
      if (liveSet.has(departed)) continue;
      if (liveIds.some((live) => live.startsWith(departed))) return true;
    }
    return false;
  }
  decide(msgId, decision) {
    return this.withControllerValidity(
      () => this.gate?.decide(msgId, decision) ?? "gone"
    );
  }
  /** Remove a revoked grant's authority from messages already waiting. */
  forgetController(id) {
    return this.withControllerValidity(
      () => this.gate?.forgetController(id) ?? 0
    );
  }
  /** Release everything the gate now considers acceptable. */
  reevaluate(reason) {
    return this.withControllerValidity(
      () => this.gate?.reevaluate(reason) ?? 0
    );
  }
  onHeldChange(listener) {
    this.heldListeners.add(listener);
    try {
      listener(this.getHeld());
    } catch (error) {
      debugLogger.debug(
        `held-change listener threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return () => this.heldListeners.delete(listener);
  }
  /** Subscribe to receipts for messages this session sent. */
  onReceipt(listener) {
    this.receiptListeners.add(listener);
    return () => this.receiptListeners.delete(listener);
  }
  /**
   * Subscribe to notices about messages this session turned away.
   *
   * Already throttled when they get here: one per sender per minute,
   * carrying the count of what it stands for.
   */
  onDropped(listener) {
    const first = this.dropListeners.size === 0;
    this.dropListeners.add(listener);
    if (first && this.unheardDrops.length > 0) {
      const unheard = this.unheardDrops.splice(0, this.unheardDrops.length);
      for (const notice of unheard) {
        try {
          listener(notice);
        } catch (error) {
          debugLogger.debug(
            `drop listener threw on replay: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    return () => this.dropListeners.delete(listener);
  }
  emitDropped(notice) {
    if (this.dropListeners.size === 0) {
      if (this.unheardDrops.length < MAX_UNHEARD_DROP_NOTICES) {
        this.unheardDrops.push(notice);
      }
      return;
    }
    for (const listener of this.dropListeners) {
      try {
        listener(notice);
      } catch (error) {
        debugLogger.debug(
          `drop listener threw: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  emitReceipt(receipt) {
    for (const listener of this.receiptListeners) {
      try {
        listener(receipt);
      } catch (error) {
        debugLogger.debug(
          `receipt listener threw: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const shuttingDown = this.gate?.shutdown();
    await this.inbox?.close();
    await shuttingDown;
    await this.settleUnconsumed();
    clearInheritedPeerMessagingEnv();
    await this.updateSessionRegistryIpcPath(void 0);
    await this.dropReceipts?.flush(CLOSE_DROP_FLUSH_BOUND_MS);
    this.dropReceipts?.dispose();
  }
  /**
   * Correct the 'delivered' receipts of accepted messages the session
   * never consumed. Without this, a sender told "delivered" about a
   * message that dies in the buffer or the input queue at exit cannot
   * tell that from "delivered and read" — the distinction the receipts
   * exist to carry.
   */
  async settleUnconsumed() {
    const queued = this.queuedPeerCount?.() ?? 0;
    const dropped = this.outstanding.slice(
      Math.max(0, this.outstanding.length - this.buffered.length - queued)
    );
    const receipts = dropped.filter((frame) => frame.from !== void 0).map(
      (frame) => sendDeliveryStatus(
        frame.from,
        {
          status: "expired",
          origMsgId: frame.msgId,
          from: this.inbox?.socketPath
        },
        frame.replyToken
      )
    );
    await Promise.allSettled(receipts);
  }
  /**
   * Apply a receipt that says a burst of this session's messages was
   * turned away at the far inbox.
   *
   * Every id it names is settled, but only ids this session actually sent
   * and has not settled already — the same rule every other receipt
   * follows, applied to a list. A receipt that moves nothing is noise
   * from a stranger, or a repeat, and says nothing to the user.
   *
   * One notice for the whole batch: the point of folding the receipt was
   * that a flood must not become a flood of lines, and unfolding it here
   * would undo that.
   */
  onDroppedReceipt(frame) {
    const ids = [frame.origMsgId, ...frame.droppedMsgIds ?? []];
    let first;
    let settledCount = 0;
    const settledByPath = /* @__PURE__ */ new Map();
    for (const id of ids) {
      const settled = this.settleSentMessage(id, "dropped");
      if (!settled) continue;
      first ??= settled;
      settledCount += 1;
      const entry = settledByPath.get(settled.ipcPath) ?? {
        ids: [],
        freshestAgeMs: Number.POSITIVE_INFINITY
      };
      entry.ids.push(id);
      entry.freshestAgeMs = Math.min(entry.freshestAgeMs, settled.ageMs);
      settledByPath.set(settled.ipcPath, entry);
    }
    if (!first) {
      debugLogger.debug(
        `ignoring dropped receipt for ${frame.origMsgId}: unknown message or repeated receipt`
      );
      return;
    }
    debugLogger.debug(
      `dropped receipt from ${first.address} (${frame.dropReason ?? "unspecified"}) settled ${settledCount} message(s)`
    );
    if (frame.dropReason === "duplicate") {
      for (const [ipcPath, entry] of settledByPath) {
        for (const id of entry.ids) this.refundMirrorToken(ipcPath, id);
      }
    } else {
      for (const [ipcPath, entry] of settledByPath) {
        this.forgetMirror(ipcPath, entry.ids);
      }
    }
    if (frame.dropReason === "rate-limited") {
      for (const [ipcPath, entry] of settledByPath) {
        if (entry.freshestAgeMs <= RECEIVER_REFILL_MS)
          this.drainMirror(ipcPath);
      }
    }
    this.emitReceipt({
      status: "dropped",
      address: first.address,
      origMsgId: frame.origMsgId,
      // A drop can only follow `pending`; the ledger enforced that above.
      previous: "pending",
      ...frame.dropReason ? { dropReason: frame.dropReason } : {},
      dropped: settledCount
    });
  }
  /**
   * `origin` is what the transport established from the connection's auth
   * line — the child token, or a controller grant the user minted. None
   * of it is ever read off the frame.
   */
  onFrame(frame, origin) {
    if (frame.type === "control") {
      if (frame.status === "dropped") {
        this.onDroppedReceipt(frame);
        return;
      }
      const settled = this.settleSentMessage(frame.origMsgId, frame.status);
      if (!settled) {
        debugLogger.debug(
          `ignoring delivery status ${frame.status} for ${frame.origMsgId}: unknown message or repeated receipt`
        );
        return;
      }
      debugLogger.debug(
        `delivery status from ${settled.address}: ${settled.previous} -> ${frame.status} for ${frame.origMsgId}`
      );
      if (frame.status !== "held" && frame.status !== "delivered") {
        if (frame.status === "misaddressed") {
          this.refundMirror(settled.ipcPath, frame.origMsgId);
        } else {
          this.forgetMirror(settled.ipcPath, [frame.origMsgId]);
        }
      }
      this.emitReceipt({
        status: frame.status,
        address: settled.address,
        origMsgId: frame.origMsgId,
        previous: settled.previous
      });
      return;
    }
    const ownSessionId = this.getSessionId?.();
    const ownsSessionId = this.ownsSessionId;
    const misaddressed = ownsSessionId ? (
      // Hosting several sessions: a frame has to say which, and name one
      // this process still holds.
      frame.toSessionId === void 0 || !ownsSessionId(frame.toSessionId)
    ) : frame.toSessionId !== void 0 && ownSessionId !== void 0 && frame.toSessionId !== ownSessionId;
    if (misaddressed) {
      debugLogger.debug(
        `refusing peer message ${frame.msgId}: addressed to session ${frame.toSessionId ?? "(unspecified)"}, this process does not hold it`
      );
      if (frame.from) {
        void sendDeliveryStatus(
          frame.from,
          {
            status: "misaddressed",
            origMsgId: frame.msgId,
            from: this.inbox?.socketPath
          },
          frame.replyToken
        );
      }
      void this.reassertSessionRecord?.().catch((error) => {
        debugLogger.debug(
          `re-asserting the session record failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }
    this.gate?.admit(frame, origin);
  }
  deliver(frame, origin) {
    if (!this.submitFn) {
      if (this.buffered.length >= MAX_ACCEPTED_BACKLOG) {
        throw new Error("accepted-message backlog is full");
      }
      this.buffered.push({ frame, origin });
      this.trackOutstanding(frame);
      return;
    }
    if (this.buffered.length > 0) {
      this.withControllerValidity(() => {
        while (this.buffered.length > 0) {
          const head = this.buffered[0];
          if (!head || !this.submit(head.frame, head.origin)) {
            throw new Error("accepted-message backlog is full");
          }
          this.buffered.shift();
        }
      });
    }
    if (!this.submit(frame, origin)) {
      throw new Error("accepted-message backlog is full");
    }
    this.trackOutstanding(frame);
  }
  trackOutstanding(frame) {
    this.outstanding.push(frame);
    while (this.outstanding.length > 2 * MAX_ACCEPTED_BACKLOG) {
      this.outstanding.shift();
    }
  }
  withControllerValidity(action) {
    if (this.controllerRegistryPath === null || this.validControllerIds) {
      return action();
    }
    this.validControllerIds = new Set(
      readPeerControllerRegistrySync(
        this.controllerRegistryPath
      ).controllers.map((controller) => controller.id)
    );
    for (const delivery of this.buffered) {
      const controller = delivery.origin.controller;
      if (controller && !this.validControllerIds.has(controller.id)) {
        delete delivery.origin.controller;
      }
    }
    try {
      return action();
    } finally {
      this.validControllerIds = null;
    }
  }
  submit(frame, origin) {
    const from = frame.from ?? (origin.controller ? "controller" : origin.selfSent ? "own process" : "unknown session");
    const attribution = {
      selfSent: origin.selfSent,
      ...origin.controller ? { controller: origin.controller } : {}
    };
    return this.submitFn?.(
      formatPeerEnvelope({
        from,
        ...frame.fromName !== void 0 ? { fromName: frame.fromName } : {},
        content: frame.message.content,
        ...attribution
      }),
      formatPeerDisplay({
        from,
        ...frame.fromName !== void 0 ? { fromName: frame.fromName } : {},
        content: frame.message.content,
        ...attribution
      }),
      {
        msgId: frame.msgId,
        admissionKey: peerSenderKey(frame, origin),
        ...frame.from !== void 0 ? { from: frame.from } : {},
        ...frame.replyToken !== void 0 ? { replyToken: frame.replyToken } : {},
        ...frame.toSessionId !== void 0 ? { toSessionId: frame.toSessionId } : {}
      }
    ) ?? false;
  }
  /** Drop a queued frame if an in-process session swap invalidated its pin. */
  drainQueuedFrame(delivery) {
    const ownSessionId = this.getSessionId?.();
    if (delivery?.toSessionId === void 0 || ownSessionId === void 0 || delivery.toSessionId === ownSessionId) {
      return true;
    }
    debugLogger.debug(
      `dropping queued peer message ${delivery.msgId}: addressed to session ${delivery.toSessionId}, this is ${ownSessionId}`
    );
    if (delivery.from) {
      void sendDeliveryStatus(
        delivery.from,
        {
          status: "misaddressed",
          origMsgId: delivery.msgId,
          from: this.inbox?.socketPath
        },
        delivery.replyToken
      );
    }
    if (delivery.admissionKey !== void 0) {
      this.gate?.forgetAdmittedMessage(delivery.admissionKey, delivery.msgId);
    }
    return false;
  }
  emitHeldChange(held) {
    for (const listener of this.heldListeners) {
      try {
        listener(held);
      } catch (error) {
        debugLogger.debug(
          `held-change listener threw: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
};

// packages/cli/src/utils/classify-api-error.ts
init_esbuild_shims();
function classifyApiError(error) {
  const status = error.status;
  const message = error.message?.toLowerCase() ?? "";
  if (status === 429 || message.includes("rate limit")) {
    return "rate_limit";
  }
  if (status === 401 || message.includes("unauthorized")) {
    return "authentication_failed";
  }
  if (status === 402 || status === 403 || message.includes("billing") || message.includes("quota")) {
    return "billing_error";
  }
  if (status === 400 || message.includes("invalid")) {
    return "invalid_request";
  }
  if (status !== void 0 && status >= 500) {
    return "server_error";
  }
  if (message.includes("max_tokens") || message.includes("token limit")) {
    return "max_output_tokens";
  }
  return "unknown";
}
__name(classifyApiError, "classifyApiError");

export {
  classifyApiError,
  MAX_ACCEPTED_BACKLOG,
  PeerMessaging
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
