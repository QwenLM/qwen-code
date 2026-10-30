// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BtwMessage } from './BtwMessage';

vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./Markdown', () => ({
  Markdown: ({ content }: { content: string }) => <span>{content}</span>,
}));

it.each(['', 'Partial answer'])(
  'shows pending hints with answer snapshot %j',
  (answer) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <BtwMessage question="Question" answer={answer} isPending />,
        ),
      );
      if (answer) expect(container.textContent).toContain(answer);
      expect(container.textContent).toContain('btw.shortcuts.pending');
      expect(container.textContent?.includes('btw.answering')).toBe(!answer);
    } finally {
      act(() => root.unmount());
    }
  },
);

it('follows answer growth, pauses when scrolled up, and resumes at the bottom', () => {
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (answer: string) =>
    act(() =>
      root.render(<BtwMessage question="Question" answer={answer} isPending />),
    );
  try {
    render('');
    const viewport = container.querySelector<HTMLElement>(
      '[data-web-shell-btw-content]',
    )!;
    let height = 200;
    let top = 0;
    Object.defineProperties(viewport, {
      clientHeight: { get: () => 80 },
      scrollHeight: { get: () => height },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.min(Math.max(0, value), height - 80);
        },
      },
    });
    render('First chunk');
    expect(top).toBe(120);
    act(() => {
      viewport.scrollTop = 40;
      viewport.dispatchEvent(new Event('scroll'));
    });
    height = 300;
    render('First chunk, more content');
    expect(top).toBe(40);
    act(() => resize());
    expect(top).toBe(40);
    act(() => {
      viewport.scrollTop = 220;
      viewport.dispatchEvent(new Event('scroll'));
    });
    height = 400;
    render('First chunk, more content, newest content');
    expect(top).toBe(320);
    height = 450;
    act(() => resize());
    expect(top).toBe(370);
    act(() => {
      viewport.scrollTop = 367;
      viewport.dispatchEvent(new Event('scroll'));
    });
    height = 500;
    act(() => resize());
    expect(top).toBe(367);
    act(() => {
      viewport.scrollTop = 418;
      viewport.dispatchEvent(new Event('scroll'));
    });
    height = 550;
    act(() => resize());
    expect(top).toBe(470);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
  expect(disconnect).toHaveBeenCalledOnce();
});
