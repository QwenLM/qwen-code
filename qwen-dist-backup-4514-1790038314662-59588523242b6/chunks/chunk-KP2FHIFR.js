// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/thoughtUtils.ts
init_esbuild_shims();
var START_DELIMITER = "**";
var END_DELIMITER = "**";
var OPENAI_REASONING_THOUGHT_MARKER = Symbol("openaiReasoningThought");
function createOpenAIReasoningThoughtPart(text) {
  const part = { text, thought: true };
  Object.defineProperty(part, OPENAI_REASONING_THOUGHT_MARKER, {
    value: true
  });
  return part;
}
__name(createOpenAIReasoningThoughtPart, "createOpenAIReasoningThoughtPart");
function isOpenAIReasoningThoughtPart(part) {
  return Boolean(
    part[OPENAI_REASONING_THOUGHT_MARKER]
  );
}
__name(isOpenAIReasoningThoughtPart, "isOpenAIReasoningThoughtPart");
function isResponsesReasoningSignature(signature) {
  if (typeof signature !== "string") return false;
  if (!signature.trimStart().startsWith("{")) return false;
  try {
    const payload = JSON.parse(signature);
    return payload !== null && typeof payload === "object" && "id" in payload && typeof payload.id === "string" && "encrypted_content" in payload && typeof payload.encrypted_content === "string";
  } catch {
    return false;
  }
}
__name(isResponsesReasoningSignature, "isResponsesReasoningSignature");
function parseThought(rawText) {
  const startIndex = rawText.indexOf(START_DELIMITER);
  if (startIndex === -1) {
    return { subject: "", description: rawText };
  }
  const endIndex = rawText.indexOf(
    END_DELIMITER,
    startIndex + START_DELIMITER.length
  );
  if (endIndex === -1) {
    return { subject: "", description: rawText };
  }
  const subject = rawText.substring(startIndex + START_DELIMITER.length, endIndex).trim();
  const description = (rawText.substring(0, startIndex) + rawText.substring(endIndex + END_DELIMITER.length)).trim();
  return { subject, description };
}
__name(parseThought, "parseThought");
function getThoughtSummary(response) {
  if (response.candidates && response.candidates.length > 0) {
    const candidate = response.candidates[0];
    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
      const thoughtParts = candidate.content.parts.filter(
        (part) => part.thought
      );
      if (thoughtParts.length === 0) {
        return null;
      }
      const thoughtText = thoughtParts.map((part) => part.text ?? "").join("");
      if (!thoughtText) {
        return null;
      }
      if (thoughtParts.some(isOpenAIReasoningThoughtPart)) {
        return { subject: "", description: thoughtText };
      }
      return parseThought(thoughtText);
    }
  }
  return null;
}
__name(getThoughtSummary, "getThoughtSummary");

export {
  createOpenAIReasoningThoughtPart,
  isResponsesReasoningSignature,
  getThoughtSummary
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
