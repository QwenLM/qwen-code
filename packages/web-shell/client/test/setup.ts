import { vi } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const globalWithDom = globalThis as typeof globalThis & {
  Element?: typeof Element;
  ResizeObserver?: typeof ResizeObserver;
};

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

// jsdom implements getClientRects()/getBoundingClientRect() on Element but not
// on Range. CodeMirror's async measure pass (scheduled via requestAnimationFrame)
// calls them on a text Range, so without this stub it throws
// "textRange(...).getClientRects is not a function" from a rAF callback after a
// test has completed — an unhandled error that flakes the whole run even though
// every assertion passed.
if (typeof Range !== 'undefined') {
  const emptyRectList = {
    length: 0,
    item: () => null,
    *[Symbol.iterator] () {},
  } as unknown as DOMRectList;
  const emptyRect = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON() {
      return {};
    },
  } as DOMRect;
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => emptyRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => emptyRect;
  }
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
