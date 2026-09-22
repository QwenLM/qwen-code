// Force strict mode and setup for ESM
"use strict";
import {
  createMediaMemoryRecallService
} from "./chunk-DJYHML3Y.js";
import {
  MediaMemoryRecallRejection
} from "./chunk-SLHYLVRW.js";
import {
  OMNI_MEMORY_RECALL_KINDS
} from "./chunk-YDERQ7ZV.js";
import "./chunk-TFDCK56Y.js";
import "./chunk-FTKXJMQV.js";
import "./chunk-S5BHLTHK.js";
import "./chunk-KSEKRQJO.js";
import {
  resolveMediaReference
} from "./chunk-MNU36NGH.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-BKVPLSEI.js";
import "./chunk-CA63HYHU.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/recall-media-memory-tool.ts
init_esbuild_shims();
var OmniRecallMediaMemoryInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "OmniRecallMediaMemoryInvocation");
  }
  getDescription() {
    const handles = this.params.resourceIds.join(", ");
    return `Recall media memory for ${handles}`;
  }
  async execute(_signal) {
    const service = createMediaMemoryRecallService(this.config);
    if (!service) {
      return {
        llmContent: "Media memory is not available in this session (omni memory is not configured).",
        returnDisplay: "Media memory unavailable",
        error: {
          message: "omni memory is not configured",
          type: "execution_failed" /* EXECUTION_FAILED */
        }
      };
    }
    try {
      const result = await service.recall({
        resourceIds: this.params.resourceIds,
        query: this.params.query,
        ...this.params.kinds !== void 0 ? { kinds: this.params.kinds } : {},
        ...this.params.roles !== void 0 ? { roles: this.params.roles } : {},
        ...this.params.includeHistoricalVersions !== void 0 ? {
          includeHistoricalVersions: this.params.includeHistoricalVersions
        } : {},
        ...this.params.limit !== void 0 ? { limit: this.params.limit } : {}
      });
      return {
        llmContent: JSON.stringify(result, null, 1),
        returnDisplay: `Recall ${result.status}: ${result.entries.length} entr${result.entries.length === 1 ? "y" : "ies"}, ${result.gaps.length} gap${result.gaps.length === 1 ? "" : "s"}` + (result.nextPolicyActions?.length ? `, ${result.nextPolicyActions.length} suggested action${result.nextPolicyActions.length === 1 ? "" : "s"}` : "")
      };
    } catch (err) {
      if (err instanceof MediaMemoryRecallRejection) {
        return {
          llmContent: `Recall request rejected (${err.reason}): ${err.message}`,
          returnDisplay: `Recall rejected: ${err.reason}`,
          error: {
            message: err.message,
            type: "invalid_tool_params" /* INVALID_TOOL_PARAMS */
          }
        };
      }
      throw err;
    }
  }
};
var OmniRecallMediaMemoryTool = class _OmniRecallMediaMemoryTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _OmniRecallMediaMemoryTool.Name,
      ToolDisplayNames.OMNI_RECALL_MEDIA_MEMORY,
      "Recalls what is already known about media resources delivered in this session: prior transcripts, extracted keyframes, technical metadata, and processing history persisted by earlier sessions. Pass the reference announced next to delivered media \u2014 the \u3010\u5A92\u4F53\u8DEF\u5F84\u3011<absolute path> of a local file you read, or the \u3010\u5A92\u4F53\u8D44\u6E90\u3011<resourceId> handle of path-less media (handles from recall results work too). Returns matching entries plus honest gaps \u2014 channels never processed or artifacts no longer available \u2014 and may suggest follow-up tool calls to gather missing evidence. Use this BEFORE reprocessing media: a transcript or keyframe set that already exists is returned instantly.",
      "read" /* Read */,
      {
        type: "object",
        properties: {
          resourceIds: {
            type: "array",
            // maxLength admits a full absolute path (the path form), not just
            // a ~16-char media-<n>-<hex> handle — an over-long bound would let
            // Ajv reject the very path the annotation displayed, before
            // resolution, with no shorter identifier to retry.
            items: { type: "string", minLength: 1, maxLength: 4096 },
            minItems: 1,
            description: "Resource references to consult, each taken from a \u3010\u5A92\u4F53\u8DEF\u5F84\u3011 or \u3010\u5A92\u4F53\u8D44\u6E90\u3011 annotation or a prior recall result: the absolute path shown for a local file you read, or an opaque session handle. An unresolvable reference rejects the whole request."
          },
          query: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
            description: "Free-text information need; orders results by relevance."
          },
          kinds: {
            type: "array",
            items: {
              type: "string",
              enum: [...OMNI_MEMORY_RECALL_KINDS]
            },
            // An empty list would read as "restrict to nothing" and return a
            // silent miss; omit the key instead to mean "all kinds".
            minItems: 1,
            uniqueItems: true,
            description: "Restrict to entry kinds (default: all configured kinds)."
          },
          roles: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 128 },
            minItems: 1,
            uniqueItems: true,
            description: 'Restrict to artifact roles (e.g. "transcript", "keyframe").'
          },
          includeHistoricalVersions: {
            type: "boolean",
            description: "Also consult superseded file versions (default: only the current version)."
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Maximum entries to return (capped by session config)."
          }
        },
        required: ["resourceIds", "query"],
        additionalProperties: false
      },
      false,
      // isOutputMarkdown — structured JSON payload
      false,
      // canUpdateOutput
      true,
      // shouldDefer — recall is an occasional lookup (matches web_fetch)
      false,
      // alwaysLoad
      "recall media memory transcript keyframe history resource"
    );
    this.config = config;
  }
  static {
    __name(this, "OmniRecallMediaMemoryTool");
  }
  static Name = ToolNames.OMNI_RECALL_MEDIA_MEMORY;
  validateToolParamValues(params) {
    const maxFiles = this.config.getOmniMemoryConfig()?.recall.active.maxFilesPerCall;
    if (maxFiles === void 0) return null;
    const registry = this.config.getOmniMediaResourceRegistry?.();
    const resolved = /* @__PURE__ */ new Set();
    const unresolvable = /* @__PURE__ */ new Set();
    for (const reference of params.resourceIds) {
      const binding = registry ? resolveMediaReference(registry, reference) : void 0;
      if (binding) resolved.add(binding.resourceId);
      else unresolvable.add(reference);
    }
    const distinct = resolved.size + unresolvable.size;
    if (distinct > maxFiles) {
      return `resourceIds resolves to ${distinct} distinct media files; at most ${maxFiles} may be consulted per call (omni.memory.recall.active.maxFilesPerCall). Split the request.`;
    }
    return null;
  }
  createInvocation(params) {
    return new OmniRecallMediaMemoryInvocation(this.config, params);
  }
};
export {
  OmniRecallMediaMemoryTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
