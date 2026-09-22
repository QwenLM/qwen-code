// Force strict mode and setup for ESM
"use strict";
import {
  getInboxesDir
} from "./chunk-YVYK3JYU.js";
import {
  require_proper_lockfile
} from "./chunk-MLXTMF7H.js";
import {
  Mutex
} from "./chunk-VGC4I5JJ.js";
import {
  atomicWriteJSON
} from "./chunk-CA63HYHU.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  isNodeError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/agents/team/leaderPermissionBridge.ts
init_esbuild_shims();
var leaderCallbacks = null;
function unregisterLeader() {
  leaderCallbacks = null;
}
__name(unregisterLeader, "unregisterLeader");
function forwardApproval(teammateName, teammateColor, details) {
  if (!leaderCallbacks) {
    return false;
  }
  leaderCallbacks.enqueueApproval({
    teammateName,
    teammateColor,
    details
  });
  return true;
}
__name(forwardApproval, "forwardApproval");
function wrapConfirmWithBadge(original, teammateName, respond, _teammateColor) {
  return {
    ...original,
    title: `[${teammateName}] ${original.title}`,
    onConfirm: /* @__PURE__ */ __name(async (outcome, payload) => {
      await respond(outcome, payload);
    }, "onConfirm")
  };
}
__name(wrapConfirmWithBadge, "wrapConfirmWithBadge");

// packages/core/src/agents/team/mailbox.ts
init_esbuild_shims();
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import * as fs from "node:fs/promises";
import * as path from "node:path";
var debug = createDebugLogger("AGENTS_TEAM_MAILBOX");
var LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
    // Jitter the backoff so cross-process contenders don't retry in
    // lockstep (thundering herd) and starve each other out of the
    // retry budget.
    randomize: true
  },
  stale: 5e3,
  // Stale locks from crashed processes are expected in multi-agent
  // scenarios; log at debug level for traceability without noise.
  onCompromised: /* @__PURE__ */ __name((err) => {
    debug.debug("mailbox lock compromised:", err);
  }, "onCompromised")
};
var inboxLocks = /* @__PURE__ */ new Map();
function getInboxLock(inboxPath) {
  let lock = inboxLocks.get(inboxPath);
  if (!lock) {
    lock = new Mutex();
    inboxLocks.set(inboxPath, lock);
  }
  return lock;
}
__name(getInboxLock, "getInboxLock");
function disposeInboxLocks(teamName) {
  const dir = getInboxesDir(teamName);
  let evicted = 0;
  for (const key of inboxLocks.keys()) {
    if (path.dirname(key) === dir) {
      inboxLocks.delete(key);
      evicted++;
    }
  }
  return evicted;
}
__name(disposeInboxLocks, "disposeInboxLocks");
async function withInboxLock(inboxPath, fn) {
  return getInboxLock(inboxPath).runExclusive(async () => {
    const release = await import_proper_lockfile.default.lock(inboxPath, LOCK_OPTIONS);
    try {
      return await fn();
    } finally {
      try {
        await release();
      } catch (error) {
        debug.debug("Failed to release mailbox lock:", error);
      }
    }
  });
}
__name(withInboxLock, "withInboxLock");
function getInboxPath(teamName, agentName) {
  return path.join(getInboxesDir(teamName), `${agentName}.json`);
}
__name(getInboxPath, "getInboxPath");
async function readInbox(teamName, agentName) {
  const inboxPath = getInboxPath(teamName, agentName);
  try {
    const raw = await fs.readFile(inboxPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return [];
    throw err;
  }
}
__name(readInbox, "readInbox");
var READ_RETENTION_MS = 5 * 60 * 1e3;
async function writeMessage(teamName, toAgentName, message) {
  const inboxPath = getInboxPath(teamName, toAgentName);
  await ensureInboxFile(inboxPath);
  await withInboxLock(inboxPath, async () => {
    const messages = await readInboxRaw(inboxPath);
    const cutoff = Date.now() - READ_RETENTION_MS;
    const compacted = messages.filter((m) => {
      if (!m.read) return true;
      const ts = Date.parse(m.timestamp);
      return Number.isNaN(ts) || ts >= cutoff;
    });
    compacted.push(message);
    await atomicWriteJSON(inboxPath, compacted);
  });
}
__name(writeMessage, "writeMessage");
async function consumeUnread(teamName, agentName, type) {
  const inboxPath = getInboxPath(teamName, agentName);
  await ensureInboxFile(inboxPath);
  return withInboxLock(inboxPath, async () => {
    const messages = await readInboxRaw(inboxPath);
    const predicate = /* @__PURE__ */ __name((m) => !m.read && (type === void 0 || m.type === type), "predicate");
    const matching = messages.filter(predicate);
    if (matching.length === 0) return [];
    const updated = messages.map(
      (m) => predicate(m) ? { ...m, read: true } : m
    );
    await atomicWriteJSON(inboxPath, updated);
    return matching;
  });
}
__name(consumeUnread, "consumeUnread");
async function clearAllInboxes(teamName) {
  const dir = getInboxesDir(teamName);
  await fs.rm(dir, { recursive: true, force: true });
  disposeInboxLocks(teamName);
}
__name(clearAllInboxes, "clearAllInboxes");
async function sendStructuredMessage(teamName, toAgentName, opts) {
  await writeMessage(teamName, toAgentName, {
    from: opts.from,
    text: opts.text,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    read: false,
    type: opts.type,
    color: opts.color,
    summary: opts.summary
  });
}
__name(sendStructuredMessage, "sendStructuredMessage");
async function ensureInboxFile(inboxPath) {
  await fs.mkdir(path.dirname(inboxPath), { recursive: true });
  try {
    await fs.writeFile(inboxPath, "[]\n", { flag: "wx" });
  } catch (err) {
    if (!isNodeError(err) || err.code !== "EEXIST") throw err;
  }
}
__name(ensureInboxFile, "ensureInboxFile");
async function readInboxRaw(inboxPath) {
  try {
    const raw = await fs.readFile(inboxPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return [];
    const errMsg = err instanceof Error ? err.message : String(err);
    debug.warn(`Quarantining corrupt inbox at ${inboxPath}: ${errMsg}`);
    try {
      await fs.rename(inboxPath, `${inboxPath}.corrupt-${Date.now()}`);
    } catch (renameErr) {
      const renameMsg = renameErr instanceof Error ? renameErr.message : String(renameErr);
      debug.warn(`Failed to quarantine ${inboxPath}: ${renameMsg}`);
      throw err instanceof Error ? err : new Error(`Failed to read inbox at ${inboxPath}: ${errMsg}`);
    }
    return [];
  }
}
__name(readInboxRaw, "readInboxRaw");

export {
  unregisterLeader,
  forwardApproval,
  wrapConfirmWithBadge,
  disposeInboxLocks,
  getInboxPath,
  readInbox,
  writeMessage,
  consumeUnread,
  clearAllInboxes,
  sendStructuredMessage
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
