// Force strict mode and setup for ESM
"use strict";
import {
  createMediaMemoryRecallService
} from "./chunk-DJYHML3Y.js";
import {
  MediaMemoryRecallRejection
} from "./chunk-SLHYLVRW.js";
import "./chunk-YDERQ7ZV.js";
import "./chunk-TFDCK56Y.js";
import "./chunk-FTKXJMQV.js";
import "./chunk-S5BHLTHK.js";
import "./chunk-KSEKRQJO.js";
import "./chunk-MNU36NGH.js";
import "./chunk-BQMSZSG6.js";
import {
  parseResourceHandleText,
  parseResourcePathText
} from "./chunk-BKVPLSEI.js";
import {
  runSideQuery
} from "./chunk-43QUA4MC.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/memory-side-query.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("omni:memory");
var SELECTION_SCHEMA = {
  type: "object",
  properties: {
    entryIds: {
      type: "array",
      items: { type: "string" },
      description: "entryIds chosen from the candidate manifest."
    }
  },
  required: ["entryIds"],
  additionalProperties: false
};
var MAX_SELECTOR_REQUEST_CHARS = 4e3;
function extractRequestResourceIds(config, parts) {
  const registry = config.getOmniMediaResourceRegistry?.();
  if (!registry) return [];
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  for (const part of parts) {
    const text = typeof part === "string" ? part : typeof part === "object" && part !== null && "text" in part ? part.text : void 0;
    if (!text) continue;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      let resourceId = parseResourceHandleText(trimmed);
      if (!resourceId) {
        const leftTrimmed = line.replace(/^\s+/, "");
        for (const candidate of [
          parseResourcePathText(leftTrimmed),
          parseResourcePathText(trimmed)
        ]) {
          if (!candidate) continue;
          const binding = registry.resolveByFileRef(candidate);
          if (binding) {
            resourceId = binding.resourceId;
            break;
          }
        }
      }
      if (!resourceId || seen.has(resourceId)) continue;
      if (!registry.resolve(resourceId)) continue;
      seen.add(resourceId);
      found.push(resourceId);
    }
  }
  return found;
}
__name(extractRequestResourceIds, "extractRequestResourceIds");
function stripSystemReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
}
__name(stripSystemReminders, "stripSystemReminders");
function stripResourceAnnotationLines(text) {
  return text.split("\n").filter((line) => {
    const trimmed = line.trim();
    const leftTrimmed = line.replace(/^\s+/, "");
    return !(parseResourceHandleText(trimmed) ?? parseResourcePathText(leftTrimmed) ?? parseResourcePathText(trimmed));
  }).join("\n");
}
__name(stripResourceAnnotationLines, "stripResourceAnnotationLines");
function selectorRequestText(parts) {
  const texts = [];
  for (const part of parts) {
    const text = typeof part === "string" ? part : typeof part === "object" && part !== null && "text" in part ? part.text : void 0;
    if (!text) continue;
    const stripped = stripResourceAnnotationLines(
      stripSystemReminders(text)
    ).trim();
    if (stripped) texts.push(stripped);
  }
  let joined = texts.join("\n");
  if (joined.length > MAX_SELECTOR_REQUEST_CHARS) {
    joined = joined.slice(0, MAX_SELECTOR_REQUEST_CHARS);
  }
  return joined;
}
__name(selectorRequestText, "selectorRequestText");
async function runOmniMemorySideQuery(params) {
  const { config } = params;
  const memoryConfig = config.getOmniMemoryConfig?.();
  if (!memoryConfig || memoryConfig.recall.mode !== "sideQuery") return null;
  const resourceIds = extractRequestResourceIds(config, params.requestParts);
  if (resourceIds.length === 0) return null;
  const service = createMediaMemoryRecallService(config);
  if (!service) return null;
  const sideQuery = memoryConfig.recall.sideQuery;
  let manifest;
  try {
    manifest = await service.candidateSummaries(resourceIds);
  } catch (err) {
    const reason = `manifest_failed: ${err instanceof Error ? err.message : err}`;
    debugLogger.debug(`omni sideQuery recall degraded: ${reason}`);
    return { result: null, reason, resourceIds };
  }
  if (manifest.length === 0) {
    return { result: null, reason: "no_candidates", resourceIds };
  }
  const manifestIds = new Set(manifest.map((c) => c.entryId));
  const timeoutSignal = AbortSignal.timeout(sideQuery.timeoutMs);
  const abortSignal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const contents = [
    {
      role: "user",
      parts: [
        {
          text: JSON.stringify(
            {
              request: selectorRequestText(params.requestParts),
              candidates: manifest
            },
            null,
            1
          )
        }
      ]
    }
  ];
  let selection;
  try {
    selection = await runSideQuery(config, {
      contents,
      schema: SELECTION_SCHEMA,
      abortSignal,
      ...sideQuery.model !== null ? { model: sideQuery.model } : {},
      systemInstruction: `You select which persisted media-memory entries are relevant to the current request. Input: {request, candidates}. Return ONLY {"entryIds": [...]}: at most ${sideQuery.maxSelectedEntries} ids, each copied verbatim from the candidates. Return an empty array when nothing is relevant. Never invent ids, never add other keys.`,
      ...params.promptId !== void 0 ? { promptId: params.promptId } : {},
      purpose: "omni-memory-sidequery-selector",
      maxAttempts: sideQuery.maxAttempts,
      skipOutputLanguagePreference: true,
      validate: /* @__PURE__ */ __name((response) => {
        if (!Array.isArray(response.entryIds))
          return "entryIds must be an array";
        if (response.entryIds.length > sideQuery.maxSelectedEntries) {
          return `at most ${sideQuery.maxSelectedEntries} entryIds`;
        }
        const unknown = response.entryIds.find(
          (id) => typeof id !== "string" || !manifestIds.has(id)
        );
        return unknown !== void 0 ? `entryId ${String(unknown)} is not in the candidate manifest` : null;
      }, "validate")
    });
  } catch (err) {
    const reason = timeoutSignal.aborted ? "selector_timeout" : `selector_failed: ${err instanceof Error ? err.message : err}`;
    debugLogger.debug(`omni sideQuery recall degraded: ${reason}`);
    return { result: null, reason, resourceIds };
  }
  if (selection.entryIds.length === 0) {
    return { result: null, reason: "selector_selected_nothing", resourceIds };
  }
  try {
    const result = await service.recallSelection(
      resourceIds,
      selection.entryIds
    );
    if (result.entries.length === 0) {
      return { result: null, reason: "materialized_nothing", resourceIds };
    }
    return { result, resourceIds };
  } catch (err) {
    const reason = err instanceof MediaMemoryRecallRejection ? `selection_rejected: ${err.reason}` : `materialize_failed: ${err instanceof Error ? err.message : err}`;
    debugLogger.debug(`omni sideQuery recall degraded: ${reason}`);
    return { result: null, reason, resourceIds };
  }
}
__name(runOmniMemorySideQuery, "runOmniMemorySideQuery");
function formatOmniMemorySideQueryReminder(result) {
  return `<system-reminder>
\u3010\u5A92\u4F53\u8BB0\u5FC6\u3011Recalled media memory for the resources referenced in this request (passive mode). Entries below were persisted by earlier processing; resourceIds in them are session handles you may pass to omni media tools.
${JSON.stringify(result, null, 1)}
</system-reminder>`;
}
__name(formatOmniMemorySideQueryReminder, "formatOmniMemorySideQueryReminder");
export {
  extractRequestResourceIds,
  formatOmniMemorySideQueryReminder,
  runOmniMemorySideQuery
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
