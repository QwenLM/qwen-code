// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import {
  WebShellCustomizationProvider,
  type LoadingPhrasesResolver,
  type WebShellCustomization,
} from '../customization';
import {
  getLoadingPhrases,
  PHRASE_CHANGE_INTERVAL_MS,
} from '../constants/loadingPhrases';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Keep StreamingStatus active (it renders null when idle) and give the real
// useStreamingLoadingMetrics an empty transcript so it reports zero tokens.
const mocks = vi.hoisted(() => ({ streamingState: 'responding' as string }));
vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useStreamingState: () => mocks.streamingState,
  useTranscriptBlocks: () => [],
}));

const { StreamingStatus } = await import('./StreamingStatus');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.restoreAllMocks();
});

function render(
  customization: WebShellCustomization = {},
  props: { showPhrase?: boolean } = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={customization}>
          <StreamingStatus {...props} />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

// Math.random()=0 makes pickPhrase() deterministically choose index 0, so the
// rendered phrase is always phrases[0].
function pinPhraseSelection(): void {
  vi.spyOn(Math, 'random').mockReturnValue(0);
}

function labelText(container: HTMLElement): string | undefined {
  const status = container.firstElementChild;
  // spinner span, optional label span, meta span — the label is the middle one.
  const spans = status?.querySelectorAll('span') ?? [];
  return spans.length === 3 ? (spans[1]?.textContent ?? '') : undefined;
}

describe('StreamingStatus loading phrases', () => {
  it('shows a built-in default phrase when no resolver is provided', () => {
    pinPhraseSelection();
    const container = render({});
    expect(labelText(container)).toBe(getLoadingPhrases('en')[0]);
  });

  it('overrides the built-in defaults with host-provided phrases', () => {
    pinPhraseSelection();
    const sentinel = 'Custom loading sentinel';
    const container = render({ loadingPhrases: () => [sentinel] });
    expect(labelText(container)).toBe(sentinel);
    expect(container.textContent).not.toContain(getLoadingPhrases('en')[0]);
  });

  it('hides the phrase when the resolver returns an empty array', () => {
    pinPhraseSelection();
    const container = render({ loadingPhrases: () => [] });
    // No label span — only spinner + meta remain.
    expect(labelText(container)).toBeUndefined();
    expect(container.firstElementChild?.querySelectorAll('span').length).toBe(
      2,
    );
  });

  it('hides the phrase but keeps the dynamic status when showPhrase is false', () => {
    pinPhraseSelection();
    // A resolver that would otherwise supply a phrase must still be suppressed.
    const container = render(
      { loadingPhrases: () => ['should not appear'] },
      {
        showPhrase: false,
      },
    );
    // The witty phrase (the "废话文学") is gone: no label span.
    expect(labelText(container)).toBeUndefined();
    expect(container.textContent).not.toContain('should not appear');
    // But the dynamic status stays: spinner + meta (elapsed time + cancel hint).
    const spans = container.firstElementChild?.querySelectorAll('span') ?? [];
    expect(spans.length).toBe(2);
    expect(spans[0]?.textContent).not.toBe(''); // spinner frame
    expect(container.textContent).toContain('esc to cancel'); // meta/cancel hint
    expect(container.textContent).toMatch(/\ds/); // elapsed time, e.g. "0s"
  });

  it('falls back to the built-in defaults when the resolver returns undefined', () => {
    pinPhraseSelection();
    const container = render({ loadingPhrases: () => undefined });
    expect(labelText(container)).toBe(getLoadingPhrases('en')[0]);
  });

  it('passes the resolved UI language to the resolver', () => {
    pinPhraseSelection();
    const resolver = vi.fn(() => ['x']);
    render({ loadingPhrases: resolver });
    expect(resolver).toHaveBeenCalledWith('en');
  });

  // Regression: a host passing an inline `loadingPhrases` arrow hands a fresh
  // reference on every render. During streaming App re-renders on every
  // transcript delta; if the rotation effect depended on the resolver identity
  // it would tear down its interval and re-pick a phrase every render, flickering
  // many times per second instead of every 15s. The ref-based resolver keeps the
  // effect deps stable, so a re-render with a new resolver must NOT reset the
  // currently shown phrase (the new output is only picked up on the next tick).
  it('does not reset the phrase when the resolver identity changes mid-stream', () => {
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0); // selects index 0
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const tree = (resolver: LoadingPhrasesResolver) => (
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={{ loadingPhrases: resolver }}>
          <StreamingStatus />
        </WebShellCustomizationProvider>
      </I18nProvider>
    );

    act(() => root.render(tree(() => ['AAA', 'BBB'])));
    mounted.push({ root, container });
    expect(labelText(container)).toBe('AAA');

    // New resolver reference (as an inline arrow produces each render) plus a
    // random value that WOULD pick a different phrase if the effect re-ran.
    rand.mockReturnValue(0.99); // floor(0.99 * 2) === 1
    act(() => root.render(tree(() => ['CCC', 'DDD'])));

    // Stable deps → effect did not re-run → phrase unchanged (not 'DDD'/'BBB').
    expect(labelText(container)).toBe('AAA');
  });

  // Companion to the test above: the effect does not re-run on a resolver swap,
  // but pickPhrase re-resolves on each tick, so the NEW resolver's output must
  // appear on the next rotation tick (honoring the "picked up on the next tick"
  // contract without flickering on every render).
  it('picks up the new resolver output on the next rotation tick', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0); // index 0
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const tree = (resolver: LoadingPhrasesResolver) => (
        <I18nProvider language="en">
          <WebShellCustomizationProvider value={{ loadingPhrases: resolver }}>
            <StreamingStatus />
          </WebShellCustomizationProvider>
        </I18nProvider>
      );

      act(() => root.render(tree(() => ['AAA', 'BBB'])));
      mounted.push({ root, container });
      expect(labelText(container)).toBe('AAA');

      // Swap the resolver's content (new reference, same language/state): the
      // effect does not re-run, so the phrase is unchanged until the next tick.
      act(() => root.render(tree(() => ['CCC', 'DDD'])));
      expect(labelText(container)).toBe('AAA');

      // Advance one rotation interval — pickPhrase re-resolves and now reads the
      // swapped resolver, so the displayed phrase comes from the new array.
      act(() => {
        vi.advanceTimersByTime(PHRASE_CHANGE_INTERVAL_MS);
      });
      expect(labelText(container)).toBe('CCC');
    } finally {
      vi.useRealTimers();
    }
  });

  // The PR drops the old `phrases.length === 0` early-return: an empty result no
  // longer skips the interval, so a resolver that flips from [] (hidden) to a
  // non-empty set is re-shown on the next tick. Guards against a refactor
  // re-introducing the early return.
  it('re-shows the phrase when the resolver switches from empty to non-empty on the next tick', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      let phrases: readonly string[] = [];
      const tree = () => (
        <I18nProvider language="en">
          <WebShellCustomizationProvider
            value={{ loadingPhrases: () => phrases }}
          >
            <StreamingStatus />
          </WebShellCustomizationProvider>
        </I18nProvider>
      );

      act(() => root.render(tree()));
      mounted.push({ root, container });
      expect(labelText(container)).toBeUndefined();

      phrases = ['Now visible'];
      act(() => {
        vi.advanceTimersByTime(PHRASE_CHANGE_INTERVAL_MS);
      });
      expect(labelText(container)).toBe('Now visible');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the built-in defaults when the resolver throws', () => {
    pinPhraseSelection();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = render({
      loadingPhrases: () => {
        throw new Error('boom');
      },
    });
    expect(labelText(container)).toBe(getLoadingPhrases('en')[0]);
    expect(warn).toHaveBeenCalled();
  });
});
