// Force strict mode and setup for ESM
"use strict";
import {
  getGitVersion,
  getNpmVersion
} from "./chunk-4JVOFH22.js";
import {
  buildEnvStatusFromEnv,
  snapshotProcessEnv
} from "./chunk-E3OBB2PK.js";
import {
  mapDomainErrorToErrorKind
} from "./chunk-SIUR4U2P.js";
import {
  canUseRipgrep
} from "./chunk-IWMYX5LB.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/daemon-status-provider.ts
init_esbuild_shims();
import { promises as fs } from "node:fs";
var REQUIRED_NODE_MAJOR = 22;
function createDaemonStatusProvider(options = {}) {
  const readEnv = /* @__PURE__ */ __name(() => options.env ?? snapshotProcessEnv(), "readEnv");
  return {
    async getEnvStatus(boundWorkspace, acpChannelLive) {
      return buildEnvStatusFromEnv(boundWorkspace, acpChannelLive, readEnv());
    },
    async getDaemonPreflightCells(boundWorkspace) {
      return buildDaemonPreflightCells(boundWorkspace, readEnv());
    }
  };
}
__name(createDaemonStatusProvider, "createDaemonStatusProvider");
async function buildDaemonPreflightCells(boundWorkspace, env) {
  const nodeVersionCell = /* @__PURE__ */ __name(() => {
    try {
      const nodeVersion = process.versions.node;
      const major = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
      if (Number.isFinite(major) && major >= REQUIRED_NODE_MAJOR) {
        return {
          kind: "node_version",
          status: "ok",
          locality: "daemon",
          detail: {
            version: nodeVersion,
            required: `>=${REQUIRED_NODE_MAJOR}`
          }
        };
      }
      return {
        kind: "node_version",
        status: "error",
        errorKind: "missing_binary",
        error: `Node ${nodeVersion} is below the required >=${REQUIRED_NODE_MAJOR}.`,
        hint: `Upgrade Node to v${REQUIRED_NODE_MAJOR} or newer.`,
        locality: "daemon",
        detail: { version: nodeVersion, required: `>=${REQUIRED_NODE_MAJOR}` }
      };
    } catch (err) {
      return {
        kind: "node_version",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        locality: "daemon"
      };
    }
  }, "nodeVersionCell");
  const cliEntryCell = /* @__PURE__ */ __name(() => {
    const cliEntry = env["QWEN_CLI_ENTRY"] || process.argv[1] || "";
    if (cliEntry) {
      return {
        kind: "cli_entry",
        status: "ok",
        locality: "daemon",
        detail: {
          path: cliEntry,
          source: env["QWEN_CLI_ENTRY"] ? "QWEN_CLI_ENTRY" : "process.argv[1]"
        }
      };
    }
    return {
      kind: "cli_entry",
      status: "error",
      errorKind: "missing_binary",
      error: "Cannot determine CLI entry path for spawning the ACP child.",
      hint: "Set QWEN_CLI_ENTRY to the absolute path of the qwen entry script.",
      locality: "daemon"
    };
  }, "cliEntryCell");
  const workspaceDirCell = /* @__PURE__ */ __name(async () => {
    try {
      const stat = await fs.stat(boundWorkspace);
      if (stat.isDirectory()) {
        return {
          kind: "workspace_dir",
          status: "ok",
          locality: "daemon",
          detail: { path: boundWorkspace }
        };
      }
      return {
        kind: "workspace_dir",
        status: "error",
        errorKind: "missing_file",
        error: `Bound workspace path is not a directory: ${boundWorkspace}`,
        locality: "daemon",
        detail: { path: boundWorkspace }
      };
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err);
      return {
        kind: "workspace_dir",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        ...errorKind ? { errorKind } : {},
        locality: "daemon",
        detail: { path: boundWorkspace }
      };
    }
  }, "workspaceDirCell");
  const slots = [
    { kind: "node_version", run: nodeVersionCell },
    { kind: "cli_entry", run: cliEntryCell },
    { kind: "workspace_dir", run: workspaceDirCell },
    {
      kind: "ripgrep",
      run: /* @__PURE__ */ __name(() => safeCheck("ripgrep", async () => {
        const ok = await canUseRipgrep(true);
        return ok ? { status: "ok" } : {
          status: "warning",
          hint: "Install ripgrep for faster grep tool execution."
        };
      }), "run")
    },
    {
      kind: "git",
      run: /* @__PURE__ */ __name(() => safeCheck("git", async () => {
        const v = await getGitVersion();
        return v && v !== "unknown" ? { status: "ok", detail: { version: v } } : { status: "warning", hint: "git not found on PATH." };
      }), "run")
    },
    {
      kind: "npm",
      run: /* @__PURE__ */ __name(() => safeCheck("npm", async () => {
        const v = await getNpmVersion();
        return v && v !== "unknown" ? { status: "ok", detail: { version: v } } : { status: "warning", hint: "npm not found on PATH." };
      }), "run")
    }
  ];
  const settled = await Promise.allSettled(
    slots.map((s) => Promise.resolve().then(s.run))
  );
  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const err = result.reason;
    const errorKind = mapDomainErrorToErrorKind(err);
    return {
      kind: slots[i].kind,
      status: "error",
      locality: "daemon",
      error: err instanceof Error ? err.message : String(err),
      ...errorKind ? { errorKind } : {}
    };
  });
}
__name(buildDaemonPreflightCells, "buildDaemonPreflightCells");
async function safeCheck(kind, body) {
  try {
    const r = await body();
    return {
      kind,
      status: r.status,
      locality: "daemon",
      ...r.detail ? { detail: r.detail } : {},
      ...r.hint ? { hint: r.hint } : {}
    };
  } catch (err) {
    const errorKind = mapDomainErrorToErrorKind(err);
    return {
      kind,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      locality: "daemon",
      ...errorKind ? { errorKind } : {}
    };
  }
}
__name(safeCheck, "safeCheck");

export {
  createDaemonStatusProvider
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
