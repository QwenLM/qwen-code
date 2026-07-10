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
