// Force strict mode and setup for ESM
"use strict";
import {
  getRateLimitErrorDetails
} from "./chunk-YSD6IY6F.js";
import {
  isInternalPromptId
} from "./chunk-KKGSJZWK.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/openaiLogger.ts
init_esbuild_shims();
import * as path from "node:path";
import { promises as fs } from "node:fs";

// node_modules/uuid/dist/esm-node/index.js
init_esbuild_shims();

// node_modules/uuid/dist/esm-node/rng.js
init_esbuild_shims();
import crypto from "crypto";
var rnds8Pool = new Uint8Array(256);
var poolPtr = rnds8Pool.length;
function rng() {
  if (poolPtr > rnds8Pool.length - 16) {
    crypto.randomFillSync(rnds8Pool);
    poolPtr = 0;
  }
  return rnds8Pool.slice(poolPtr, poolPtr += 16);
}
__name(rng, "rng");

// node_modules/uuid/dist/esm-node/stringify.js
init_esbuild_shims();
var byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
  return byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]];
}
__name(unsafeStringify, "unsafeStringify");

// node_modules/uuid/dist/esm-node/v4.js
init_esbuild_shims();

// node_modules/uuid/dist/esm-node/native.js
init_esbuild_shims();
import crypto2 from "crypto";
var native_default = {
  randomUUID: crypto2.randomUUID
};

// node_modules/uuid/dist/esm-node/v4.js
function v4(options, buf, offset) {
  if (native_default.randomUUID && !buf && !options) {
    return native_default.randomUUID();
  }
  options = options || {};
  const rnds = options.random || (options.rng || rng)();
  rnds[6] = rnds[6] & 15 | 64;
  rnds[8] = rnds[8] & 63 | 128;
  if (buf) {
    offset = offset || 0;
    for (let i = 0; i < 16; ++i) {
      buf[offset + i] = rnds[i];
    }
    return buf;
  }
  return unsafeStringify(rnds);
}
__name(v4, "v4");
var v4_default = v4;

// packages/core/src/utils/openaiLogger.ts
import * as os from "os";
var debugLogger = createDebugLogger("OPENAI_LOGGER");
var MAIN_SESSION_PROMPT_ID_DELIMITER = "########";
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function resolveOpenAILogDir(customLogDir, cwd) {
  const baseCwd = cwd || process.cwd();
  if (!customLogDir) {
    return path.join(baseCwd, "logs", "openai");
  }
  let resolvedPath = customLogDir;
  if (customLogDir === "~" || customLogDir.startsWith("~/")) {
    resolvedPath = path.join(os.homedir(), customLogDir.slice(1));
  } else if (!path.isAbsolute(customLogDir)) {
    resolvedPath = path.resolve(baseCwd, customLogDir);
  }
  return path.normalize(resolvedPath);
}
__name(resolveOpenAILogDir, "resolveOpenAILogDir");
function sanitizeDiagnosticSuffix(suffix) {
  if (!suffix) return void 0;
  const sanitized = suffix.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || void 0;
}
__name(sanitizeDiagnosticSuffix, "sanitizeDiagnosticSuffix");
function extractSubagentSuffix(promptId) {
  const parts = promptId.split("#");
  if (parts.length !== 3) return void 0;
  const [, subagentId, turn] = parts;
  if (!subagentId || !turn || !/^\d+$/.test(turn)) {
    return void 0;
  }
  return `subagent-${subagentId}`;
}
__name(extractSubagentSuffix, "extractSubagentSuffix");
function promptIdSuffixForFilename(promptId) {
  if (!promptId) return void 0;
  if (isInternalPromptId(promptId)) {
    return sanitizeDiagnosticSuffix(promptId);
  }
  return sanitizeDiagnosticSuffix(extractSubagentSuffix(promptId));
}
__name(promptIdSuffixForFilename, "promptIdSuffixForFilename");
function sessionIdFromPromptId(promptId) {
  if (!promptId) return void 0;
  const mainSessionDelimiterIndex = promptId.indexOf(
    MAIN_SESSION_PROMPT_ID_DELIMITER
  );
  if (mainSessionDelimiterIndex > 0) {
    return promptId.slice(0, mainSessionDelimiterIndex);
  }
  if (UUID_PATTERN.test(promptId)) {
    return promptId;
  }
  const parts = promptId.split("#");
  if (parts.length >= 3 && parts[0]) {
    return parts[0];
  }
  return void 0;
}
__name(sessionIdFromPromptId, "sessionIdFromPromptId");
function contextForPromptId(promptId) {
  const trimmedPromptId = promptId?.trim();
  const sessionId = sessionIdFromPromptId(trimmedPromptId);
  if (!trimmedPromptId && !sessionId) {
    return null;
  }
  return {
    ...trimmedPromptId ? { promptId: trimmedPromptId } : {},
    ...sessionId ? { sessionId } : {}
  };
}
__name(contextForPromptId, "contextForPromptId");
function getString(value) {
  return typeof value === "string" && value ? value : void 0;
}
__name(getString, "getString");
function getErrorRequestId(error) {
  const source = error;
  return getString(source.requestID) ?? getString(source.request_id) ?? getString(source.requestId) ?? getString(source.response_id) ?? getRateLimitErrorDetails(error).requestId;
}
__name(getErrorRequestId, "getErrorRequestId");
function serializeError(error) {
  const requestId = getErrorRequestId(error);
  return {
    message: error.message,
    stack: error.stack,
    ...requestId ? { requestId } : {}
  };
}
__name(serializeError, "serializeError");
var OpenAILogger = class {
  static {
    __name(this, "OpenAILogger");
  }
  logDir;
  initialized = false;
  /**
   * Creates a new OpenAI logger
   * @param customLogDir Optional custom log directory path (supports relative paths, absolute paths, and ~ expansion)
   * @param cwd Optional working directory for resolving relative paths. Defaults to process.cwd().
   *            In ACP mode, process.cwd() may be '/' (filesystem root), so callers should
   *            pass the project working directory from Config.getWorkingDir().
   */
  constructor(customLogDir, cwd) {
    this.logDir = resolveOpenAILogDir(customLogDir, cwd);
  }
  /**
   * Initialize the logger by creating the log directory if it doesn't exist
   */
  async initialize() {
    if (this.initialized) return;
    try {
      await fs.mkdir(this.logDir, { recursive: true });
      this.initialized = true;
    } catch (error) {
      debugLogger.error("Failed to initialize OpenAI logger:", error);
      throw new Error(`Failed to initialize OpenAI logger: ${error}`);
    }
  }
  /**
   * Logs an OpenAI API request and its response
   * @param request The request sent to OpenAI
   * @param response The response received from OpenAI
   * @param error Optional error if the request failed
   * @param promptId Optional prompt id; internal and subagent prompt ids are
   *                 appended to the filename after timestamp and id.
   * @returns The file path where the log was written
   */
  async logInteraction(request, response, error, promptId) {
    if (!this.initialized) {
      await this.initialize();
    }
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/:/g, "-");
    const id = v4_default().slice(0, 8);
    const promptIdSuffix = promptIdSuffixForFilename(promptId);
    const filename = promptIdSuffix ? `openai-${timestamp}-${id}-${promptIdSuffix}.json` : `openai-${timestamp}-${id}.json`;
    const filePath = path.join(this.logDir, filename);
    const logData = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      request,
      response: response || null,
      error: error ? serializeError(error) : null,
      context: contextForPromptId(promptId),
      system: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        nodeVersion: process.version
      }
    };
    try {
      await fs.writeFile(filePath, JSON.stringify(logData, null, 2), "utf-8");
      return filePath;
    } catch (writeError) {
      debugLogger.error("Failed to write OpenAI log file:", writeError);
      throw new Error(`Failed to write OpenAI log file: ${writeError}`);
    }
  }
  /**
   * Get all logged interactions
   * @param limit Optional limit on the number of log files to return (sorted by most recent first)
   * @returns Array of log file paths
   */
  async getLogFiles(limit) {
    if (!this.initialized) {
      await this.initialize();
    }
    try {
      const files = await fs.readdir(this.logDir);
      const logFiles = files.filter((file) => file.startsWith("openai-") && file.endsWith(".json")).map((file) => path.join(this.logDir, file)).sort().reverse();
      return limit === void 0 ? logFiles : logFiles.slice(0, limit);
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      debugLogger.error("Failed to read OpenAI log directory:", error);
      return [];
    }
  }
  /**
   * Read a specific log file
   * @param filePath The path to the log file
   * @returns The log file content
   */
  async readLogFile(filePath) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      debugLogger.error(`Failed to read log file ${filePath}:`, error);
      throw new Error(`Failed to read log file: ${error}`);
    }
  }
};
var openaiLogger = new OpenAILogger();

export {
  resolveOpenAILogDir,
  OpenAILogger
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
