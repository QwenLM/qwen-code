// Force strict mode and setup for ESM
"use strict";
import {
  validateSessionSourceInput
} from "./chunk-ELRMZTPF.js";
import {
  isSubagentLikeExecutionContext
} from "./chunk-B5WYAQ4I.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/record-source.ts
init_esbuild_shims();
var RecordSourceInvocation = class extends BaseToolInvocation {
  constructor(params, config) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "RecordSourceInvocation");
  }
  getDescription() {
    return `Add reference: ${this.params.title}`;
  }
  async execute() {
    try {
      if (isSubagentLikeExecutionContext()) {
        throw new Error("Only the top-level session can register sources");
      }
      const service = this.config.getSessionSourceService();
      if (!service) throw new Error("Session source service unavailable");
      if (this.params.locator.type === "attachment")
        throw new Error("The tool accepts only workspace files and URLs");
      const { source } = await service.upsert(this.params);
      const message = `Reference added: ${source.id}`;
      return { llmContent: message, returnDisplay: message };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Source registration failed";
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: "execution_failed" /* EXECUTION_FAILED */ }
      };
    }
  }
};
var RecordSourceTool = class _RecordSourceTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _RecordSourceTool.Name,
      ToolDisplayNames.RECORD_SOURCE,
      "Adds a file or HTTP(S) link to this session reference list. Registration stores metadata only: it does not read or send resource contents, and does not prove the assistant used the reference. Use record_artifact for newly produced deliverables.",
      "other" /* Other */,
      {
        type: "object",
        additionalProperties: false,
        required: ["title", "locator"],
        properties: {
          title: { type: "string", maxLength: 200 },
          description: { type: "string", maxLength: 1e3 },
          locator: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "workspacePath"],
                properties: {
                  type: { type: "string", const: "workspace_file" },
                  workspacePath: { type: "string", maxLength: 500 }
                }
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["type", "url"],
                properties: {
                  type: { type: "string", const: "url" },
                  url: { type: "string", maxLength: 2048 }
                }
              }
            ]
          }
        }
      },
      true,
      false,
      true,
      false,
      "source reference file link"
    );
    this.config = config;
  }
  static {
    __name(this, "RecordSourceTool");
  }
  static Name = ToolNames.RECORD_SOURCE;
  validateToolParamValues(params) {
    try {
      const input = validateSessionSourceInput(params);
      return input.locator.type === "attachment" ? "The tool accepts only workspace files and URLs" : null;
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid source";
    }
  }
  createInvocation(params) {
    return new RecordSourceInvocation(params, this.config);
  }
};

export {
  RecordSourceTool
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
