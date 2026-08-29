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

  it('fails closed before emphasis or indentation can amplify parse cost', () => {
    for (const input of [
      `${'a*'.repeat(10_000)}]`,
      `${' '.repeat(1_025)}- nested\n]`,
    ]) {
      const activePolicy = policy();

      expect(sanitizeMarkdownDocument(input, activePolicy)).toBe(
        '[markdown omitted: complexity limit exceeded]',
      );
      expect(activePolicy.onComplexityLimit).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ['pseudo fence', ['```a`', `${'a*'.repeat(3_000)}]`, '```'].join('\n')],
    ['strikethrough delimiters', `${'a~'.repeat(3_000)}]`],
    ['math delimiters', `${'a$'.repeat(3_000)}]`],
    [
      'comment-wrapped fence',
      ['<!--', '```', '-->', `${'a*'.repeat(3_000)}]`].join('\n'),
    ],
  ])('fails closed for parser/scanner divergence: %s', (_name, input) => {
    const activePolicy = policy();

    expect(sanitizeMarkdownDocument(input, activePolicy)).toBe(
      '[markdown omitted: complexity limit exceeded]',
    );
    expect(activePolicy.onComplexityLimit).toHaveBeenCalledOnce();
  });

  it('keeps flat bracketed logs above the old raw-marker limit', () => {
    const input = Array.from(
      { length: 342 },
      (_, index) =>
        `[2026-01-01 12:00:${String(index % 60).padStart(2, '0')}] [INFO] [worker-${index}] ok`,
    ).join('\n');
    const activePolicy = policy();

    expect(sanitizeMarkdownDocument(input, activePolicy)).toBe(input);
    expect(activePolicy.onComplexityLimit).not.toHaveBeenCalled();
  });

  it('reports complexity loss from rich-task transformation', () => {
    const onComplexityLimit = vi.fn();
    const input = ['```mermaid', 'graph TD', '```', '['.repeat(513)].join('\n');

    expect(
      transformRichMarkdownTasks(input, () => true, onComplexityLimit),
    ).toBe('[markdown omitted: complexity limit exceeded]');
    expect(onComplexityLimit).toHaveBeenCalledOnce();
  });

  it('writes sanitized links and definitions with round-trip-safe destinations', () => {
    const queryStrippingPolicy = policy();
    queryStrippingPolicy.normalizeUrl = (source: string) => {
      const url = new URL(source);
      url.search = '';
      return url.toString();
    };

    expect(
      sanitizeMarkdownDocument(
        '[docs](<https://example.com/report)v2?q=1>)',
        queryStrippingPolicy,
      ),
    ).toBe('[docs](<https://example.com/report)v2>)');
    expect(
      sanitizeMarkdownDocument(
        ['[docs][ref]', '', '[ref]: <https://example.com/report)v2?q=1>'].join(
          '\n',
        ),
        queryStrippingPolicy,
      ),
    ).toBe(
      ['[docs][ref]', '', '[ref]: <https://example.com/report)v2>'].join('\n'),
    );
  });

  it('demotes legal tilde fences with backticks in the info string', () => {
    const input = ['~~~`javascript', 'alert(1)', '~~~'].join('\n');
    const transformed = transformRichMarkdownTasks(input, () => false);

    expect(transformed).toContain('~~~text');
    expect(countRichMarkdownTasks(transformed)).toBe(0);
  });
});
