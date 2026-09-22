// Force strict mode and setup for ESM
"use strict";
import {
  DEFAULT_QWEN_MODEL
} from "./chunk-XZA32HII.js";
import {
  SchemaValidator
} from "./chunk-ERIBG3BX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/sideQuery.ts
init_esbuild_shims();
import { readFile } from "node:fs/promises";
function buildDefaultPromptId(purpose) {
  return purpose ? `side-query:${purpose}` : "side-query";
}
__name(buildDefaultPromptId, "buildDefaultPromptId");
function resolveDefaultModel(config, override) {
  return override ?? config.getFastModel?.() ?? config.getModel() ?? DEFAULT_QWEN_MODEL;
}
__name(resolveDefaultModel, "resolveDefaultModel");
function applyThinkingDefault(callerConfig) {
  const thinkingOverride = callerConfig?.thinkingConfig;
  return {
    ...callerConfig ?? {},
    thinkingConfig: thinkingOverride ? { includeThoughts: false, ...thinkingOverride } : { includeThoughts: false }
  };
}
__name(applyThinkingDefault, "applyThinkingDefault");
async function getOutputLanguageInstruction(config) {
  const outputLanguageFilePath = config.getOutputLanguageFilePath?.();
  if (!outputLanguageFilePath) return void 0;
  try {
    const preference = (await readFile(outputLanguageFilePath, "utf8")).trim();
    if (!preference) return void 0;
    return [
      "Follow the user-visible output language preference below for this side query.",
      "This preference overrides any earlier language-selection rule in this system instruction.",
      preference
    ].join("\n\n");
  } catch {
    return void 0;
  }
}
__name(getOutputLanguageInstruction, "getOutputLanguageInstruction");
function appendSystemInstruction(systemInstruction, outputLanguageInstruction) {
  if (!outputLanguageInstruction) return systemInstruction;
  if (systemInstruction === void 0) return outputLanguageInstruction;
  if (typeof systemInstruction === "string") {
    return `${systemInstruction}

${outputLanguageInstruction}`;
  }
  if (Array.isArray(systemInstruction)) {
    return [...systemInstruction, { text: outputLanguageInstruction }];
  }
  if (typeof systemInstruction === "object" && "parts" in systemInstruction && Array.isArray(systemInstruction.parts)) {
    return {
      ...systemInstruction,
      parts: [...systemInstruction.parts, { text: outputLanguageInstruction }]
    };
  }
  return [systemInstruction, { text: outputLanguageInstruction }];
}
__name(appendSystemInstruction, "appendSystemInstruction");
function isJsonOptions(options) {
  return options.schema !== void 0 && options.schema !== null;
}
__name(isJsonOptions, "isJsonOptions");
async function runSideQuery(config, options) {
  const model = resolveDefaultModel(config, options.model);
  const promptId = options.promptId ?? buildDefaultPromptId(options.purpose);
  const requestConfig = applyThinkingDefault(options.config);
  const outputLanguageInstruction = options.skipOutputLanguagePreference ? void 0 : await getOutputLanguageInstruction(config);
  const systemInstruction = appendSystemInstruction(
    options.systemInstruction,
    outputLanguageInstruction
  );
  if (isJsonOptions(options)) {
    const response = await config.getBaseLlmClient().generateJson({
      contents: options.contents,
      schema: options.schema,
      abortSignal: options.abortSignal,
      model,
      systemInstruction,
      promptId,
      config: requestConfig,
      ...options.maxAttempts !== void 0 && {
        maxAttempts: options.maxAttempts
      }
    });
    const schemaError = SchemaValidator.validate(options.schema, response);
    if (schemaError) {
      throw new Error(`Invalid side query response: ${schemaError}`);
    }
    const customError2 = options.validate?.(response);
    if (customError2) {
      throw new Error(customError2);
    }
    return response;
  }
  const result = await config.getBaseLlmClient().generateText({
    contents: options.contents,
    model,
    systemInstruction,
    abortSignal: options.abortSignal,
    promptId,
    config: requestConfig,
    ...options.maxAttempts !== void 0 && {
      maxAttempts: options.maxAttempts
    },
    ...options.stream !== void 0 && { stream: options.stream },
    ...options.failClosed !== void 0 && { failClosed: options.failClosed }
  });
  const customError = options.validate?.(result.text);
  if (customError) {
    throw new Error(customError);
  }
  return result;
}
__name(runSideQuery, "runSideQuery");

export {
  runSideQuery
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
