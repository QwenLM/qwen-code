/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { getErrorMessage } from '../utils/errors.js';
import type { RetrievalService } from '../indexing/retrievalService.js';
import { ToolErrorType } from './tool-error.js';

// --- Interfaces ---

/**
 * Parameters for the CodebaseSearchTool.
 */
export interface CodebaseSearchToolParams {
  /**
   * Pre-enhanced BM25 keyword queries for full-text search.
   * Each query should contain space-separated identifiers and keywords
   * (camelCase, snake_case, PascalCase) relevant to the search intent.
   */
  bm25Queries: string[];

  /**
   * Pre-enhanced vector/semantic queries for embedding-based search.
   * Should include hypothetical code snippets (HyDE) and/or semantic
   * descriptions of the desired functionality.
   */
  vectorQueries: string[];

  /**
   * Number of results to return. Defaults to 10.
   */
  topK?: number;

  /**
   * Whether the query is related to test code (unit tests, integration tests,
   * test fixtures, mocks, etc.). When true, the test-file penalty is skipped
   * so that test files rank normally in the results.
   */
  isTestRelated?: boolean;
}

// --- Constants ---

const MAX_TOP_K = 30;
const DEFAULT_TOP_K = 10;

const TOOL_DESCRIPTION = `The PRIMARY search tool for exploring and understanding the codebase. Uses intelligent hybrid search (BM25 + vector/semantic) with reranking and graph expansion to find relevant code.

ALWAYS prefer this tool over grep_search when:
- Understanding how a feature, module, or system is implemented
- Finding code related to a concept, pattern, or functionality
- Exploring unfamiliar areas of the codebase
- Looking for usage patterns, architectural decisions, or design patterns
- You can describe what you want but don't know exact identifiers
- Starting a new task and need to understand the relevant code landscape

Only use grep_search instead when you need an exact string/regex match (e.g., a specific error message, a known variable name).

## Parameters

### bm25Queries (required)
2-5 keyword queries (space-separated tokens each). Include:
- Likely identifiers: function/class/variable names in camelCase, snake_case, PascalCase
- Sub-queries breaking down different aspects of your search
- One abstract/general query for the high-level concept
Example: ["handleUserAuth middleware express", "JWT token verify", "auth middleware pattern"]

### vectorQueries (required)
1-3 semantic queries. The first should ideally be a hypothetical code snippet (5-15 lines) resembling what you expect to find; the rest are natural language descriptions.
Example: ["async function verifyToken(token: string) {\\n  const decoded = jwt.verify(token, secret);\\n  return decoded;\\n}", "middleware that validates authentication tokens before processing requests"]

### topK (optional)
Number of results (default 10, max 30).

### isTestRelated (optional)
Set true when searching for test code to avoid penalizing test files.
`;

const PARAMETER_SCHEMA = {
  type: 'object',
  properties: {
    bm25Queries: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Pre-enhanced BM25 keyword queries. Each should contain space-separated ' +
        'identifiers and keywords (camelCase, snake_case) relevant to the search intent.',
    },
    vectorQueries: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Pre-enhanced vector/semantic queries. Include hypothetical code snippets ' +
        '(5-10 lines) and/or semantic descriptions of the desired functionality.',
    },
    topK: {
      type: 'number',
      description: `Number of results to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}).`,
    },
    isTestRelated: {
      type: 'boolean',
      description:
        'Set to true when the query is about test code (unit tests, integration tests, ' +
        'test utilities, mocks, fixtures). Prevents test files from being penalized in results.',
    },
  },
  required: ['bm25Queries', 'vectorQueries'],
} as const;

// --- Invocation ---

/**
 * Provider function that returns a {@link RetrievalService} instance.
 * Returns `null` when the index is not ready (should not happen because the
 * tool is only registered after the index is built).
 */
export type RetrievalServiceProvider = () => Promise<RetrievalService | null>;

class CodebaseSearchInvocation extends BaseToolInvocation<
  CodebaseSearchToolParams,
  ToolResult
> {
  constructor(
    private readonly getRetrievalService: RetrievalServiceProvider,
    params: CodebaseSearchToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    const bm25Summary = this.params.bm25Queries.map((q) => `'${q}'`).join(', ');
    const vectorSummary = this.params.vectorQueries
      .map((q) => `'${q.slice(0, 60)}${q.length > 60 ? '...' : ''}'`)
      .join(', ');
    return `bm25=[${bm25Summary}] vector=[${vectorSummary}] topK=${this.params.topK ?? DEFAULT_TOP_K}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    // Abort-early check.
    if (signal.aborted) {
      return {
        llmContent: 'Search was cancelled.',
        returnDisplay: 'Cancelled',
      };
    }

    try {
      const service = await this.getRetrievalService();
      if (!service) {
        return {
          llmContent:
            'Error: Codebase index is not available. ' +
            'The index may still be building or was not initialized.',
          returnDisplay: 'Index not available',
          error: {
            message: 'Codebase index is not available',
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }

      const topK = Math.min(
        Math.max(this.params.topK ?? DEFAULT_TOP_K, 1),
        MAX_TOP_K,
      );

      // Build a composite query for the reranker from BM25 keywords.
      const rerankQuery = this.params.bm25Queries.join(' ');

      const response = await service.retrieveWithEnhancedQueries(
        rerankQuery,
        this.params.bm25Queries,
        this.params.vectorQueries,
        { topK, isTestRelated: this.params.isTestRelated ?? false },
      );

      if (response.chunks.length === 0) {
        return {
          llmContent: 'No results found for the given queries.',
          returnDisplay: 'No results found',
        };
      }

      // Use the pre-built text view from the retrieval pipeline.
      const resultCount = response.chunks.length;
      const resultTerm = resultCount === 1 ? 'result' : 'results';

      return {
        llmContent: response.textView,
        returnDisplay: `Found ${resultCount} ${resultTerm}`,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error(`Error during codebase search: ${error}`);
      return {
        llmContent: `Error during codebase search: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

// --- Tool ---

/**
 * Semantic code search tool that leverages the codebase index for hybrid
 * BM25 + vector retrieval with reranking and graph expansion.
 *
 * This tool should only be registered when the codebase index is built and
 * ready. Registration is managed by {@link Config} which listens to the
 * IndexService `build_complete` event.
 */
export class CodebaseSearchTool extends BaseDeclarativeTool<
  CodebaseSearchToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.CODEBASE_SEARCH;

  constructor(private readonly getRetrievalService: RetrievalServiceProvider) {
    super(
      CodebaseSearchTool.Name,
      ToolDisplayNames.CODEBASE_SEARCH,
      TOOL_DESCRIPTION,
      Kind.Search,
      PARAMETER_SCHEMA,
    );
  }

  protected override validateToolParamValues(
    params: CodebaseSearchToolParams,
  ): string | null {
    if (!params.bm25Queries || params.bm25Queries.length === 0) {
      return 'bm25Queries must be a non-empty array of strings.';
    }
    if (!params.vectorQueries || params.vectorQueries.length === 0) {
      return 'vectorQueries must be a non-empty array of strings.';
    }
    if (
      params.topK !== undefined &&
      (typeof params.topK !== 'number' || params.topK < 1)
    ) {
      return `topK must be a positive number (got ${params.topK}).`;
    }
    return null;
  }

  protected createInvocation(
    params: CodebaseSearchToolParams,
  ): ToolInvocation<CodebaseSearchToolParams, ToolResult> {
    return new CodebaseSearchInvocation(this.getRetrievalService, params);
  }
}
