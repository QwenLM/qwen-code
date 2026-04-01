import { describe, it, expect } from 'vitest';
import { markdownToPlainText } from './send.js';

describe('markdownToPlainText', () => {
  it('strips code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(markdownToPlainText(input)).toBe('const x = 1;');
  });

  it('strips inline code', () => {
    expect(markdownToPlainText('use `npm install`')).toBe('use npm install');
  });

  it('strips bold', () => {
    expect(markdownToPlainText('**bold text**')).toBe('bold text');
  });

  it('strips italic', () => {
    expect(markdownToPlainText('*italic text*')).toBe('italic text');
    expect(markdownToPlainText('_italic text_')).toBe('italic text');
  });

  it('strips bold+italic', () => {
    expect(markdownToPlainText('***bold italic***')).toBe('bold italic');
  });

  it('strips strikethrough', () => {
    expect(markdownToPlainText('~~deleted~~')).toBe('deleted');
  });

  it('strips headings', () => {
    expect(markdownToPlainText('# Title\n## Subtitle')).toBe('Title\nSubtitle');
  });

  it('converts links to text (url)', () => {
    expect(markdownToPlainText('[click here](https://example.com)')).toBe(
      'click here (https://example.com)',
    );
  });

  it('converts image syntax (link regex fires before image regex)', () => {
    // In the current implementation, the link regex fires before the image regex,
    // so `![alt](url)` becomes `!alt (url)` rather than `[alt]`
    const result = markdownToPlainText('![alt](https://img.png)');
    expect(result).toBe('!alt (https://img.png)');
  });

  it('strips blockquote markers', () => {
    expect(markdownToPlainText('> quoted text')).toBe('quoted text');
  });

  it('normalizes list markers', () => {
    expect(markdownToPlainText('* item 1\n- item 2')).toBe(
      '- item 1\n- item 2',
    );
  });

  it('collapses triple+ newlines', () => {
    expect(markdownToPlainText('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims result', () => {
    expect(markdownToPlainText('  \n hello \n  ')).toBe('hello');
  });

  it('handles double underscore bold', () => {
    expect(markdownToPlainText('__bold__')).toBe('bold');
  });

  it('handles complex markdown', () => {
    const input = '# Title\n\n**Bold** and *italic* with `code`\n\n> quote';
    const result = markdownToPlainText(input);
    expect(result).toContain('Title');
    expect(result).toContain('Bold');
    expect(result).toContain('italic');
    expect(result).toContain('code');
    expect(result).toContain('quote');
    expect(result).not.toContain('#');
    expect(result).not.toContain('**');
    expect(result).not.toContain('`');
  });
});
