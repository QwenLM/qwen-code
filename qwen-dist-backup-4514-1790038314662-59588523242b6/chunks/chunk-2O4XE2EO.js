// Force strict mode and setup for ESM
"use strict";
import {
  updateEventEmitter
} from "./chunk-YAF2MQZ6.js";
import {
  loadUndici
} from "./chunk-TXASDT2M.js";
import {
  t
} from "./chunk-POMFSBEC.js";
import {
  So
} from "./chunk-MRTRBONQ.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/standalone-update.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { spawn, execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";

// packages/cli/src/utils/standalone-update-verify.ts
init_esbuild_shims();
import { createPublicKey, verify } from "node:crypto";
var RELEASE_PUBLIC_KEY_DER_B64 = "MCowBQYDK2VwAyEAr9WRFLDauibZQKCe1oKfuFZn6zRMaEkD5+KVqN6mKM4=";
function verifySignature(sha256sumsContent, signatureBase64) {
  const key = createPublicKey({
    key: Buffer.from(RELEASE_PUBLIC_KEY_DER_B64, "base64"),
    format: "der",
    type: "spki"
  });
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64) {
    throw new Error(
      `Invalid signature length: expected 64 bytes, got ${signature.length}`
    );
  }
  const valid = verify(null, Buffer.from(sha256sumsContent), key, signature);
  if (!valid) {
    throw new Error(
      "SHA256SUMS signature verification failed \u2014 possible tampering detected"
    );
  }
}
__name(verifySignature, "verifySignature");

// packages/cli/src/ui/standalone-update.ts
var debugLogger = createDebugLogger("STANDALONE_UPDATE");
var OSS_BASE = "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code";
var GITHUB_BASE = "https://github.com/QwenLM/qwen-code/releases/download";
var FETCH_TIMEOUT_MS = 3e4;
var ARCHIVE_TIMEOUT_MS = 3e5;
var VALID_TARGETS = /* @__PURE__ */ new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win-x64"
]);
var SEMVER_RE = /^v?\d+\.\d+\.\d+(-[\w.]+)?$/;
function normalizeVersion(version) {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid version format: ${version}`);
  }
  return version.startsWith("v") ? version : `v${version}`;
}
__name(normalizeVersion, "normalizeVersion");
function validateTarget(target) {
  if (!VALID_TARGETS.has(target)) {
    throw new Error(`Unknown target: ${target}`);
  }
}
__name(validateTarget, "validateTarget");
function archiveFilename(target) {
  const ext = target.startsWith("win") ? "zip" : "tar.gz";
  return `qwen-code-${target}.${ext}`;
}
__name(archiveFilename, "archiveFilename");
function escapePS(s) {
  return s.replace(/'/g, "''");
}
__name(escapePS, "escapePS");
function resolveUpdateBaseUrl() {
  const value = process.env["QWEN_UPDATE_BASE_URL"]?.trim();
  if (!value) return void 0;
  const invalidUrl = /* @__PURE__ */ __name(() => new Error(
    "QWEN_UPDATE_BASE_URL must be an absolute HTTPS URL without credentials, query parameters, or a fragment."
  ), "invalidUrl");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrl();
  }
  if (!/^https:\/\//i.test(value) || url.username || url.password || /[?#\s]/.test(value)) {
    throw invalidUrl();
  }
  return url.href.replace(/\/+$/, "");
}
__name(resolveUpdateBaseUrl, "resolveUpdateBaseUrl");
async function tryFetch(url, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    const { fetch } = await loadUndici();
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.ok) return { response: res };
    await res.body?.cancel().catch(() => {
    });
    return { error: new Error(`HTTP ${res.status} ${res.statusText}`) };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    debugLogger.debug(`Fetch failed for ${url}: ${error.message}`);
    return { error };
  }
}
__name(tryFetch, "tryFetch");
async function downloadWithFallback(versionPath, filename, timeoutMs = FETCH_TIMEOUT_MS, baseUrl) {
  if (baseUrl) {
    const result = await tryFetch(
      `${baseUrl}/${versionPath}/${filename}`,
      timeoutMs
    );
    if (result.response) return result.response;
    throw new Error(
      `Failed to download ${filename} from QWEN_UPDATE_BASE_URL: ${result.error.message}`
    );
  }
  const ossUrl = `${OSS_BASE}/${versionPath}/${filename}`;
  const ossResult = await tryFetch(ossUrl, timeoutMs);
  if (ossResult.response) return ossResult.response;
  const ghUrl = `${GITHUB_BASE}/${versionPath}/${filename}`;
  const ghResult = await tryFetch(ghUrl, timeoutMs);
  if (ghResult.response) return ghResult.response;
  throw new Error(
    `Failed to download ${filename}: OSS (${ossResult.error?.message ?? "unknown"}), GitHub (${ghResult.error?.message ?? "unknown"})`
  );
}
__name(downloadWithFallback, "downloadWithFallback");
async function verifyChecksum(actualHash, filename, versionPath, baseUrl) {
  const response = await downloadWithFallback(
    versionPath,
    "SHA256SUMS",
    FETCH_TIMEOUT_MS,
    baseUrl
  );
  const text = await response.text();
  const requireSig = process.env["QWEN_REQUIRE_SIGNATURE"] === "1";
  let sigResponse;
  try {
    sigResponse = await downloadWithFallback(
      versionPath,
      "SHA256SUMS.sig",
      FETCH_TIMEOUT_MS,
      baseUrl
    );
  } catch (err) {
    debugLogger.debug("SHA256SUMS.sig not available:", err);
  }
  if (sigResponse) {
    const sigContent = await sigResponse.text();
    verifySignature(text, sigContent.trim());
    debugLogger.info("SHA256SUMS signature verified.");
  } else if (requireSig) {
    throw new Error(
      "SHA256SUMS.sig not found and QWEN_REQUIRE_SIGNATURE=1 is set"
    );
  } else {
    debugLogger.warn(
      "SHA256SUMS.sig not available \u2014 update integrity relies on SHA256 checksum only. Set QWEN_REQUIRE_SIGNATURE=1 to enforce signature verification."
    );
  }
  const expectedLine = text.split("\n").find((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) return false;
    const name = parts[parts.length - 1].replace(/^\*/, "");
    return name === filename;
  });
  if (!expectedLine) {
    throw new Error(`No checksum found for ${filename} in SHA256SUMS`);
  }
  const expectedHash = expectedLine.trim().split(/\s+/)[0];
  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch: expected ${expectedHash}, got ${actualHash}`
    );
  }
}
__name(verifyChecksum, "verifyChecksum");
var MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
async function downloadToFile(versionPath, filename, destPath, baseUrl) {
  const response = await downloadWithFallback(
    versionPath,
    filename,
    ARCHIVE_TIMEOUT_MS,
    baseUrl
  );
  const body = response.body;
  if (!body) throw new Error("Empty response body");
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
    await body.cancel().catch(() => {
    });
    throw new Error(
      `Download too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_BYTES} limit`
    );
  }
  const hash = createHash("sha256");
  let bytesWritten = 0;
  const dest = fs.createWriteStream(destPath);
  const sizeGuard = new Transform({
    transform(chunk, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > MAX_DOWNLOAD_BYTES) {
        callback(
          new Error(`Download exceeded ${MAX_DOWNLOAD_BYTES} byte limit`)
        );
      } else {
        hash.update(chunk);
        callback(null, chunk);
      }
    }
  });
  await pipeline(Readable.fromWeb(body), sizeGuard, dest);
  return hash.digest("hex");
}
__name(downloadToFile, "downloadToFile");
function isPathInside(base, candidate) {
  const rel = path.relative(base, candidate);
  return rel === "" || !!rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
__name(isPathInside, "isPathInside");
function normalizeTarEntryPath(entryPath) {
  const parts = entryPath.split(/[\\/]+/).filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    return null;
  }
  return parts.join("/");
}
__name(normalizeTarEntryPath, "normalizeTarEntryPath");
function isSafeTarLinkTarget(entryPath, linkPath, resolvedDest) {
  if (path.posix.isAbsolute(linkPath) || path.win32.isAbsolute(linkPath)) {
    return false;
  }
  const normalizedEntryPath = normalizeTarEntryPath(entryPath);
  if (!normalizedEntryPath) {
    return false;
  }
  const archiveRoot = normalizedEntryPath.split("/")[0];
  const linkTarget = path.resolve(
    resolvedDest,
    path.posix.dirname(normalizedEntryPath),
    linkPath
  );
  return isPathInside(path.join(resolvedDest, archiveRoot), linkTarget);
}
__name(isSafeTarLinkTarget, "isSafeTarLinkTarget");
function getTarEntryType(entry) {
  if ("type" in entry) return entry.type;
  if ("isFile" in entry && entry.isFile()) return "File";
  if ("isDirectory" in entry && entry.isDirectory()) return "Directory";
  if ("isSymbolicLink" in entry && entry.isSymbolicLink()) {
    return "SymbolicLink";
  }
  return void 0;
}
__name(getTarEntryType, "getTarEntryType");
function isSafeTarEntry(entryPath, entry, resolvedDest) {
  if (!isSafeTarEntryPath(entryPath)) return false;
  const entryType = getTarEntryType(entry);
  const linkPath = "linkpath" in entry ? entry.linkpath : void 0;
  if (entryType !== "File" && entryType !== "Directory" && entryType !== "SymbolicLink") {
    return false;
  }
  if (entryType === "SymbolicLink") {
    if (linkPath === void 0) return false;
    return isSafeTarLinkTarget(entryPath, String(linkPath), resolvedDest);
  }
  return true;
}
__name(isSafeTarEntry, "isSafeTarEntry");
function isAlreadyExistsError(err) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";
}
__name(isAlreadyExistsError, "isAlreadyExistsError");
function validateExtractedPaths(resolvedDest, options = {}) {
  const entries = fs.readdirSync(resolvedDest, {
    recursive: true,
    withFileTypes: true
  });
  for (const entry of entries) {
    if (options.symlinksOnly && !entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(
      String(entry.parentPath || entry.path),
      entry.name
    );
    let resolved;
    try {
      resolved = fs.realpathSync(fullPath);
    } catch (err) {
      fs.rmSync(resolvedDest, { recursive: true, force: true });
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Invalid archive entry: ${entry.name} could not be resolved (${detail})`
      );
    }
    if (!isPathInside(resolvedDest, resolved)) {
      fs.rmSync(resolvedDest, { recursive: true, force: true });
      throw new Error(
        `Path traversal detected in archive: ${entry.name} resolves to ${resolved}`
      );
    }
  }
}
__name(validateExtractedPaths, "validateExtractedPaths");
function isSafeTarEntryPath(entryPath) {
  if (entryPath.length === 0) return false;
  if (path.posix.isAbsolute(entryPath) || path.win32.isAbsolute(entryPath)) {
    return false;
  }
  return normalizeTarEntryPath(entryPath) !== null;
}
__name(isSafeTarEntryPath, "isSafeTarEntryPath");
async function extractArchive(archivePath, destDir, target) {
  fs.mkdirSync(destDir, { recursive: true });
  if (target.startsWith("win")) {
    await new Promise((resolve2, reject) => {
      const ps = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -Path '${escapePS(archivePath)}' -DestinationPath '${escapePS(destDir)}' -Force`
        ],
        { stdio: "ignore" }
      );
      ps.on(
        "close",
        (code) => code === 0 ? resolve2() : reject(new Error(`Expand-Archive exited with code ${code}`))
      );
      ps.on("error", reject);
    });
    const resolvedDest = fs.realpathSync(destDir);
    validateExtractedPaths(resolvedDest);
  } else {
    const resolvedDest = fs.realpathSync(destDir);
    await So({
      file: archivePath,
      cwd: destDir,
      preservePaths: false,
      filter: /* @__PURE__ */ __name((p, entry) => isSafeTarEntry(p, entry, resolvedDest), "filter")
    });
    validateExtractedPaths(fs.realpathSync(destDir), { symlinksOnly: true });
  }
}
__name(extractArchive, "extractArchive");
function spawnAndCapture(command, args, timeoutMs) {
  return new Promise((resolve2, reject) => {
    let settled = false;
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs },
      (err, out, stderr) => {
        if (settled) return;
        settled = true;
        if (err && ("killed" in err && err.killed || "signal" in err && err.signal)) {
          reject(new Error("Smoke test timed out"));
          return;
        }
        if (err) {
          const exitCode = "code" in err && typeof err.code === "number" ? err.code : 1;
          resolve2({ exitCode, stdout: out || "", stderr: stderr || "" });
          return;
        }
        resolve2({ exitCode: 0, stdout: out || "", stderr: stderr || "" });
      }
    );
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}
__name(spawnAndCapture, "spawnAndCapture");
async function smokeTest(newInstallDir, target) {
  const resolvedInstallDir = path.resolve(newInstallDir);
  const nodeBin = target.startsWith("win") ? path.join(resolvedInstallDir, "node", "node.exe") : path.join(resolvedInstallDir, "node", "bin", "node");
  const cliBin = path.join(resolvedInstallDir, "lib", "cli.js");
  if (!fs.existsSync(nodeBin)) {
    throw new Error(`Smoke test failed: node binary not found at ${nodeBin}`);
  }
  if (!fs.existsSync(cliBin)) {
    throw new Error(`Smoke test failed: cli.js not found at ${cliBin}`);
  }
  const { exitCode, stdout, stderr } = await spawnAndCapture(
    nodeBin,
    [cliBin, "--version"],
    1e4
  );
  if (exitCode !== 0) {
    const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
    throw new Error(
      `Smoke test failed: new binary exited with code ${exitCode}${detail}`
    );
  }
  const version = stdout.trim();
  if (!SEMVER_RE.test(version)) {
    throw new Error(
      `Smoke test failed: unexpected version output "${version}"`
    );
  }
  debugLogger.info(`Smoke test passed: ${version}`);
}
__name(smokeTest, "smokeTest");
function checkDeferredSwap(standaloneDir) {
  const deferredMarker = `${standaloneDir}.deferred`;
  if (fs.existsSync(deferredMarker)) {
    try {
      const batPid = parseInt(
        fs.readFileSync(deferredMarker, "utf-8").trim(),
        10
      );
      if (!Number.isNaN(batPid) && isProcessAlive(batPid)) {
        throw new Error(
          "A previous update is still being applied. Please wait a moment and try again."
        );
      }
    } catch (readErr) {
      if (readErr instanceof Error && readErr.message.startsWith("A previous update")) {
        throw readErr;
      }
    }
    try {
      fs.unlinkSync(deferredMarker);
    } catch {
    }
  }
  if (fs.existsSync(`${standaloneDir}.new`)) {
    throw new Error(
      `A previous update left a pending swap at ${standaloneDir}.new. If no qwen-update.bat process is running, remove the pending swap and .qwen-update.lock, then try again.`
    );
  }
}
__name(checkDeferredSwap, "checkDeferredSwap");
function acquireLock(lockPath, standaloneDir) {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    if (standaloneDir) {
      checkDeferredSwap(standaloneDir);
    }
    return true;
  } catch (fastPathErr) {
    if (fastPathErr instanceof Error && (fastPathErr.message.startsWith("A previous update") || fastPathErr.message.includes("pending swap"))) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
      }
      throw fastPathErr;
    }
    let pidStr;
    try {
      pidStr = fs.readFileSync(lockPath, "utf-8").trim();
    } catch {
      return false;
    }
    const pid = parseInt(pidStr, 10);
    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      return false;
    }
    if (standaloneDir) {
      checkDeferredSwap(standaloneDir);
    }
    try {
      fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}
__name(acquireLock, "acquireLock");
function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
  }
}
__name(releaseLock, "releaseLock");
function cleanupEmptyStandaloneDir(standaloneDir) {
  const manifestPath = path.join(standaloneDir, "manifest.json");
  if (fs.existsSync(standaloneDir) && !fs.existsSync(manifestPath)) {
    fs.rmSync(standaloneDir, { recursive: true, force: true });
  }
}
__name(cleanupEmptyStandaloneDir, "cleanupEmptyStandaloneDir");
var UNSAFE_SHELL_CHARS = /[\0\n\r]/;
var UNSAFE_CMD_CHARS = /[&|<>^%!"`\n\r]/;
function assertSafeForSingleQuotedShellPath(p, context) {
  if (UNSAFE_SHELL_CHARS.test(p)) {
    throw new Error(
      `${context} contains characters unsafe for shell embedding: ${p}`
    );
  }
}
__name(assertSafeForSingleQuotedShellPath, "assertSafeForSingleQuotedShellPath");
function shellQuoteForSh(p) {
  return `'${p.replace(/'/g, "'\\''")}'`;
}
__name(shellQuoteForSh, "shellQuoteForSh");
function shellQuoteForFish(p) {
  return shellQuoteForSh(p);
}
__name(shellQuoteForFish, "shellQuoteForFish");
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
__name(isProcessAlive, "isProcessAlive");
function atomicReplace(standaloneDir, newDir, lockPath) {
  const oldDir = `${standaloneDir}.old`;
  const pendingDir = `${standaloneDir}.new`;
  if (fs.existsSync(oldDir)) {
    fs.rmSync(oldDir, { recursive: true, force: true });
  }
  if (os.platform() === "win32") {
    if (UNSAFE_CMD_CHARS.test(standaloneDir) || UNSAFE_CMD_CHARS.test(oldDir) || UNSAFE_CMD_CHARS.test(pendingDir)) {
      throw new Error(
        "Installation path contains characters unsafe for deferred update script"
      );
    }
    if (fs.existsSync(pendingDir)) {
      fs.rmSync(pendingDir, { recursive: true, force: true });
    }
    fs.renameSync(newDir, pendingDir);
    const lockFile = lockPath;
    const deferredMarker = `${standaloneDir}.deferred`;
    const logFile = path.join(path.dirname(standaloneDir), "qwen-update.log");
    const script = [
      "@echo off",
      "set /a TRIES=0",
      ":wait",
      "set /a TRIES+=1",
      "if %TRIES% GTR 30 goto proceed",
      `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul && (timeout /t 1 >nul & goto wait)`,
      ...process.env["QWEN_CODE_LAUNCHER_PID"]?.match(/^\d+$/) ? [
        "set /a LAUNCHER_TRIES=0",
        ":wait_launcher",
        "set /a LAUNCHER_TRIES+=1",
        "if %LAUNCHER_TRIES% GTR 30 goto proceed",
        `tasklist /FI "PID eq ${process.env["QWEN_CODE_LAUNCHER_PID"]}" 2>nul | find "${process.env["QWEN_CODE_LAUNCHER_PID"]}" >nul && (timeout /t 1 >nul & goto wait_launcher)`
      ] : [],
      ":proceed",
      `echo [%DATE% %TIME%] starting swap >> "${logFile}"`,
      `move /Y "${standaloneDir}" "${oldDir}"`,
      "if errorlevel 1 goto move1_failed",
      `move /Y "${pendingDir}" "${standaloneDir}"`,
      "if errorlevel 1 goto move2_failed",
      `echo [%DATE% %TIME%] swap completed >> "${logFile}"`,
      "goto cleanup",
      ":move1_failed",
      `echo [%DATE% %TIME%] ERROR: failed to rename install to .old (errorlevel %errorlevel%) >> "${logFile}"`,
      "goto cleanup",
      ":move2_failed",
      `echo [%DATE% %TIME%] ERROR: failed to promote .new; rolling back >> "${logFile}"`,
      `move /Y "${oldDir}" "${standaloneDir}"`,
      "if errorlevel 1 (",
      `  echo [%DATE% %TIME%] CRITICAL: rollback also failed; manual recovery: move "${oldDir}" "${standaloneDir}" >> "${logFile}"`,
      ") else (",
      `  echo [%DATE% %TIME%] rollback succeeded >> "${logFile}"`,
      ")",
      ":cleanup",
      `del /F /Q "${deferredMarker}" 2>nul`,
      `del /F /Q "${lockFile}" 2>nul`,
      `del "%~f0"`
    ].join("\r\n");
    const scriptPath = path.join(
      path.dirname(standaloneDir),
      "qwen-update.bat"
    );
    fs.writeFileSync(scriptPath, script);
    const child = spawn("cmd.exe", ["/c", scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", (err) => {
      debugLogger.warn("Deferred bat script failed to spawn:", err);
    });
    child.unref();
    if (!child.pid) {
      throw new Error(
        "Failed to spawn deferred update script. Update was not applied."
      );
    }
    fs.writeFileSync(deferredMarker, String(child.pid));
    return "deferred";
  } else {
    fs.renameSync(standaloneDir, oldDir);
    try {
      fs.renameSync(newDir, standaloneDir);
    } catch (promoteErr) {
      try {
        fs.renameSync(oldDir, standaloneDir);
      } catch (rollbackErr) {
        const detail = `Standalone update failed AND rollback failed.
Original error: ${promoteErr.message}
Rollback error: ${rollbackErr.message}
Manual recovery: mv "${oldDir}" "${standaloneDir}"`;
        throw new Error(detail);
      }
      throw promoteErr;
    }
    return "done";
  }
}
__name(atomicReplace, "atomicReplace");
function ensureBinWrapper(standaloneDir, target) {
  const binDir = path.join(path.dirname(standaloneDir), "..", "bin");
  const artifacts = { wrapperCreated: false };
  try {
    fs.mkdirSync(binDir, { recursive: true });
    if (target.startsWith("win")) {
      if (UNSAFE_CMD_CHARS.test(standaloneDir)) {
        throw new Error(
          "standaloneDir contains characters unsafe for cmd.exe wrapper"
        );
      }
      const wrapperPath = path.join(binDir, "qwen.cmd");
      artifacts.wrapperPath = wrapperPath;
      const content = `@echo off\r
call "${standaloneDir}\\bin\\qwen.cmd" %*\r
`;
      try {
        fs.writeFileSync(wrapperPath, content, { flag: "wx" });
        artifacts.wrapperCreated = true;
      } catch (err) {
        if (!isAlreadyExistsError(err)) {
          throw err;
        }
        artifacts.wrapperNeedsAttention = !existingWrapperMatches(
          wrapperPath,
          standaloneDir
        );
      }
    } else {
      assertSafeForSingleQuotedShellPath(standaloneDir, "standaloneDir");
      const wrapperPath = path.join(binDir, "qwen");
      artifacts.wrapperPath = wrapperPath;
      const quotedQwenBin = shellQuoteForSh(
        path.join(standaloneDir, "bin", "qwen")
      );
      const content = `#!/usr/bin/env sh
exec ${quotedQwenBin} "$@"
`;
      try {
        fs.writeFileSync(wrapperPath, content, { mode: 493, flag: "wx" });
        artifacts.wrapperCreated = true;
      } catch (err) {
        if (!isAlreadyExistsError(err)) {
          throw err;
        }
        artifacts.wrapperNeedsAttention = !existingWrapperMatches(
          wrapperPath,
          standaloneDir
        );
      }
      artifacts.shellPathUpdate = ensurePathInShellRc(binDir);
    }
    return artifacts;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create bin wrapper: ${detail}`);
  }
}
__name(ensureBinWrapper, "ensureBinWrapper");
function existingWrapperMatches(wrapperPath, standaloneDir) {
  try {
    return fs.readFileSync(wrapperPath, "utf-8").includes(standaloneDir);
  } catch {
    return false;
  }
}
__name(existingWrapperMatches, "existingWrapperMatches");
function ensurePathInShellRc(binDir) {
  assertSafeForSingleQuotedShellPath(binDir, "binDir");
  const shell = process.env["SHELL"] || "";
  let rcFile = null;
  const home = process.env["HOME"] || os.homedir();
  if (shell.endsWith("/zsh")) {
    rcFile = path.join(home, ".zshrc");
  } else if (shell.endsWith("/bash")) {
    const bashrc = path.join(home, ".bashrc");
    const profile = path.join(home, ".bash_profile");
    if (fs.existsSync(bashrc)) {
      rcFile = bashrc;
    } else if (fs.existsSync(profile)) {
      rcFile = profile;
    } else {
      rcFile = bashrc;
    }
  } else if (shell.endsWith("/fish")) {
    rcFile = path.join(home, ".config", "fish", "config.fish");
  }
  if (!rcFile) return { blockAdded: false };
  try {
    const content = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, "utf-8") : "";
    const beginMarker = "# Qwen Code PATH block begin";
    const endMarker = "# Qwen Code PATH block end";
    const legacyMarker = "# Added by Qwen Code standalone installer";
    if (content.includes(beginMarker) && content.includes(endMarker)) {
      return { rcFile, blockAdded: false };
    }
    if (content.includes(legacyMarker)) return { rcFile, blockAdded: false };
    const exportLine = shell.endsWith("/fish") ? `set -gx PATH ${shellQuoteForFish(binDir)} $PATH` : `export PATH=${shellQuoteForSh(binDir)}:$PATH`;
    const block = `
${beginMarker}
${exportLine}
${endMarker}
`;
    fs.mkdirSync(path.dirname(rcFile), { recursive: true });
    fs.appendFileSync(rcFile, block);
    debugLogger.info(`Added ${binDir} to ${rcFile}`);
    return { rcFile, blockAdded: true };
  } catch (err) {
    debugLogger.debug("Failed to update shell rc:", err);
    return {
      rcFile,
      blockAdded: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
__name(ensurePathInShellRc, "ensurePathInShellRc");
function surfaceBinWrapperWarnings(artifacts) {
  if (!artifacts) return;
  if (artifacts.wrapperNeedsAttention && artifacts.wrapperPath) {
    const message = `Update completed, but the existing wrapper at ${artifacts.wrapperPath} does not point to this standalone installation.`;
    debugLogger.warn(message);
    updateEventEmitter.emit("update-info", { message });
  }
  if (artifacts.shellPathUpdate?.error && artifacts.shellPathUpdate.rcFile) {
    const message = `Update completed, but ${artifacts.shellPathUpdate.rcFile} could not be updated. Add ~/.local/bin to PATH manually.`;
    debugLogger.warn(message);
    updateEventEmitter.emit("update-info", { message });
  }
}
__name(surfaceBinWrapperWarnings, "surfaceBinWrapperWarnings");
function cleanupShellPathBlock(rcFile) {
  try {
    if (!fs.existsSync(rcFile)) return;
    const content = fs.readFileSync(rcFile, "utf-8");
    const blockPattern = /\n?# Qwen Code PATH block begin\n(?:.|\n)*?\n# Qwen Code PATH block end\n?/;
    const nextContent = content.replace(blockPattern, "");
    if (nextContent !== content) {
      fs.writeFileSync(rcFile, nextContent);
    }
  } catch (err) {
    debugLogger.debug("Failed to roll back shell rc PATH block:", err);
  }
}
__name(cleanupShellPathBlock, "cleanupShellPathBlock");
function cleanupFirstTimeMigrationArtifacts(artifacts) {
  if (!artifacts) return;
  if (artifacts.wrapperCreated && artifacts.wrapperPath) {
    try {
      fs.unlinkSync(artifacts.wrapperPath);
    } catch (err) {
      debugLogger.debug("Failed to roll back bin wrapper:", err);
    }
  }
  if (artifacts.shellPathUpdate?.blockAdded && artifacts.shellPathUpdate.rcFile) {
    cleanupShellPathBlock(artifacts.shellPathUpdate.rcFile);
  }
}
__name(cleanupFirstTimeMigrationArtifacts, "cleanupFirstTimeMigrationArtifacts");
function detectTarget() {
  const platform2 = os.platform();
  const arch2 = os.arch();
  if (platform2 === "darwin") {
    return arch2 === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (platform2 === "win32") return "win-x64";
  if (platform2 === "linux") {
    if (arch2 === "arm64") return "linux-arm64";
    if (arch2 === "x64") return "linux-x64";
  }
  throw new Error(`Unsupported platform: ${platform2}-${arch2}`);
}
__name(detectTarget, "detectTarget");
async function performStandaloneUpdate(standaloneDir, newVersion) {
  const versionPath = normalizeVersion(newVersion);
  const baseUrl = resolveUpdateBaseUrl();
  let target;
  let isFirstTimeMigration = false;
  const manifestPath = path.join(standaloneDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifestRaw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw);
    target = manifest.target ?? detectTarget();
  } else if (fs.existsSync(standaloneDir)) {
    throw new Error(
      `${standaloneDir} exists but is not a Qwen Code standalone install. Remove it manually to proceed.`
    );
  } else {
    target = detectTarget();
    isFirstTimeMigration = true;
  }
  validateTarget(target);
  const filename = archiveFilename(target);
  const parentDir = path.dirname(standaloneDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const lockPath = path.join(parentDir, ".qwen-update.lock");
  if (!acquireLock(lockPath, standaloneDir)) {
    throw new Error("Another update is already in progress");
  }
  if (isFirstTimeMigration) {
    try {
      fs.mkdirSync(standaloneDir, { recursive: true });
    } catch (err) {
      releaseLock(lockPath);
      throw err;
    }
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-code-update-"));
  let extractDir;
  let updateResult;
  let migrationArtifacts;
  try {
    extractDir = fs.mkdtempSync(path.join(parentDir, ".qwen-code-update-"));
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    releaseLock(lockPath);
    throw err;
  }
  try {
    const archivePath = path.join(tempDir, filename);
    debugLogger.info(`Downloading ${filename} (${versionPath})...`);
    updateEventEmitter.emit("update-info", {
      message: t("Downloading update...")
    });
    const archiveHash = await downloadToFile(
      versionPath,
      filename,
      archivePath,
      baseUrl
    );
    debugLogger.info("Verifying checksum...");
    await verifyChecksum(archiveHash, filename, versionPath, baseUrl);
    debugLogger.info("Extracting archive...");
    await extractArchive(archivePath, extractDir, target);
    const newInstallDir = path.join(extractDir, "qwen-code");
    if (!fs.existsSync(path.join(newInstallDir, "manifest.json"))) {
      throw new Error(
        "Extracted archive does not contain expected qwen-code directory"
      );
    }
    debugLogger.info("Running smoke test...");
    await smokeTest(newInstallDir, target);
    debugLogger.info("Replacing installation...");
    updateResult = atomicReplace(standaloneDir, newInstallDir, lockPath);
    const oldDir = `${standaloneDir}.old`;
    if (fs.existsSync(oldDir)) {
      if (isFirstTimeMigration) {
        fs.rmSync(oldDir, { recursive: true, force: true });
      } else {
        try {
          const oldManifestPath = path.join(oldDir, "manifest.json");
          let oldVersion = "unknown";
          if (fs.existsSync(oldManifestPath)) {
            const oldManifest = JSON.parse(
              fs.readFileSync(oldManifestPath, "utf-8")
            );
            oldVersion = oldManifest.version || "unknown";
          }
          const rollbackInfo = {
            preservedVersion: oldVersion,
            updatedTo: versionPath,
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            reason: "auto-update"
          };
          fs.writeFileSync(
            path.join(oldDir, ".qwen-rollback-info.json"),
            JSON.stringify(rollbackInfo, null, 2)
          );
        } catch {
        }
      }
    }
    try {
      migrationArtifacts = ensureBinWrapper(standaloneDir, target);
      surfaceBinWrapperWarnings(migrationArtifacts);
    } catch (wrapperErr) {
      debugLogger.warn("Failed to refresh bin wrapper:", wrapperErr);
      updateEventEmitter.emit("update-info", {
        message: isFirstTimeMigration ? "Update installed, but the PATH wrapper could not be created. Add the standalone bin directory to your PATH manually, or re-run the update." : "Update completed, but the PATH wrapper could not be refreshed. The existing installation remains usable."
      });
    }
    debugLogger.info("Standalone update complete.");
    return updateResult;
  } catch (err) {
    const pendingDir = `${standaloneDir}.new`;
    if (updateResult !== "deferred" && fs.existsSync(pendingDir)) {
      fs.rmSync(pendingDir, { recursive: true, force: true });
    }
    cleanupEmptyStandaloneDir(standaloneDir);
    if (isFirstTimeMigration) {
      cleanupFirstTimeMigrationArtifacts(migrationArtifacts);
    }
    throw err;
  } finally {
    if (updateResult !== "deferred") {
      releaseLock(lockPath);
      const deferredMarker = `${standaloneDir}.deferred`;
      if (fs.existsSync(deferredMarker)) {
        try {
          fs.unlinkSync(deferredMarker);
        } catch {
        }
      }
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
    }
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {
    }
  }
}
__name(performStandaloneUpdate, "performStandaloneUpdate");
function rollbackStandaloneUpdate(standaloneDir) {
  const lockPath = path.join(path.dirname(standaloneDir), ".qwen-update.lock");
  try {
    const pidStr = fs.readFileSync(lockPath, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      return {
        ok: false,
        reason: "rename-failed",
        detail: "An auto-update is currently in progress. Wait for it to finish before rolling back."
      };
    }
  } catch {
  }
  const oldDir = `${standaloneDir}.old`;
  if (!fs.existsSync(oldDir)) {
    return { ok: false, reason: "no-old", detail: `${oldDir} does not exist` };
  }
  const oldManifest = path.join(oldDir, "manifest.json");
  if (!fs.existsSync(oldManifest)) {
    debugLogger.error("Rollback failed: .old directory has no manifest.json");
    return {
      ok: false,
      reason: "no-manifest",
      detail: `${oldDir}/manifest.json missing \u2014 .old may be corrupt`
    };
  }
  const failedDir = `${standaloneDir}.failed`;
  try {
    if (fs.existsSync(failedDir)) {
      fs.rmSync(failedDir, { recursive: true, force: true });
    }
    fs.renameSync(standaloneDir, failedDir);
    fs.renameSync(oldDir, standaloneDir);
    debugLogger.info("Rollback successful.");
    try {
      fs.rmSync(failedDir, { recursive: true, force: true });
    } catch {
      debugLogger.debug(`Leftover .failed dir at ${failedDir}, safe to delete`);
    }
    return { ok: true };
  } catch (err) {
    debugLogger.error("Rollback failed:", err);
    if (!fs.existsSync(standaloneDir) && fs.existsSync(failedDir)) {
      try {
        fs.renameSync(failedDir, standaloneDir);
        return {
          ok: false,
          reason: "rename-failed",
          detail: `Filesystem error: ${err.message}. Current installation was restored automatically.`
        };
      } catch {
      }
    }
    return {
      ok: false,
      reason: "rename-failed",
      detail: `Filesystem error: ${err.message}. Manual recovery: mv "${oldDir}" "${standaloneDir}"`
    };
  }
}
__name(rollbackStandaloneUpdate, "rollbackStandaloneUpdate");

export {
  isSafeTarLinkTarget,
  isSafeTarEntry,
  isSafeTarEntryPath,
  acquireLock,
  ensureBinWrapper,
  ensurePathInShellRc,
  cleanupFirstTimeMigrationArtifacts,
  performStandaloneUpdate,
  rollbackStandaloneUpdate
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
