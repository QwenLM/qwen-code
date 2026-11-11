/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ToolSearchIndex,
  schemaSearchText,
  tokenize,
  toolSearchText,
} from './tool-search.js';

const names = (tools: ReadonlyArray<{ name: string }>) =>
  tools.map((tool) => tool.name);

describe('tool search', () => {
  it('tokenizes camelCase, stems plurals, drops stop words and splits CJK into bigrams', () => {
    expect(tokenize('searchIssues for the Pull Requests')).toEqual([
      'search',
      'issue',
      'pull',
      'request',
    ]);
    expect(tokenize('搜索问题')).toEqual(['搜索', '索问', '问题']);
  });

  it('indexes nested input property names and descriptions', () => {
    expect(
      schemaSearchText({
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'owner/name' },
          filter: {
            type: 'object',
            properties: { label: { description: 'issue label' } },
          },
          tags: { type: 'array', items: { properties: { color: {} } } },
        },
      }),
    ).toBe('repo owner/name filter  label issue label tags  color ');
  });

  it('ranks multi-word queries that a substring filter would miss', () => {
    const index = new ToolSearchIndex(
      [
        { name: 'mcp__github__create_issue', description: 'Open a new ticket', namespace: 'github' },
        { name: 'mcp__github__get_file', description: 'Read repository contents', namespace: 'github' },
        { name: 'mcp__docs__search', description: 'Search pages', namespace: 'docs' },
      ],
      [{ name: 'github', description: 'GitHub issues and pull requests' }],
    );
    expect(names(index.search('github issue', { limit: 1 }))).toEqual([
      'mcp__github__create_issue',
    ]);
    expect(names(index.search('search', { namespace: 'mcp__docs' }))).toEqual([
      'mcp__docs__search',
    ]);
    expect(names(index.search('', { limit: 2 }))).toHaveLength(2);
    expect(index.search('zzz')).toEqual([]);
  });

  it('matches tools by their input parameters', () => {
    const index = new ToolSearchIndex([
      { name: 'Fetch', searchText: toolSearchText('Fetch', 'Fetch a page', { properties: { url: {} } }) },
      { name: 'Read', searchText: toolSearchText('Read', 'Read a file', { properties: { file_path: {} } }) },
    ]);
    expect(names(index.search('url'))).toEqual(['Fetch']);
  });
});
