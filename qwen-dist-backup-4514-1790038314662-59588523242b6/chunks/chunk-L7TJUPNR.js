// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/dist/process-registry.js
init_esbuild_shims();
import { execFile, spawnSync } from "node:child_process";
var TERM_GRACE_MS = 5e3;
var EXIT_DEADLINE_MS = 1e4;
var PROCESS_QUERY_TIMEOUT_MS = 2e3;
var PROCESS_QUERY_MAX_BUFFER = 8 * 1024 * 1024;
var PROCESS_POLL_MS = 50;
var PROCESS_STATE_POLL_MS = 250;
var MAX_OWNED_PROCESSES = 256;
var MAX_OWNERSHIP_DEPTH = 8;
var POSIX_PS = "/bin/ps";
var WINDOWS_TASKKILL = `${process.env["SystemRoot"] || "C:\\Windows"}\\System32\\taskkill.exe`;
var STRING_EXEC_OPTIONS = {
  encoding: "utf8",
  maxBuffer: PROCESS_QUERY_MAX_BUFFER,
  timeout: PROCESS_QUERY_TIMEOUT_MS,
  windowsHide: true
};
var ProcessRegistry = class {
  static {
    __name(this, "ProcessRegistry");
  }
  reservations = /* @__PURE__ */ new Set();
  children = /* @__PURE__ */ new Set();
  draining = false;
  shutdownPromise;
  reserve() {
    if (this.draining) {
      throw new Error("ACP process registry is draining");
    }
    const token = Symbol("acp-child");
    this.reservations.add(token);
    let settled = false;
    return {
      attach: /* @__PURE__ */ __name((child, options) => {
        if (settled || !this.reservations.delete(token)) {
          throw new Error("ACP process reservation is no longer active");
        }
        settled = true;
        const tracked = new TrackedChild(child, options?.ownsProcessTree === true, () => {
          this.children.delete(tracked);
        });
        this.children.add(tracked);
        if (this.draining)
          void tracked.terminate().catch(() => {
          });
        return tracked;
      }, "attach"),
      cancel: /* @__PURE__ */ __name(() => {
        if (settled)
          return;
        settled = true;
        this.reservations.delete(token);
      }, "cancel")
    };
  }
  shutdown() {
    if (this.shutdownPromise)
      return this.shutdownPromise;
    this.draining = true;
    this.shutdownPromise = Promise.allSettled([...this.children].map((child) => child.terminate())).then((results) => {
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) {
        throw new AggregateError(failures, "ACP child process shutdown failed");
      }
    });
    return this.shutdownPromise;
  }
  killAllSync() {
    this.draining = true;
    let processTable;
    if (process.platform !== "win32" && [...this.children].some((child) => child.needsProcessTreeSnapshot)) {
      try {
        processTable = parseProcessTable(queryProcessTableSync());
      } catch {
        processTable = null;
      }
    }
    for (const child of this.children)
      child.killSync(processTable);
  }
  get activeProcessCount() {
    return this.children.size;
  }
  /**
   * Children this registry has committed to: attached ones plus reservations
   * that have not attached yet. Larger than {@link activeProcessCount}, and
   * the right figure for admission — `reserve()` inserts its token
   * synchronously before `spawn()`, so two racing spawns each see the other
   * here, while neither is visible in `activeProcessCount` until its child is
   * attached.
   *
   * A direct child leaves this count when its root exits. A tree-owned child
   * under explicit teardown remains committed until its known tree is gone,
   * so a channel swap includes memory still held by descendants.
   */
  get committedProcessCount() {
    return this.children.size + this.reservations.size;
  }
};
var TrackedChild = class {
  static {
    __name(this, "TrackedChild");
  }
  child;
  ownsProcessTree;
  onRelease;
  exited;
  knownGroups = /* @__PURE__ */ new Set();
  cleanupProofError;
  exitInfo;
  exitedSettled = false;
  forceKillRequested = false;
  released = false;
  releasePollTimer;
  releaseStateCheckInFlight = false;
  spawnConfirmed = false;
  terminatePromise;
  terminating = false;
  terminationSettled = false;
  constructor(child, ownsProcessTree, onRelease) {
    this.child = child;
    this.ownsProcessTree = ownsProcessTree;
    this.onRelease = onRelease;
    this.rememberRoot();
    this.exited = new Promise((resolve) => {
      const finish = /* @__PURE__ */ __name((info) => {
        if (this.exitedSettled)
          return;
        this.exitedSettled = true;
        this.exitInfo = info;
        resolve(info);
        this.handleRootExit();
      }, "finish");
      child.once("exit", (exitCode, signalCode) => {
        finish({ exitCode, signalCode });
      });
      child.once("spawn", () => {
        this.spawnConfirmed = true;
        this.rememberRoot();
      });
      child.once("error", () => {
        if (!this.spawnConfirmed)
          finish(void 0);
      });
    });
  }
  terminate() {
    if (this.terminatePromise)
      return this.terminatePromise;
    this.terminating = true;
    if (this.releasePollTimer) {
      clearTimeout(this.releasePollTimer);
      this.releasePollTimer = void 0;
    }
    const termination = this.ownsProcessTree ? this.terminateTree() : this.terminateDirectChild();
    this.terminatePromise = termination.finally(() => {
      this.terminationSettled = true;
      if (this.ownsProcessTree && this.exitedSettled && !this.released) {
        this.releaseWhenGroupsExit();
      }
    });
    return this.terminatePromise;
  }
  get needsProcessTreeSnapshot() {
    return this.ownsProcessTree && !this.forceKillRequested && !this.rootHasExited && !this.released;
  }
  killSync(processTable) {
    if (!this.ownsProcessTree) {
      this.killDirectChildSync();
      return;
    }
    if (this.released)
      return;
    const firstForceKill = !this.forceKillRequested;
    this.forceKillRequested = true;
    const rootPid = this.rootPid;
    if (!rootPid) {
      this.killDirectChildSync();
      return;
    }
    if (process.platform === "win32") {
      if (!firstForceKill)
        return;
      if (!taskkillSync(rootPid))
        this.killDirectChildSync();
      return;
    }
    if (firstForceKill && !this.rootHasExited) {
      if (processTable === void 0)
        this.mergeSynchronousSnapshot();
      else if (processTable !== null) {
        this.mergeSnapshot(collectOwnership(processTable, rootPid));
      }
    }
    const rootSignalled = this.signalKnownGroups("SIGKILL");
    this.signalDirectRootIfNeeded("SIGKILL", rootSignalled);
    if (this.exitedSettled && this.survivingGroups().length === 0) {
      this.release();
    }
  }
  get rootPid() {
    const pid = this.child.pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : void 0;
  }
  get rootHasExited() {
    return this.exitedSettled || this.child.exitCode !== null || this.child.signalCode !== null;
  }
  rememberRoot() {
    if (!this.ownsProcessTree)
      return;
    const rootPid = this.rootPid;
    if (!rootPid)
      return;
    if (process.platform !== "win32")
      this.knownGroups.add(rootPid);
  }
  handleRootExit() {
    if (!this.ownsProcessTree) {
      this.release();
      return;
    }
    if (this.terminating && !this.terminationSettled)
      return;
    if (process.platform !== "win32") {
      this.forceKillRequested = true;
      this.signalKnownGroups("SIGKILL");
      this.releaseWhenGroupsExit();
      return;
    }
    this.release();
  }
  release() {
    if (this.released)
      return;
    this.released = true;
    if (this.releasePollTimer)
      clearTimeout(this.releasePollTimer);
    this.onRelease();
  }
  killDirectChildSync() {
    if (this.exitedSettled)
      return;
    try {
      this.child.kill("SIGKILL");
    } catch {
    }
  }
  signalDirectRootIfNeeded(signal, rootGroupSignalled) {
    const rootPid = this.rootPid;
    if (!rootPid || this.exitedSettled || rootGroupSignalled)
      return;
    try {
      this.child.kill(signal);
    } catch {
    }
  }
  async terminateDirectChild() {
    if (this.exitedSettled)
      return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      if (this.exitedSettled)
        return;
    }
    let hardKillTimer;
    let deadlineTimer;
    const deadline = new Promise((_, reject) => {
      hardKillTimer = setTimeout(() => this.killDirectChildSync(), TERM_GRACE_MS);
      hardKillTimer.unref();
      deadlineTimer = setTimeout(() => {
        reject(new Error(`ACP child pid=${this.child.pid ?? "unknown"} did not exit within ${EXIT_DEADLINE_MS}ms`));
      }, EXIT_DEADLINE_MS);
      deadlineTimer.unref();
    });
    try {
      const exitInfo = await Promise.race([this.exited, deadline]);
      this.throwForUncleanExit(exitInfo);
    } finally {
      if (hardKillTimer)
        clearTimeout(hardKillTimer);
      if (deadlineTimer)
        clearTimeout(deadlineTimer);
    }
  }
  async terminateTree() {
    if (this.exitedSettled && (process.platform === "win32" || this.released)) {
      return;
    }
    const rootPid = this.rootPid;
    if (!rootPid) {
      await this.terminateDirectChild();
      return;
    }
    if (process.platform === "win32") {
      await this.terminateWindowsTree(rootPid);
      return;
    }
    await this.terminatePosixTree(rootPid);
  }
  async terminatePosixTree(rootPid) {
    const startedAt = Date.now();
    if (!this.rootHasExited) {
      await this.mergeAsynchronousSnapshot(rootPid, true);
    }
    let escalated = this.forceKillRequested;
    let rootSignalled = this.signalKnownGroups(escalated ? "SIGKILL" : "SIGTERM");
    this.signalDirectRootIfNeeded(escalated ? "SIGKILL" : "SIGTERM", rootSignalled);
    const graceDeadline = Math.min(startedAt + EXIT_DEADLINE_MS, Date.now() + TERM_GRACE_MS);
    const exitDeadline = startedAt + EXIT_DEADLINE_MS;
    let nextStateCheckAt = 0;
    while (true) {
      let survivingGroups = this.survivingGroups();
      let now = Date.now();
      if (this.exitedSettled && escalated && survivingGroups.length > 0 && now < exitDeadline && now >= nextStateCheckAt) {
        await this.pruneTerminalGroups(survivingGroups, exitDeadline - now);
        nextStateCheckAt = Date.now() + PROCESS_STATE_POLL_MS;
        survivingGroups = this.survivingGroups();
        now = Date.now();
      }
      if (this.exitedSettled && survivingGroups.length === 0) {
        this.release();
        if (this.cleanupProofError)
          throw this.cleanupProofError;
        this.throwForUncleanExit(this.exitInfo);
        return;
      }
      if (!escalated && (this.forceKillRequested || now >= graceDeadline)) {
        if (!this.rootHasExited && this.knownGroups.has(rootPid)) {
          await this.mergeAsynchronousSnapshot(rootPid, false);
        }
        escalated = true;
        rootSignalled = this.signalKnownGroups("SIGKILL");
        this.signalDirectRootIfNeeded("SIGKILL", rootSignalled);
        continue;
      }
      if (now >= exitDeadline) {
        const groups = survivingGroups.join(",") || "none";
        const proof = this.cleanupProofError ? `; ${this.cleanupProofError.message}` : "";
        throw new Error(`ACP child pid=${rootPid} did not exit with its owned process groups within ${EXIT_DEADLINE_MS}ms (surviving pgids=${groups})${proof}`);
      }
      await delay(Math.min(PROCESS_POLL_MS, (escalated ? exitDeadline : graceDeadline) - now));
      if (this.forceKillRequested)
        escalated = true;
    }
  }
  async terminateWindowsTree(rootPid) {
    const startedAt = Date.now();
    let treeKillError;
    try {
      await taskkill(rootPid);
    } catch (error) {
      treeKillError = toError(error);
      this.killDirectChildSync();
    }
    const remainingMs = Math.max(1, EXIT_DEADLINE_MS - (Date.now() - startedAt));
    const exitInfo = await waitForPromise(this.exited, remainingMs).catch(() => {
      throw new Error(`ACP child pid=${rootPid} did not exit within ${EXIT_DEADLINE_MS}ms` + (treeKillError ? `; ${treeKillError.message}` : ""));
    });
    this.release();
    if (treeKillError) {
      throw new Error(`ACP child pid=${rootPid} process-tree cleanup failed: ${treeKillError.message}`);
    }
    this.throwForUncleanExit(exitInfo);
  }
  async mergeAsynchronousSnapshot(rootPid, initial) {
    try {
      const table = parseProcessTable(await queryProcessTable());
      if (this.rootHasExited) {
        if (initial && !this.forceKillRequested) {
          this.recordCleanupProofError(`ACP child pid=${rootPid} exited before its initial process-tree snapshot completed`);
        }
        return;
      }
      const snapshot = collectOwnership(table, rootPid);
      this.mergeSnapshot(snapshot);
      if (snapshot.truncated) {
        this.recordCleanupProofError(`ACP child pid=${rootPid} process-tree snapshot exceeded ${MAX_OWNED_PROCESSES} processes or depth ${MAX_OWNERSHIP_DEPTH}`);
      }
      if (initial && !snapshot.rootSeen) {
        this.recordCleanupProofError(`ACP child pid=${rootPid} was absent from the initial process-tree snapshot`);
      } else if (initial && !snapshot.rootIsGroupLeader) {
        this.recordCleanupProofError(`ACP child pid=${rootPid} was not an isolated process-group leader`);
      }
    } catch (error) {
      this.recordCleanupProofError(`ACP child pid=${rootPid} process-tree snapshot failed: ${toError(error).message}`);
    }
  }
  mergeSynchronousSnapshot() {
    const rootPid = this.rootPid;
    if (!rootPid || process.platform === "win32" || this.rootHasExited)
      return;
    try {
      const table = parseProcessTable(queryProcessTableSync());
      this.mergeSnapshot(collectOwnership(table, rootPid));
    } catch {
    }
  }
  mergeSnapshot(snapshot) {
    if (!snapshot.rootIsGroupLeader) {
      const rootPid = this.rootPid;
      if (snapshot.rootSeen && rootPid)
        this.knownGroups.delete(rootPid);
      return;
    }
    for (const group of snapshot.groups)
      this.knownGroups.add(group);
  }
  signalKnownGroups(signal) {
    const rootPid = this.rootPid;
    let rootSignalled = false;
    const groups = [...this.knownGroups].sort((left, right) => {
      if (left === rootPid)
        return 1;
      if (right === rootPid)
        return -1;
      return right - left;
    });
    for (const group of groups) {
      try {
        process.kill(-group, signal);
        if (group === rootPid)
          rootSignalled = true;
      } catch (error) {
        if (isErrno(error, "ESRCH")) {
          this.knownGroups.delete(group);
          continue;
        }
        this.recordCleanupProofError(`ACP child pid=${rootPid ?? "unknown"} could not send ${signal} to pgid=${group}: ${toError(error).message}`);
      }
    }
    return rootSignalled;
  }
  survivingGroups() {
    const surviving = [];
    for (const group of this.knownGroups) {
      try {
        process.kill(-group, 0);
        surviving.push(group);
      } catch (error) {
        if (isErrno(error, "ESRCH")) {
          this.knownGroups.delete(group);
          continue;
        }
        surviving.push(group);
        if (!isErrno(error, "EPERM")) {
          this.recordCleanupProofError(`ACP child pid=${this.rootPid ?? "unknown"} could not inspect pgid=${group}: ${toError(error).message}`);
        }
      }
    }
    return surviving;
  }
  recordCleanupProofError(message) {
    this.cleanupProofError ??= new Error(message);
  }
  async pruneTerminalGroups(groups, timeoutMs = PROCESS_QUERY_TIMEOUT_MS) {
    try {
      const table = parseProcessTable(await queryProcessTable(timeoutMs));
      const targets = new Set(groups);
      const terminalGroups = /* @__PURE__ */ new Set();
      const liveGroups = /* @__PURE__ */ new Set();
      for (const row of table.rowsByPid.values()) {
        if (!targets.has(row.pgid))
          continue;
        if (row.terminal)
          terminalGroups.add(row.pgid);
        else
          liveGroups.add(row.pgid);
      }
      for (const group of terminalGroups) {
        if (!liveGroups.has(group))
          this.knownGroups.delete(group);
      }
    } catch {
    }
  }
  releaseWhenGroupsExit() {
    if (this.released || this.releasePollTimer || this.releaseStateCheckInFlight || this.terminating && !this.terminationSettled) {
      return;
    }
    const survivingGroups = this.survivingGroups();
    if (survivingGroups.length === 0) {
      this.release();
      return;
    }
    this.releaseStateCheckInFlight = true;
    void this.pruneTerminalGroups(survivingGroups).finally(() => {
      this.releaseStateCheckInFlight = false;
      if (this.released)
        return;
      if (this.terminating && !this.terminationSettled)
        return;
      if (this.survivingGroups().length === 0) {
        this.release();
        return;
      }
      this.releasePollTimer = setTimeout(() => {
        this.releasePollTimer = void 0;
        this.releaseWhenGroupsExit();
      }, PROCESS_STATE_POLL_MS);
      this.releasePollTimer.unref();
    });
  }
  throwForUncleanExit(exitInfo) {
    if (exitInfo && (exitInfo.exitCode !== 0 || exitInfo.signalCode !== null)) {
      throw new Error(`ACP child pid=${this.child.pid ?? "unknown"} exited uncleanly during shutdown (code=${exitInfo.exitCode ?? "none"}, signal=${exitInfo.signalCode ?? "none"})`);
    }
  }
};
function parseProcessTable(stdout) {
  const rowsByPid = /* @__PURE__ */ new Map();
  const childrenByParent = /* @__PURE__ */ new Map();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)(?:\s+(\S+)(?:\s+(\d+))?)?$/u);
    if (!match)
      continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const pgid = Number.parseInt(match[3], 10);
    const state = match[4];
    const threadCount = match[5] ? Number.parseInt(match[5], 10) : void 0;
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || pid <= 0 || ppid < 0 || pgid <= 0) {
      continue;
    }
    const terminal = state?.startsWith("X") === true || state?.startsWith("Z") === true && (process.platform !== "linux" || threadCount === 1);
    rowsByPid.set(pid, { pgid, terminal });
    const children = childrenByParent.get(ppid);
    if (children)
      children.push(pid);
    else
      childrenByParent.set(ppid, [pid]);
  }
  if (rowsByPid.size === 0) {
    throw new Error("process-table query returned no parseable rows");
  }
  return { childrenByParent, rowsByPid };
}
__name(parseProcessTable, "parseProcessTable");
function collectOwnership(table, rootPid) {
  const groups = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const queue = [{ depth: 0, pid: rootPid }];
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.pid))
      continue;
    if (visited.size >= MAX_OWNED_PROCESSES) {
      truncated = true;
      break;
    }
    visited.add(current.pid);
    const row = table.rowsByPid.get(current.pid);
    if (row)
      groups.add(row.pgid);
    const children = table.childrenByParent.get(current.pid) ?? [];
    if (current.depth >= MAX_OWNERSHIP_DEPTH) {
      if (children.length > 0)
        truncated = true;
      continue;
    }
    for (const pid of children) {
      queue.push({ depth: current.depth + 1, pid });
    }
  }
  const root = table.rowsByPid.get(rootPid);
  return {
    groups,
    rootIsGroupLeader: root?.pgid === rootPid,
    rootSeen: root !== void 0,
    truncated
  };
}
__name(collectOwnership, "collectOwnership");
function queryProcessTable(timeoutMs = PROCESS_QUERY_TIMEOUT_MS) {
  let timer;
  const query = new Promise((resolve, reject) => {
    const child = execFile(POSIX_PS, posixPsArgs(), { ...STRING_EXEC_OPTIONS, timeout: 0 }, (error, stdout) => {
      if (error)
        reject(error);
      else
        resolve(stdout);
    });
    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        reject(error);
      }
    }, Math.max(1, Math.min(PROCESS_QUERY_TIMEOUT_MS, timeoutMs)));
  });
  return query.finally(() => {
    if (timer)
      clearTimeout(timer);
  });
}
__name(queryProcessTable, "queryProcessTable");
function queryProcessTableSync() {
  const result = spawnSync(POSIX_PS, posixPsArgs(), STRING_EXEC_OPTIONS);
  if (result.error)
    throw result.error;
  if (result.status !== 0) {
    throw new Error(`ps exited with status ${result.status ?? "unknown"}`);
  }
  return result.stdout;
}
__name(queryProcessTableSync, "queryProcessTableSync");
function posixPsArgs() {
  const columns = process.platform === "linux" ? "pid=,ppid=,pgid=,state=,nlwp=" : "pid=,ppid=,pgid=,state=";
  return ["-A", "-o", columns];
}
__name(posixPsArgs, "posixPsArgs");
function taskkill(rootPid) {
  return runExecFile(WINDOWS_TASKKILL, ["/f", "/t", "/pid", String(rootPid)], STRING_EXEC_OPTIONS);
}
__name(taskkill, "taskkill");
function taskkillSync(rootPid) {
  try {
    const result = spawnSync(WINDOWS_TASKKILL, ["/f", "/t", "/pid", String(rootPid)], STRING_EXEC_OPTIONS);
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}
__name(taskkillSync, "taskkillSync");
function runExecFile(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error)
        reject(error);
      else
        resolve(stdout);
    });
  });
}
__name(runExecFile, "runExecFile");
function waitForPromise(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline exceeded")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer)
      clearTimeout(timer);
  });
}
__name(waitForPromise, "waitForPromise");
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
__name(delay, "delay");
function isErrno(error, code) {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
__name(isErrno, "isErrno");
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
__name(toError, "toError");

export {
  ProcessRegistry
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
