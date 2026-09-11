// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import {
  WebShellCustomizationProvider,
  type WebShellFootnoteIconResolver,
} from '../../customization';
import { AssistantMessage } from './AssistantMessage';
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
      <AssistantMessage
        showFooterActions
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
      container.querySelector('[data-web-shell-turn-sources-trigger]'),
    ).toBeNull();
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

  it('keeps the card open when pagination races a pending hover dismissal', () => {
    vi.useFakeTimers();
    try {
      render(
        <Markdown content={`Sources[^source-a][^source-b].${definitions}`} />,
      );
      const trigger = container.querySelector(triggerSelector)!;
      act(() => {
        trigger.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
        vi.advanceTimersByTime(150);
      });
      const preview = card();
      click(preview.querySelector('[aria-label="Next reference"]'));
      act(() => {
        preview.dispatchEvent(
          new MouseEvent('pointerout', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      act(() => vi.advanceTimersByTime(250));

      expect(document.querySelector(cardSelector)).not.toBeNull();
      expect(card().textContent).toContain('Ticket website');
    } finally {
      vi.useRealTimers();
    }
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
      <TranscriptRenderModeProvider value="document">
        <Markdown content={text} />
        <Markdown content={text} />
      </TranscriptRenderModeProvider>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(container.querySelectorAll('[data-footnote-backref]')).toHaveLength(
      6,
    );
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
        <AssistantMessage
          showFooterActions
          content={`Sources[^source-a][^source-plain]${definitions}`}
        />
      </I18nProvider>,
    );
    expect(
      container.querySelector(triggerSelector)?.getAttribute('aria-label'),
    ).toBe('查看 2 条引用');
    expect(
      container.querySelector('[data-web-shell-turn-sources-trigger]'),
    ).toBeNull();
    click(container.querySelector(triggerSelector));
    click(card().querySelector('[aria-label="下一条引用"]'));
    expect(card().textContent).toContain('脚注 2');
  });

  it('aggregates numeric, named and Chinese IDs without requiring links or bold titles', () => {
    render(
      <AssistantMessage
        showFooterActions
        content={`Numeric[^1]. Named[^order]. Chinese[^说明]. Missing[^missing].

[^1]: Numeric explanation.
[^order]: Named explanation.
[^说明]: First paragraph.

    Second paragraph without a link.`}
      />,
    );
    const triggers = container.querySelectorAll(triggerSelector);
    expect(triggers).toHaveLength(3);
    expect(container.querySelector('[data-footnotes]')).toBeNull();
    expect(container.textContent).toContain('[^missing]');
    expect(
      container.querySelector('[data-web-shell-turn-sources-trigger]'),
    ).toBeNull();
    click(triggers[2]);
    expect(card().textContent).toContain('Footnote 3');
    expect(card().textContent).toContain(
      'First paragraph. Second paragraph without a link.',
    );
    expect(card().querySelector('a')).toBeNull();
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
      container.querySelector('[data-web-shell-turn-sources-trigger]'),
    ).toBeNull();
  });

  it('routes source links through the host component with the locator intact', () => {
    const locator =
      'https://citation.invalid/dataworks-knowledge#v=1&kind=content&kbInstanceId=instance-1&sourceFileId=file-2&citationId=citation-3&relativePath=docs%2Forder.md&anchor=definition%20one';
    render(
      <WebShellCustomizationProvider
        value={{
          markdown: {
            components: {
              a: ({ href, children }) =>
                href === 'https://outer.example' ? (
                  <span>{children}</span>
                ) : (
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
          content={`Source[^source-locator]. [Note[^note]](https://outer.example).\n\n[^source-locator]: [Knowledge result](<${locator}>) Result excerpt.\n[^note]: A normal footnote.`}
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

const resourceDefinitions = [
  '[^a]: [Order](https://example.com/shared "Knowledge") — Definition.\n\n    A second paragraph. ![Preview](https://example.com/preview.png)',
  '[^b]: Plain explanation without a link.',
  '[^c]: [Specification](https://example.com/shared) — Details.',
];
const resourceReport = `First[^a] [^b][^a].\n\nSecond[^c].${'\n\n'}${resourceDefinitions.join('\n')}`;

function iconMask(selector: string) {
  return container
    .querySelector(selector)
    ?.querySelector<HTMLElement>('[aria-hidden="true"]')?.style.maskImage;
}

describe('Host inline footnote icon selection', () => {
  it('receives complete independent groups and transformed definitions without rendering nodes', () => {
    const inline = vi.fn<WebShellFootnoteIconResolver>((notes) =>
      notes.length === 2 ? '/icons/pair.svg' : '/icons/single.svg',
    );
    render(
      <WebShellCustomizationProvider
        value={{
          markdown: {
            transformMarkdown: () => resourceReport,
            getInlineFootnoteIcon: inline,
          },
        }}
      >
        <AssistantMessage content="Before transformation" showFooterActions />
      </WebShellCustomizationProvider>,
    );
    const groups = inline.mock.calls.map(([notes]) => notes);
    expect(groups.map((notes) => notes.map((note) => note.id))).toContainEqual([
      'a',
      'b',
    ]);
    expect(groups.map((notes) => notes.map((note) => note.id))).toContainEqual([
      'c',
    ]);
    const all = [
      ...groups.find((notes) => notes.length === 2)!,
      ...groups.find((notes) => notes.length === 1)!,
    ];
    expect(all.map((note) => note.definitionMarkdown)).toEqual(
      resourceDefinitions,
    );
    expect(all.map((note) => note.number)).toEqual([1, 2, 3]);
    expect(all[0]).toMatchObject({
      id: 'a',
      title: 'Order',
      source: 'Knowledge',
      summary: '— Definition. A second paragraph.',
      href: 'https://example.com/shared',
      image: 'https://example.com/preview.png',
    });
    expect(all[1]).toMatchObject({
      title: undefined,
      href: undefined,
      summary: 'Plain explanation without a link.',
    });
    expect(all[2].href).toBe(all[0].href);
    expect(all.every((note) => !('linkNode' in note))).toBe(true);
    expect(
      container.querySelector('[data-web-shell-turn-sources-trigger]'),
    ).toBeNull();
    const triggers = container.querySelectorAll(triggerSelector);
    expect(iconMask(triggerSelector)).toContain('/icons/pair.svg');
    expect(
      (triggers[1].firstElementChild as HTMLElement).style.maskImage,
    ).toContain('/icons/single.svg');
    click(triggers[0]);
    click(card().querySelector('[aria-label="Next reference"]'));
    expect(card().textContent).toContain('Plain explanation without a link.');
    expect(iconMask(triggerSelector)).toContain('/icons/pair.svg');
    expect(
      inline.mock.calls.every(
        ([notes]) => notes.map((note) => note.id).join(',') !== 'b',
      ),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    ' ',
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz4=',
    '//external.example/icon.svg',
  ])('falls back for an empty or unsafe inline icon %s', (result) => {
    render(<AssistantMessage content={resourceReport} />);
    const fallback = iconMask(triggerSelector);
    render(
      <WebShellCustomizationProvider
        value={{ markdown: { getInlineFootnoteIcon: () => result } }}
      >
        <AssistantMessage content={resourceReport} />
      </WebShellCustomizationProvider>,
    );
    expect(iconMask(triggerSelector)).toBe(fallback);
    click(container.querySelector(triggerSelector));
    expect(card().textContent).toContain('Order');
  });

  it('isolates icon exceptions from the report', () => {
    render(
      <WebShellCustomizationProvider
        value={{
          markdown: {
            getInlineFootnoteIcon: () => {
              throw new Error('Icon failed');
            },
          },
        }}
      >
        <AssistantMessage content={resourceReport} />
      </WebShellCustomizationProvider>,
    );
    click(container.querySelector(triggerSelector));
    expect(card().textContent).toContain('Order');
  });

  it('preserves Chinese IDs, CRLF definitions and message isolation', () => {
    const inline = vi.fn<WebShellFootnoteIconResolver>();
    const original = '[^说明]: First line.\r\n\r\n    Second line.';
    render(
      <WebShellCustomizationProvider
        value={{ markdown: { getInlineFootnoteIcon: inline } }}
      >
        <AssistantMessage content={`Note[^说明].\r\n\r\n${original}`} />
        <AssistantMessage
          content={'Other[^说明].\n\n[^说明]: Different explanation.'}
        />
      </WebShellCustomizationProvider>,
    );
    expect(
      inline.mock.calls.every(
        ([notes]) => notes.length === 1 && notes[0].id === '说明',
      ),
    ).toBe(true);
    expect(
      inline.mock.calls.map(([notes]) => notes[0].definitionMarkdown),
    ).toContain(original);
    expect(inline.mock.calls.map(([notes]) => notes[0].summary)).toContain(
      'Different explanation.',
    );
  });

  it('keeps percent IDs distinct and case-insensitive references deduplicated', () => {
    const inline = vi.fn<WebShellFootnoteIconResolver>();
    render(
      <WebShellCustomizationProvider
        value={{ markdown: { getInlineFootnoteIcon: inline } }}
      >
        <AssistantMessage
          content={
            'Notes[^a][^%61][^ORDER][^order].\n\n[^a]: Letter.\n[^%61]: Percent.\n[^Order]: Order.'
          }
        />
      </WebShellCustomizationProvider>,
    );
    expect(inline.mock.calls.at(-1)![0].map((note) => note.id)).toEqual([
      'a',
      '%61',
      'Order',
    ]);
  });

  it('keeps the current page open across assistant updates', () => {
    const markdown = { getInlineFootnoteIcon: () => '/icons/pair.svg' };
    const tree = (content: string) => (
      <WebShellCustomizationProvider value={{ markdown }}>
        <AssistantMessage content={content} />
      </WebShellCustomizationProvider>
    );
    render(tree(resourceReport));
    click(container.querySelector(triggerSelector));
    click(card().querySelector('[aria-label="Next reference"]'));
    const before = card();
    render(tree(`${resourceReport}\n\nMore text.`));
    expect(card()).toBe(before);
    expect(card().textContent).toContain('2 / 2');
  });

  it('copies original Markdown and keeps static export as standard footnotes', async () => {
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue();
    render(<AssistantMessage content={resourceReport} showFooterActions />);
    click(container.querySelector('[aria-label="Copy"]'));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(resourceReport);
    const resolver = vi.fn<WebShellFootnoteIconResolver>();
    render(
      <WebShellCustomizationProvider
        value={{ markdown: { getInlineFootnoteIcon: resolver } }}
      >
        <TranscriptRenderModeProvider value="document">
          <AssistantMessage content={resourceReport} />
        </TranscriptRenderModeProvider>
      </WebShellCustomizationProvider>,
    );
    expect(container.querySelectorAll('[data-footnotes] li')).toHaveLength(3);
    expect(container.querySelector(triggerSelector)).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });
});
