import { vi } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const globalWithDom = globalThis as typeof globalThis & {
  Element?: typeof Element;
  Range?: typeof Range;
  ResizeObserver?: typeof ResizeObserver;
};

function createEmptyDOMRect(): DOMRect {
  if (typeof DOMRect === 'function') {
    return new DOMRect(0, 0, 0, 0);
  }

  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function createEmptyDOMRectList(): DOMRectList {
  return {
    length: 0,
    item: () => null,
  } as DOMRectList;
}

if (typeof globalWithDom.ResizeObserver === 'undefined') {
  globalWithDom.ResizeObserver = class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}

if (
  typeof globalWithDom.Element !== 'undefined' &&
  !globalWithDom.Element.prototype.scrollIntoView
) {
  globalWithDom.Element.prototype.scrollIntoView = () => {};
}

// jsdom implements `Element.getClientRects` but not `Range.prototype`'s.
// CodeMirror's `measureTextSize` calls `range.getClientRects()` from a
// `requestAnimationFrame` measure pass, so in jsdom that async callback
// throws `TypeError: getClientRects is not a function`. Vitest surfaces it
// as an *unhandled error* that fails the whole run (exit 1) even when every
// test passes — and because it depends on rAF timing, it's flaky. Return an
// empty rect list (CodeMirror already handles the no-layout case).
if (typeof globalWithDom.Range !== 'undefined') {
  const rangePrototype = globalWithDom.Range.prototype as Range & {
    getBoundingClientRect?: () => DOMRect;
    getClientRects?: () => DOMRectList;
  };

  rangePrototype.getBoundingClientRect ??= createEmptyDOMRect;
  rangePrototype.getClientRects ??= createEmptyDOMRectList;
}

if (typeof navigator !== 'undefined' && !navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(() => Promise.resolve()),
    },
  });
}

if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

if (typeof navigator !== 'undefined' && !navigator.mediaDevices) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() =>
        Promise.reject(new Error('getUserMedia is not mocked for this test')),
      ),
    },
  });
}
