import { describe, expect, it, vi } from 'vitest';
import {
  countRichMarkdownTasks,
  sanitizeMarkdownDocument,
  transformRichMarkdownTasks,
} from './markdown-document-policy.js';

const policy = () => ({
  normalizeUrl: (source: string) =>
    source.startsWith('https://') ? source : undefined,
  replaceImage: () => '[image omitted]',
  onUrlChange: vi.fn(),
  onComplexityLimit: vi.fn(),
});

describe('markdown document policy', () => {
  it('keeps a shared link definition after replacing its image reference', () => {
    const input = [
      '![image][shared] and [link][shared]',
      '',
      '[shared]: https://example.com/resource',
    ].join('\n');

    expect(sanitizeMarkdownDocument(input, policy())).toBe(
      [
        '[image omitted] and [link][shared]',
        '',
        '[shared]: https://example.com/resource',
      ].join('\n'),
    );
  });

  it('fails closed before deeply nested markdown can exhaust the stack', () => {
    const activePolicy = policy();
    const result = sanitizeMarkdownDocument(
      `${'> '.repeat(6_000)}[link](https://example.com)`,
      activePolicy,
    );

    expect(result).toBe('[markdown omitted: complexity limit exceeded]');
    expect(activePolicy.onComplexityLimit).toHaveBeenCalledOnce();
  });

  it('demotes legal tilde fences with backticks in the info string', () => {
    const input = ['~~~`javascript', 'alert(1)', '~~~'].join('\n');
    const transformed = transformRichMarkdownTasks(input, () => false);

    expect(transformed).toContain('~~~text');
    expect(countRichMarkdownTasks(transformed)).toBe(0);
  });
});
