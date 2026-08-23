import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

function installMeasureGuard(
  measure: (...args: unknown[]) => unknown,
  clearMeasures?: () => void,
): Performance {
  const html = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
  const script = Array.from(
    html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  )
    .map((match) => match[1] ?? '')
    .find((source) => source.includes('performance.measure ='));

  if (!script) throw new Error('Performance measure guard not found');

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
    const measure = vi.fn(() => 'measure');
    const clearThis: unknown[] = [];
    const clearMeasures = vi.fn(function (this: unknown) {
      clearThis.push(this);
    });
    const fakePerformance = installMeasureGuard(measure, clearMeasures);
    const reactOptions = {
      start: 1,
      end: 2,
      // A non-Components track: the flood is dominated by lane/scheduler
      // tracks, so the budget must count every React devtools measure.
      detail: { devtools: { track: 'Blocking' } },
    };

    for (let i = 0; i < 16384; i += 1) {
      fakePerformance.measure('⏱ track', reactOptions);
    }
    // The timeline is cleared with no name filter (React never names its
    // measures) and with the performance object as receiver (a detached
    // brand-checked clearMeasures throws Illegal invocation).
    expect(clearMeasures).toHaveBeenCalledTimes(1);
    expect(clearMeasures).toHaveBeenCalledWith();
    expect(clearThis).toEqual([fakePerformance]);
    // Every React measure is still forwarded, detail stripped — including
    // the one that triggers the clear.
    expect(measure).toHaveBeenCalledTimes(16384);
    expect(
      (measure.mock.calls[16383]?.[1] as PerformanceMeasureOptions).detail,
    ).toBeNull();

    // The clear is not latched: a second full window clears again.
    for (let i = 0; i < 16384; i += 1) {
      fakePerformance.measure('⏱ track', reactOptions);
    }
    expect(clearMeasures).toHaveBeenCalledTimes(2);

    // Non-React measures do not count toward the budget.
    for (let i = 0; i < 16384 - 1; i += 1) {
      fakePerformance.measure('custom-measure', {
        detail: { source: 'web-shell' },
      });
    }
    expect(clearMeasures).toHaveBeenCalledTimes(2);
  });
});
