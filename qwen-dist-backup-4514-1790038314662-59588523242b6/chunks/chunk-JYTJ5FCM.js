// Force strict mode and setup for ESM
"use strict";
import {
  t
} from "./chunk-POMFSBEC.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/services/voice-model.ts
init_esbuild_shims();
function resolveVoiceTransport(model) {
  const id = model.toLowerCase();
  if (/^qwen3-asr-flash-realtime(?:-|$)/.test(id)) {
    return "qwen-asr-realtime";
  }
  if (/^qwen3-asr-flash(?:-\d{4}-\d{2}-\d{2})?$/.test(id)) {
    return "qwen-asr-chat";
  }
  if (/^(fun-asr|paraformer).*realtime(?:-|$)/.test(id)) {
    return "dashscope-task-realtime";
  }
  return "unsupported";
}
__name(resolveVoiceTransport, "resolveVoiceTransport");
function isTranscribableVoiceModel(model) {
  return model.authType === "openai" /* USE_OPENAI */ && model.isRuntimeModel !== true && model.imageOnly !== true && typeof model.baseUrl === "string" && model.baseUrl.trim().length > 0;
}
__name(isTranscribableVoiceModel, "isTranscribableVoiceModel");
function isSelectableVoiceModel(model) {
  return isTranscribableVoiceModel(model) && resolveVoiceTransport(model.id) !== "unsupported";
}
__name(isSelectableVoiceModel, "isSelectableVoiceModel");
function formatUnsupportedVoiceModelMessage(modelName) {
  return t(
    "Voice model '{{modelName}}' cannot be used for transcription. Configure an OpenAI-compatible model with baseUrl in settings.modelProviders.",
    {
      modelName
    }
  );
}
__name(formatUnsupportedVoiceModelMessage, "formatUnsupportedVoiceModelMessage");

// packages/cli/src/services/voice-settings.ts
init_esbuild_shims();
function readVoiceModel(settings) {
  const value = settings.merged?.voiceModel;
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
__name(readVoiceModel, "readVoiceModel");
function isVoiceEnabled(settings) {
  return settings.merged?.general?.voice?.enabled === true;
}
__name(isVoiceEnabled, "isVoiceEnabled");
function readVoiceMode(settings) {
  return settings.merged?.general?.voice?.mode === "tap" ? "tap" : "hold";
}
__name(readVoiceMode, "readVoiceMode");
function readVoiceLanguage(settings) {
  const language = settings.merged.general?.voice?.language;
  if (typeof language !== "string") {
    return "";
  }
  return language.trim();
}
__name(readVoiceLanguage, "readVoiceLanguage");
function getVoiceSettingsScope(settings, workspaceTrusted = settings.isTrusted === true) {
  return workspaceTrusted && typeof settings.workspace?.settings?.general?.voice?.enabled === "boolean" ? "Workspace" /* Workspace */ : "User" /* User */;
}
__name(getVoiceSettingsScope, "getVoiceSettingsScope");
function isVoiceMode(value) {
  return value === "hold" || value === "tap";
}
__name(isVoiceMode, "isVoiceMode");

export {
  resolveVoiceTransport,
  isTranscribableVoiceModel,
  isSelectableVoiceModel,
  formatUnsupportedVoiceModelMessage,
  readVoiceModel,
  isVoiceEnabled,
  readVoiceMode,
  readVoiceLanguage,
  getVoiceSettingsScope,
  isVoiceMode
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
