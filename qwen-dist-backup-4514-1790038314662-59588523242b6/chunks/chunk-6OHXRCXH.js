// Force strict mode and setup for ESM
"use strict";
import {
  JsonFormatter
} from "./chunk-47GVX3K4.js";
import {
  parseAndFormatApiError
} from "./chunk-MRTRBONQ.js";
import {
  stripAnsiAndControl
} from "./chunk-B3XJFEEH.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  FatalBudgetExceededError,
  FatalCancellationError,
  FatalTurnLimitedError
} from "./chunk-S34QJ6IR.js";
import {
  runExitCleanup
} from "./chunk-FR7RJHJR.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/errors.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("CLI_ERRORS");
var AlreadyReportedError = class extends Error {
  static {
    __name(this, "AlreadyReportedError");
  }
  /** Exit code to surface — defaults to 1 for generic upstream failures. */
  exitCode;
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "AlreadyReportedError";
    this.exitCode = exitCode;
  }
};
function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (error !== null && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  if (error !== null && typeof error === "object") {
    try {
      const stringified = JSON.stringify(error);
      return stringified ?? String(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
__name(getErrorMessage, "getErrorMessage");
function extractErrorCode(error) {
  const errorWithCode = error;
  if (typeof errorWithCode.exitCode === "number") {
    return errorWithCode.exitCode;
  }
  if (errorWithCode.code !== void 0) {
    return errorWithCode.code;
  }
  if (errorWithCode.status !== void 0) {
    return errorWithCode.status;
  }
  return 1;
}
__name(extractErrorCode, "extractErrorCode");
function getNumericExitCode(errorCode) {
  return typeof errorCode === "number" ? errorCode : 1;
}
__name(getNumericExitCode, "getNumericExitCode");
var exiting = false;
async function exitAfterCleanup(code) {
  if (exiting) return new Promise(() => {
  });
  exiting = true;
  await runExitCleanup();
  return process.exit(code);
}
__name(exitAfterCleanup, "exitAfterCleanup");
function _resetExitLatchForTest() {
  exiting = false;
}
__name(_resetExitLatchForTest, "_resetExitLatchForTest");
async function handleError(error, config, customErrorCode) {
  if (error instanceof AlreadyReportedError) {
    if (config.getOutputFormat() === "json" /* JSON */) {
      const formatter = new JsonFormatter();
      const errorCode = customErrorCode ?? error.exitCode;
      const formattedError = formatter.formatError(error, errorCode);
      writeStderrLine(formattedError);
      return exitAfterCleanup(getNumericExitCode(errorCode));
    }
    await runExitCleanup();
    throw error;
  }
  const errorMessage = parseAndFormatApiError(
    error,
    config.getContentGeneratorConfig()?.authType
  );
  if (config.getOutputFormat() === "json" /* JSON */) {
    const formatter = new JsonFormatter();
    const errorCode = customErrorCode ?? extractErrorCode(error);
    const formattedError = formatter.formatError(
      error instanceof Error ? error : new Error(getErrorMessage(error)),
      errorCode
    );
    writeStderrLine(formattedError);
    return exitAfterCleanup(getNumericExitCode(errorCode));
  } else {
    writeStderrLine(errorMessage);
    await runExitCleanup();
    throw error;
  }
}
__name(handleError, "handleError");
var TOOL_NAME_ECHO_LIMIT = 64;
var DENIAL_REASON_ECHO_LIMIT = 500;
function sanitizeForStderr(text, limit) {
  const clean = stripAnsiAndControl(text.replace(/\s+/g, " ")).replace(new RegExp("\\p{Cf}", "gu"), "").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}\u2026` : clean;
}
__name(sanitizeForStderr, "sanitizeForStderr");
function handleToolError(toolName, toolError, config, errorCode, resultDisplay, options = {}) {
  const isExecutionDenied = errorCode === "execution_denied" /* EXECUTION_DENIED */;
  const isNonInteractive = !config.isInteractive();
  const isTextMode = config.getOutputFormat() === "text" /* TEXT */;
  if (isExecutionDenied && isNonInteractive && isTextMode) {
    const displayName = sanitizeForStderr(toolName, TOOL_NAME_ECHO_LIMIT);
    if (options.approvalRequired) {
      process.stderr.write(
        `Warning: Tool "${displayName}" requires user approval but cannot execute in non-interactive mode.
To enable automatic tool execution, use the -y flag (YOLO mode):
Example: qwen -p 'your prompt' -y

`
      );
    } else {
      const reason = sanitizeForStderr(
        resultDisplay || toolError.message,
        DENIAL_REASON_ECHO_LIMIT
      );
      process.stderr.write(
        `Warning: Tool "${displayName}" was not run: ${reason || "the call was denied."}

`
      );
    }
  }
  debugLogger.error(
    `Error executing tool ${toolName}: ${resultDisplay || toolError.message}`
  );
}
__name(handleToolError, "handleToolError");
async function handleCancellationError(config) {
  const cancellationError = new FatalCancellationError("Operation cancelled.");
  if (config.getOutputFormat() === "json" /* JSON */) {
    const formatter = new JsonFormatter();
    const formattedError = formatter.formatError(
      cancellationError,
      cancellationError.exitCode
    );
    writeStderrLine(formattedError);
  } else {
    writeStderrLine(cancellationError.message);
  }
  return exitAfterCleanup(cancellationError.exitCode);
}
__name(handleCancellationError, "handleCancellationError");
async function handleMaxTurnsExceededError(config) {
  const baseMessage = "Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.";
  const jsonSchemaActive = config.getJsonSchema?.() !== void 0;
  const message = jsonSchemaActive ? `${baseMessage}
Note: --json-schema is active. If the model never called structured_output, verify it isn't denied by permissions.deny / --exclude-tools and that the schema is satisfiable.` : baseMessage;
  const maxTurnsError = new FatalTurnLimitedError(message);
  if (config.getOutputFormat() === "json" /* JSON */) {
    const formatter = new JsonFormatter();
    const formattedError = formatter.formatError(
      maxTurnsError,
      maxTurnsError.exitCode
    );
    writeStderrLine(formattedError);
  } else {
    writeStderrLine(maxTurnsError.message);
  }
  return exitAfterCleanup(maxTurnsError.exitCode);
}
__name(handleMaxTurnsExceededError, "handleMaxTurnsExceededError");
async function handleBudgetExceededError(config, exceeded) {
  const fatal = new FatalBudgetExceededError(exceeded.message);
  if (config.getOutputFormat() === "json" /* JSON */) {
    const formatter = new JsonFormatter();
    writeStderrLine(formatter.formatError(fatal, fatal.exitCode));
  } else {
    writeStderrLine(fatal.message);
  }
  return exitAfterCleanup(fatal.exitCode);
}
__name(handleBudgetExceededError, "handleBudgetExceededError");

export {
  AlreadyReportedError,
  getErrorMessage,
  _resetExitLatchForTest,
  handleError,
  handleToolError,
  handleCancellationError,
  handleMaxTurnsExceededError,
  handleBudgetExceededError
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
