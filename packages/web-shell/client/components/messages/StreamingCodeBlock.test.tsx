/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';
import { enqueueSuffix, exceedsStreamingLimit } from './StreamingCodeBlock';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function makeController() {
  const chunks: string[] = [];
  const controller = {
    enqueue: (chunk: string) => chunks.push(chunk),
  } as unknown as ReadableStreamDefaultController<string>;
  return { controller, chunks };
}

describe('enqueueSuffix', () => {
  it('is a no-op when content is unchanged', () => {
    const { controller, chunks } = makeController();
    expect(enqueueSuffix(controller, 'abc', 'abc')).toEqual({
      sent: 'abc',
      diverged: false,
    });
    expect(chunks).toEqual([]);
  });

  it('enqueues only the newly-appended suffix on a prefix-extension', () => {
    const { controller, chunks } = makeController();
    expect(enqueueSuffix(controller, 'abc', 'abcdef')).toEqual({
      sent: 'abcdef',
      diverged: false,
    });
    expect(chunks).toEqual(['def']);
  });

  it('diverges (no enqueue) when content shrinks', () => {
    const { controller, chunks } = makeController();
    expect(enqueueSuffix(controller, 'abcdef', 'abc')).toEqual({
      sent: 'abcdef',
      diverged: true,
    });
    expect(chunks).toEqual([]);
  });

  it('diverges (no enqueue) when content is replaced, not extended', () => {
    const { controller, chunks } = makeController();
    expect(enqueueSuffix(controller, 'abc', 'xyz').diverged).toBe(true);
    expect(chunks).toEqual([]);
  });

  it('diverges when the controller throws (closed/errored stream)', () => {
    const controller = {
      enqueue: () => {
        throw new TypeError('Cannot enqueue into a closed stream');
      },
    } as unknown as ReadableStreamDefaultController<string>;
    expect(enqueueSuffix(controller, 'abc', 'abcdef')).toEqual({
      sent: 'abc',
      diverged: true,
    });
  });
});

describe('exceedsStreamingLimit', () => {
  it('allows normal multi-line code', () => {
    expect(exceedsStreamingLimit('const x = 1;\nconst y = 2;\n')).toBe(false);
  });

  it('bails on a very long single line (minified content)', () => {
    expect(exceedsStreamingLimit('x'.repeat(2_001))).toBe(true);
  });

  it('bails when the whole block is very large', () => {
    const block = ('a'.repeat(80) + '\n').repeat(700); // > 50K total
    expect(block.length).toBeGreaterThan(50_000);
    expect(exceedsStreamingLimit(block)).toBe(true);
  });

  it('measures only the trailing (in-progress) line, not earlier ones', () => {
    expect(exceedsStreamingLimit('x'.repeat(3_000) + '\nshort')).toBe(false);
  });
});

describe('StreamingCodeBlock oversized fallback', () => {
  it('renders plain (no streaming highlight) for an oversized single line', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const longLine = 'a'.repeat(2_500);

    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```json\n' + longLine + '\n```',
          isStreaming: true,
        }),
      );
    });

    expect(container.textContent).toContain(longLine);
    expect(container.querySelector('.shiki-stream')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe('StreamingCodeBlock streaming → settled handoff', () => {
  it('keeps the code content through the isStreaming true→false transition', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const content = '```ts\nconst x: number = 1;\n```';

    await act(async () => {
      root.render(createElement(Markdown, { content, isStreaming: true }));
    });
    expect(container.textContent).toContain('const x: number = 1;');

    // Settle the turn: the CodeBlock is reused (stable `code` element type via
    // context), so the transition must not drop or garble the content.
    await act(async () => {
      root.render(createElement(Markdown, { content, isStreaming: false }));
    });
    expect(container.textContent).toContain('const x: number = 1;');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
