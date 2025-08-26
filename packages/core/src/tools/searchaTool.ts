/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTool, Kind, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';
import { execSync } from 'node:child_process';

/**
 * Parameters for the SearchaTool.
 */
export interface SearchaToolParams {
  /**
   * The search query.
   */
  query: string;
}

/**
 * Extends ToolResult to include sources for searcha results.
 */
export interface SearchaToolResult extends ToolResult {
  sources?: Array<{ title: string; url: string; description: string }>;
}

/**
 * A tool to perform web searches using the searcha command.
 */
export class SearchaTool extends BaseTool<
  SearchaToolParams,
  SearchaToolResult
> {
  static readonly Name: string = 'searcha';

  constructor() {
    super(
      SearchaTool.Name,
      'SearchaWebSearch',
      'Performs web searches using the searcha command-line tool. Returns structured JSON results with titles, URLs, and descriptions.',
      Kind.Search,
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find information on the web.',
          },
        },
        required: ['query'],
      },
    );
  }

  /**
   * Validates the parameters for the SearchaTool.
   * @param params The parameters to validate
   * @returns An error message string if validation fails, null if valid
   */
  validateParams(params: SearchaToolParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params,
    );
    if (errors) {
      return errors;
    }

    if (!params.query || params.query.trim() === '') {
      return "The 'query' parameter cannot be empty.";
    }
    return null;
  }

  override getDescription(params: SearchaToolParams): string {
    return `Searching the web with searcha for: "${params.query}"`;
  }

  async execute(
    params: SearchaToolParams,
    _signal: AbortSignal,
  ): Promise<SearchaToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    try {
      // Execute searcha command with the query
      const command = `searcha "${params.query.replace(/"/g, '\\"')}"`;
      const stdout = execSync(command, { 
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 1024 * 1024 // 1MB buffer
      });

      // Parse JSON output from searcha
      let searchResults;
      try {
        searchResults = JSON.parse(stdout);
      } catch (parseError) {
        // If JSON parsing fails, return the raw output
        return {
          llmContent: `Search results for "${params.query}":\n\n${stdout}`,
          returnDisplay: `Search completed for "${params.query}".`,
        };
      }

      // Extract sources from the structured results
      const sources = Array.isArray(searchResults) 
        ? searchResults.map((result: any) => ({
            title: result.title || 'Untitled',
            url: result.url || result.link || '',
            description: result.description || result.snippet || ''
          }))
        : [];

      // Format the content for display
      let content = '';
      if (sources.length > 0) {
        content = sources.map((source, i) => 
          `${i + 1}. **${source.title}**\n   ${source.description}\n   ${source.url}`
        ).join('\n\n');
      } else {
        content = `No structured results found for "${params.query}".\n\nRaw output:\n${stdout}`;
      }

      return {
        llmContent: `Web search results for "${params.query}":\n\n${content}`,
        returnDisplay: `Search completed for "${params.query}" - ${sources.length} results found.`,
        sources,
      };
    } catch (error: unknown) {
      const errorMessage = `Error during searcha execution for query "${params.query}": ${getErrorMessage(error)}`;
      console.error(errorMessage, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error performing searcha search.`,
      };
    }
  }
}