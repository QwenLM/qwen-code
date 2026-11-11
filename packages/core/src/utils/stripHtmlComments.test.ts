/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { stripHtmlComments } from './stripHtmlComments.js';

describe('stripHtmlComments', () => {
  it('returns content unchanged when no comments exist', () => {
    const input = '# Hello\n\nSome text here.';
    const result = stripHtmlComments(input);
    expect(result.content).toBe(input);
    expect(result.stripped).toBe(false);
  });

  it('strips a block-level HTML comment', () => {
    const input = '# Title\n\n<!-- This is an author note -->\n\nContent here.';
    const result = stripHtmlComments(input);
    expect(result.content).not.toContain('<!--');
    expect(result.content).toContain('# Title');
    expect(result.content).toContain('Content here.');
    expect(result.stripped).toBe(true);
  });

  it('strips multi-line block-level HTML comments', () => {
    const input =
      '# Title\n\n<!--\nThis is a\nmulti-line comment\n-->\n\nContent here.';
    const result = stripHtmlComments(input);
    expect(result.content).not.toContain('<!--');
    expect(result.content).not.toContain('multi-line comment');
    expect(result.content).toContain('Content here.');
    expect(result.stripped).toBe(true);
  });

  it('preserves HTML comments inside fenced code blocks', () => {
    const input =
      '# Title\n\n```html\n<!-- This comment should stay -->\n<div>hello</div>\n```\n\nContent.';
    const result = stripHtmlComments(input);
    expect(result.content).toContain('<!-- This comment should stay -->');
    expect(result.content).toContain('<div>hello</div>');
  });

  it('preserves HTML comments inside inline code', () => {
    const input = 'Use `<!-- comment -->` to add notes.';
    const result = stripHtmlComments(input);
    expect(result.content).toContain('<!-- comment -->');
  });

  it('strips multiple block-level comments', () => {
    const input =
      '<!-- First comment -->\n\n# Title\n\n<!-- Second comment -->\n\nContent.';
    const result = stripHtmlComments(input);
    expect(result.content).not.toContain('First comment');
    expect(result.content).not.toContain('Second comment');
    expect(result.content).toContain('# Title');
    expect(result.content).toContain('Content.');
    expect(result.stripped).toBe(true);
  });

  it('preserves residual content after comment on same line', () => {
    const input = '<!-- note --> Use bun\n\nContent.';
    const result = stripHtmlComments(input);
    expect(result.content).toContain('Use bun');
    expect(result.content).not.toContain('<!-- note -->');
    expect(result.stripped).toBe(true);
  });

  it('leaves unclosed comments intact', () => {
    const input = '# Title\n\n<!-- This is unclosed\n\nContent.';
    const result = stripHtmlComments(input);
    expect(result.content).toContain('<!-- This is unclosed');
    expect(result.content).toContain('Content.');
  });

  it('handles Chinese content in comments', () => {
    const input =
      '# 标题\n\n<!-- 这是作者注释，不应送入上下文 -->\n\n正文内容。';
    const result = stripHtmlComments(input);
    expect(result.content).not.toContain('这是作者注释');
    expect(result.content).toContain('# 标题');
    expect(result.content).toContain('正文内容。');
    expect(result.stripped).toBe(true);
  });

  it('preserves comments in code blocks while stripping block-level ones', () => {
    const input = [
      '<!-- This should be stripped -->',
      '',
      '# Title',
      '',
      '```',
      '<!-- This should stay -->',
      '```',
      '',
      '<!-- This should also be stripped -->',
      '',
      'Content.',
    ].join('\n');
    const result = stripHtmlComments(input);
    expect(result.content).not.toContain('This should be stripped');
    expect(result.content).not.toContain('This should also be stripped');
    expect(result.content).toContain('<!-- This should stay -->');
    expect(result.content).toContain('Content.');
    expect(result.stripped).toBe(true);
  });
});
