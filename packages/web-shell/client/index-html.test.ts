import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

function extractMeasureScript(): string {
  const html = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
  const script = Array.from(
    html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  )
    .map((match) => match[1] ?? '')
    .find((source) => source.includes('performance.measure ='));

  if (!script) throw new Error('Performance measure guard not found');
  return script;
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
