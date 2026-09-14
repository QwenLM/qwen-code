import { describe, expect, it, vi } from 'vitest';
import { extractInlineScript, readIndexHtml } from './test/indexHtmlTestUtils';

function extractMeasureScript(): string {
  return extractInlineScript('performance.measure =');
}

function installMeasureGuard(
  measure: (...args: unknown[]) => unknown,
  clearMeasures?: () => void,
): Performance {
  const script = extractMeasureScript();
  const performance = { measure, clearMeasures };
  Function('performance', 'DOMException', script)(performance, DOMException);
  return performance as Performance;
}

describe('React performance measure guard', () => {
  it('removes React component detail before calling the native measure', () => {
    const measure = vi.fn(() => 'measure');
    const performance = installMeasureGuard(measure);
    const options = {
      start: 1,
      end: 2,
      detail: {
        devtools: {
          track: 'Components ⚛',
          properties: [['transcript', new Array(50_000).fill('block')]],
        },
      },
    };

    const result = performance.measure('WebShell', options);
    const forwardedOptions = measure.mock.calls[0]?.[1] as
      | PerformanceMeasureOptions
      | undefined;

    expect(result).toBe('measure');
    expect(forwardedOptions?.start).toBe(1);
    expect(forwardedOptions?.end).toBe(2);
    expect(forwardedOptions?.detail === null).toBe(true);
    expect(options.detail.devtools.properties).toHaveLength(1);
  });

  it('preserves non-React performance measure detail', () => {
    const measure = vi.fn(() => 'measure');
    const performance = installMeasureGuard(measure);
    const options = {
      start: 1,
      end: 2,
      detail: { source: 'web-shell' },
    };

    performance.measure('custom-measure', options);

    expect(measure).toHaveBeenCalledWith('custom-measure', options);
  });

  it('strips detail from any React devtools track, not just Components', () => {
    const measure = vi.fn(() => 'measure');
    const performance = installMeasureGuard(measure);
    const options = {
      start: 1,
      end: 2,
      detail: { devtools: { track: 'Blocking', properties: [['k', 'v']] } },
    };

    performance.measure('React', options);

    expect(
      (measure.mock.calls[0]?.[1] as PerformanceMeasureOptions).detail,
    ).toBeNull();
  });

  it('clears the measure timeline on a budget so entries cannot accumulate', () => {
    const measureThis: unknown[] = [];
    const measure = vi.fn(function (this: unknown): string {
      measureThis.push(this);
      return 'measure';
    });
    const clearThis: unknown[] = [];
    const clearMeasures = vi.fn(function (this: unknown) {
      clearThis.push(this);
    });
    const fakePerformance = installMeasureGuard(measure, clearMeasures);
    // The real flood mixes lane/scheduler tracks and measure names, so drive
    // a mixed flood: the budget must count every React devtools measure
    // regardless of track or name.
    const tracks = ['Blocking', 'Transition', 'Suspense', 'Components ⚛'];
    const names = ['⏱ lane', '⏱ render', '⏱ commit'];
    const reactName = (index: number): string => names[index % names.length];
    let reactDriven = 0;
    const driveReact = (count: number): void => {
      for (let i = 0; i < count; i += 1) {
        fakePerformance.measure(reactName(reactDriven), {
          start: 1,
          end: 2,
          detail: { devtools: { track: tracks[reactDriven % tracks.length] } },
        });
        reactDriven += 1;
      }
    };

    // The clear fires at exactly the budget, not one measure early.
    driveReact(16383);
    expect(clearMeasures).not.toHaveBeenCalled();
    driveReact(1);
    expect(clearMeasures).toHaveBeenCalledTimes(1);
    // The timeline is cleared with no name filter (React never names its
    // measures) and with the performance object as receiver (a detached
    // brand-checked clearMeasures throws Illegal invocation).
    expect(clearMeasures).toHaveBeenCalledWith();
    expect(clearThis).toEqual([fakePerformance]);
    // Every React measure is still forwarded with its name preserved and its
    // detail stripped — including the one that triggers the clear.
    expect(measure).toHaveBeenCalledTimes(16384);
    expect(measure.mock.calls[16383]).toEqual([
      reactName(16383),
      expect.objectContaining({ detail: null }),
    ]);

    // The clear is not latched: a second full window clears again, and
    // forwarding + stripping survive past the first clear.
    driveReact(16384);
    expect(clearMeasures).toHaveBeenCalledTimes(2);
    expect(measure).toHaveBeenCalledTimes(32768);
    expect(measure.mock.calls[32767]).toEqual([
      reactName(32767),
      expect.objectContaining({ detail: null }),
    ]);

    // A full window of non-React measures neither counts toward the budget
    // nor is dropped or stripped after a clear.
    const customOptions = { start: 1, end: 2, detail: { source: 'web-shell' } };
    for (let i = 0; i < 16384 - 1; i += 1) {
      fakePerformance.measure('custom-measure', customOptions);
    }
    // The wrapper's return value passes through like the native call's.
    const customResult = fakePerformance.measure(
      'custom-measure',
      customOptions,
    );
    expect(clearMeasures).toHaveBeenCalledTimes(2);
    expect(customResult).toBe('measure');
    expect(measure).toHaveBeenCalledTimes(49152);
    // Identity: the non-React options object is forwarded as-is.
    expect(measure.mock.calls[49151]?.[0]).toBe('custom-measure');
    expect(measure.mock.calls[49151]?.[1]).toBe(customOptions);
    // Value survival, not just reference: an in-place strip of the caller's
    // options object must fail here.
    expect(
      (measure.mock.calls[49151]?.[1] as PerformanceMeasureOptions).detail,
    ).toEqual({ source: 'web-shell' });

    // Mixed app + React traffic still reaches the budget: interleaved
    // non-React measures must not reset the counter.
    for (let i = 0; i < 16384; i += 1) {
      driveReact(1);
      fakePerformance.measure('custom-measure', customOptions);
    }
    expect(clearMeasures).toHaveBeenCalledTimes(3);

    // A detached wrapper call still reaches the native measure bound to the
    // performance object (both captures keep their .bind(performance)).
    const detachedMeasure = fakePerformance.measure as (
      ...args: unknown[]
    ) => unknown;
    detachedMeasure('detached', {
      start: 1,
      end: 2,
      detail: { devtools: { track: 'Blocking' } },
    });
    expect(measure).toHaveBeenCalledTimes(81921);
    expect(measureThis.every((receiver) => receiver === fakePerformance)).toBe(
      true,
    );
  });

  it('keeps measuring when clearMeasures is unavailable', () => {
    const measure = vi.fn(() => 'measure');
    const performance = installMeasureGuard(measure);
    const options = {
      start: 1,
      end: 2,
      detail: { devtools: { track: 'Blocking' } },
    };

    expect(() => {
      for (let i = 0; i < 16384 + 1; i += 1) {
        performance.measure('⏱ lane', options);
      }
    }).not.toThrow();
    expect(measure).toHaveBeenCalledTimes(16384 + 1);
  });

  it('forwards standard measure shapes untouched', () => {
    const measure = vi.fn(() => 'measure');
    const performance = installMeasureGuard(measure);
    const bareMeasure = performance.measure as (
      name: string,
      options?: unknown,
    ) => unknown;
    const options = { start: 1, end: 2 };

    expect(() => {
      bareMeasure('plain');
      bareMeasure('null-options', null);
      bareMeasure('string-mark', 'start-mark');
      bareMeasure('detail-less', options);
    }).not.toThrow();

    expect(bareMeasure('return-check', options)).toBe('measure');
    expect(measure.mock.calls[0]).toEqual(['plain']);
    expect(measure.mock.calls[1]).toEqual(['null-options', null]);
    expect(measure.mock.calls[2]).toEqual(['string-mark', 'start-mark']);
    expect(measure.mock.calls[3]).toEqual(['detail-less', options]);
  });

  it('does not touch environments without performance.measure', () => {
    const script = extractMeasureScript();
    const install = (performance: unknown): void => {
      Function(
        'performance',
        'DOMException',
        script,
      )(performance, DOMException);
    };

    expect(() => install(undefined)).not.toThrow();
    expect(() => install({})).not.toThrow();
  });
});

describe('brand pre-paint script', () => {
  const BUILT_IN_TITLE = 'Qwen Code Web chat';
  const BUILT_IN_ICON = 'data:image/svg+xml,BUILT-IN';

  function runBrandScript(stored: string | null): {
    title: string;
    iconHref: string;
  } {
    const script = extractInlineScript('qwen-code-web-shell-brand');
    const icon = { href: BUILT_IN_ICON };
    const document = {
      title: BUILT_IN_TITLE,
      querySelector: (selector: string) =>
        selector === 'link[rel="icon"]' ? icon : null,
    };
    const localStorage = {
      getItem: (key: string) => {
        // The inline script must ask for exactly this key — a drift between
        // index.html's literal and main.tsx's BRAND_STORAGE_KEY silently
        // disables the pre-paint cache, and an argument-ignoring stub would
        // never catch it.
        if (key !== 'qwen-code-web-shell-brand') return null;
        return stored;
      },
    };
    Function('localStorage', 'document', script)(localStorage, document);
    return { title: document.title, iconHref: icon.href };
  }

  it('applies a cached title and logo before first paint', () => {
    const result = runBrandScript(
      JSON.stringify({
        title: 'QiuQiu Code Web chat',
        logo: 'data:image/svg+xml,CACHED',
      }),
    );

    expect(result.title).toBe('QiuQiu Code Web chat');
    expect(result.iconHref).toBe('data:image/svg+xml,CACHED');
  });

  it('applies the title alone when the cache holds no logo', () => {
    const result = runBrandScript(
      JSON.stringify({ title: 'QiuQiu Code Web chat' }),
    );

    expect(result.title).toBe('QiuQiu Code Web chat');
    expect(result.iconHref).toBe(BUILT_IN_ICON);
  });

  it('leaves the built-in title and logo alone on a first-ever load', () => {
    expect(runBrandScript(null)).toEqual({
      title: BUILT_IN_TITLE,
      iconHref: BUILT_IN_ICON,
    });
  });

  it('leaves the built-in title and logo alone when the cache is corrupt', () => {
    expect(runBrandScript('{not json')).toEqual({
      title: BUILT_IN_TITLE,
      iconHref: BUILT_IN_ICON,
    });
  });
});

describe('built-in brand document contract', () => {
  // A deployment that configures no brand must get exactly the shell it got
  // before branding was configurable. These two literals are what the
  // pre-paint script and main.tsx fall back to, so they are pinned here rather
  // than left to a visual diff.
  it('ships the built-in document title', () => {
    expect(readIndexHtml()).toContain('<title>Qwen Code Web chat</title>');
  });

  it('ships the built-in favicon as an inline data URI', () => {
    const html = readIndexHtml();
    const href = /rel="icon"[^>]*href="([^"]+)"/s.exec(html)?.[1];

    expect(href?.startsWith('data:image/svg+xml,')).toBe(true);
    // The Qwen mark's purple, percent-encoded.
    expect(href).toContain('%236D44E8');
  });

  // The brand script swaps the icon link's href, so it must run after that
  // element is parsed — earlier and querySelector finds nothing to swap, which
  // silently degrades to "the favicon updates one load late". The script's own
  // unit tests cannot catch this: they hand it a document that already has the
  // link. Pinned against the real file for the same reason the watchdog order
  // below is.
  it('applies the cached brand after the icon link is parsed', () => {
    const html = readIndexHtml();

    expect(html.indexOf('qwen-code-web-shell-brand')).toBeGreaterThan(
      html.indexOf('rel="icon"'),
    );
  });

  it('applies the cached brand after the title is parsed', () => {
    const html = readIndexHtml();

    expect(html.indexOf('qwen-code-web-shell-brand')).toBeGreaterThan(
      html.indexOf('<title>'),
    );
  });
});

describe('boot watchdog document contract', () => {
  // The watchdog detects a mount as "#root has a first element child that is
  // not the fallback box". A static child shipped in the HTML — a boot
  // spinner, say — reads as already-mounted, which disables the watchdog
  // outright: no immediate fallback on a module failure, no timeout
  // fallback, exactly the white screen this feature exists to replace. No
  // boot-watchdog unit test can catch that, because they all build their own
  // #root; pin it against the real document instead.
  it('ships an empty #root', () => {
    const root = /<div id="root"[^>]*>([\s\S]*?)<\/div>/.exec(readIndexHtml());

    expect(root).not.toBeNull();
    expect(root?.[1]).toMatch(/^\s*$/);
  });

  // The watchdog is deliberately installed before #root is parsed so it is
  // already listening while the module graph loads. If a future edit moves
  // it after #root the DOMContentLoaded deferral becomes dead code, so the
  // boot-watchdog suite must keep exercising the install-before-#root order.
  it('installs the watchdog before #root is parsed', () => {
    const html = readIndexHtml();

    expect(html.indexOf('data-boot-fallback')).toBeLessThan(
      html.indexOf('<div id="root">'),
    );
  });
});
