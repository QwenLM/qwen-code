/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from '../tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from '../tools.js';
import { ToolNames, ToolDisplayNames } from '../tool-names.js';
import type { Config } from '../../config/config.js';
import { getMediaMemory } from '../../memory/media/media-memory-store.js';
import { recallMedia } from '../../memory/media/media-recall.js';

export interface MediaGrepParams {
  query: string;
  context_files?: string[];
}

class MediaGrepInvocation extends BaseToolInvocation<
  MediaGrepParams,
  ToolResult
> {
  constructor(params: MediaGrepParams) {
    super(params);
  }

  getDescription(): string {
    return `media memory: "${this.params.query}"`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const hits = await recallMedia(getMediaMemory(), this.params.query, {
      contextFiles: this.params.context_files,
    });
    if (hits.length === 0) {
      return {
        llmContent:
          'No matching media understandings in memory. Read the file directly with image_view / media_watch to build one.',
        returnDisplay: 'No media memory hits.',
      };
    }
    const lines = hits.map((h) => {
      const r = h.record;
      return `- [${r.modality}] ${r.summary} (hash ${r.hash.slice(0, 12)}, ${r.path})`;
    });
    return {
      llmContent:
        'Media understandings recalled from memory (a low-cost hint; the original file remains the source of truth — re-read for full fidelity):\n' +
        lines.join('\n'),
      returnDisplay: `${hits.length} media memory hit(s).`,
    };
  }
}

/**
 * P2 · `media_grep` — search the cross-session media memory. This is the fast
 * path: a hit returns a cheap recalled understanding without re-reading bytes.
 */
export class MediaGrepTool extends BaseDeclarativeTool<
  MediaGrepParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.MEDIA_GREP;

  constructor(_config: Config) {
    super(
      MediaGrepTool.Name,
      ToolDisplayNames.MEDIA_GREP,
      'Search cross-session memory of previously-understood media files. Returns recalled summaries (a low-cost hint); re-read the original for full fidelity.',
      Kind.Search,
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to look for across understood media files.',
          },
          context_files: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional file paths currently in play, to prioritize their understandings.',
          },
        },
        required: ['query'],
      },
    );
  }

  protected override validateToolParamValues(
    params: MediaGrepParams,
  ): string | null {
    if (!params.query?.trim()) {
      return "The 'query' parameter must be non-empty.";
    }
    return null;
  }

  protected createInvocation(
    params: MediaGrepParams,
  ): ToolInvocation<MediaGrepParams, ToolResult> {
    return new MediaGrepInvocation(params);
  }
}
