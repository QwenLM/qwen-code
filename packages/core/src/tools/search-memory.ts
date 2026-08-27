/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { logMemorySearch, MemorySearchEvent } from '../telemetry/index.js';
import {
  executeSearchMemory,
  type SearchMemoryToolResult,
  type SearchMemoryToolParams,
} from '../memory/search-memory.js';
import {
  AUTO_MEMORY_TREE_CATEGORIES,
  AUTO_MEMORY_UNCATEGORIZED,
} from '../memory/types.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

class SearchMemoryToolInvocation extends BaseToolInvocation<
  SearchMemoryToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: SearchMemoryToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Search memory (${this.params.mode})`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (this.config.getMemoryRecallMode() !== 'structured') {
      const message =
        'search_memory is unavailable while the legacy memory protocol is active.';
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_DENIED },
      };
    }
    const memoryManager = this.config.getMemoryManager();
    const signature = searchMemoryRequestSignature(this.params);
    const claimed =
      this.params.mode !== 'fetch' &&
      memoryManager.claimSearchMemoryRequestForCurrentTurn(signature);
    if (this.params.mode !== 'fetch' && !claimed) {
      const content = JSON.stringify(
        {
          mode: this.params.mode,
          duplicateRequest: true,
          warning:
            'This identical search_memory request already ran in the current turn. Use the previous result or change the parameters instead of repeating it.',
        },
        null,
        2,
      );
      return { llmContent: content, returnDisplay: content };
    }
    let result: SearchMemoryToolResult;
    try {
      result = await executeSearchMemory(this.params, {
        projectRoot: this.config.getProjectRoot(),
        teamMemoryEnabled: this.config.getTeamMemoryEnabled?.() ?? false,
        trustedProject: this.config.isTrustedFolder?.() ?? false,
        bodyPresentVersions: memoryManager.getBodyPresentVersionsInHistory(),
        bodyCoverage: memoryManager.getBodyCoverageInHistory(),
        exhaustedBodyRefs: memoryManager.getExhaustedBodyRefsForCurrentTurn(),
        onComplete: (observation) => {
          logMemorySearch(
            this.config,
            new MemorySearchEvent({
              mode: observation.mode,
              docs_scanned: observation.docsScanned,
              results_returned: observation.resultsReturned,
              duration_ms: observation.durationMs,
            }),
          );
        },
      });
    } catch (error) {
      if (claimed) {
        memoryManager.releaseSearchMemoryRequestForCurrentTurn(signature);
      }
      throw error;
    }
    const content = JSON.stringify(result, null, 2);
    return {
      llmContent: content,
      returnDisplay: content,
    };
  }
}

function searchMemoryRequestSignature(params: SearchMemoryToolParams): string {
  if (params.mode === 'fetch') {
    return JSON.stringify({
      mode: params.mode,
      refs: params.refs,
      cursor: params.cursor,
    });
  }
  if (params.mode === 'search') {
    return JSON.stringify({
      mode: params.mode,
      keywords: params.keywords,
      scopes: params.scopes,
      categories: params.categories,
      limit: params.limit,
    });
  }
  return JSON.stringify({
    mode: params.mode,
    scopes: params.scopes,
    branches: params.branches?.map((branch) => ({
      category: branch.category,
      cursor: branch.cursor,
    })),
    limitPerBranch: params.limitPerBranch,
  });
}

const SEARCH_MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['fetch', 'search', 'explore'],
      description: 'mode',
    },
    refs: {
      type: 'array',
      description:
        'fetch only: exact opaque refs copied from the tree/results, e.g. project:project/compaction-pipeline.md',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 5,
    },
    cursor: {
      type: 'string',
      description:
        'fetch only: cursor returned for the sole ref; copy the returned continuation',
    },
    keywords: {
      type: 'array',
      description: 'search only: 1-5 terms, phrases, or identifiers',
      items: { type: 'string', maxLength: 64 },
      minItems: 1,
      maxItems: 5,
    },
    scopes: {
      type: 'array',
      description: 'search/explore only: visible memory scopes',
      items: { type: 'string', enum: ['project', 'user', 'team'] },
    },
    categories: {
      type: 'array',
      description: 'search only: category filters',
      items: {
        type: 'string',
        enum: [...AUTO_MEMORY_TREE_CATEGORIES, AUTO_MEMORY_UNCATEGORIZED],
      },
    },
    limit: {
      type: 'integer',
      description: 'search only: result limit',
      minimum: 1,
      maximum: 5,
    },
    branches: {
      type: 'array',
      description: 'explore only: category branches',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: [...AUTO_MEMORY_TREE_CATEGORIES, AUTO_MEMORY_UNCATEGORIZED],
          },
          cursor: {
            type: 'string',
          },
        },
        required: ['category'],
        additionalProperties: false,
      },
    },
    limitPerBranch: {
      type: 'integer',
      description: 'explore only: leaf limit per branch',
      minimum: 1,
      maximum: 20,
    },
  },
  required: ['mode'],
  additionalProperties: false,
} as const;

const SEARCH_MEMORY_DESCRIPTION =
  'Use visible memory metadata when sufficient. Fetch exact refs copied from the memory tree; search terms or phrases when the ref or relevant body section is unknown; explore categories for an overview. Continue a truncated body with fetch using its returned ref and cursor.';

export class SearchMemoryTool extends BaseDeclarativeTool<
  SearchMemoryToolParams,
  ToolResult
> {
  override get maxOutputChars(): number {
    return Number.POSITIVE_INFINITY;
  }

  constructor(private readonly config: Config) {
    super(
      ToolNames.SEARCH_MEMORY,
      ToolDisplayNames.SEARCH_MEMORY,
      SEARCH_MEMORY_DESCRIPTION,
      Kind.Fetch,
      SEARCH_MEMORY_SCHEMA,
      true,
      false,
      false,
      false,
      'memory recall fetch search explore overview category',
    );
  }

  protected override validateToolParamValues(
    params: SearchMemoryToolParams,
  ): string | null {
    if (params.mode === 'fetch') {
      if (!Array.isArray(params.refs) || params.refs.length === 0) {
        return 'fetch requires refs.';
      }
      if (params.cursor && params.refs.length !== 1) {
        return 'fetch cursor requires exactly one ref.';
      }
      if (
        'query' in params ||
        'keywords' in params ||
        'categories' in params ||
        'limit' in params ||
        'branches' in params ||
        'limitPerBranch' in params
      ) {
        return 'fetch only accepts refs and optional cursor.';
      }
      return null;
    }
    if (params.mode === 'search') {
      if (!Array.isArray(params.keywords) || params.keywords.length === 0) {
        return 'search requires keywords.';
      }
      if (
        'query' in params ||
        'refs' in params ||
        'cursor' in params ||
        'branches' in params ||
        'limitPerBranch' in params
      ) {
        return 'search accepts keywords, scopes, categories, and limit.';
      }
      return null;
    }
    if (params.mode === 'explore') {
      if (
        'refs' in params ||
        'cursor' in params ||
        'query' in params ||
        'keywords' in params ||
        'categories' in params ||
        'limit' in params
      ) {
        return 'explore accepts scopes, branches, and limitPerBranch.';
      }
      return null;
    }
    return 'Invalid search_memory mode.';
  }

  protected createInvocation(
    params: SearchMemoryToolParams,
  ): ToolInvocation<SearchMemoryToolParams, ToolResult> {
    return new SearchMemoryToolInvocation(this.config, params);
  }
}
