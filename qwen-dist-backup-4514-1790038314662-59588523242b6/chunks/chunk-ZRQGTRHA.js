// Force strict mode and setup for ESM
"use strict";
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

// packages/core/src/tools/syntheticOutput.ts
init_esbuild_shims();
var structuredOutputDescription = `Submit your final answer as structured JSON that conforms to the provided schema.

CRITICAL: In structured-output mode, this is the ONLY way to deliver the final result. Call this tool to deliver the final result; the first call with valid arguments ends the session. Do not emit the final answer as plain text \u2014 it will be discarded. Use other tools (Read, Grep, etc.) to gather the information you need before calling this tool.

The arguments you pass MUST validate against the tool's parameter schema. If validation fails you will receive the error and may retry with corrected fields.`;
var STRUCTURED_OUTPUT_REDACTED_ARGS = {
  __redacted: "structured_output payload (see stdout result)"
};
var SyntheticOutputTool = class _SyntheticOutputTool extends BaseDeclarativeTool {
  static {
    __name(this, "SyntheticOutputTool");
  }
  static Name = ToolNames.STRUCTURED_OUTPUT;
  constructor(userSchema) {
    super(
      _SyntheticOutputTool.Name,
      ToolDisplayNames.STRUCTURED_OUTPUT,
      structuredOutputDescription,
      "think" /* Think */,
      userSchema,
      false,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      false,
      // shouldDefer — must be visible so the model knows to call it
      true,
      // alwaysLoad — never hidden behind ToolSearch
      "structured output json schema final result submit"
    );
  }
  createInvocation(params) {
    return new SyntheticOutputInvocation(params);
  }
};
var SyntheticOutputInvocation = class extends BaseToolInvocation {
  static {
    __name(this, "SyntheticOutputInvocation");
  }
  getDescription() {
    return "Submit structured result";
  }
  async execute(_signal) {
    return {
      llmContent: "Structured output accepted. The session will end now \u2014 do not send further content.",
      returnDisplay: "Structured output accepted."
    };
  }
};

export {
  STRUCTURED_OUTPUT_REDACTED_ARGS,
  SyntheticOutputTool
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
