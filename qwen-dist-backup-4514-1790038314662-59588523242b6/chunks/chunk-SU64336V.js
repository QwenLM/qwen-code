// Force strict mode and setup for ESM
"use strict";
import {
  isSameProcess,
  readLocalBootId,
  readPidNamespaceId,
  readProcStartToken
} from "./chunk-YVYK3JYU.js";
import {
  require_proper_lockfile
} from "./chunk-MLXTMF7H.js";
import {
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/commands/channel/pidfile.ts
init_esbuild_shims();
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  constants,
  ftruncateSync,
  writeSync
} from "node:fs";
import * as path2 from "node:path";

// packages/cli/src/commands/channel/pidfile-lock.ts
init_esbuild_shims();
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import fs from "node:fs";
import path from "node:path";
var RETRY_DELAYS_MS = [10, 20, 30, 40, 50];
var STALE_LOCK_MS = 1e4;
var sleepState = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepState, 0, 0, ms);
}
__name(sleepSync, "sleepSync");
function withChannelPidfileLock(filePath, operation) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let release;
  for (let attempt = 0; ; attempt += 1) {
    try {
      release = import_proper_lockfile.default.lockSync(filePath, {
        realpath: false,
        stale: STALE_LOCK_MS
      });
      break;
    } catch (error) {
      const lockError = error;
      if (lockError.code !== "ELOCKED") {
        throw error;
      }
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw Object.assign(
          new Error(
            `Channel pidfile lock ${filePath}.lock is held; an abandoned lock recovers automatically after ${STALE_LOCK_MS / 1e3} seconds.`,
            { cause: error }
          ),
          { code: "ELOCKED" }
        );
      }
      sleepSync(RETRY_DELAYS_MS[attempt]);
    }
  }
  try {
    return operation();
  } finally {
    release();
  }
}
__name(withChannelPidfileLock, "withChannelPidfileLock");

// packages/cli/src/commands/channel/pidfile.ts
function pidFilePath() {
  return path2.join(Storage.getGlobalQwenDir(), "channels", "service.pid");
}
__name(pidFilePath, "pidFilePath");
function isValidPid(pid) {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}
__name(isValidPid, "isValidPid");
function parseServiceInfo(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const info = value;
  const owner = info.owner ?? "channel";
  if (owner !== "channel" && owner !== "serve") return null;
  if (!isValidPid(info.pid) || typeof info.startedAt !== "string" || Number.isNaN(Date.parse(info.startedAt)) || !Array.isArray(info.channels) || !info.channels.every((channel) => typeof channel === "string")) {
    return null;
  }
  if (info.servePid !== void 0 && !isValidPid(info.servePid)) return null;
  if (info.workerPid !== void 0 && !isValidPid(info.workerPid)) return null;
  if (info.procStart !== void 0 && info.procStart !== null && typeof info.procStart !== "string") {
    return null;
  }
  if (info.pidNs !== void 0 && info.pidNs !== null && typeof info.pidNs !== "number") {
    return null;
  }
  const workers = parseServiceInfoWorkers(info.workers);
  if (workers === null) return null;
  return {
    owner,
    pid: info.pid,
    ...info.procStart !== void 0 ? { procStart: info.procStart } : {},
    ...info.pidNs !== void 0 ? { pidNs: info.pidNs } : {},
    startedAt: info.startedAt,
    channels: info.channels,
    ...info.servePid !== void 0 ? { servePid: info.servePid } : {},
    ...info.workerPid !== void 0 ? { workerPid: info.workerPid } : {},
    ...workers !== void 0 ? { workers } : {}
  };
}
__name(parseServiceInfo, "parseServiceInfo");
function parseServiceInfoWorkers(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) return null;
  const workers = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    const worker = raw;
    if (!Array.isArray(worker.channels) || !worker.channels.every((channel) => typeof channel === "string")) {
      return null;
    }
    if (worker.workspaceId !== void 0 && typeof worker.workspaceId !== "string") {
      return null;
    }
    if (worker.workspaceCwd !== void 0 && typeof worker.workspaceCwd !== "string") {
      return null;
    }
    if (worker.workerPid !== void 0 && !isValidPid(worker.workerPid)) {
      return null;
    }
    workers.push({
      channels: worker.channels,
      ...worker.workspaceId !== void 0 ? { workspaceId: worker.workspaceId } : {},
      ...worker.workspaceCwd !== void 0 ? { workspaceCwd: worker.workspaceCwd } : {},
      ...worker.workerPid !== void 0 ? { workerPid: worker.workerPid } : {}
    });
  }
  return workers;
}
__name(parseServiceInfoWorkers, "parseServiceInfoWorkers");
function unlinkPidFile(filePath) {
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
__name(unlinkPidFile, "unlinkPidFile");
function bootIdOf(procStart) {
  if (procStart == null) return null;
  const separator = procStart.indexOf(":");
  return separator === -1 ? null : procStart.slice(0, separator);
}
__name(bootIdOf, "bootIdOf");
function isLocalIdentity(info) {
  if (info.pidNs !== void 0 && info.pidNs !== readPidNamespaceId()) {
    return false;
  }
  const recordBootId = bootIdOf(info.procStart);
  return recordBootId === null || recordBootId === readLocalBootId();
}
__name(isLocalIdentity, "isLocalIdentity");
function isOwnServeReservation(info, servePid) {
  return info !== null && info.owner === "serve" && info.pid === servePid && info.servePid === servePid && isLocalIdentity(info);
}
__name(isOwnServeReservation, "isOwnServeReservation");
function withPidFileLock(operation) {
  const filePath = pidFilePath();
  return withChannelPidfileLock(filePath, () => operation(filePath));
}
__name(withPidFileLock, "withPidFileLock");
function readServiceInfo() {
  const filePath = pidFilePath();
  if (!existsSync(filePath)) return null;
  try {
    return withChannelPidfileLock(
      filePath,
      () => readServiceInfoRecord(filePath, true)
    );
  } catch {
    return readServiceInfoRecord(filePath, false);
  }
}
__name(readServiceInfo, "readServiceInfo");
function readServiceInfoRecord(filePath, sweep) {
  if (!existsSync(filePath)) return null;
  let raw;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (sweep) unlinkPidFile(filePath);
    return null;
  }
  const info = parseServiceInfo(parsed);
  if (!info) {
    if (sweep) unlinkPidFile(filePath);
    return null;
  }
  if (!isLocalIdentity(info)) {
    return null;
  }
  if (!isSameProcess(info.pid, info.procStart)) {
    if (sweep) unlinkPidFile(filePath);
    return null;
  }
  return info;
}
__name(readServiceInfoRecord, "readServiceInfoRecord");
function writeInfo(info, flag = "w") {
  const filePath = pidFilePath();
  const dir = path2.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(info, null, 2), {
    encoding: "utf-8",
    flag
  });
}
__name(writeInfo, "writeInfo");
function fileExistsError(message) {
  const err = new Error(message);
  err.code = "EEXIST";
  return err;
}
__name(fileExistsError, "fileExistsError");
function writeInfoExclusive(info) {
  const filePath = pidFilePath();
  try {
    writeInfo(info, "wx");
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    let existing = null;
    try {
      existing = parseServiceInfo(JSON.parse(readFileSync(filePath, "utf-8")));
    } catch {
      throw err;
    }
    if (existing && !isLocalIdentity(existing)) {
      const conflict = new Error(
        `Channel service pidfile ${filePath} holds a record this machine cannot verify, written before a reboot or by another machine or PID namespace sharing this home. Confirm no channel service is running, then delete that file to start again.`
      );
      conflict.code = "channel_service_conflict";
      throw conflict;
    }
    if (existing && isSameProcess(existing.pid, existing.procStart)) {
      throw err;
    }
    unlinkPidFile(filePath);
    writeInfo(info, "wx");
  }
}
__name(writeInfoExclusive, "writeInfoExclusive");
function readPidfileProcessToken(pid) {
  let procStart = readProcStartToken(pid);
  if (process.platform !== "linux" || procStart !== null) return procStart;
  procStart = readProcStartToken(pid);
  if (procStart !== null) return procStart;
  throw new Error(
    `Unable to read the process start token for PID ${pid}; refusing to write an impersonable Channel pidfile.`
  );
}
__name(readPidfileProcessToken, "readPidfileProcessToken");
function readPidfileNamespaceId() {
  let pidNs = readPidNamespaceId();
  if (process.platform !== "linux" || pidNs !== null) return pidNs;
  pidNs = readPidNamespaceId();
  if (pidNs !== null) return pidNs;
  throw new Error(
    "Unable to read the PID namespace id; refusing to write an unreclaimable Channel pidfile."
  );
}
__name(readPidfileNamespaceId, "readPidfileNamespaceId");
function writeServiceInfo(channels) {
  const info = {
    owner: "channel",
    pid: process.pid,
    procStart: readPidfileProcessToken(process.pid),
    pidNs: readPidfileNamespaceId(),
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    channels
  };
  withPidFileLock(() => writeInfoExclusive(info));
}
__name(writeServiceInfo, "writeServiceInfo");
function writeServeServiceInfo({
  channels,
  servePid = process.pid,
  workerPid,
  workers
}) {
  const buildInfo = /* @__PURE__ */ __name((startedAt, procStart) => ({
    owner: "serve",
    pid: servePid,
    procStart,
    pidNs: readPidfileNamespaceId(),
    startedAt,
    channels,
    servePid,
    ...workerPid !== void 0 ? { workerPid } : {},
    ...workers !== void 0 ? { workers } : {}
  }), "buildInfo");
  withPidFileLock((filePath) => {
    let fd;
    try {
      fd = openSync(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (err) {
      if (err.code === "ENOENT") {
        writeInfo(
          buildInfo(
            (/* @__PURE__ */ new Date()).toISOString(),
            readPidfileProcessToken(servePid)
          ),
          "wx"
        );
        return;
      }
      throw err;
    }
    try {
      let existing = null;
      try {
        existing = parseServiceInfo(JSON.parse(readFileSync(fd, "utf-8")));
      } catch {
      }
      if (!isOwnServeReservation(existing, servePid)) {
        throw fileExistsError(
          "Channel service pidfile is owned by another process."
        );
      }
      const info = buildInfo(
        existing.startedAt,
        existing.procStart ?? readPidfileProcessToken(servePid)
      );
      ftruncateSync(fd, 0);
      writeSync(fd, JSON.stringify(info, null, 2), 0, "utf-8");
    } finally {
      closeSync(fd);
    }
  });
}
__name(writeServeServiceInfo, "writeServeServiceInfo");
function reserveServeServiceInfo({
  channels,
  servePid = process.pid
}) {
  const info = {
    owner: "serve",
    pid: servePid,
    procStart: readPidfileProcessToken(servePid),
    pidNs: readPidfileNamespaceId(),
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    channels,
    servePid
  };
  withPidFileLock(() => writeInfoExclusive(info));
}
__name(reserveServeServiceInfo, "reserveServeServiceInfo");
function removeServiceInfo(expected) {
  try {
    withPidFileLock((filePath) => {
      if (!expected) {
        if (existsSync(filePath)) unlinkPidFile(filePath);
        return;
      }
      try {
        const current = parseServiceInfo(
          JSON.parse(readFileSync(filePath, "utf-8"))
        );
        if (current?.owner === expected.owner && current.pid === expected.pid && current.procStart === expected.procStart && current.startedAt === expected.startedAt) {
          unlinkPidFile(filePath);
        }
      } catch {
      }
    });
  } catch {
  }
}
__name(removeServiceInfo, "removeServiceInfo");
function removeServeServiceInfo(servePid = process.pid) {
  try {
    return withPidFileLock((filePath) => {
      if (!existsSync(filePath)) return false;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        return false;
      }
      if (!isOwnServeReservation(parseServiceInfo(parsed), servePid)) {
        return false;
      }
      return unlinkPidFile(filePath);
    });
  } catch {
    return false;
  }
}
__name(removeServeServiceInfo, "removeServeServiceInfo");
function signalService(pid, signal = "SIGTERM", procStart) {
  if (!isValidPid(pid)) {
    return "refused";
  }
  if (procStart != null) {
    const current = readProcStartToken(pid) ?? readProcStartToken(pid);
    if (current !== procStart) return "refused";
  }
  try {
    process.kill(pid, signal);
    return "sent";
  } catch (err) {
    return err.code === "EPERM" ? "not-permitted" : "refused";
  }
}
__name(signalService, "signalService");
async function waitForExit(pid, timeoutMs = 5e3, pollMs = 200, procStart) {
  const isOriginalProcessAlive = /* @__PURE__ */ __name(() => isSameProcess(pid, procStart), "isOriginalProcessAlive");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isOriginalProcessAlive()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !isOriginalProcessAlive();
}
__name(waitForExit, "waitForExit");

export {
  pidFilePath,
  readServiceInfo,
  writeServiceInfo,
  writeServeServiceInfo,
  reserveServeServiceInfo,
  removeServiceInfo,
  removeServeServiceInfo,
  signalService,
  waitForExit
};
