// Force strict mode and setup for ESM
"use strict";
import {
  describeSessionKind,
  flattenPeerLabel,
  listLiveSessions,
  readOwnSessionRecord
} from "./chunk-GHG4PQY2.js";
import {
  LEADER_NAME,
  sanitizeName
} from "./chunk-YVYK3JYU.js";
import {
  APPROVAL_MODES
} from "./chunk-JX6XHPTX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/ipc/peer-directory.ts
init_esbuild_shims();
import { createHash } from "node:crypto";

// packages/core/src/ipc/uds-client.ts
init_esbuild_shims();
import * as net from "node:net";

// packages/core/src/ipc/peer-frames.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
var PEER_FRAME_VERSION = 1;
var MAX_DROPPED_MSG_IDS = 256;
var MAX_FRAME_BYTES = 1024 * 1024;
var MSG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var MAX_RETAINED_REPLY_TOKEN_CHARS = 256;
function canonicalizeMsgId(msgId) {
  return msgId.replace(/-/g, "").toLowerCase();
}
__name(canonicalizeMsgId, "canonicalizeMsgId");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function optionalString(value) {
  return typeof value === "string" ? value : void 0;
}
__name(optionalString, "optionalString");
function isAddressableMsgId(value) {
  return typeof value === "string" && MSG_ID_RE.test(value) && canonicalizeMsgId(value) !== "all";
}
__name(isAddressableMsgId, "isAddressableMsgId");
function optionalDropReason(value) {
  return value === "rate-limited" || value === "duplicate" || value === "queue-full" ? value : void 0;
}
__name(optionalDropReason, "optionalDropReason");
function parseDroppedMsgIds(value) {
  if (!Array.isArray(value)) return void 0;
  const ids = value.filter(isAddressableMsgId).slice(0, MAX_DROPPED_MSG_IDS);
  return ids.length > 0 ? ids : void 0;
}
__name(parseDroppedMsgIds, "parseDroppedMsgIds");
function parsePeerFrame(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const msgV = parsed["msgV"];
  if (typeof msgV !== "number" || msgV > PEER_FRAME_VERSION) return null;
  const msgId = parsed["msgId"];
  if (!isAddressableMsgId(msgId)) return null;
  if (parsed["type"] === "user") {
    const message = parsed["message"];
    if (!isRecord(message)) return null;
    if (message["role"] !== "user") return null;
    const content = message["content"];
    if (typeof content !== "string" || content.length === 0) return null;
    const priority = parsed["priority"];
    const fromMode = parsed["fromMode"];
    const toSessionId = optionalString(parsed["toSessionId"]);
    const replyToken = optionalString(parsed["replyToken"]);
    return {
      msgV,
      msgId,
      type: "user",
      from: optionalString(parsed["from"]),
      ...replyToken !== void 0 ? { replyToken } : {},
      fromName: optionalString(parsed["fromName"]),
      ...fromMode === "bypass" || fromMode === "prompting" ? { fromMode } : {},
      ...toSessionId !== void 0 ? { toSessionId } : {},
      priority: priority === "now" ? "now" : "next",
      message: { role: "user", content }
    };
  }
  if (parsed["type"] === "control") {
    if (parsed["action"] !== "delivery_status") return null;
    const status = parsed["status"];
    if (status !== "held" && status !== "denied" && status !== "refused" && status !== "expired" && status !== "delivered" && status !== "misaddressed" && status !== "dropped") {
      return null;
    }
    const origMsgId = parsed["origMsgId"];
    if (typeof origMsgId !== "string" || origMsgId.length === 0) return null;
    const dropReason = status === "dropped" ? optionalDropReason(parsed["dropReason"]) : void 0;
    const droppedMsgIds = status === "dropped" ? parseDroppedMsgIds(parsed["droppedMsgIds"]) : void 0;
    return {
      msgV,
      msgId,
      type: "control",
      action: "delivery_status",
      status,
      origMsgId,
      from: optionalString(parsed["from"]),
      reason: optionalString(parsed["reason"]),
      ...dropReason !== void 0 ? { dropReason } : {},
      ...droppedMsgIds !== void 0 ? { droppedMsgIds } : {}
    };
  }
  return null;
}
__name(parsePeerFrame, "parsePeerFrame");
function encodePeerFrame(frame) {
  return `${JSON.stringify(frame)}
`;
}
__name(encodePeerFrame, "encodePeerFrame");
function buildUserFrame(fields) {
  return {
    msgV: PEER_FRAME_VERSION,
    msgId: randomUUID(),
    type: "user",
    ...fields.from !== void 0 ? { from: fields.from } : {},
    ...fields.replyToken !== void 0 ? { replyToken: fields.replyToken } : {},
    ...fields.fromName !== void 0 ? { fromName: fields.fromName } : {},
    ...fields.fromMode !== void 0 ? { fromMode: fields.fromMode } : {},
    ...fields.toSessionId !== void 0 ? { toSessionId: fields.toSessionId } : {},
    priority: fields.priority ?? "next",
    message: { role: "user", content: fields.content }
  };
}
__name(buildUserFrame, "buildUserFrame");
function describeDeliveryStatus(status) {
  switch (status) {
    case "held":
      return "Your message is held for the recipient user to review before it reaches their Qwen Code session.";
    case "denied":
      return "The recipient declined your message; it was not delivered.";
    case "refused":
      return "The recipient session does not accept messages from other sessions, so nobody saw this one. Don't re-send it; reach that session's user another way.";
    case "expired":
      return "Your held message expired without a decision and was not delivered.";
    case "delivered":
      return "Your message was released to the recipient session.";
    case "misaddressed":
      return "That address now belongs to a different session than the one you addressed; it was not delivered. List the agents again before re-sending.";
    case "dropped":
      return "Your message was dropped at the recipient's inbox before anyone saw it: sent too fast, a repeat of your previous message, or the inbox queue was full. Treat it as unsent; fold what still matters into one later message rather than re-sending.";
    default: {
      const exhaustive = status;
      return exhaustive;
    }
  }
}
__name(describeDeliveryStatus, "describeDeliveryStatus");
function describeDropReason(reason) {
  switch (reason) {
    case "rate-limited":
      return "you sent faster than that session accepts";
    case "duplicate":
      return "it repeated your previous message";
    case "queue-full":
      return "its queue of undelivered peer messages was full";
    default: {
      const exhaustive = reason;
      return exhaustive;
    }
  }
}
__name(describeDropReason, "describeDropReason");
function buildAuthLine(token) {
  return `${JSON.stringify({ msgV: PEER_FRAME_VERSION, type: "auth", token })}
`;
}
__name(buildAuthLine, "buildAuthLine");
function parsePeerAuthLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const msgV = parsed["msgV"];
  if (typeof msgV !== "number" || msgV > PEER_FRAME_VERSION) return null;
  if (parsed["type"] !== "auth") return null;
  const token = parsed["token"];
  return typeof token === "string" && token.length > 0 ? token : null;
}
__name(parsePeerAuthLine, "parsePeerAuthLine");
function buildDeliveryStatusFrame(fields) {
  return {
    msgV: PEER_FRAME_VERSION,
    msgId: randomUUID(),
    type: "control",
    action: "delivery_status",
    status: fields.status,
    origMsgId: fields.origMsgId,
    ...fields.from !== void 0 ? { from: fields.from } : {},
    reason: describeDeliveryStatus(fields.status),
    ...fields.dropReason !== void 0 ? { dropReason: fields.dropReason } : {},
    // An empty list is left off rather than sent as `[]`: the field means
    // "these ids too", and there are none.
    ...fields.droppedMsgIds !== void 0 && fields.droppedMsgIds.length > 0 ? { droppedMsgIds: fields.droppedMsgIds.slice(0, MAX_DROPPED_MSG_IDS) } : {}
  };
}
__name(buildDeliveryStatusFrame, "buildDeliveryStatusFrame");

// packages/core/src/ipc/socket-path.ts
init_esbuild_shims();
import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
var MAX_SOCKET_PATH_BYTES = 103;
var SOCKET_DIR_NAME = "qwen-socks";
function resolvePeerSocketCandidates(pid = process.pid) {
  const candidates = [];
  const runtimeDir = process.env["XDG_RUNTIME_DIR"];
  if (runtimeDir) {
    candidates.push(path.join(runtimeDir, SOCKET_DIR_NAME, `${pid}.sock`));
  }
  const nonce = randomBytes(8).toString("hex");
  candidates.push(
    path.join(os.tmpdir(), `${SOCKET_DIR_NAME}-${nonce}`, `${pid}.sock`)
  );
  candidates.push(
    path.join("/tmp", `${SOCKET_DIR_NAME}-${nonce}`, `${pid}.sock`)
  );
  return candidates.filter(
    (candidate, index) => Buffer.byteLength(candidate) <= MAX_SOCKET_PATH_BYTES && candidates.indexOf(candidate) === index
  );
}
__name(resolvePeerSocketCandidates, "resolvePeerSocketCandidates");
function isLocalIpcPath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  if (candidate.includes("\0")) return false;
  if (process.platform === "win32") {
    const normalized = candidate.replace(/\//g, "\\").toLowerCase();
    return normalized.startsWith("\\\\.\\pipe\\") || normalized.startsWith("\\\\?\\pipe\\");
  }
  if (candidate.startsWith("//")) return false;
  return path.isAbsolute(candidate);
}
__name(isLocalIpcPath, "isLocalIpcPath");

// packages/core/src/ipc/uds-client.ts
var debugLogger = createDebugLogger("PEER_IPC");
var SEND_TIMEOUT_MS = 5e3;
var MAX_CONCURRENT_SENDS = 64;
var PROBE_TIMEOUT_MS = 250;
var inFlightSends = 0;
var PeerSendError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "PeerSendError";
  }
  static {
    __name(this, "PeerSendError");
  }
};
function sendPeerFrame(socketPath, frame, options = {}) {
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (!isLocalIpcPath(socketPath)) {
      reject(
        new PeerSendError(
          `Refusing to connect to a non-local IPC path: ${socketPath}`,
          void 0
        )
      );
      return;
    }
    const encoded = encodePeerFrame(frame);
    if (encoded.length - 1 > MAX_FRAME_BYTES) {
      reject(
        new PeerSendError(
          `Frame is ${encoded.length - 1} characters, over the ${MAX_FRAME_BYTES} limit a peer will accept`,
          "EMSGSIZE"
        )
      );
      return;
    }
    if (inFlightSends >= MAX_CONCURRENT_SENDS) {
      reject(
        new PeerSendError(
          `Already sending ${inFlightSends} peer frames; not opening another connection`,
          "EBUSY"
        )
      );
      return;
    }
    const socket = net.connect({ path: socketPath });
    inFlightSends += 1;
    let settled = false;
    const fail = /* @__PURE__ */ __name((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      inFlightSends -= 1;
      socket.destroy();
      reject(new PeerSendError(error.message, error.code));
    }, "fail");
    const deadline = setTimeout(() => {
      fail(
        Object.assign(new Error(`Timed out sending to ${socketPath}`), {
          code: "ETIMEDOUT"
        })
      );
    }, timeoutMs);
    socket.on("error", fail);
    socket.on("connect", () => {
      socket.end(
        options.authToken !== void 0 ? buildAuthLine(options.authToken) + encoded : encoded
      );
    });
    socket.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      inFlightSends -= 1;
      debugLogger.debug(`sent ${frame.type} frame to ${socketPath}`);
      resolve();
    });
  });
}
__name(sendPeerFrame, "sendPeerFrame");
async function sendDeliveryStatus(socketPath, fields, authToken) {
  try {
    await sendPeerFrame(socketPath, buildDeliveryStatusFrame(fields), {
      ...authToken !== void 0 ? { authToken } : {}
    });
  } catch (error) {
    debugLogger.debug(
      `delivery-status (${fields.status}) to ${socketPath} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
__name(sendDeliveryStatus, "sendDeliveryStatus");
function probePeerSocketVerdict(socketPath) {
  return new Promise((resolve) => {
    if (!isLocalIpcPath(socketPath)) {
      resolve("unknown");
      return;
    }
    const socket = net.connect({ path: socketPath });
    let settled = false;
    const settle = /* @__PURE__ */ __name((verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(verdict);
    }, "settle");
    const deadline = setTimeout(() => settle("unknown"), PROBE_TIMEOUT_MS);
    deadline.unref();
    socket.on("connect", () => settle("alive"));
    socket.on("error", (error) => {
      const code = error.code;
      if (code === "EAGAIN" || code === "EBUSY") {
        settle("alive");
        return;
      }
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        settle("dead");
        return;
      }
      settle("unknown");
    });
  });
}
__name(probePeerSocketVerdict, "probePeerSocketVerdict");

// packages/core/src/ipc/peer-directory.ts
function peerRef(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 6);
}
__name(peerRef, "peerRef");
function toPeerSessionInfo(record) {
  if (!record.ipcPath) return null;
  const name = flattenPeerLabel(record.name);
  if (name.length === 0) return null;
  return {
    sessionId: record.sessionId,
    name,
    ref: peerRef(record.sessionId),
    cwd: flattenPeerLabel(record.cwd),
    pid: record.pid,
    // Not flattened: the registry's own read guard already bounds `kind`
    // to lowercase ASCII, digits and dashes, which is narrower than
    // anything flattening would remove.
    kind: describeSessionKind(record.kind),
    ipcPath: record.ipcPath,
    ...record.ipcToken !== void 0 ? { ipcToken: record.ipcToken } : {},
    startedAt: record.startedAt
  };
}
__name(toPeerSessionInfo, "toPeerSessionInfo");
async function listMessageablePeers() {
  const records = await listLiveSessions();
  const candidates = records.map(toPeerSessionInfo).filter((peer) => peer !== null);
  const verdicts = new Map(
    await Promise.all(
      [...new Set(candidates.map((peer) => peer.ipcPath))].map(
        async (ipcPath) => [ipcPath, await probePeerSocketVerdict(ipcPath)]
      )
    )
  );
  return dedupeSameNameTwins(
    candidates.filter((peer) => verdicts.get(peer.ipcPath) === "alive")
  );
}
__name(listMessageablePeers, "listMessageablePeers");
function dedupeSameNameTwins(peers) {
  const newestByKey = /* @__PURE__ */ new Map();
  for (const peer of peers) {
    const key = `${peer.sessionId}\0${peer.name}`;
    const seen = newestByKey.get(key);
    if (!seen || peer.startedAt > seen.startedAt) {
      newestByKey.set(key, peer);
    }
  }
  return [...newestByKey.values()];
}
__name(dedupeSameNameTwins, "dedupeSameNameTwins");
function resolvePeerTarget(peers, target) {
  const trimmed = target.trim();
  if (trimmed.length === 0) return { kind: "none" };
  const withRef = /^(.*?)\s*\[([0-9a-f]{4,12})\]$/i.exec(trimmed);
  if (withRef) {
    const [, namePart, ref] = withRef;
    const bracketed = peers.filter(
      (peer) => peer.ref === ref.toLowerCase() && (namePart.length === 0 || peer.name === namePart)
    );
    const literal = peers.filter((peer) => peer.name === trimmed);
    const matches2 = [.../* @__PURE__ */ new Set([...literal, ...bracketed])];
    if (matches2.length === 1) return { kind: "one", peer: matches2[0] };
    if (matches2.length > 1) return { kind: "ambiguous", matches: matches2 };
    return { kind: "none" };
  }
  const byName = peers.filter((peer) => peer.name === trimmed);
  const byRef = peers.filter((peer) => peer.ref === trimmed.toLowerCase());
  const matches = [.../* @__PURE__ */ new Set([...byName, ...byRef])];
  if (matches.length === 1) return { kind: "one", peer: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "none" };
}
__name(resolvePeerTarget, "resolvePeerTarget");
function formatPeerAddress(peer, peers, isReserved) {
  const contested = peers.filter((other) => other.name === peer.name).length > 1;
  return contested || isReserved?.(peer.name) === true ? `${peer.name} [${peer.ref}]` : peer.name;
}
__name(formatPeerAddress, "formatPeerAddress");
function advertisablePeerAddress(peer, peers, isReserved) {
  const candidates = [peer.name, `${peer.name} [${peer.ref}]`, `[${peer.ref}]`];
  return candidates.find((candidate) => {
    if (isReserved?.(candidate) === true) return false;
    const resolved = resolvePeerTarget(peers, candidate);
    return resolved.kind === "one" && resolved.peer === peer;
  });
}
__name(advertisablePeerAddress, "advertisablePeerAddress");
function suggestPeerNames(peers, target, limit = 3, isReserved) {
  const needle = target.trim().replace(/\s*\[[0-9a-f]{0,12}\]?$/i, "").trim().toLowerCase();
  if (needle.length === 0) return [];
  return peers.filter((peer) => peer.name.toLowerCase().includes(needle)).sort(
    (a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle))
  ).slice(0, limit).map((peer) => formatPeerAddress(peer, peers, isReserved));
}
__name(suggestPeerNames, "suggestPeerNames");

// packages/core/src/ipc/peer-routing.ts
init_esbuild_shims();
function isInProcessRecipient(address, team) {
  if (address === "*") return true;
  if (!team) return false;
  if (address.toLowerCase() === LEADER_NAME) return true;
  if (address === team.leadAgentId) return true;
  const sanitized = sanitizeName(address);
  return team.members.some((member) => member.name === sanitized);
}
__name(isInProcessRecipient, "isInProcessRecipient");

// packages/core/src/ipc/inbound-gate.ts
init_esbuild_shims();

// packages/core/src/ipc/peer-admission.ts
init_esbuild_shims();
import { createHash as createHash2 } from "node:crypto";
var debugLogger2 = createDebugLogger("PEER_ADMISSION");
var PEER_ADMISSION_LIMITS = {
  bucketCapacity: 30,
  refillPerSecond: 0.5,
  dedupWindowMs: 3e4,
  globalBucketCapacity: 32,
  globalRefillPerSecond: 1,
  maxTrackedSenders: 256
};
var PEER_BURST_WINDOW_MS = PEER_ADMISSION_LIMITS.bucketCapacity / PEER_ADMISSION_LIMITS.refillPerSecond * 1e3;
function refillBucket(tokens, lastRefill, now, capacity, perSecond) {
  const elapsedSeconds = Math.max(0, now - lastRefill) / 1e3;
  return Math.min(capacity, tokens + elapsedSeconds * perSecond);
}
__name(refillBucket, "refillBucket");
function hasToken(tokens) {
  return tokens >= 1;
}
__name(hasToken, "hasToken");
function isBodyWithinWindow(at, atWall, now, wallNow, windowMs) {
  return Math.max(now - at, wallNow - atWall) < windowMs;
}
__name(isBodyWithinWindow, "isBodyWithinWindow");
var PeerAdmission = class {
  static {
    __name(this, "PeerAdmission");
  }
  now;
  wallNow;
  limits;
  senders = /* @__PURE__ */ new Map();
  globalTokens;
  globalRefill;
  constructor(options = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.limits = { ...PEER_ADMISSION_LIMITS, ...options.limits };
    this.globalTokens = this.limits.globalBucketCapacity;
    this.globalRefill = this.now();
  }
  /**
   * Whether this message may go on to the gate's policy.
   *
   * The order matters. The global bucket is checked first, so a flood
   * that rotates `from` is stopped before it can mint a meter per name.
   * The duplicate check comes before the sender's bucket is charged: a
   * repeat should not also cost the sender the allowance it would need to
   * say something new. Nothing is charged unless every check passes.
   */
  admit(request) {
    const now = this.now();
    const wallNow = this.wallNow();
    this.globalTokens = refillBucket(
      this.globalTokens,
      this.globalRefill,
      now,
      this.limits.globalBucketCapacity,
      this.limits.globalRefillPerSecond
    );
    this.globalRefill = now;
    if (!hasToken(this.globalTokens)) {
      debugLogger2.debug(
        `dropping a peer message from ${request.senderKey}: every sender combined is over the rate limit`
      );
      return { admitted: false, reason: "rate-limited" };
    }
    const meter = this.trackSender(request.senderKey, now);
    meter.bodies = meter.bodies.filter(
      (record) => isBodyWithinWindow(
        record.at,
        record.atWall,
        now,
        wallNow,
        this.limits.dedupWindowMs
      )
    );
    const bodyHash = request.exemptFromDedup ? void 0 : hashBody(request.body);
    const lastBody = meter.bodies.at(-1);
    if (bodyHash !== void 0 && lastBody?.hash === bodyHash) {
      debugLogger2.debug(
        `dropping a peer message from ${request.senderKey}: identical to its previous message`
      );
      return { admitted: false, reason: "duplicate" };
    }
    meter.tokens = refillBucket(
      meter.tokens,
      meter.lastRefill,
      now,
      this.limits.bucketCapacity,
      this.limits.refillPerSecond
    );
    meter.lastRefill = now;
    if (!hasToken(meter.tokens)) {
      debugLogger2.debug(
        `dropping a peer message from ${request.senderKey}: over its rate limit`
      );
      return { admitted: false, reason: "rate-limited" };
    }
    this.globalTokens -= 1;
    meter.tokens -= 1;
    if (bodyHash !== void 0) {
      meter.bodies.push({
        messageId: request.messageId,
        hash: bodyHash,
        at: now,
        atWall: wallNow
      });
    }
    return { admitted: true };
  }
  /** How many senders are metered right now. For tests and diagnostics. */
  trackedSenderCount() {
    return this.senders.size;
  }
  /**
   * Undo the repeat record `body` left when it was admitted, leaving the
   * bucket alone.
   *
   * The gate calls this wherever it settles an admitted message as
   * anything other than delivered or held — a full input queue, a
   * standing refusal, a hold buffer with no room, a shutdown, a session
   * swap. In every one of those the far model never saw the message, so a
   * `duplicate` verdict on the sender's honest retry would assert
   * something false: that identical content is already over there. The
   * retry then meets the repeat check it would have met had this message
   * never arrived.
   *
   * Removes only this message's record. A later admitted message remains
   * the duplicate baseline, and the body admitted before this one keeps
   * the protection it earned if it becomes the latest remaining record.
   *
   * The token stays spent. It is the only bound on how often a peer can
   * make the receiver attempt, and fail, a delivery.
   */
  forgetBody(senderKey, body, messageId) {
    const meter = this.senders.get(senderKey);
    if (meter === void 0) return;
    const bodyHash = hashBody(body);
    for (let index = meter.bodies.length - 1; index >= 0; index -= 1) {
      const record = meter.bodies[index];
      if (record?.hash === bodyHash && (messageId === void 0 || record.messageId === messageId)) {
        meter.bodies.splice(index, 1);
      }
    }
  }
  /** Undo every repeat record owned by one admitted message. */
  forgetMessage(senderKey, messageId) {
    const meter = this.senders.get(senderKey);
    if (meter === void 0) return;
    const canonicalId = canonicalizeMsgId(messageId);
    meter.bodies = meter.bodies.filter(
      (record) => record.messageId === void 0 || canonicalizeMsgId(record.messageId) !== canonicalId
    );
  }
  /** Start a fresh per-session conversation without replacing the gate. */
  reset() {
    this.senders.clear();
    this.globalTokens = this.limits.globalBucketCapacity;
    this.globalRefill = this.now();
  }
  /**
   * The meter for `key`, creating one and making room if needed.
   *
   * The map is an LRU: a hit is re-inserted so iteration order is
   * least-recently-seen first. When it is full, a meter whose bucket has
   * refilled completely goes first — it is not limiting anyone, so
   * forgetting it changes no verdict except that its last body is
   * forgotten too, which can admit one repeat. Losing a repeat check is
   * the right thing to trade for a bounded map; losing a *bucket* that is
   * currently holding a flood back is not, which is why a full bucket is
   * preferred over a merely old one.
   */
  trackSender(key, now) {
    const existing = this.senders.get(key);
    if (existing !== void 0) {
      this.senders.delete(key);
      this.senders.set(key, existing);
      return existing;
    }
    const limit = Math.max(1, this.limits.maxTrackedSenders);
    while (this.senders.size >= limit) {
      let victim;
      for (const [candidate, meter] of this.senders) {
        const level = refillBucket(
          meter.tokens,
          meter.lastRefill,
          now,
          this.limits.bucketCapacity,
          this.limits.refillPerSecond
        );
        if (level >= this.limits.bucketCapacity) {
          victim = candidate;
          break;
        }
      }
      victim ??= this.senders.keys().next().value;
      if (victim === void 0) break;
      this.senders.delete(victim);
    }
    const fresh = {
      tokens: this.limits.bucketCapacity,
      lastRefill: now,
      bodies: []
    };
    this.senders.set(key, fresh);
    return fresh;
  }
};
function hashBody(body) {
  return createHash2("sha256").update(body).digest("hex");
}
__name(hashBody, "hashBody");

// packages/core/src/ipc/inbound-gate.ts
var debugLogger3 = createDebugLogger("PEER_INBOUND");
var MAX_HELD_MESSAGES = 50;
var MAX_SETTLED_IDS = 512;
function receiverReviewsActions(mode) {
  return mode !== "yolo" /* YOLO */ && mode !== "auto-edit" /* AUTO_EDIT */ && mode !== "auto" /* AUTO */;
}
__name(receiverReviewsActions, "receiverReviewsActions");
function modeClass(mode) {
  return receiverReviewsActions(mode) ? "prompting" : "bypass";
}
__name(modeClass, "modeClass");
function isInboundPolicy(value) {
  return value === "accept" || value === "hold" || value === "refuse";
}
__name(isInboundPolicy, "isInboundPolicy");
var MAX_SENDER_KEY_CHARS = 256;
function peerSenderKey(frame, origin) {
  if (origin.controller) return `controller:${origin.controller.id}`;
  const address = (frame.from ?? "").slice(0, MAX_SENDER_KEY_CHARS);
  if (origin.selfSent) return `own:${address}`;
  return address ? `peer:${address}` : "unknown";
}
__name(peerSenderKey, "peerSenderKey");
var MAX_TIMEOUT_MS = 2 ** 31 - 1;
var DEFAULT_HELD_EXPIRY_MS = 5 * 60 * 1e3;
var HELD_EXPIRY_VALUES = {
  "1m": 60 * 1e3,
  "5m": DEFAULT_HELD_EXPIRY_MS,
  "10m": 10 * 60 * 1e3,
  never: null
};
var HELD_EXPIRY_OPTIONS = Object.keys(HELD_EXPIRY_VALUES);
function parseHeldExpiry(value) {
  if (value === void 0) return DEFAULT_HELD_EXPIRY_MS;
  if (typeof value !== "string" || !Object.hasOwn(HELD_EXPIRY_VALUES, value)) {
    debugLogger3.debug(
      `unrecognized crossSessionHeldExpiry value (using the default): ${String(
        value
      )}`
    );
    return DEFAULT_HELD_EXPIRY_MS;
  }
  return HELD_EXPIRY_VALUES[value] ?? null;
}
__name(parseHeldExpiry, "parseHeldExpiry");
var InboundGate = class {
  constructor(options) {
    this.options = options;
    this.admission = options.admission ?? new PeerAdmission();
  }
  static {
    __name(this, "InboundGate");
  }
  held = [];
  /**
   * Canonicalized ids this gate already settled, with their verdict.
   * A re-sent id repeats its verdict instead of re-entering the gate:
   * the duplicate guard over `held` alone would let a peer slip a
   * different body behind an id the user already decided — or saw
   * evicted — and have it decided again.
   */
  settled = /* @__PURE__ */ new Map();
  shuttingDown = false;
  /**
   * One timer for the whole buffer, armed for the message that expires
   * first. A timer per message would be up to `MAX_HELD_MESSAGES` of
   * them, all firing to do the same sweep.
   */
  expiryTimer = null;
  /** How fast senders may arrive. See `peer-admission.ts`. */
  admission;
  admissionSessionObserved = false;
  admissionSessionId;
  /** Messages currently parked, oldest first. */
  getHeld() {
    this.forgetInvalidControllers();
    return this.held;
  }
  /** Remove a revoked grant's authority from messages already waiting. */
  forgetController(id) {
    const isControllerValid = this.options.isControllerValid;
    return this.forgetControllersWhere(
      (controller) => controller.id === id || isControllerValid !== void 0 && !isControllerValid(controller.id)
    );
  }
  forgetInvalidControllers() {
    const isControllerValid = this.options.isControllerValid;
    if (!isControllerValid) return 0;
    return this.forgetControllersWhere(
      (controller) => !isControllerValid(controller.id)
    );
  }
  forgetControllersWhere(shouldForget) {
    let forgotten = 0;
    for (let index = 0; index < this.held.length; index += 1) {
      const entry = this.held[index];
      if (!entry?.controller || !shouldForget(entry.controller)) continue;
      const next = { ...entry };
      delete next.controller;
      this.held[index] = withCause(
        next,
        this.resolvePolicy(next.frame, originOf(next))
      );
      forgotten += 1;
    }
    if (forgotten > 0) this.notifyHeldChange();
    return forgotten;
  }
  /**
   * The current hold lifetime in milliseconds, or null when holds do not
   * expire. Exposed so `/peers` can tell the user how long a message has
   * left rather than making them guess.
   */
  getHeldExpiryMs() {
    if (this.options.getHeldExpiryMs === void 0) {
      return DEFAULT_HELD_EXPIRY_MS;
    }
    try {
      return this.options.getHeldExpiryMs();
    } catch (error) {
      debugLogger3.debug(
        `held-expiry getter threw; falling back to the default: ${error instanceof Error ? error.message : String(error)}`
      );
      return DEFAULT_HELD_EXPIRY_MS;
    }
  }
  /**
   * Resolve the policy for a frame, and explain it.
   *
   * Exposed for tests and for the UI, which shows the cause next to a
   * held message.
   */
  resolvePolicy(frame, origin) {
    let explicit;
    try {
      const configured = this.options.getPolicySetting();
      if (configured !== void 0 && !isInboundPolicy(configured)) {
        debugLogger3.debug(
          `unrecognized crossSessionInbound value (failing closed): ${String(
            configured
          )}`
        );
        return this.hold("policy-unreadable", this.policyScope());
      }
      explicit = configured;
    } catch (error) {
      debugLogger3.debug(
        `policy-setting getter threw (failing closed): ${error instanceof Error ? error.message : String(error)}`
      );
      return { policy: "hold", cause: "policy-unreadable" };
    }
    if (explicit === "hold") {
      return this.hold("explicit-setting", this.policyScope());
    }
    if (explicit !== void 0) {
      return { policy: explicit };
    }
    if (origin?.selfSent) {
      return { policy: "accept" };
    }
    if (origin?.controller) {
      return { policy: "accept" };
    }
    let mode;
    try {
      mode = this.options.getApprovalMode();
    } catch (error) {
      debugLogger3.debug(
        `approval-mode getter threw (failing closed): ${error instanceof Error ? error.message : String(error)}`
      );
      mode = null;
    }
    if (mode === null || !APPROVAL_MODES.includes(mode)) {
      return { policy: "hold", cause: "mode-unknown" };
    }
    const sender = frame?.fromMode;
    if (sender === void 0) {
      return { policy: "hold", cause: "no-mode-asserted" };
    }
    return sender === modeClass(mode) ? { policy: "accept" } : { policy: "hold", cause: "mode-mismatch" };
  }
  hold(cause, scope) {
    return scope === void 0 ? { policy: "hold", cause } : { policy: "hold", cause, scope };
  }
  /** The scope is decoration on a cause; a broken getter must not change the verdict. */
  policyScope() {
    try {
      return this.options.getPolicyScope?.();
    } catch (error) {
      debugLogger3.debug(
        `policy-scope getter threw (ignored): ${error instanceof Error ? error.message : String(error)}`
      );
      return void 0;
    }
  }
  /**
   * Run a freshly-arrived message through the gate. `origin` defaults to
   * an ordinary peer — the transport asserts self-sent, never the frame.
   */
  admit(frame, origin = { selfSent: false }) {
    const sessionId = this.options.getSessionId?.();
    if (this.admissionSessionObserved && this.admissionSessionId !== sessionId) {
      this.admission.reset();
    }
    this.admissionSessionObserved = true;
    this.admissionSessionId = sessionId;
    this.expireOverdue();
    const verdict = this.admission.admit({
      senderKey: peerSenderKey(frame, origin),
      body: frame.message.content,
      messageId: frame.msgId,
      // A hook reporting the same line twice, or a user repeating
      // themselves to a controller, is not the model-driven repetition
      // the duplicate check exists to stop. Both are still rate limited.
      exemptFromDedup: origin.selfSent || origin.controller !== void 0
    });
    if (!verdict.admitted) {
      return this.drop(frame, origin, verdict.reason);
    }
    const settled = this.settled.get(canonicalizeMsgId(frame.msgId));
    if (settled !== void 0) {
      debugLogger3.debug(
        `re-sent msgId ${frame.msgId}; repeating earlier verdict ${settled}`
      );
      this.forgetAdmittedBody(frame, origin);
      void this.report(frame, settled);
      return "refused";
    }
    if (this.held.some(
      (entry) => canonicalizeMsgId(entry.frame.msgId) === canonicalizeMsgId(frame.msgId)
    )) {
      debugLogger3.debug(`duplicate msgId ${frame.msgId}; already held`);
      this.forgetAdmittedBody(frame, origin);
      void this.report(frame, "held");
      return "held";
    }
    const decision = this.resolvePolicy(frame, origin);
    const { policy } = decision;
    if (policy === "refuse") {
      debugLogger3.debug(`refused peer message ${frame.msgId}`);
      this.forgetAdmittedBody(frame, origin);
      this.recordSettled(frame.msgId, "refused");
      void this.report(frame, "refused");
      return "refused";
    }
    if (this.shuttingDown) {
      debugLogger3.debug(
        `not admitting peer message ${frame.msgId} during shutdown; expiring it`
      );
      this.forgetAdmittedBody(frame, origin);
      void this.report(frame, "expired");
      return "refused";
    }
    if (policy === "accept") {
      if (!this.tryDeliver(frame, origin)) {
        this.forgetAdmittedBody(frame, origin);
        return this.drop(frame, origin, "queue-full");
      }
      this.recordSettled(frame.msgId, "delivered");
      void this.report(frame, "delivered");
      return "accept";
    }
    if (this.held.length >= MAX_HELD_MESSAGES) {
      this.forgetAdmittedBody(frame, origin);
      return this.drop(frame, origin, "queue-full");
    }
    const cause = decision.policy === "hold" ? decision.cause : "mode-unknown";
    const scope = decision.policy === "hold" ? decision.scope : void 0;
    this.held.push({
      frame,
      cause,
      ...scope === void 0 ? {} : { policyScope: scope },
      heldAt: Date.now(),
      monotonicAt: performance.now(),
      ...origin.selfSent ? { selfSent: true } : {},
      ...origin.controller ? { controller: origin.controller } : {}
    });
    debugLogger3.debug(
      `held peer message ${frame.msgId} (cause=${cause}, ${this.held.length} held)`
    );
    void this.report(frame, "held");
    this.notifyHeldChange();
    this.rescheduleExpiry();
    return "held";
  }
  /**
   * Release or drop one parked message.
   *
   * Returns 'gone' when the id is unknown — it may have been evicted,
   * expired at shutdown, or already decided. Callers surface that rather
   * than treating it as an error, because a stale UI action is normal.
   *
   * Returns 'failed' when an approved message could not be delivered
   * (the input queue is full or tearing down). The message is parked
   * again exactly where it was, so it stays reviewable and the user can
   * retry; claiming 'done' would report a release that never happened.
   */
  decide(msgId, decision) {
    this.expireOverdue();
    this.forgetInvalidControllers();
    const index = this.held.findIndex((entry2) => entry2.frame.msgId === msgId);
    if (index === -1) return "gone";
    const [entry] = this.held.splice(index, 1);
    if (!entry) return "gone";
    if (decision === "approve") {
      if (!this.pinStillValid(entry.frame)) {
        this.forgetAdmittedBody(entry.frame, originOf(entry));
        this.recordSettled(entry.frame.msgId, "misaddressed");
        void this.report(entry.frame, "misaddressed");
        this.notifyHeldChange();
        this.rescheduleExpiry();
        return "gone";
      }
      if (!this.tryDeliver(entry.frame, originOf(entry))) {
        this.held.splice(index, 0, entry);
        void this.report(entry.frame, "held");
        this.notifyHeldChange();
        this.rescheduleExpiry();
        return "failed";
      }
      this.recordSettled(entry.frame.msgId, "delivered");
      void this.report(entry.frame, "delivered");
    } else {
      this.forgetAdmittedBody(entry.frame, originOf(entry));
      this.recordSettled(entry.frame.msgId, "denied");
      void this.report(entry.frame, "denied");
    }
    this.notifyHeldChange();
    this.rescheduleExpiry();
    return "done";
  }
  /**
   * Re-run every parked message through the gate.
   *
   * Called when the approval mode or the setting changes: a message held
   * only because the modes disagreed should be delivered once they agree,
   * without the user having to approve it by hand. The reverse also
   * holds — switching to `refuse` drops the backlog.
   *
   * Returns the number of messages released.
   */
  reevaluate(reason) {
    this.expireOverdue();
    this.forgetInvalidControllers();
    this.rescheduleExpiry();
    if (this.held.length === 0) return 0;
    const stillHeld = [];
    const release = [];
    let dropped = 0;
    for (const entry of this.held) {
      const decision = this.resolvePolicy(entry.frame, originOf(entry));
      const { policy } = decision;
      if (policy === "accept") {
        release.push(entry);
      } else if (policy === "refuse") {
        dropped += 1;
        this.forgetAdmittedBody(entry.frame, originOf(entry));
        this.recordSettled(entry.frame.msgId, "denied");
        void this.report(entry.frame, "denied");
      } else {
        stillHeld.push(withCause(entry, decision));
      }
    }
    let released = 0;
    let misaddressed = 0;
    for (const entry of release) {
      if (!this.pinStillValid(entry.frame)) {
        misaddressed += 1;
        this.forgetAdmittedBody(entry.frame, originOf(entry));
        this.recordSettled(entry.frame.msgId, "misaddressed");
        void this.report(entry.frame, "misaddressed");
        continue;
      }
      if (this.tryDeliver(entry.frame, originOf(entry))) {
        released += 1;
        this.recordSettled(entry.frame.msgId, "delivered");
        void this.report(entry.frame, "delivered");
      } else {
        stillHeld.push(entry);
        void this.report(entry.frame, "held");
      }
    }
    this.held.length = 0;
    stillHeld.sort((a, b) => this.ageOf(b) - this.ageOf(a));
    this.held.push(...stillHeld);
    this.rescheduleExpiry();
    if (release.length > 0 || dropped > 0) {
      debugLogger3.debug(
        `reevaluate (${reason}): released ${released}, dropped ${dropped}, misaddressed ${misaddressed}, ${this.held.length} still held`
      );
      this.notifyHeldChange();
    }
    return released;
  }
  /**
   * Settle every parked message as expired and refuse new holds.
   *
   * A sender blocked on a decision has to learn that no decision is
   * coming; silence would look identical to "delivered and ignored".
   */
  shutdown() {
    this.shuttingDown = true;
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (this.held.length === 0) return Promise.resolve();
    const settling = this.held.splice(0, this.held.length);
    debugLogger3.debug(
      `shutdown: expiring ${settling.length} held peer message(s)`
    );
    const receipts = settling.map((entry) => {
      this.forgetAdmittedBody(entry.frame, originOf(entry));
      return this.report(entry.frame, "expired");
    });
    this.notifyHeldChange();
    return Promise.allSettled(receipts).then(() => void 0);
  }
  /** Remember a settled id, pruning the oldest beyond the cap. */
  recordSettled(msgId, verdict) {
    const key = canonicalizeMsgId(msgId);
    this.settled.delete(key);
    this.settled.set(key, verdict);
    while (this.settled.size > MAX_SETTLED_IDS) {
      const oldest = this.settled.keys().next().value;
      if (oldest === void 0) break;
      this.settled.delete(oldest);
    }
  }
  /**
   * A frame's pin is judged at arrival, but a session swap can happen
   * while it sits parked; the release paths re-judge against the id the
   * session holds now, not the one the frame saw on arrival.
   */
  pinStillValid(frame) {
    const ownsSessionId = this.options.ownsSessionId;
    if (ownsSessionId) {
      return frame.toSessionId !== void 0 && ownsSessionId(frame.toSessionId);
    }
    if (frame.toSessionId === void 0) return true;
    const ownSessionId = this.options.getSessionId?.();
    return ownSessionId === void 0 || frame.toSessionId === ownSessionId;
  }
  /**
   * Receipt a terminal outcome without letting the transport take the
   * gate down with it.
   *
   * These run inside loops that have already removed entries from the
   * held set: a throw partway through would strand every message after it
   * with no receipt and no way for the user to reach it — the exact
   * silent loss the receipts exist to prevent.
   */
  report(frame, status) {
    try {
      return Promise.resolve(this.options.reportStatus?.(frame, status));
    } catch (error) {
      debugLogger3.debug(
        `reportStatus(${status}) threw: ${error instanceof Error ? error.message : String(error)}`
      );
      return Promise.resolve();
    }
  }
  /**
   * Undo the repeat record an admitted message left, when the gate went on
   * to settle it as something the far model never saw.
   *
   * Admission records a body before the gate decides what to do with it,
   * so every terminal that is not a delivery or a hold leaves a record for
   * content that never arrived — and the sender's honest retry then comes
   * back `duplicate`, a verdict whose whole premise is that the far side
   * already has it. Keyed exactly as admission keyed it, or it is a
   * silent no-op.
   */
  forgetAdmittedBody(frame, origin) {
    this.admission.forgetBody(
      peerSenderKey(frame, origin),
      frame.message.content,
      frame.msgId
    );
  }
  /** Undo an admitted queued message that was invalidated outside the gate. */
  forgetAdmittedMessage(senderKey, messageId) {
    this.admission.forgetMessage(senderKey, messageId);
  }
  /**
   * Turn a message away without the model or the user ever seeing it, and
   * say so to both audiences.
   *
   * Two of the three reasons are decided above policy; `queue-full` is
   * decided below it, when a buffer the message was already accepted into
   * had no room. What they share is that nothing was *decided about the
   * message*, which is why none of them leaves a tombstone: a sender that
   * waits and retries should find the same gate it would have found if it
   * had waited in the first place.
   *
   * Both reporters are best-effort and neither may take the gate down,
   * for the same reason `report` is wrapped: this runs on the arrival
   * path of every message.
   */
  drop(frame, origin, reason) {
    debugLogger3.debug(`dropped peer message ${frame.msgId} (${reason})`);
    try {
      this.options.reportDropped?.(frame, reason, origin);
    } catch (error) {
      debugLogger3.debug(`reportDropped(${reason}) threw: ${describe(error)}`);
    }
    try {
      this.options.onDropped?.(frame, origin, reason);
    } catch (error) {
      debugLogger3.debug(`onDropped(${reason}) threw: ${describe(error)}`);
    }
    return "dropped";
  }
  /** Hand a message to the session, reporting whether it landed. */
  tryDeliver(frame, origin) {
    try {
      this.options.deliver(frame, origin);
      return true;
    } catch (error) {
      debugLogger3.error(
        `deliver threw for ${frame.msgId}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }
  /**
   * How long `entry` has been parked: the larger of the wall-clock and
   * monotonic elapsed times.
   *
   * Neither clock alone is right. The wall clock is what a suspended
   * machine advances -- CLOCK_MONOTONIC does not tick across suspend, so
   * a monotonic-only age would keep a message parked through a two-hour
   * sleep. But the wall clock also moves when nothing elapsed: a
   * backward NTP correction of an hour would stretch a five-minute hold
   * past sixty, and a step over ~24.8 days pushes the re-armed delay
   * beyond setTimeout's range.
   *
   * Taking the larger keeps the suspend case working and makes a
   * backward step a no-op, at the cost of treating a forward step as
   * elapsed time -- which is the conservative direction, and in any case
   * a forward step is indistinguishable from a suspend from in here.
   */
  ageOf(entry) {
    const wall = Date.now() - entry.heldAt;
    if (entry.monotonicAt === void 0) return wall;
    return Math.max(wall, performance.now() - entry.monotonicAt);
  }
  /**
   * Settle every message whose hold has run out.
   *
   * Expiry is judged against the lifetime configured *now*, not the one
   * in force when each message arrived: shortening the setting expires a
   * backlog that is already too old, and lengthening it gives the
   * backlog the longer window. Either reading is defensible; this one
   * has the property that what `/peers` shows as remaining is what
   * actually happens.
   */
  expireOverdue() {
    const expiryMs = this.getHeldExpiryMs();
    if (expiryMs === null || this.held.length === 0) return;
    const survivors = [];
    const expired = [];
    for (const entry of this.held) {
      (this.ageOf(entry) >= expiryMs ? expired : survivors).push(entry);
    }
    if (expired.length === 0) return;
    this.held.length = 0;
    this.held.push(...survivors);
    for (const entry of expired) {
      debugLogger3.debug(
        `held peer message ${entry.frame.msgId} expired after ${expiryMs} ms`
      );
      this.forgetAdmittedBody(entry.frame, originOf(entry));
      this.recordSettled(entry.frame.msgId, "expired");
      void this.report(entry.frame, "expired");
    }
    this.notifyHeldChange();
    this.rescheduleExpiry();
  }
  /**
   * Arm the timer for whichever message expires first, or clear it when
   * nothing is waiting and when holds do not expire.
   *
   * Called after every change to the buffer. Unref'd: a session with a
   * message parked should still be able to exit, and shutdown settles
   * the backlog anyway.
   */
  rescheduleExpiry() {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (this.shuttingDown) return;
    const expiryMs = this.getHeldExpiryMs();
    if (expiryMs === null) return;
    let oldestAge = null;
    for (const entry of this.held) {
      const age = this.ageOf(entry);
      if (oldestAge === null || age > oldestAge) oldestAge = age;
    }
    if (oldestAge === null) return;
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(1, expiryMs - oldestAge));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expireOverdue();
      this.rescheduleExpiry();
    }, delay);
    this.expiryTimer.unref?.();
  }
  notifyHeldChange() {
    try {
      this.options.onHeldChange?.(this.held);
    } catch (error) {
      debugLogger3.debug(
        `onHeldChange threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
};
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
__name(describe, "describe");
function originOf(entry) {
  return {
    selfSent: entry.selfSent === true,
    ...entry.controller ? { controller: entry.controller } : {}
  };
}
__name(originOf, "originOf");
function withCause(entry, decision) {
  if (decision.policy !== "hold") return entry;
  const { cause, scope } = decision;
  if (cause === entry.cause && scope === entry.policyScope) return entry;
  const { policyScope: _dropped, ...rest } = entry;
  return scope === void 0 ? { ...rest, cause } : { ...rest, cause, policyScope: scope };
}
__name(withCause, "withCause");
function describeHoldCause(cause, scope) {
  switch (cause) {
    case "explicit-setting":
      switch (scope) {
        case "workspace":
          return `this repository's settings hold messages from other sessions (agents.crossSessionInbound is "hold" in workspace settings)`;
        case "system":
          return 'a system setting holds messages from other sessions (agents.crossSessionInbound is "hold" in system settings)';
        default:
          return 'your crossSessionInbound setting is "hold"';
      }
    case "mode-mismatch":
      return "the sender and this session are in different review modes: one reviews each action and the other can apply some without per-action review";
    case "no-mode-asserted":
      return "the sender did not say whether it reviews each action";
    case "mode-unknown":
      return "this session's approval mode could not be determined";
    case "policy-unreadable":
      switch (scope) {
        case "workspace":
          return "the agents.crossSessionInbound value in this repository's workspace settings could not be read";
        case "system":
          return "the agents.crossSessionInbound value in system settings could not be read";
        default:
          return "your crossSessionInbound setting could not be read";
      }
    default: {
      const exhaustive = cause;
      return exhaustive;
    }
  }
}
__name(describeHoldCause, "describeHoldCause");

// packages/core/src/ipc/peer-send.ts
init_esbuild_shims();
async function getOwnPeerIdentity(slot) {
  const record = await readOwnSessionRecord(slot);
  const self = record === null ? null : toPeerSessionInfo(record);
  if (!self) return null;
  return {
    ipcPath: self.ipcPath,
    name: self.name,
    sessionId: self.sessionId,
    ref: self.ref
  };
}
__name(getOwnPeerIdentity, "getOwnPeerIdentity");
function senderModeClass(mode) {
  return modeClass(mode);
}
__name(senderModeClass, "senderModeClass");
var MAX_TRACKED_SENDS = 200;
var sentMessages = /* @__PURE__ */ new Map();
var NEVER_WRITTEN_SEND_CODES = /* @__PURE__ */ new Set([
  void 0,
  "ENOENT",
  "ECONNREFUSED",
  "EMSGSIZE",
  "EAGAIN",
  "EBUSY"
]);
function trackSent(msgId, info) {
  const key = canonicalizeMsgId(msgId);
  sentMessages.delete(key);
  sentMessages.set(key, info);
  while (sentMessages.size > MAX_TRACKED_SENDS) {
    const oldest = sentMessages.keys().next().value;
    if (oldest === void 0) break;
    sentMessages.delete(oldest);
  }
}
__name(trackSent, "trackSent");
var RECEIPT_TRANSITIONS = {
  pending: /* @__PURE__ */ new Set([
    "held",
    "delivered",
    "denied",
    "refused",
    "expired",
    "misaddressed",
    "dropped"
  ]),
  // A refusal is decided at admission, so it cannot follow a hold: a
  // message already parked was not turned away. Switching the setting to
  // `refuse` while it sits there settles it as `denied` — someone chose.
  //
  // A drop is decided even earlier, before the message is anything to the
  // receiver at all, so it can only ever follow `pending`. A `dropped`
  // receipt naming a message this session already saw held or delivered
  // is answering a *later* frame that reused the id, and applying it
  // would tell the user a message that did arrive never did.
  held: /* @__PURE__ */ new Set(["delivered", "denied", "expired", "misaddressed"]),
  delivered: /* @__PURE__ */ new Set(["expired", "misaddressed"]),
  denied: /* @__PURE__ */ new Set(),
  refused: /* @__PURE__ */ new Set(),
  expired: /* @__PURE__ */ new Set(),
  misaddressed: /* @__PURE__ */ new Set(),
  dropped: /* @__PURE__ */ new Set()
};
function settleSentPeerMessage(msgId, status) {
  const entry = sentMessages.get(canonicalizeMsgId(msgId));
  if (!entry || !RECEIPT_TRANSITIONS[entry.state].has(status)) {
    return void 0;
  }
  const previous = entry.state;
  entry.state = status;
  return {
    address: entry.address,
    ipcPath: entry.ipcPath,
    previous,
    ageMs: Math.max(0, pacerWallNow() - entry.sentAt)
  };
}
__name(settleSentPeerMessage, "settleSentPeerMessage");
var MAX_PACED_TARGETS = 256;
var pacedTargets = /* @__PURE__ */ new Map();
function pacedTargetFor(ipcPath, now) {
  const existing = pacedTargets.get(ipcPath);
  if (existing !== void 0) {
    pacedTargets.delete(ipcPath);
    pacedTargets.set(ipcPath, existing);
    return existing;
  }
  while (pacedTargets.size >= MAX_PACED_TARGETS) {
    let victim;
    for (const [candidate, target] of pacedTargets) {
      const level = refillBucket(
        target.tokens,
        target.lastRefill,
        now,
        PEER_ADMISSION_LIMITS.bucketCapacity,
        PEER_ADMISSION_LIMITS.refillPerSecond
      );
      if (level >= PEER_ADMISSION_LIMITS.bucketCapacity) {
        victim = candidate;
        break;
      }
    }
    victim ??= pacedTargets.keys().next().value;
    if (victim === void 0) break;
    pacedTargets.delete(victim);
  }
  const fresh = {
    tokens: PEER_ADMISSION_LIMITS.bucketCapacity,
    lastRefill: now,
    sentInBurst: 0,
    burstStartedAt: now,
    bodies: [],
    generation: 0
  };
  pacedTargets.set(ipcPath, fresh);
  return fresh;
}
__name(pacedTargetFor, "pacedTargetFor");
var pacerNow = /* @__PURE__ */ __name(() => performance.now(), "pacerNow");
var pacerWallNow = /* @__PURE__ */ __name(() => Date.now(), "pacerWallNow");
function reservePacerToken(ipcPath, body, messageId) {
  const now = pacerNow();
  const wallNow = pacerWallNow();
  const target = pacedTargetFor(ipcPath, now);
  target.tokens = refillBucket(
    target.tokens,
    target.lastRefill,
    now,
    PEER_ADMISSION_LIMITS.bucketCapacity,
    PEER_ADMISSION_LIMITS.refillPerSecond
  );
  target.lastRefill = now;
  target.bodies = target.bodies.filter(
    (record2) => isBodyWithinWindow(
      record2.at,
      record2.atWall,
      now,
      wallNow,
      PEER_ADMISSION_LIMITS.dedupWindowMs
    )
  );
  const bodyHash = hashBody(body);
  const lastBody = target.bodies.at(-1);
  if (lastBody?.hash === bodyHash) {
    return { ok: false, repeat: true };
  }
  if (!hasToken(target.tokens)) {
    return { ok: false, sentInBurst: target.sentInBurst };
  }
  if (target.tokens >= PEER_ADMISSION_LIMITS.bucketCapacity || now - target.burstStartedAt > PEER_BURST_WINDOW_MS) {
    target.sentInBurst = 0;
    target.burstStartedAt = now;
  }
  const generation = target.generation;
  target.tokens -= 1;
  const record = {
    messageId: canonicalizeMsgId(messageId),
    hash: bodyHash,
    at: now,
    atWall: wallNow,
    generation,
    tokenSpent: true
  };
  target.bodies.push(record);
  target.sentInBurst += 1;
  let refunded = false;
  return {
    ok: true,
    refund: /* @__PURE__ */ __name(() => {
      if (refunded) return;
      refunded = true;
      refundPacedRecord(target, record, true);
      forgetPacedBodies(target, [messageId]);
    }, "refund")
  };
}
__name(reservePacerToken, "reservePacerToken");
function drainSendPacer(ipcPath) {
  const target = pacedTargets.get(ipcPath);
  if (target === void 0) return;
  target.tokens = 0;
  target.lastRefill = pacerNow();
  target.generation += 1;
}
__name(drainSendPacer, "drainSendPacer");
function forgetSendPacerMessages(ipcPath, messageIds) {
  const target = pacedTargets.get(ipcPath);
  if (target === void 0) return;
  forgetPacedBodies(target, messageIds);
}
__name(forgetSendPacerMessages, "forgetSendPacerMessages");
function refundSendPacerMessage(ipcPath, messageId) {
  const target = pacedTargets.get(ipcPath);
  if (target === void 0) return;
  const canonicalId = canonicalizeMsgId(messageId);
  const record = target.bodies.find((body) => body.messageId === canonicalId);
  if (record === void 0) return;
  refundPacedRecord(target, record);
  forgetPacedBodies(target, [messageId]);
}
__name(refundSendPacerMessage, "refundSendPacerMessage");
function refundSendPacerToken(ipcPath, messageId) {
  const target = pacedTargets.get(ipcPath);
  if (target === void 0) return;
  const canonicalId = canonicalizeMsgId(messageId);
  const record = target.bodies.find((body) => body.messageId === canonicalId);
  if (record === void 0) return;
  refundPacedRecord(target, record);
}
__name(refundSendPacerToken, "refundSendPacerToken");
function refundPacedRecord(target, record, decrementBurst = false) {
  if (!record.tokenSpent) return;
  record.tokenSpent = false;
  if (decrementBurst) {
    target.sentInBurst = Math.max(0, target.sentInBurst - 1);
  }
  if (record.generation === target.generation) {
    target.tokens = Math.min(
      PEER_ADMISSION_LIMITS.bucketCapacity,
      target.tokens + 1
    );
  }
}
__name(refundPacedRecord, "refundPacedRecord");
function forgetPacedBodies(target, messageIds) {
  const forgotten = new Set(messageIds.map(canonicalizeMsgId));
  target.bodies = target.bodies.filter(
    (record) => !forgotten.has(record.messageId)
  );
}
__name(forgetPacedBodies, "forgetPacedBodies");
async function sendToPeer(options) {
  const own = await readOwnSessionRecord(options.slot);
  const self = own === null ? null : toPeerSessionInfo(own);
  if (!self) return { kind: "disabled" };
  const directory = await listMessageablePeers();
  const peers = directory.filter((peer2) => peer2.sessionId !== self.sessionId);
  const resolved = resolvePeerTarget(peers, options.target);
  if (resolved.kind === "none") {
    const incarnations = [
      self,
      ...directory.filter((peer2) => peer2.sessionId === self.sessionId)
    ];
    if (resolvePeerTarget(incarnations, options.target).kind !== "none") {
      return { kind: "self", name: self.name };
    }
    return {
      kind: "not-found",
      suggestions: suggestPeerNames(
        peers,
        options.target,
        void 0,
        options.isReserved
      )
    };
  }
  if (resolved.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      // Round-trip every address before printing it. `name [ref]` is the
      // form the caller is told to retry with, but two sessions can share
      // both — one name over a 6-hex ref collision — and then this list
      // prints one string twice and the retry it advises resolves straight
      // back to this branch. `advertisablePeerAddress` is the same
      // uniqueness check `list_agents` prints through, so an entry that
      // survives it is an address the retry can actually use.
      matches: resolved.matches.map((peer2) => {
        const address2 = advertisablePeerAddress(
          peer2,
          peers,
          options.isReserved
        );
        return address2 === void 0 ? `${peer2.name} [${peer2.ref}] in ${peer2.cwd} \u2014 no address reaches this one while its twin is running` : `${address2} in ${peer2.cwd}`;
      })
    };
  }
  const peer = resolved.peer;
  if (peer.ipcPath === self.ipcPath) {
    const fresh = await readOwnSessionRecord(options.slot);
    if (fresh !== null && fresh.sessionId === peer.sessionId) {
      return { kind: "self", name: self.name };
    }
  }
  const address = advertisablePeerAddress(peer, peers, options.isReserved) ?? options.target.trim();
  if (options.message.length === 0) {
    return {
      kind: "failed",
      peer,
      address,
      reason: "the message is empty \u2014 there is nothing to deliver. Say what to send."
    };
  }
  const frame = buildUserFrame({
    content: options.message,
    from: self.ipcPath,
    // Our own inbox token, so the receiver's receipts authenticate back.
    ...self.ipcToken !== void 0 ? { replyToken: self.ipcToken } : {},
    fromName: self.name,
    // Pin the frame to the session the name resolved to. The address is
    // keyed by PID, and PIDs get reused: if that session has since been
    // replaced by another one at the same path, the receiver sees the
    // mismatch and refuses rather than acting on a message meant for its
    // predecessor.
    toSessionId: peer.sessionId,
    ...options.approvalMode !== null ? { fromMode: senderModeClass(options.approvalMode) } : {}
  });
  const reservation = reservePacerToken(
    peer.ipcPath,
    options.message,
    frame.msgId
  );
  if (!reservation.ok) {
    return {
      kind: "failed",
      peer,
      address,
      reason: reservation.repeat ? `that exact message went to that inbox within the last ${PEER_ADMISSION_LIMITS.dedupWindowMs / 1e3} seconds, and it turns away a repeat before anyone reads it, so this one was not sent. Say something different, or wait for a reply rather than re-sending.` : reservation.sentInBurst === 0 ? "that session inbox is still over its rate limit, so this message was not sent. Wait a little before sending more." : `too many messages to that session just now: ${reservation.sentInBurst} were sent in the last ${PEER_BURST_WINDOW_MS / 1e3} seconds and more would be dropped by its rate limit, so this one was not sent. Batch what remains into one message, or wait a little before sending more.`
    };
  }
  trackSent(frame.msgId, {
    address,
    ipcPath: peer.ipcPath,
    sentAt: pacerWallNow(),
    state: "pending"
  });
  try {
    await sendPeerFrame(peer.ipcPath, frame, {
      ...peer.ipcToken !== void 0 ? { authToken: peer.ipcToken } : {}
    });
    return { kind: "sent", peer, address };
  } catch (error) {
    const definitelyUnwritten = error instanceof PeerSendError && NEVER_WRITTEN_SEND_CODES.has(error.code);
    if (definitelyUnwritten) {
      reservation.refund();
      sentMessages.delete(canonicalizeMsgId(frame.msgId));
    }
    return {
      kind: "failed",
      peer,
      address,
      reason: describeSendFailure(error)
    };
  }
}
__name(sendToPeer, "sendToPeer");
function describeSendFailure(error) {
  if (error instanceof PeerSendError) {
    switch (error.code) {
      case "ENOENT":
      case "ECONNREFUSED":
        return "that session just exited \u2014 its address is stale. List the agents again to see who is reachable now.";
      case "EAGAIN":
      case "EBUSY":
        return "the session is alive but momentarily busy. Retry the same name shortly.";
      case "ETIMEDOUT":
        return "the session accepted the connection but had not read the message after 5 seconds. It may still read it once it is free, so do not assume it was lost or resend the same message; wait for a delivery receipt, then tell that session user if none arrives.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
__name(describeSendFailure, "describeSendFailure");

export {
  MAX_DROPPED_MSG_IDS,
  MAX_FRAME_BYTES,
  MAX_RETAINED_REPLY_TOKEN_CHARS,
  canonicalizeMsgId,
  parsePeerFrame,
  describeDeliveryStatus,
  describeDropReason,
  parsePeerAuthLine,
  MAX_SOCKET_PATH_BYTES,
  SOCKET_DIR_NAME,
  resolvePeerSocketCandidates,
  isLocalIpcPath,
  sendDeliveryStatus,
  probePeerSocketVerdict,
  listMessageablePeers,
  advertisablePeerAddress,
  isInProcessRecipient,
  PEER_ADMISSION_LIMITS,
  MAX_HELD_MESSAGES,
  MAX_SENDER_KEY_CHARS,
  peerSenderKey,
  parseHeldExpiry,
  InboundGate,
  describeHoldCause,
  getOwnPeerIdentity,
  settleSentPeerMessage,
  drainSendPacer,
  forgetSendPacerMessages,
  refundSendPacerMessage,
  refundSendPacerToken,
  sendToPeer
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
