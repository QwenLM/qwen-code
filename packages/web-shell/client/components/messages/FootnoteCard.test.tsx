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

[^source-a]: [**Tourism office**](https://tourism.example/event) Concert details. ![Poster](https://images.example/poster.png)
[^source-b]: [Ticket website](https://tickets.example/show) Ticket information.
[^source-plain]: **Plain source** A plain note with no link.
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
        content={`Sources[^source-a][^source-b] [^source-a][^source-plain]. Separate[^source-b], text[^source-a].${definitions}`}
      />,
    );
    const triggers = container.querySelectorAll(triggerSelector);
    expect([...triggers].map((node) => node.textContent)).toEqual([
      '3',
      '',
      '',
    ]);
    expect(container.querySelector('[data-footnotes]')).toBeNull();
    expect(
      container.querySelector('[data-web-shell-footnote-sources]')?.textContent,
    ).toBe('3 sources');
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
    expect(card().textContent).toContain('Plain source');
    expect(card().textContent).toContain('A plain note with no link.');
    expect(card().querySelector('a')).toBeNull();
    expect(
      card().querySelector('[aria-label="Next reference"]'),
    ).toHaveProperty('disabled', true);
  });

  it('does not merge across paragraphs, cells, or inline code', () => {
    render(
      <Markdown
        content={`First[^source-a].\n\nSecond[^source-b]\n\n| A | B |\n|---|---|\n| Cell[^source-a] | Cell[^source-b] |\n\nCode \`[^source-a][^source-b]\` and [^unknown].${definitions}`}
      />,
    );
    expect(container.querySelectorAll(triggerSelector)).toHaveLength(4);
    expect(container.querySelector('code')?.textContent).toBe(
      '[^source-a][^source-b]',
    );
    expect(container.textContent).toContain('[^unknown]');
  });

  it('retains incomplete references and resolves them when definitions arrive', () => {
    render(<Markdown content="Sources[^source-a][^source-b]" isStreaming />);
    expect(container.textContent).toContain('[^source-a][^source-b]');
    expect(container.querySelector(triggerSelector)).toBeNull();
    render(
      <Markdown content={`Sources[^source-a][^source-b]${definitions}`} />,
    );
    expect(container.querySelector(triggerSelector)?.textContent).toBe('2');
  });

  it('keeps the selected source as streamed content grows and falls back when removed', () => {
    render(
      <Markdown content={`Sources[^source-a][^source-b]${definitions}`} />,
    );
    click(container.querySelector(triggerSelector));
    click(card().querySelector('[aria-label="Next reference"]'));
    render(
      <Markdown
        content={`Sources[^source-a][^source-b][^source-plain]${definitions}`}
      />,
    );
    expect(card().textContent).toContain('Ticket website');
    expect(card().textContent).toContain('2 / 3');
    render(
      <Markdown content={`Sources[^source-a][^source-plain]${definitions}`} />,
    );
    expect(card().textContent).toContain('Tourism office');
    expect(card().textContent).toContain('1 / 2');
  });

  it('gives repeated references and separate documents valid isolated return targets', () => {
    const text = `Note[^note] [^note]. Again[^note].\n\n[^note]: A normal footnote.`;
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
        expect(target?.matches('[data-footnote-ref]')).toBe(true);
        expect(doc.contains(target)).toBe(true);
        click(link);
        expect(document.activeElement).toBe(target);
      }
    }
  });

  it('keeps standard navigable references in static exports', () => {
    render(
      <TranscriptRenderModeProvider value="document">
        <Markdown content={`Sources[^source-a][^source-b]${definitions}`} />
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
          content={`Sources[^source-a][^source-b]${definitions}`}
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
          'Source[^source-a].\n\n[^source-a]: [Unsafe](javascript:alert%281%29) ![Bad](data:image/svg+xml;base64,PHN2Zz4=) [Safe](https://safe.example) ![Good](https://safe.example/image.png)'
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
        content={`| Conclusion |\n| --- |\n| Result[^source-a] [^source-b][^source-a] |${definitions}`}
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
        <Markdown content={`Sources[^source-a][^source-plain]${definitions}`} />
      </I18nProvider>,
    );
    expect(
      container.querySelector(triggerSelector)?.getAttribute('aria-label'),
    ).toBe('查看 2 条引用');
    expect(
      container.querySelector('[data-web-shell-footnote-sources]')?.textContent,
    ).toBe('2 个来源');
    click(container.querySelector(triggerSelector));
    click(card().querySelector('[aria-label="下一条引用"]'));
    expect(card().textContent).toContain('脚注 2');
  });

  it('enhances only valid source footnotes and keeps ordinary footnotes navigable', () => {
    render(
      <Markdown
        content={`Source[^source-a]. Note[^note]. Invalid[^source-invalid].${definitions}\n\n[^note]: A normal footnote.\n[^source-invalid]: Plain text without a source title.`}
      />,
    );

    const trigger = container.querySelector(triggerSelector);
    expect(trigger?.textContent).toBe('');
    expect(container.querySelectorAll('[data-footnote-ref]')).toHaveLength(2);
    const visibleDefinitions = container.querySelectorAll<HTMLLIElement>(
      '[data-footnotes] li',
    );
    expect(visibleDefinitions).toHaveLength(2);
    expect(
      [...visibleDefinitions].map((definition) => definition.value),
    ).toEqual([2, 3]);
    expect(container.querySelector('[data-footnotes]')?.textContent).toContain(
      'A normal footnote.',
    );
    expect(container.querySelector('[data-footnotes]')?.textContent).toContain(
      'Plain text without a source title.',
    );
    expect(
      container.querySelector('[data-footnotes]')?.textContent,
    ).not.toContain('Concert details.');
    const ordinaryReference = container.querySelector<HTMLAnchorElement>(
      '[data-footnote-ref]',
    );
    click(ordinaryReference);
    expect(document.activeElement?.id).toBe(
      ordinaryReference?.getAttribute('href')?.slice(1),
    );
    click(container.querySelector('[data-footnote-backref]'));
    expect(document.activeElement).toBe(ordinaryReference);
  });

  it('keeps a source definition when one occurrence cannot become a card', () => {
    render(
      <WebShellCustomizationProvider
        value={{
          markdown: {
            components: {
              a: ({ children }) => <span data-host-link="">{children}</span>,
            },
          },
        }}
      >
        <Markdown
          source="assistant"
          content={`Converted[^source-a]. [Linked reference[^source-a]](https://outer.example).${definitions}`}
        />
      </WebShellCustomizationProvider>,
    );

    expect(container.querySelectorAll(triggerSelector)).toHaveLength(1);
    const linkedReference = container.querySelector<HTMLAnchorElement>(
      '[data-host-link] [data-footnote-ref]',
    );
    expect(linkedReference).not.toBeNull();
    const target = document.getElementById(
      linkedReference!.getAttribute('href')!.slice(1),
    );
    expect(target?.textContent).toContain('Concert details.');
    expect(
      container.querySelector('[data-web-shell-footnote-sources-trigger]')
        ?.textContent,
    ).toBe('1 source');
  });

  it('opens all unique message sources from the footer', () => {
    render(
      <Markdown
        content={`First[^source-b]. Repeat[^source-b]. Then[^source-a].${definitions}`}
      />,
    );
    const footer = container.querySelector(
      '[data-web-shell-footnote-sources-trigger]',
    );
    expect(footer?.textContent).toBe('2 sources');
    click(footer);
    expect(card().textContent).toContain('Ticket website');
    expect(card().textContent).toContain('1 / 2');
    click(card().querySelector('[aria-label="Next reference"]'));
    expect(card().textContent).toContain('Tourism office');
  });

  it('routes source links through the host component with the locator intact', () => {
    const locator =
      'https://citation.invalid/dataworks-knowledge#v=1&kind=content&kbInstanceId=instance-1&sourceFileId=file-2&citationId=citation-3&relativePath=docs%2Forder.md&anchor=definition%20one';
    render(
      <WebShellCustomizationProvider
        value={{
          markdown: {
            components: {
              a: ({ href, children }) => (
                <a data-host-link="" href={href}>
                  {children}
                </a>
              ),
              section: ({ children }) => (
                <section data-host-section="">{children}</section>
              ),
            },
          },
        }}
      >
        <Markdown
          source="assistant"
          content={`Source[^source-locator]. Note[^note].\n\n[^source-locator]: [Knowledge result](<${locator}>) Result excerpt.\n[^note]: A normal footnote.`}
        />
      </WebShellCustomizationProvider>,
    );

    click(container.querySelector(triggerSelector));
    expect(card().querySelector('[data-host-link]')?.getAttribute('href')).toBe(
      locator,
    );
    expect(
      container.querySelectorAll(
        '[data-footnote-ref][data-host-link], [data-footnote-backref][data-host-link]',
      ),
    ).toHaveLength(0);
    expect(container.querySelectorAll('[data-footnote-ref]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-footnote-backref]')).toHaveLength(
      1,
    );
    expect(container.querySelector('[data-host-section]')).not.toBeNull();
  });

  it('does not navigate citation locators without a host link resolver', () => {
    const locator =
      'https://citation.invalid/dataworks-knowledge#v=1&sourceFileId=file-2';
    render(
      <Markdown
        content={`Source[^source-locator].\n\n[^source-locator]: [Knowledge result](<${locator}> "DataWorks Knowledge") Result excerpt.`}
      />,
    );

    click(container.querySelector(triggerSelector));
    expect(card().textContent).toContain('DataWorks Knowledge');
    expect(card().textContent).toContain('Knowledge result');
    expect(card().querySelector('a')).toBeNull();
  });
});
