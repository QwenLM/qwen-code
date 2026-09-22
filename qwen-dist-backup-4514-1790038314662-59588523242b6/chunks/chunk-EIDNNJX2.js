// Force strict mode and setup for ESM
"use strict";
import {
  BaseJsonOutputAdapter
} from "./chunk-LPRZ7GBH.js";
import {
  observeHeadlessJsonToolResultWire
} from "./chunk-TPIZYLF2.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/nonInteractive/io/JsonOutputAdapter.ts
init_esbuild_shims();
var JsonOutputAdapter = class extends BaseJsonOutputAdapter {
  static {
    __name(this, "JsonOutputAdapter");
  }
  messages = [];
  attemptMessageCheckpoint = 0;
  lastAssistantMessageAtAttemptStart = null;
  constructor(config) {
    super(config);
  }
  /**
   * Emits message to the messages array (batch mode).
   * Tracks the last assistant message for efficient result text extraction.
   */
  emitMessageImpl(message) {
    this.messages.push(message);
    if (typeof message === "object" && message !== null && "type" in message && message.type === "assistant") {
      this.updateLastAssistantMessage(message);
    }
  }
  /**
   * JSON mode does not emit stream events.
   */
  shouldEmitStreamEvents() {
    return false;
  }
  startAssistantMessage() {
    this.attemptMessageCheckpoint = this.messages.length;
    this.lastAssistantMessageAtAttemptStart = this.lastAssistantMessage;
    super.startAssistantMessage();
  }
  restartAttempt(preserveText, discardedToolCalls) {
    if (preserveText) {
      const discardedIds = new Set(
        discardedToolCalls.map((request) => request.callId)
      );
      if (discardedIds.size > 0) {
        const retained = this.messages.slice(this.attemptMessageCheckpoint).filter(
          (message) => message.type !== "assistant" || !message.message.content.some(
            (block) => block.type === "tool_use" && discardedIds.has(block.id)
          )
        );
        this.messages.splice(
          this.attemptMessageCheckpoint,
          this.messages.length - this.attemptMessageCheckpoint,
          ...retained
        );
        this.lastAssistantMessage = this.messages.findLast(
          (message) => message.type === "assistant"
        ) ?? this.lastAssistantMessageAtAttemptStart;
      }
    } else {
      const retained = this.messages.slice(this.attemptMessageCheckpoint).filter((message) => message.type !== "assistant");
      this.messages.splice(
        this.attemptMessageCheckpoint,
        this.messages.length - this.attemptMessageCheckpoint,
        ...retained
      );
      this.lastAssistantMessage = this.lastAssistantMessageAtAttemptStart;
    }
    super.restartAttempt(preserveText, discardedToolCalls);
  }
  finalizeAssistantMessage() {
    return this.finalizeAssistantMessageInternal(
      this.mainAgentMessageState,
      null
    );
  }
  emitResult(options) {
    const resultMessage = this.buildResultMessage(
      options,
      this.lastAssistantMessage
    );
    this.messages.push(resultMessage);
    if (this.config.getOutputFormat() === "text") {
      if (resultMessage.is_error) {
        process.stderr.write(`${resultMessage.error?.message || ""}
`);
      } else {
        process.stdout.write(`${resultMessage.result}
`);
      }
    } else {
      const json = JSON.stringify(this.messages);
      const frame = `${json}
`;
      observeHeadlessJsonToolResultWire(this.messages, frame);
      process.stdout.write(frame);
    }
  }
  emitMessage(message) {
    this.messages.push(message);
  }
};

export {
  JsonOutputAdapter
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
