// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  WebShellCustomizationProvider,
  type WebShellFootnotePreviewInfo,
  type WebShellFootnotePreviewMount,
} from '../../customization';
import { I18nProvider } from '../../i18n';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import { AssistantMessage } from './AssistantMessage';
import { FootnotePreviewContent } from './FootnotePreviewContent';

const report =
  'First[^a][^b].\n\nSecond[^c].\n\n[^a]: [Alpha](https://citation.invalid/record#id=a "Knowledge") First summary.\n[^b]: Plain beta.\n[^c]: [Gamma](https://example.com/gamma) Third summary.';
const trigger = '[data-web-shell-footnote-trigger]';
const cardSelector = '[data-web-shell-footnote-card]';
let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
  if (!container) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root.render(<I18nProvider language="en">{node}</I18nProvider>));
}
function click(element: Element | null) {
  expect(element).not.toBeNull();
  act(() => (element as HTMLElement).click());
}
function close() {
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  expect(document.querySelector(cardSelector)).toBeNull();
}
function preview() {
  return document.querySelector(cardSelector)!;
}
function harness(onUpdate?: (info: WebShellFootnotePreviewInfo) => void) {
  const views: Array<{
    element: HTMLElement;
    update: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const mount = vi.fn<WebShellFootnotePreviewMount>((element, initial) => {
    expect(element.hidden).toBe(false);
    const summary = document.createElement('p');
    summary.dataset['hostSummary'] = '';
    const update = vi.fn((info: WebShellFootnotePreviewInfo) => {
      onUpdate?.(info);
      summary.textContent = `Host ${info.footnote.summary}`;
      element.replaceChildren(info.sourceLink, summary);
    });
    const dispose = vi.fn(() => element.replaceChildren());
    views.push({ element, update, dispose });
    update(initial);
    return { update, dispose };
  });
  return { mount, views };
}
function tree(mount: WebShellFootnotePreviewMount, content = report) {
  return (
    <WebShellCustomizationProvider
      value={{ markdown: { mountFootnotePreview: mount } }}
    >
      <AssistantMessage content={content} showFooterActions />
    </WebShellCustomizationProvider>
  );
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  container = undefined!;
  vi.restoreAllMocks();
});

it('mounts only an open page, supplies isolated data and updates without replacing the host view', () => {
  const { mount, views } = harness();
  render(tree(mount));
  expect(mount).not.toHaveBeenCalled();
  const triggers = container.querySelectorAll(trigger);
  click(triggers[0]);
  const first = mount.mock.calls[0][1];
  expect(first.footnotes.map((note) => note.id)).toEqual(['a', 'b']);
  expect(first.footnote).toBe(first.footnotes[0]);
  expect(first).toMatchObject({
    index: 0,
    title: 'Alpha',
    sourceLabel: 'Knowledge',
  });
  expect(first.footnote.definitionMarkdown).toContain('[^a]: [Alpha]');
  expect(Object.keys(first.footnote)).not.toContain('linkNode');
  expect(first.sourceLink).toBeInstanceOf(HTMLElement);
  const element = views[0].element;
  click(preview().querySelector('[aria-label="Next reference"]'));
  expect(mount).toHaveBeenCalledTimes(1);
  expect(views[0].element).toBe(element);
  expect(views[0].update.mock.calls.at(-1)?.[0]).toMatchObject({
    index: 1,
    title: 'Footnote 2',
  });
  expect(views[0].update.mock.calls.at(-1)?.[0].sourceLink).toBe(
    first.sourceLink,
  );
  expect(preview().textContent).toContain('Host Plain beta.');
  expect(preview().textContent).toContain('2 / 2');
  expect(preview().querySelector('a')).toBeNull();
  close();
  expect(views[0].dispose).toHaveBeenCalledTimes(1);
  click(triggers[1]);
  expect(mount.mock.calls.at(-1)![1].footnotes.map((note) => note.id)).toEqual([
    'c',
  ]);
  close();
});

it('preserves components.a interception inside the DOM content slot', () => {
  const { mount } = harness();
  const open = vi.fn();
  render(
    <WebShellCustomizationProvider
      value={{
        markdown: {
          mountFootnotePreview: mount,
          components: {
            a: ({ href, children }) => (
              <button data-host-open="" onClick={() => open(href)}>
                {children}
              </button>
            ),
          },
        },
      }}
    >
      <AssistantMessage content={report} />
    </WebShellCustomizationProvider>,
  );
  click(container.querySelector(trigger));
  click(preview().querySelector('[data-host-open]'));
  expect(open).toHaveBeenCalledWith('https://citation.invalid/record#id=a');
  expect(preview().textContent).toContain('1 / 2');
});

it('updates a mounted view when report content grows and disposes on message removal', () => {
  const { mount, views } = harness();
  render(tree(mount));
  click(container.querySelector(trigger));
  click(preview().querySelector('[aria-label="Next reference"]'));
  const before = preview();
  render(tree(mount, report.replace('Plain beta.', 'Updated beta.')));
  expect(preview()).toBe(before);
  expect(preview().textContent).toContain('Host Updated beta.');
  expect(preview().textContent).toContain('2 / 2');
  expect(mount).toHaveBeenCalledTimes(1);
  expect(views[0].dispose).not.toHaveBeenCalled();
  render(tree(mount, report.replace('First[^a][^b].', 'First[^a][^b][^c].')));
  expect(preview()).toBe(before);
  expect(preview().textContent).toContain('2 / 3');
  expect(
    views[0].update.mock.calls
      .at(-1)?.[0]
      .footnotes.map((note: { id: string }) => note.id),
  ).toEqual(['a', 'b', 'c']);
  expect(mount).toHaveBeenCalledTimes(1);
  render(null);
  expect(views[0].dispose).toHaveBeenCalledTimes(1);
});

it.each([null, undefined])(
  'declines to the default page with %s and retries on another page',
  (value) => {
    const { mount: custom } = harness();
    const mount: WebShellFootnotePreviewMount = (element, info) =>
      info.index === 0 ? value : custom(element, info);
    render(tree(mount));
    click(container.querySelector(trigger));
    expect(
      preview().querySelector('[data-web-shell-footnote-summary]')?.textContent,
    ).toBe('First summary.');
    click(preview().querySelector('[aria-label="Next reference"]'));
    expect(preview().textContent).toContain('Host Plain beta.');
  },
);

it('falls back after mount failure and recovers on a different page', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { mount: custom } = harness();
  const mount: WebShellFootnotePreviewMount = (element, info) => {
    if (info.index === 0) {
      element.textContent = 'Partial mount';
      throw new Error('Mount failed');
    }
    return custom(element, info);
  };
  render(tree(mount));
  click(container.querySelector(trigger));
  expect(preview().textContent).not.toContain('Partial mount');
  expect(preview().textContent).toContain('First summary.');
  click(preview().querySelector('[aria-label="Next reference"]'));
  expect(preview().textContent).toContain('Host Plain beta.');
});

it('disposes a failing update once, keeps the pager and retries after changing page', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { mount, views } = harness((info) => {
    if (info.index === 1) throw new Error('Update failed');
  });
  render(tree(mount));
  click(container.querySelector(trigger));
  click(preview().querySelector('[aria-label="Next reference"]'));
  expect(views[0].dispose).toHaveBeenCalledTimes(1);
  expect(preview().querySelector('[data-host-summary]')).toBeNull();
  expect(preview().textContent).toContain('Plain beta.');
  expect(preview().textContent).toContain('2 / 2');
  click(preview().querySelector('[aria-label="Previous reference"]'));
  expect(preview().textContent).toContain('Host First summary.');
  close();
  expect(views.every((view) => view.dispose.mock.calls.length === 1)).toBe(
    true,
  );
});

it('cleans up on renderer replacement and balances StrictMode mounts', () => {
  const first = harness();
  const second = harness();
  const notes = [
    {
      id: 'a',
      number: 1,
      summary: 'Description.',
      definitionMarkdown: '[^a]: Description.',
    },
  ];
  const node = (mount: WebShellFootnotePreviewMount) => (
    <StrictMode>
      <FootnotePreviewContent notes={notes} index={0} mount={mount} />
    </StrictMode>
  );
  render(node(first.mount));
  expect(first.mount.mock.calls.length).toBeGreaterThan(0);
  render(node(second.mount));
  expect(
    first.views.every((view) => view.dispose.mock.calls.length === 1),
  ).toBe(true);
  expect(second.mount.mock.calls.length).toBeGreaterThan(0);
  render(null);
  expect(
    second.views.every((view) => view.dispose.mock.calls.length === 1),
  ).toBe(true);
});

it('contains disposal errors when the popup closes', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const dispose = vi.fn(() => {
    throw new Error('Dispose failed');
  });
  const mount: WebShellFootnotePreviewMount = (element, info) => {
    element.append(info.sourceLink);
    return { update() {}, dispose };
  };
  render(tree(mount));
  click(container.querySelector(trigger));
  close();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalled();
  expect(
    container.querySelector('[data-web-shell-turn-sources-trigger]'),
  ).toBeNull();
});

it('does not mount for static export or custom superscript rendering', () => {
  const { mount } = harness();
  render(
    <TranscriptRenderModeProvider value="document">
      {tree(mount)}
    </TranscriptRenderModeProvider>,
  );
  expect(container.querySelectorAll('[data-footnotes] li')).toHaveLength(3);
  expect(mount).not.toHaveBeenCalled();
  render(
    <WebShellCustomizationProvider
      value={{
        markdown: {
          mountFootnotePreview: mount,
          components: { sup: ({ children }) => <sup>{children}</sup> },
        },
      }}
    >
      <AssistantMessage content={report} />
    </WebShellCustomizationProvider>,
  );
  expect(container.querySelector(trigger)).toBeNull();
  expect(mount).not.toHaveBeenCalled();
});

it('rejects an invalid JavaScript mount handle while cleaning up and showing the default page', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const dispose = vi.fn();
  const mount = ((element: HTMLElement) => {
    element.textContent = 'Incomplete host view';
    return { dispose };
  }) as unknown as WebShellFootnotePreviewMount;
  render(tree(mount));
  click(container.querySelector(trigger));
  expect(preview().textContent).toContain('First summary.');
  expect(preview().textContent).not.toContain('Incomplete host view');
  expect(dispose).toHaveBeenCalled();
});

it('keeps DOM and footnote data separate for messages sharing an ID', () => {
  const { mount } = harness();
  render(
    <WebShellCustomizationProvider
      value={{ markdown: { mountFootnotePreview: mount } }}
    >
      <AssistantMessage content={'One[^a].\n\n[^a]: First message.'} />
      <AssistantMessage content={'Two[^a].\n\n[^a]: Second message.'} />
    </WebShellCustomizationProvider>,
  );
  const triggers = container.querySelectorAll(trigger);
  click(triggers[0]);
  const first = mount.mock.calls.at(-1)![1];
  close();
  click(triggers[1]);
  const second = mount.mock.calls.at(-1)![1];
  expect(second.sourceLink).not.toBe(first.sourceLink);
  expect(first.footnote.summary).toBe('First message.');
  expect(second.footnote.summary).toBe('Second message.');
  expect(preview().textContent).not.toContain('First message.');
});

it('retries a previously declined renderer after another renderer succeeds', () => {
  const first = harness();
  const second = harness();
  let decline = true;
  const mount: WebShellFootnotePreviewMount = (element, info) =>
    decline ? null : first.mount(element, info);
  const notes = [
    {
      id: 'a',
      number: 1,
      summary: 'Renderer cycle.',
      definitionMarkdown: '[^a]: Renderer cycle.',
    },
  ];
  const node = (renderer: WebShellFootnotePreviewMount) => (
    <FootnotePreviewContent notes={notes} index={0} mount={renderer} />
  );
  render(node(mount));
  render(node(second.mount));
  decline = false;
  render(node(mount));
  expect(container.textContent).toContain('Host Renderer cycle.');
  expect(second.views[0].dispose).toHaveBeenCalledTimes(1);
});

it('keeps every StrictMode mount measurable even when the host declines', () => {
  const hidden: boolean[] = [];
  const mount: WebShellFootnotePreviewMount = (element) => {
    hidden.push(element.hidden);
    return null;
  };
  const notes = [
    {
      id: 'a',
      number: 1,
      summary: 'Declined.',
      definitionMarkdown: '[^a]: Declined.',
    },
  ];
  render(
    <StrictMode>
      <FootnotePreviewContent notes={notes} index={0} mount={mount} />
    </StrictMode>,
  );
  expect(hidden.length).toBeGreaterThan(0);
  expect(hidden.every((value) => !value)).toBe(true);
  expect(container.textContent).toContain('Declined.');
});
