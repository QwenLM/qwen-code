// Force strict mode and setup for ESM
"use strict";
import {
  STATUS_SCHEMA_VERSION
} from "./chunk-SIUR4U2P.js";
import {
  formatMemoryUsage
} from "./chunk-CHEIIBT3.js";
import {
  detectRuntime,
  redactProxyCredentials
} from "./chunk-SBP43AO6.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/env-snapshot.ts
init_esbuild_shims();
import os from "node:os";
var SECRET_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DASHSCOPE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_SERVER_TOKEN"
];
var NONSECRET_ENV_VARS = [
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_BASE",
  "NODE_EXTRA_CA_CERTS",
  "TZ",
  "LANG",
  "LC_ALL",
  "TERM",
  "QWEN_CLI_ENTRY"
];
var PROXY_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY"
];
function snapshotProcessEnv() {
  return { ...process.env };
}
__name(snapshotProcessEnv, "snapshotProcessEnv");
function readProxyVar(env, name) {
  return env[name] ?? env[name.toLowerCase()];
}
__name(readProxyVar, "readProxyVar");
function safeProxyValue(name, raw) {
  if (name === "NO_PROXY") return redactProxyCredentials(raw);
  try {
    const host = new URL(raw).host;
    if (host) return host;
  } catch {
  }
  try {
    const host = new URL(`http://${raw}`).host;
    if (host) return host;
  } catch {
  }
  const stripped = raw.replace(/^[^@/?#]*@/, "").split(/[/?#]/)[0] ?? "";
  return stripped || "<unparseable>";
}
__name(safeProxyValue, "safeProxyValue");
function buildEnvStatusFromEnv(workspaceCwd, acpChannelLive, sourceEnv) {
  const env = { ...sourceEnv };
  const cells = [];
  const runtime = detectRuntime();
  const runtimeVersion = runtime === "bun" ? process.versions["bun"] ?? process.versions.node : process.versions.node;
  cells.push({
    kind: "runtime",
    name: runtime,
    status: "ok",
    value: runtimeVersion
  });
  cells.push({
    kind: "platform",
    name: process.platform,
    status: "ok",
    value: `${process.arch} (${os.release()})`
  });
  cells.push({
    kind: "memory",
    name: "rss",
    status: "ok",
    value: formatMemoryUsage(process.memoryUsage().rss)
  });
  const sandboxName = env["SANDBOX"];
  cells.push({
    kind: "sandbox",
    name: "SANDBOX",
    status: sandboxName ? "ok" : "disabled",
    present: Boolean(sandboxName),
    ...sandboxName ? { value: sandboxName } : {}
  });
  const seatbelt = env["SEATBELT_PROFILE"];
  if (seatbelt) {
    cells.push({
      kind: "sandbox",
      name: "SEATBELT_PROFILE",
      status: "ok",
      present: true,
      value: seatbelt
    });
  }
  for (const name of PROXY_VARS) {
    const raw = readProxyVar(env, name);
    if (raw) {
      cells.push({
        kind: "proxy",
        name,
        status: "ok",
        present: true,
        value: safeProxyValue(name, raw)
      });
    } else {
      cells.push({
        kind: "proxy",
        name,
        status: "disabled",
        present: false
      });
    }
  }
  for (const name of [...SECRET_ENV_VARS, ...NONSECRET_ENV_VARS]) {
    const present = Boolean(env[name]);
    cells.push({
      kind: "env_var",
      name,
      status: present ? "ok" : "disabled",
      present
    });
  }
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: true,
    acpChannelLive,
    cells
  };
}
__name(buildEnvStatusFromEnv, "buildEnvStatusFromEnv");

export {
  snapshotProcessEnv,
  buildEnvStatusFromEnv
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
