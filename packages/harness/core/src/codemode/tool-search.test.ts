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

  it('puts an exact name first within the namespace even for identical tokens', () => {
    const target = 'mcp__docs__search_notes';
    const index = new ToolSearchIndex([
      { name: 'mcp__docs__notes_search', namespace: 'docs', description: target },
      { name: target, namespace: 'docs', description: 'Find a note. '.repeat(100) },
      { name: 'mcp__work__search_notes', namespace: 'work' },
    ]);
    expect(index.search(target, { namespace: 'docs', limit: 1 })[0].name).toBe(target);
    expect(names(index.search(target, { namespace: 'work' }))).toEqual(['mcp__work__search_notes']);
  });

  it('ranks tool names and purpose above parameter and shared service text', () => {
    const namespace = 'docs';
    const index = new ToolSearchIndex(
      [
        { name: 'mcp__docs__list_documents', namespace },
        { name: 'mcp__docs__filter_documents', namespace, definition: {
          description: 'Filter documents.', inputSchema: { properties: { search: {} } },
        } },
        { name: 'mcp__docs__find_documents', namespace, description: 'Search documents.' },
        { name: 'mcp__docs__search_documents', namespace },
      ],
      [{ name: namespace, instructions: 'Search documents. '.repeat(80) }],
    );
    expect(names(index.search('search', { namespace }))).toEqual([
      'mcp__docs__search_documents', 'mcp__docs__find_documents',
      'mcp__docs__filter_documents', 'mcp__docs__list_documents',
    ]);
  });

  it('resolves namespaces from indexed tools even when they have no searchable terms', () => {
    const tool = { name: 'the', namespace: 'and' };
    const index = new ToolSearchIndex([tool]);
    expect(index.search('', { namespace: 'mcp__AND' })).toEqual([tool]);
    expect(index.search('', { namespace: 'missing' })).toEqual([]);
  });

  it('prefers exact namespaces and rejects ambiguous aliases', () => {
    const hyphen = { name: 'first', namespace: 'my-docs' };
    const underscore = { name: 'second', namespace: 'my_docs' };
    const index = new ToolSearchIndex([hyphen, underscore]);
    expect(index.search('', { namespace: 'my-docs' })).toEqual([hyphen]);
    expect(index.search('', { namespace: 'mcp__my_docs' })).toEqual([underscore]);
    expect(index.search('', { namespace: 'MY_DOCS' })).toEqual([]);
  });

  it('can disable browsing for tokenless queries while preserving exact matches', () => {
    const tools = [{ name: 'Read' }, { name: 'a' }];
    const index = new ToolSearchIndex(tools);
    for (const query of ['', 'the', '!!!']) {
      expect(index.search(query)).toEqual(tools);
      expect(index.search(query, { browseOnEmptyTerms: true })).toEqual(tools);
      expect(index.search(query, { browseOnEmptyTerms: false })).toEqual([]);
    }
    expect(index.search('a', { browseOnEmptyTerms: false })).toEqual([tools[1]]);
    expect(index.search('a', { browseOnEmptyTerms: false, limit: 0 })).toEqual([]);
  });

  it('matches tools by their input parameters', () => {
    const index = new ToolSearchIndex([
      {
        name: 'Fetch',
        definition: {
          description: 'Fetch a page',
          inputSchema: { properties: { url: {} } },
        },
      },
      {
        name: 'Read',
        definition: {
          description: 'Read a file',
          inputSchema: { properties: { file_path: {} } },
        },
      },
    ]);
    expect(names(index.search('url'))).toEqual(['Fetch']);
  });
});
