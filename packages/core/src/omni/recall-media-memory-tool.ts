/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
} from '../tools/tools.js';
import type { ToolInvocation, ToolResult } from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import {
  MediaMemoryRecallRejection,
  OMNI_MEMORY_RECALL_KINDS,
  type OmniMemoryRecallKind,
} from '../services/media-memory/index.js';
import { createMediaMemoryRecallService } from './memory-recall.js';

/**
 * Active-mode recall surface (M §9, D10): registered ONLY when
 * `omni.memory.recall.mode === 'active'` — the sideQuery selector never
 * runs in that mode, and vice versa. Read-only by constitution (D11):
 * the tool consults persistent media memory and binds session handles;
 * it never writes a record.
 */

export interface OmniRecallMediaMemoryParams {
  /** Resource references from 【媒体资源】 annotations: an opaque session
   * handle for path-less media, or the absolute path for a model-visible
   * local file. Both resolve to the same session binding. */
  resourceIds: string[];
  query: string;
  kinds?: OmniMemoryRecallKind[];
  roles?: string[];
  includeHistoricalVersions?: boolean;
  limit?: number;
}

class OmniRecallMediaMemoryInvocation extends BaseToolInvocation<
  OmniRecallMediaMemoryParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: OmniRecallMediaMemoryParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const handles = this.params.resourceIds.join(', ');
    return `Recall media memory for ${handles}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const service = createMediaMemoryRecallService(this.config);
    if (!service) {
      // Defensive: registration is gated on the normalized memory config,
      // so a missing config here means a stub/uninitialized embedding.
      return {
        llmContent:
          'Media memory is not available in this session (omni memory is ' +
          'not configured).',
        returnDisplay: 'Media memory unavailable',
        error: {
          message: 'omni memory is not configured',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
    try {
      const result = await service.recall({
        resourceIds: this.params.resourceIds,
        query: this.params.query,
        ...(this.params.kinds !== undefined
          ? { kinds: this.params.kinds }
          : {}),
        ...(this.params.roles !== undefined
          ? { roles: this.params.roles }
          : {}),
        ...(this.params.includeHistoricalVersions !== undefined
          ? {
              includeHistoricalVersions: this.params.includeHistoricalVersions,
            }
          : {}),
        ...(this.params.limit !== undefined
          ? { limit: this.params.limit }
          : {}),
      });
      return {
        llmContent: JSON.stringify(result, null, 1),
        returnDisplay:
          `Recall ${result.status}: ${result.entries.length} entr${
            result.entries.length === 1 ? 'y' : 'ies'
          }, ${result.gaps.length} gap${result.gaps.length === 1 ? '' : 's'}` +
          (result.nextPolicyActions?.length
            ? `, ${result.nextPolicyActions.length} suggested action${
                result.nextPolicyActions.length === 1 ? '' : 's'
              }`
            : ''),
      };
    } catch (err) {
      if (err instanceof MediaMemoryRecallRejection) {
        // Whole-request rejection (M §9.2): the request itself is invalid
        // — a parameter-level error the model can correct and retry.
        return {
          llmContent: `Recall request rejected (${err.reason}): ${err.message}`,
          returnDisplay: `Recall rejected: ${err.reason}`,
          error: {
            message: err.message,
            type: ToolErrorType.INVALID_TOOL_PARAMS,
          },
        };
      }
      throw err;
    }
  }
}

export class OmniRecallMediaMemoryTool extends BaseDeclarativeTool<
  OmniRecallMediaMemoryParams,
  ToolResult
> {
  static readonly Name = ToolNames.OMNI_RECALL_MEDIA_MEMORY;

  constructor(private readonly config: Config) {
    super(
      OmniRecallMediaMemoryTool.Name,
      ToolDisplayNames.OMNI_RECALL_MEDIA_MEMORY,
      'Recalls what is already known about media resources delivered in ' +
        'this session: prior transcripts, extracted keyframes, technical ' +
        'metadata, and processing history persisted by earlier sessions. ' +
        'Pass the reference announced in the 【媒体资源】 annotation next to ' +
        'delivered media — an opaque resourceId handle, or the absolute ' +
        'path shown for a local file you read (handles from recall results ' +
        'work too). Returns matching entries plus honest gaps — channels ' +
        'never processed or artifacts no longer available — and may ' +
        'suggest follow-up tool calls to gather missing evidence. Use ' +
        'this BEFORE reprocessing media: a transcript or keyframe set ' +
        'that already exists is returned instantly.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          resourceIds: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 256 },
            minItems: 1,
            description:
              'Resource references to consult, each taken from a 【媒体资源】 ' +
              'annotation or a prior recall result: an opaque session ' +
              'handle, or the absolute path shown for a local file you ' +
              'read. An unresolvable reference rejects the whole request.',
          },
          query: {
            type: 'string',
            minLength: 1,
            maxLength: 2048,
            description:
              'Free-text information need; orders results by relevance.',
          },
          kinds: {
            type: 'array',
            items: {
              type: 'string',
              enum: [...OMNI_MEMORY_RECALL_KINDS],
            },
            // An empty list would read as "restrict to nothing" and return a
            // silent miss; omit the key instead to mean "all kinds".
            minItems: 1,
            uniqueItems: true,
            description:
              'Restrict to entry kinds (default: all configured kinds).',
          },
          roles: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 128 },
            minItems: 1,
            uniqueItems: true,
            description:
              'Restrict to artifact roles (e.g. "transcript", "keyframe").',
          },
          includeHistoricalVersions: {
            type: 'boolean',
            description:
              'Also consult superseded file versions (default: only the ' +
              'current version).',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            description:
              'Maximum entries to return (capped by session config).',
          },
        },
        required: ['resourceIds', 'query'],
        additionalProperties: false,
      },
      false, // isOutputMarkdown — structured JSON payload
      false, // canUpdateOutput
      true, // shouldDefer — recall is an occasional lookup (matches web_fetch)
      false, // alwaysLoad
      'recall media memory transcript keyframe history resource',
    );
  }

  protected override validateToolParamValues(
    params: OmniRecallMediaMemoryParams,
  ): string | null {
    const maxFiles =
      this.config.getOmniMemoryConfig()?.recall.active.maxFilesPerCall;
    if (maxFiles !== undefined && params.resourceIds.length > maxFiles) {
      return (
        `resourceIds lists ${params.resourceIds.length} handles; at most ` +
        `${maxFiles} may be consulted per call ` +
        `(omni.memory.recall.active.maxFilesPerCall). Split the request.`
      );
    }
    return null;
  }

  protected createInvocation(
    params: OmniRecallMediaMemoryParams,
  ): ToolInvocation<OmniRecallMediaMemoryParams, ToolResult> {
    return new OmniRecallMediaMemoryInvocation(this.config, params);
  }
}
