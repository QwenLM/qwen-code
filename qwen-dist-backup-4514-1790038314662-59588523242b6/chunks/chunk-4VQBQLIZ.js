// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/commands/review/lib/remote-match.ts
init_esbuild_shims();
function normalizeSegment(value) {
  const v = value.toLowerCase();
  return v.endsWith(".git") ? v.slice(0, -4) : v;
}
__name(normalizeSegment, "normalizeSegment");
var AONE_HOSTS = /* @__PURE__ */ new Set(["code.alibaba-inc.com", "gitlab.alibaba-inc.com"]);
function normalizeHostSpelling(host) {
  return host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}
__name(normalizeHostSpelling, "normalizeHostSpelling");
function hostsEquivalent(a, b) {
  const na = normalizeHostSpelling(a);
  const nb = normalizeHostSpelling(b);
  if (na === nb) return true;
  return AONE_HOSTS.has(na) && AONE_HOSTS.has(nb);
}
__name(hostsEquivalent, "hostsEquivalent");
function isAoneCanonicalHost(host) {
  if (!host) return false;
  return AONE_HOSTS.has(normalizeHostSpelling(host));
}
__name(isAoneCanonicalHost, "isAoneCanonicalHost");
function isAoneHostFamily(host) {
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return h === "gitlab.alibaba-inc.com" || h === "code.alibaba-inc.com" || h.endsWith(".alibaba-inc.com");
}
__name(isAoneHostFamily, "isAoneHostFamily");
function parseRemoteUrl(raw) {
  const url = raw.trim();
  if (url === "") return null;
  let host;
  let pathPart;
  const schemeIdx = url.indexOf("://");
  if (schemeIdx !== -1) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.hostname === "") return null;
    host = parsed.hostname;
    pathPart = parsed.pathname;
  } else {
    const colonIdx = url.indexOf(":");
    const slashIdx = url.indexOf("/");
    if (colonIdx === -1 || slashIdx === -1 || colonIdx > slashIdx) {
      return null;
    }
    host = url.slice(0, colonIdx);
    const atIdx = host.lastIndexOf("@");
    if (atIdx !== -1) host = host.slice(atIdx + 1);
    pathPart = url.slice(colonIdx + 1);
  }
  const segments = pathPart.split("/").map((s) => s.trim()).filter((s) => s !== "");
  if (segments.length < 2) return null;
  if (host === "") return null;
  return {
    host: host.toLowerCase(),
    owner: normalizeSegment(segments[segments.length - 2]),
    repo: normalizeSegment(segments[segments.length - 1]),
    groupPath: segments.map(normalizeSegment).join("/")
  };
}
__name(parseRemoteUrl, "parseRemoteUrl");
function matchRemotes(remoteVOutput, { owner, repo, host = "github.com", groupPath }) {
  const wantOwner = normalizeSegment(owner);
  const wantRepo = normalizeSegment(repo);
  const wantPath = groupPath ? groupPath.split("/").filter(Boolean).map(normalizeSegment) : void 0;
  const wantHost = normalizeSegment(host.replace(/:\d+$/, ""));
  const matched = [];
  for (const line of remoteVOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !/\(fetch\)(\s+\[[^\]]*\])?$/.test(trimmed)) {
      continue;
    }
    const nameMatch = trimmed.match(
      /^(\S+)\s+(.*)\s+\(fetch\)(\s+\[[^\]]*\])?$/
    );
    if (!nameMatch) continue;
    const identity = parseRemoteUrl(nameMatch[2]);
    if (identity === null) continue;
    if (!hostsEquivalent(identity.host, wantHost)) continue;
    const remotePath = identity.groupPath.split("/");
    const sameRepo = wantPath !== void 0 ? wantPath.length === remotePath.length && wantPath.every((seg, i) => seg === remotePath[i]) : identity.owner === wantOwner && identity.repo === wantRepo;
    if (sameRepo) {
      matched.push(nameMatch[1]);
    }
  }
  return { matched };
}
__name(matchRemotes, "matchRemotes");

// packages/cli/src/commands/review/lib/platform/aone-client.ts
init_esbuild_shims();
import { execFileSync } from "node:child_process";
var A1_BINARY = "a1";
var MAX_RETRIES = 2;
var BASE_DELAY_MS = 3e3;
var A1_TIMEOUT_MS = 12e4;
var TRANSIENT_RE = /(HTTP\s?5\d\d|temporarily unavailable|connection (reset|timed? ?out)|ECONNRESET|network is unreachable)/i;
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}
__name(sleepSync, "sleepSync");
function execA1(args, retry) {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(A1_BINARY, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
        timeout: A1_TIMEOUT_MS
      }).toString().replace(/\r\n/g, "\n").trim();
    } catch (err) {
      const e = err;
      const rebuilt = new Error(
        [
          e.message ?? "",
          e.stdout?.toString() ?? "",
          e.stderr?.toString() ?? ""
        ].join("\n")
      );
      if (retry && attempt < MAX_RETRIES && TRANSIENT_RE.test(rebuilt.message)) {
        const delay = BASE_DELAY_MS * (attempt + 1);
        process.stderr.write(
          `a1 transient error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms\u2026
`
        );
        sleepSync(delay);
        continue;
      }
      throw err;
    }
  }
}
__name(execA1, "execA1");
function a1(...args) {
  return execA1(args, true);
}
__name(a1, "a1");
function a1Once(...args) {
  return execA1(args, false);
}
__name(a1Once, "a1Once");
function a1Json(...args) {
  return JSON.parse(a1(...args, "--format", "json"));
}
__name(a1Json, "a1Json");
function a1JsonOnce(...args) {
  const raw = a1Once(...args, "--format", "json");
  try {
    return JSON.parse(raw);
  } catch {
    return void 0;
  }
}
__name(a1JsonOnce, "a1JsonOnce");
var A1_MIN_VERSION = "0.1.90";
function parseA1Version(out) {
  const m = /version[^\d]*(\d+)\.(\d+)\.(\d+)/i.exec(out) ?? /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : void 0;
}
__name(parseA1Version, "parseA1Version");
function a1VersionAtLeast(version, floor) {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== floor[i]) return version[i] > floor[i];
  }
  return true;
}
__name(a1VersionAtLeast, "a1VersionAtLeast");
function execErrorCause(err) {
  const message = err instanceof Error ? err.message : String(err);
  const lines = message.split("\n").map((l) => l.trim());
  const candidates = /^(Command failed:|spawnSync |spawn )/.test(message) ? lines.slice(1) : lines;
  return candidates.find(Boolean) ?? "";
}
__name(execErrorCause, "execErrorCause");
function aoneWhoamiAccount() {
  let out;
  try {
    out = a1Json("auth", "whoami");
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error("a1 auth whoami returned an unexpected shape");
    }
    throw err;
  }
  if (out === null || typeof out.account !== "string" || out.account.trim() === "") {
    throw new Error("a1 auth whoami returned no account");
  }
  return out.account;
}
__name(aoneWhoamiAccount, "aoneWhoamiAccount");
function ensureAoneAuthenticated() {
  let versionOut;
  try {
    versionOut = a1("--version");
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT" || code === "EACCES" || code === "ENOEXEC") {
      throw new Error(
        "a1 CLI not found on PATH or not executable \u2014 install the `a1` CLI first."
      );
    }
    if (err.signal) {
      process.stderr.write(
        `WARNING: the a1 version probe timed out or was killed (check the network / a1 install) \u2014 the review provider requires a1 >= ${A1_MIN_VERSION}; continuing without a floor ruling.
`
      );
    } else {
      const why = execErrorCause(err);
      process.stderr.write(
        `WARNING: the a1 version probe failed` + (why ? ` (${JSON.stringify(why.slice(0, 80))})` : "") + ` \u2014 the review provider requires a1 >= ${A1_MIN_VERSION}; continuing without a floor ruling.
`
      );
    }
  }
  if (versionOut !== void 0) {
    const floor = parseA1Version(A1_MIN_VERSION);
    const version = parseA1Version(versionOut);
    if (version === void 0) {
      process.stderr.write(
        `WARNING: could not read the a1 version from ${JSON.stringify(versionOut.slice(0, 80))} \u2014 the review provider requires a1 >= ${A1_MIN_VERSION}; continuing.
`
      );
    } else if (!a1VersionAtLeast(version, floor)) {
      throw new Error(
        `a1 ${version.join(".")} is older than the ${A1_MIN_VERSION} this review provider requires \u2014 it depends on the comment-create flags and stable \`--format json\` output introduced there. Upgrade the a1 CLI (https://code.alibaba-inc.com/aone/a1) and retry.`
      );
    }
  }
  let raw;
  try {
    raw = a1("auth", "whoami", "--format", "json");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("a1 CLI not found on PATH \u2014 install the `a1` CLI first.");
    }
    const e = err;
    if (e.signal) {
      throw new Error(
        "a1 auth check timed out or was killed \u2014 check the network / a1 install."
      );
    }
    const cause = execErrorCause(err);
    throw new Error(
      `a1 auth check failed` + (cause ? ` \u2014 ${cause}` : "") + ` (if you have not logged in, run \`a1 auth login\`)`
    );
  }
  try {
    const out = JSON.parse(raw);
    return typeof out.account === "string" ? out.account.trim() : "";
  } catch {
    return "";
  }
}
__name(ensureAoneAuthenticated, "ensureAoneAuthenticated");

export {
  hostsEquivalent,
  isAoneCanonicalHost,
  isAoneHostFamily,
  parseRemoteUrl,
  matchRemotes,
  a1Once,
  a1Json,
  a1JsonOnce,
  A1_MIN_VERSION,
  parseA1Version,
  a1VersionAtLeast,
  execErrorCause,
  aoneWhoamiAccount,
  ensureAoneAuthenticated
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
