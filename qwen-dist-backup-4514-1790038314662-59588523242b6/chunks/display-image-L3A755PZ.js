// Force strict mode and setup for ESM
"use strict";
import {
  isInForkExecution
} from "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  MAX_TERMINAL_IMAGE_BYTES
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  makeRelative,
  shortenPath,
  unescapePath
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/display-image.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var PNG_SIGNATURE = "89504e470d0a1a0a";
function errorResult(message, type) {
  return {
    llmContent: message,
    returnDisplay: `Error: ${message}`,
    error: { message, type }
  };
}
__name(errorResult, "errorResult");
var DisplayImageInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "DisplayImageInvocation");
  }
  getDescription() {
    return shortenPath(
      makeRelative(this.params.file_path, this.config.getTargetDir())
    );
  }
  toolLocations() {
    return [{ path: this.params.file_path }];
  }
  async execute(signal) {
    signal.throwIfAborted();
    if (isInForkExecution()) {
      return errorResult(
        "display_image can only be executed by the main agent.",
        "execution_denied" /* EXECUTION_DENIED */
      );
    }
    const filePath = path.resolve(this.params.file_path);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      const message = error.code === "ENOENT" ? `Image file not found: ${filePath}` : `Unable to access image file "${filePath}": ${error instanceof Error ? error.message : String(error)}`;
      return errorResult(
        message,
        error.code === "ENOENT" ? "file_not_found" /* FILE_NOT_FOUND */ : "read_content_failure" /* READ_CONTENT_FAILURE */
      );
    }
    if (stat.isDirectory()) {
      return errorResult(
        `Image path is a directory: ${filePath}`,
        "target_is_directory" /* TARGET_IS_DIRECTORY */
      );
    }
    if (!stat.isFile()) {
      return errorResult(
        `Image path is not a regular file: ${filePath}`,
        "target_not_regular_file" /* TARGET_NOT_REGULAR_FILE */
      );
    }
    if (stat.size > MAX_TERMINAL_IMAGE_BYTES) {
      return errorResult(
        `Image exceeds the ${MAX_TERMINAL_IMAGE_BYTES} byte display limit: ${filePath}`,
        "file_too_large" /* FILE_TOO_LARGE */
      );
    }
    signal.throwIfAborted();
    let fileHandle;
    try {
      fileHandle = await fs.open(filePath, "r");
      const header = Buffer.alloc(24);
      const { bytesRead } = await fileHandle.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || header.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
        return errorResult(
          `Only PNG images are supported by display_image: ${filePath}`,
          "invalid_tool_params" /* INVALID_TOOL_PARAMS */
        );
      }
    } catch (error) {
      return errorResult(
        `Unable to read image file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
        "read_content_failure" /* READ_CONTENT_FAILURE */
      );
    } finally {
      await fileHandle?.close();
    }
    const renderSupport = await this.config.getTerminalImageRenderSupport();
    if (!renderSupport.available) {
      return errorResult(
        `The image was not displayed: ${renderSupport.reason}`,
        "execution_failed" /* EXECUTION_FAILED */
      );
    }
    const display = {
      type: "terminal_image",
      filePath,
      mimeType: "image/png"
    };
    return {
      llmContent: `The terminal renderer accepted "${path.basename(filePath)}" for display. This display-only tool does not provide the image contents to you; use read_file if you need to inspect the image.`,
      returnDisplay: display,
      resultFilePaths: [filePath]
    };
  }
};
var DisplayImageTool = class _DisplayImageTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _DisplayImageTool.Name,
      ToolDisplayNames.DISPLAY_IMAGE,
      "Displays an existing workspace PNG in the user\u2019s interactive terminal. Only the main agent can execute this tool. This is only a user-visible preview: it does not return image contents to you. Use read_file when you need to inspect or understand the image. The file_path must be absolute.",
      "read" /* Read */,
      {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to a PNG inside the current workspace."
          }
        },
        required: ["file_path"],
        additionalProperties: false
      },
      false
    );
    this.config = config;
  }
  static {
    __name(this, "DisplayImageTool");
  }
  static Name = ToolNames.DISPLAY_IMAGE;
  validateToolParamValues(params) {
    params.file_path = unescapePath(params.file_path.trim());
    if (!params.file_path) {
      return 'Missing or empty "file_path".';
    }
    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute: ${params.file_path}`;
    }
    if (!this.config.getWorkspaceContext().isPathWithinWorkspace(params.file_path)) {
      return `Image path is outside the current workspace: ${params.file_path}`;
    }
    return null;
  }
  createInvocation(params) {
    return new DisplayImageInvocation(this.config, params);
  }
};
export {
  DisplayImageTool
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
