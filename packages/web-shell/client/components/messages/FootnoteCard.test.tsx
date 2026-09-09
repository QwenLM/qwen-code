// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import { WebShellCustomizationProvider } from '../../customization';
import { Markdown } from './Markdown';

const triggerSelector = '[data-web-shell-footnote-trigger]';
const cardSelector = '[data-web-shell-footnote-card]';
const definitions = `

[^a]: [**Tourism office**](https://tourism.example/event) Concert details. ![Poster](https://images.example/poster.png)
[^b]: [Ticket website](https://tickets.example/show) Ticket information.
[^plain]: A **plain note** with no link.
`;
let root: Root;
let container: HTMLDivElement;

function render(children: ReactNode) {
  if (!container) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root.render(<I18nProvider language="en">{children}</I18nProvider>));
  return container;
}

function click(element: Element | null) {
  expect(element).not.toBeNull();
  act(() => (element as HTMLElement).click());
}

function card() {
  return document.querySelector(cardSelector)!;
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  container = undefined!;
  vi.restoreAllMocks();
});

describe('Markdown footnote cards', () => {
  it('groups adjacent references in order, deduplicates IDs, and stops at text', () => {
    render(
      <Markdown
        content={`Sources[^a][^b] [^a][^plain]. Separate[^b], text[^a].${definitions}`}
      />,
    );
    const triggers = container.querySelectorAll(triggerSelector);
    expect([...triggers].map((node) => node.textContent)).toEqual([
      '3',
      '1',
      '1',
    ]);
    expect(container.querySelectorAll('[data-footnotes] li')).toHaveLength(3);
    click(triggers[0]);
    expect(card().textContent).toContain('tourism.example');
    expect(card().textContent).toContain('Tourism office');
    expect(card().textContent).toContain('Concert details.');
    expect(card().textContent).toContain('1 / 3');
    expect(card().querySelector('img')?.getAttribute('src')).toBe(
      'https://images.example/poster.png',
    );
    expect(
      card().querySelector('[aria-label="Previous reference"]'),
    ).toHaveProperty('disabled', true);
    click(card().querySelector('[aria-label="Next reference"]'));
    expect(card().textContent).toContain('Ticket website');
    expect(card().querySelector('img')).toBeNull();
    click(card().querySelector('[aria-label="Next reference"]'));
    expect(card().textContent).toContain('Footnote 3');
    expect(card().textContent).toContain('A plain note with no link.');
    expect(card().querySelector('a')).toBeNull();
    expect(
      card().querySelector('[aria-label="Next reference"]'),
    ).toHaveProperty('disabled', true);
  });

  it('does not merge across paragraphs, cells, or inline code', () => {
    render(
      <Markdown
        content={`First[^a].\n\nSecond[^b]\n\n| A | B |\n|---|---|\n| Cell[^a] | Cell[^b] |\n\nCode \`[^a][^b]\` and [^unknown].${definitions}`}
      />,
    );
    expect(container.querySelectorAll(triggerSelector)).toHaveLength(4);
    expect(container.querySelector('code')?.textContent).toBe('[^a][^b]');
    expect(container.textContent).toContain('[^unknown]');
  });

  it('retains incomplete references and resolves them when definitions arrive', () => {
    render(<Markdown content="Sources[^a][^b]" isStreaming />);
    expect(container.textContent).toContain('[^a][^b]');
    expect(container.querySelector(triggerSelector)).toBeNull();
    render(<Markdown content={`Sources[^a][^b]${definitions}`} />);
    expect(container.querySelector(triggerSelector)?.textContent).toBe('2');
  });

  it('keeps the selected source as streamed content grows and falls back when removed', () => {
    render(<Markdown content={`Sources[^a][^b]${definitions}`} />);
    click(container.querySelector(triggerSelector));
    click(card().querySelector('[aria-label="Next reference"]'));
    render(<Markdown content={`Sources[^a][^b][^plain]${definitions}`} />);
    expect(card().textContent).toContain('Ticket website');
    expect(card().textContent).toContain('2 / 3');
    render(<Markdown content={`Sources[^a][^plain]${definitions}`} />);
    expect(card().textContent).toContain('Tourism office');
    expect(card().textContent).toContain('1 / 2');
  });

  it('gives repeated references and separate documents valid isolated return targets', () => {
    const text = `Sources[^a][^b] [^a]. Again[^b].${definitions}`;
    render(
      <>
        <Markdown content={text} />
        <Markdown content={text} />
      </>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    const docs = [...container.children];
    for (const doc of docs) {
      for (const link of doc.querySelectorAll<HTMLAnchorElement>(
        '[data-footnote-backref]',
      )) {
        const target = document.getElementById(
          link.getAttribute('href')!.slice(1),
        );
        expect(target?.matches(triggerSelector)).toBe(true);
        expect(doc.contains(target)).toBe(true);
        click(link);
        expect(document.activeElement).toBe(target);
      }
    }
  });

  it('keeps standard navigable references in static exports', () => {
    render(
      <TranscriptRenderModeProvider value="document">
        <Markdown content={`Sources[^a][^b]${definitions}`} />
      </TranscriptRenderModeProvider>,
    );
    expect(container.querySelector(triggerSelector)).toBeNull();
    const reference = container.querySelector<HTMLAnchorElement>('sup a')!;
    expect(reference.id).not.toBe('');
    expect(reference.getAttribute('target')).toBeNull();
    click(reference);
    expect(document.activeElement?.id).toBe(
      reference.getAttribute('href')?.slice(1),
    );
    click(container.querySelector('[data-footnote-backref]'));
    expect(document.activeElement).toBe(reference);
  });

  it('preserves custom superscript overrides and original reference children', () => {
    render(
      <WebShellCustomizationProvider
        value={{
          markdown: {
            components: {
              sup: ({ children }) => <sup data-custom-sup="">{children}</sup>,
            },
          },
        }}
      >
        <Markdown
          source="assistant"
          content={`Sources[^a][^b]${definitions}`}
        />
      </WebShellCustomizationProvider>,
    );
    expect(container.querySelector(triggerSelector)).toBeNull();
    expect(container.querySelectorAll('[data-custom-sup]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-footnote-ref]')).toHaveLength(2);
  });

  it('filters unsafe URLs before previews and hides failed thumbnails', () => {
    render(
      <Markdown
        content={
          'Source[^a].\n\n[^a]: [Unsafe](javascript:alert%281%29) ![Bad](data:image/svg+xml;base64,PHN2Zz4=) [Safe](https://safe.example) ![Good](https://safe.example/image.png)'
        }
      />,
    );
    click(container.querySelector(triggerSelector));
    expect(card().querySelector('a')?.getAttribute('href')).toBe(
      'https://safe.example',
    );
    expect(card().querySelectorAll('img')).toHaveLength(1);
    act(() => card().querySelector('img')!.dispatchEvent(new Event('error')));
    expect(card().querySelector('img')).toBeNull();
    expect(card().querySelector('[aria-label="Next reference"]')).toBeNull();
  });

  it('preserves original reference text in advanced table copy', async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue();
    render(
      <Markdown
        tableMode="advanced"
        content={`| Conclusion |\n| --- |\n| Result[^a] [^b][^a] |${definitions}`}
      />,
    );
    expect(container.querySelector(`td ${triggerSelector}`)?.textContent).toBe(
      '2',
    );
    const copy = [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === 'Copy table',
    );
    click(copy!);
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Result1 21'),
    );
  });

  it('uses Chinese labels when the shell language is Chinese', () => {
    render(
      <I18nProvider language="zh-CN">
        <Markdown content={`Sources[^a][^plain]${definitions}`} />
      </I18nProvider>,
    );
    expect(
      container.querySelector(triggerSelector)?.getAttribute('aria-label'),
    ).toBe('查看 2 条引用');
    click(container.querySelector(triggerSelector));
    click(card().querySelector('[aria-label="下一条引用"]'));
    expect(card().textContent).toContain('脚注 2');
  });
});
