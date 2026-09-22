// Force strict mode and setup for ESM
"use strict";
import {
  MediaMemoryRecallService,
  MediaMemoryService
} from "./chunk-SLHYLVRW.js";
import {
  OmniObjectStore
} from "./chunk-FTKXJMQV.js";
import {
  resolveMediaPolicyModelAccess
} from "./chunk-MNU36NGH.js";
import {
  formatResourceHandleText
} from "./chunk-BKVPLSEI.js";
import {
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/memory-recall.ts
init_esbuild_shims();
import path from "node:path";
var GAP_STEP = [
  {
    mediaType: "video",
    channels: ["visual"],
    toolName: ToolNames.OMNI_EXTRACT_KEYFRAMES,
    reason: "no visual evidence collected yet: extract keyframes"
  },
  {
    mediaType: "video",
    // 'acoustic' ONLY. Extracting the track covers `acoustic`, which
    // leaves `speech_text` open — so matching on speech_text too made the
    // advisor re-suggest extraction in the very payload that returns the
    // extracted audio. A wholly unprocessed video still matches (its gap
    // contains acoustic) and the model chains to transcription from there.
    channels: ["acoustic"],
    toolName: ToolNames.OMNI_EXTRACT_AUDIO,
    reason: "no audio-track evidence collected yet: extract the audio track"
  },
  {
    mediaType: "audio",
    channels: ["speech_text"],
    toolName: ToolNames.OMNI_TRANSCRIBE_AUDIO,
    reason: "no transcript collected yet: transcribe the audio"
  }
];
function buildMediaMemoryRecallAdvisor(config) {
  const callable = /* @__PURE__ */ __name((toolName) => config.getToolRegistry().getTool(toolName) !== void 0 && resolveMediaPolicyModelAccess(config, toolName).enabled, "callable");
  return ({ resourceId, mediaType, gap }) => {
    if (gap.reason === "artifact_unavailable") return [];
    if (gap.reason === "partial_coverage") return [];
    const actions = [];
    for (const step of GAP_STEP) {
      if (step.mediaType !== mediaType) continue;
      if (!gap.channels.some((c) => step.channels.includes(c))) continue;
      if (!callable(step.toolName)) continue;
      actions.push({
        toolName: step.toolName,
        resourceId,
        arguments: {},
        reason: step.reason
      });
    }
    return actions;
  };
}
__name(buildMediaMemoryRecallAdvisor, "buildMediaMemoryRecallAdvisor");
function createMediaMemoryRecallService(config) {
  const memoryConfig = config.getOmniMemoryConfig?.();
  if (!memoryConfig) return void 0;
  const omniRootDir = new OmniObjectStore(
    config.storage.getQwenDir()
  ).getOmniRootDir();
  return new MediaMemoryRecallService(
    omniRootDir,
    memoryConfig.recall,
    config.getOmniMediaResourceRegistry(),
    { advise: buildMediaMemoryRecallAdvisor(config) }
  );
}
__name(createMediaMemoryRecallService, "createMediaMemoryRecallService");
function reanchorRememberedMedia(config, absolutePath) {
  const memoryConfig = config.getOmniMemoryConfig?.();
  if (!memoryConfig) return Promise.resolve(void 0);
  const registry = config.getOmniMediaResourceRegistry?.();
  if (!registry) return Promise.resolve(void 0);
  const store = new OmniObjectStore(config.storage.getQwenDir());
  return new MediaMemoryService(store.getOmniRootDir()).findBindingByFileRef(absolutePath).then((found) => {
    if (!found) return void 0;
    const { resourceId } = registry.bind({
      ...found.binding,
      fileRef: absolutePath,
      mediaType: found.mediaType
    });
    return {
      resourceId,
      annotation: formatResourceHandleText(
        path.basename(absolutePath),
        resourceId
      )
    };
  });
}
__name(reanchorRememberedMedia, "reanchorRememberedMedia");

export {
  createMediaMemoryRecallService,
  reanchorRememberedMedia
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
