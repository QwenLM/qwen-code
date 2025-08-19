/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTool, Icon, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';
import { Config } from '../config/config.js';

interface TavilyResultItem {
  title: string;
  url: string;
  content?: string;
  score?: number;
  published_date?: string;
}

interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilyResultItem[];
}

/**
 * Parameters for the WebSearchTool.
 */
export interface WebSearchToolParams {
  /**
   * The search query.
   */
  query: string;
}

/**
 * Extends ToolResult to include sources for web search.
 */
export interface WebSearchToolResult extends ToolResult {
  sources?: Array<{ title: string; url: string }>;
}

/**
 * A tool to perform web searches using Tavily API.
 */
export class WebSearchTool extends BaseTool<
  WebSearchToolParams,
  WebSearchToolResult
> {
  static readonly Name: string = 'web_search';

  constructor(private readonly config: Config) {
    super(
      WebSearchTool.Name,
      'TavilySearch',
      'Performs a web search using the Tavily API and returns a concise answer with sources. Requires the TAVILY_API_KEY environment variable.',
      Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'The search query to find information on the web.',
          },
        },
        required: ['query'],
      },
    );
  }

  /**
   * Validates the parameters for the WebSearchTool.
   * @param params The parameters to validate
   * @returns An error message string if validation fails, null if valid
   */
  validateParams(params: WebSearchToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    if (!params.query || params.query.trim() === '') {
      return "The 'query' parameter cannot be empty.";
    }
    return null;
  }

  getDescription(params: WebSearchToolParams): string {
    return `Searching the web for: "${params.query}"`;
  }

  async execute(
    params: WebSearchToolParams,
    _signal: AbortSignal,
  ): Promise<WebSearchToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    const apiKey = this.config.getTavilyApiKey() || process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return {
        llmContent:
          'Web search is disabled because TAVILY_API_KEY is not configured. Please set it in your settings.json, .env file, or via --tavily-api-key command line argument to enable web search.',
        returnDisplay:
          'Web search disabled. Configure TAVILY_API_KEY to enable Tavily search.',
      };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: apiKey,
          query: params.query,
          search_depth: 'advanced',
          max_results: 5,
          include_answer: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Tavily API error: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`,
        );
      }

      const data = (await response.json()) as TavilySearchResponse;

      const sources = (data.results || []).map((r) => ({
        title: r.title,
        url: r.url,
      }));

      const sourceListFormatted = sources.map(
        (s, i) => `[${i + 1}] ${s.title || 'Untitled'} (${s.url})`,
      );

      let content = data.answer?.trim() || '';
      if (!content) {
        // Fallback: build a concise summary from top results
        content = sources
          .slice(0, 3)
          .map((s, i) => `${i + 1}. ${s.title} - ${s.url}`)
          .join('\n');
      }

      if (sourceListFormatted.length > 0) {
        content += `\n\nSources:\n${sourceListFormatted.join('\n')}`;
      }

      if (!content.trim()) {
        return {
          llmContent: `No search results or information found for query: "${params.query}"`,
          returnDisplay: 'No information found.',
        };
      }

      return {
        llmContent: `Web search results for "${params.query}":\n\n${content}`,
        returnDisplay: `Search results for "${params.query}" returned.`,
        sources,
      };
    } catch (error: unknown) {
      const errorMessage = `Error during web search for query "${params.query}": ${getErrorMessage(
        error,
      )}`;
      console.error(errorMessage, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error performing web search.`,
      };
    }
  }
}
