/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHROME_DOCUMENTATION } from '../core/chrome-runtime-documentation.js';
import type { LocatorStep } from '../core/primitives.js';
import { executeLocatorOperation } from './locator-operations.js';
import type { TabState } from './runtime-state.js';

class ElementFixture {
  isConnected = true;
  isContentEditable = false;
  textContent = '';
  matches = vi.fn(() => true);
}
class InputFixture extends ElementFixture {
  value = '';
}

beforeEach(() => {
  vi.stubGlobal('HTMLElement', ElementFixture);
  vi.stubGlobal('HTMLInputElement', InputFixture);
  vi.stubGlobal('HTMLTextAreaElement', class extends ElementFixture {});
  vi.stubGlobal('HTMLSelectElement', class extends ElementFixture {});
});
afterEach(() => vi.unstubAllGlobals());

function fixture(initial = new InputFixture() as ElementFixture) {
  let target = initial;
  const handle = {
    evaluate: vi.fn(async (read: (check: () => boolean) => boolean) =>
      read(() => false),
    ),
    dispose: vi.fn(async () => undefined),
  };
  const locator = {
    evaluate: vi.fn(async (read: (element: ElementFixture) => unknown) =>
      read(target),
    ),
    evaluateHandle: vi.fn(
      async (capture: (element: ElementFixture) => () => boolean) => {
        const check = capture(target);
        handle.evaluate.mockImplementation(async (read) => read(check));
        return handle;
      },
    ),
    pressSequentially: vi.fn(
      async (_value: string, _options?: { timeout: number }) => undefined,
    ),
    fill: vi.fn(async () => undefined),
    dispatchEvent: vi.fn(async () => {
      throw new Error('Target was removed');
    }),
  };
  const tab = { page: { locator: () => locator } } as unknown as TabState;
  const args = {
    steps: [{ kind: 'locator', selector: '#target' }],
    value: 'a',
    timeoutMs: 100,
  };
  return {
    initial,
    handle,
    locator,
    tab,
    replace(next: ElementFixture) {
      target = next;
    },
    type(value = 'a') {
      return executeLocatorOperation('locator.type', { ...args, value }, tab);
    },
    fill() {
      return executeLocatorOperation('locator.fill', args, tab);
    },
  };
}

describe('locator input completion', () => {
  it('does not run a second action after Playwright fills the target', async () => {
    const f = fixture();
    await expect(f.fill()).resolves.toBeNull();
    expect(f.locator.fill).toHaveBeenCalledExactlyOnceWith('a', {
      timeout: 100,
    });
    expect(f.locator.dispatchEvent).not.toHaveBeenCalled();
  });

  it('reports blocked input on the original focused editable target', async () => {
    const f = fixture();
    await expect(f.type()).rejects.toMatchObject({ code: 'INPUT_BLOCKED' });
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });

  it('accepts changed input and releases the browser handle', async () => {
    const input = new InputFixture();
    const f = fixture(input);
    f.locator.pressSequentially.mockImplementation(async () => {
      input.value = 'a';
    });
    await expect(f.type()).resolves.toBeNull();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });

  it('does not compare against a replacement element with the same locator', async () => {
    const f = fixture();
    f.locator.pressSequentially.mockImplementation(async () => {
      f.initial.isConnected = false;
      f.replace(new InputFixture());
    });
    await expect(f.type()).resolves.toBeNull();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });

  it('allows keyboard widgets without editable values', async () => {
    const f = fixture(new ElementFixture());
    await expect(f.type()).resolves.toBeNull();
    expect(f.locator.pressSequentially).toHaveBeenCalledExactlyOnceWith('a', {
      timeout: 100,
    });
  });

  it('does not report blocked input after focus moves away', async () => {
    const f = fixture();
    f.locator.pressSequentially.mockImplementation(async () => {
      f.initial.matches.mockReturnValue(false);
    });
    await expect(f.type()).resolves.toBeNull();
  });

  it('preserves input success when navigation destroys the probe context', async () => {
    const f = fixture();
    f.locator.pressSequentially.mockImplementation(async () => {
      f.handle.evaluate.mockRejectedValue(
        new Error('Execution context was destroyed'),
      );
    });
    await expect(f.type()).resolves.toBeNull();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });

  it('preserves the input error even when handle cleanup fails', async () => {
    const f = fixture();
    const failure = new Error('Input failed');
    f.locator.pressSequentially.mockRejectedValue(failure);
    f.handle.dispose.mockRejectedValue(new Error('Context closed'));
    await expect(f.type()).rejects.toBe(failure);
    expect(f.handle.evaluate).not.toHaveBeenCalled();
    expect(f.handle.dispose).toHaveBeenCalledOnce();
  });

  it('does not create a probe for empty input', async () => {
    const f = fixture();
    await expect(f.type('')).resolves.toBeNull();
    expect(f.locator.evaluateHandle).not.toHaveBeenCalled();
  });

  it('grows the typing deadline with the input length unless one is given', async () => {
    const input = new InputFixture();
    const f = fixture(input);
    f.locator.pressSequentially.mockImplementation(async (value: string) => {
      input.value = value;
    });
    const steps = [{ kind: 'locator', selector: '#target' }] as const;
    await executeLocatorOperation(
      'locator.type',
      { steps, value: 'a'.repeat(10_000) },
      f.tab,
    );
    expect(f.locator.pressSequentially).toHaveBeenCalledWith(
      'a'.repeat(10_000),
      { timeout: 20_000 },
    );
    await executeLocatorOperation(
      'locator.type',
      { steps, value: 'a'.repeat(60_000) },
      f.tab,
    );
    expect(f.locator.pressSequentially).toHaveBeenLastCalledWith(
      'a'.repeat(60_000),
      { timeout: 120_000 },
    );
    await executeLocatorOperation(
      'locator.type',
      { steps, value: 'a'.repeat(10_000), timeoutMs: 500 },
      f.tab,
    );
    expect(f.locator.pressSequentially).toHaveBeenLastCalledWith(
      'a'.repeat(10_000),
      { timeout: 500 },
    );
  });
});

describe('locator.press', () => {
  function pressFixture() {
    const keyboard = { up: vi.fn(async () => undefined) };
    const locator = { press: vi.fn(async () => undefined) };
    const tab = {
      page: { locator: () => locator, keyboard },
    } as unknown as TabState;
    const args = {
      steps: [{ kind: 'locator', selector: '#target' }],
      value: 'Control+Esc',
    };
    return { keyboard, locator, tab, args };
  }

  it('releases every held token when a later chord token is rejected', async () => {
    const f = pressFixture();
    f.locator.press.mockRejectedValue(new Error('Unknown key: "Esc"'));
    await expect(
      executeLocatorOperation('locator.press', f.args, f.tab),
    ).rejects.toThrow('Unknown key');
    expect(f.keyboard.up).toHaveBeenCalledTimes(2);
    expect(f.keyboard.up.mock.calls).toEqual([['Esc'], ['Control']]);
  });

  it('releases the tokens Playwright derives, not a naive split of the chord', async () => {
    const f = pressFixture();
    f.args.value = 'Control+++Bogus';
    f.locator.press.mockRejectedValue(new Error('Unknown key: "Bogus"'));
    await expect(
      executeLocatorOperation('locator.press', f.args, f.tab),
    ).rejects.toThrow('Unknown key');
    expect(f.locator.press).toHaveBeenCalledExactlyOnceWith('Control+++Bogus', {
      timeout: 5_000,
      noWaitAfter: true,
    });
    expect(f.keyboard.up.mock.calls).toEqual([['Bogus'], ['+'], ['Control']]);
  });

  it('leaves the keyboard alone when the press succeeds', async () => {
    const f = pressFixture();
    await expect(
      executeLocatorOperation('locator.press', f.args, f.tab),
    ).resolves.toBeNull();
    expect(f.locator.press).toHaveBeenCalledExactlyOnceWith('Control+Esc', {
      timeout: 5_000,
      noWaitAfter: true,
    });
    expect(f.keyboard.up).not.toHaveBeenCalled();
  });
});

describe('locator read defaults', () => {
  // The model learns the read default from the documentation string, so the
  // runtime constant and the documented figure must move together.
  const READ_TIMEOUT_MS = 1_000;

  it('waits the documented default when a read passes no timeoutMs', async () => {
    const locator = {
      innerText: vi.fn(async (_options: { timeout: number }) => 'text'),
      textContent: vi.fn(async (_options: { timeout: number }) => 'text'),
      getAttribute: vi.fn(
        async (_name: string, _options: { timeout: number }) => 'value',
      ),
      isEnabled: vi.fn(async (_options: { timeout: number }) => true),
    };
    const tab = { page: { locator: () => locator } } as unknown as TabState;
    const steps = [{ kind: 'locator', selector: '#row' }];

    await expect(
      executeLocatorOperation('locator.innerText', { steps }, tab),
    ).resolves.toBe('text');
    await expect(
      executeLocatorOperation('locator.textContent', { steps }, tab),
    ).resolves.toBe('text');
    await expect(
      executeLocatorOperation(
        'locator.getAttribute',
        { steps, name: 'href' },
        tab,
      ),
    ).resolves.toBe('value');
    await expect(
      executeLocatorOperation('locator.isEnabled', { steps }, tab),
    ).resolves.toBe(true);

    expect(locator.innerText).toHaveBeenCalledExactlyOnceWith({
      timeout: READ_TIMEOUT_MS,
    });
    expect(locator.textContent).toHaveBeenCalledExactlyOnceWith({
      timeout: READ_TIMEOUT_MS,
    });
    expect(locator.getAttribute).toHaveBeenCalledExactlyOnceWith('href', {
      timeout: READ_TIMEOUT_MS,
    });
    expect(locator.isEnabled).toHaveBeenCalledExactlyOnceWith({
      timeout: READ_TIMEOUT_MS,
    });
    expect(DEFAULT_CHROME_DOCUMENTATION).toContain(
      `Reads default to a ${READ_TIMEOUT_MS / 1_000}s timeout`,
    );
  });
});

describe('buildLocator', () => {
  type Call = [scope: string, method: string, args: unknown[]];
  const PATH = Symbol('path');
  const chainMethods = [
    'locator',
    'getByRole',
    'getByText',
    'getByLabel',
    'getByPlaceholder',
    'getByTestId',
    'contentFrame',
    'filter',
    'first',
    'last',
    'nth',
    'and',
    'or',
  ] as const;

  // Every chain method records its receiver's path and returns a child, so
  // a dispatched plan yields the exact Playwright call sequence it produces.
  function recorder() {
    const calls: Call[] = [];
    const describeArg = (value: unknown): unknown => {
      if (
        value === null ||
        typeof value !== 'object' ||
        value instanceof RegExp
      )
        return value;
      if (PATH in value) return value[PATH];
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, describeArg(item)]),
      );
    };
    const node = (path: string): Record<string | symbol, unknown> => {
      const self: Record<string | symbol, unknown> = {
        [PATH]: path,
        count: vi.fn(async () => 0),
      };
      for (const method of chainMethods) {
        self[method] = (...args: unknown[]) => {
          calls.push([path, method, args.map(describeArg)]);
          return node(`${path}.${method}`);
        };
      }
      return self;
    };
    return { calls, tab: { page: node('page') } as unknown as TabState };
  }

  it.each<[string, LocatorStep[], Call[]]>([
    [
      'frame scoping',
      [
        { kind: 'frame', selector: 'iframe#pay' },
        { kind: 'getByRole', role: 'button', name: 'Pay' },
      ],
      [
        ['page', 'locator', ['iframe#pay']],
        ['page.locator', 'contentFrame', []],
        ['page.locator.contentFrame', 'getByRole', ['button', { name: 'Pay' }]],
      ],
    ],
    [
      'an and operand',
      [
        { kind: 'locator', selector: 'button' },
        { kind: 'and', steps: [{ kind: 'getByText', text: 'Submit' }] },
      ],
      [
        ['page', 'locator', ['button']],
        ['page', 'getByText', ['Submit', {}]],
        ['page.locator', 'and', ['page.getByText']],
      ],
    ],
    [
      'an or operand',
      [
        { kind: 'locator', selector: 'button' },
        { kind: 'or', steps: [{ kind: 'getByText', text: 'Submit' }] },
      ],
      [
        ['page', 'locator', ['button']],
        ['page', 'getByText', ['Submit', {}]],
        ['page.locator', 'or', ['page.getByText']],
      ],
    ],
    [
      'a filter with text and a nested has operand',
      [
        { kind: 'getByTestId', testId: 'row' },
        {
          kind: 'filter',
          hasText: { regex: '^a', flags: 'i' },
          has: [
            { kind: 'getByRole', role: 'cell', name: 'Total', exact: true },
          ],
          visible: true,
        },
      ],
      [
        ['page', 'getByTestId', ['row']],
        ['page', 'getByRole', ['cell', { name: 'Total', exact: true }]],
        [
          'page.getByTestId',
          'filter',
          [{ hasText: /^a/i, has: 'page.getByRole', visible: true }],
        ],
      ],
    ],
    [
      'positional steps',
      [
        { kind: 'getByLabel', text: 'Name', exact: true },
        { kind: 'nth', index: -1 },
        { kind: 'getByPlaceholder', text: 'Search' },
        { kind: 'last' },
      ],
      [
        ['page', 'getByLabel', ['Name', { exact: true }]],
        ['page.getByLabel', 'nth', [-1]],
        ['page.getByLabel.nth', 'getByPlaceholder', ['Search', {}]],
        ['page.getByLabel.nth.getByPlaceholder', 'last', []],
      ],
    ],
  ])(
    'reconstructs %s in Playwright call order',
    async (_name, steps, expected) => {
      const f = recorder();
      await expect(
        executeLocatorOperation('locator.count', { steps }, f.tab),
      ).resolves.toBe(0);
      expect(f.calls).toEqual(expected);
    },
  );

  it('rejects a plan that ends inside a frame without an element selector', async () => {
    const f = recorder();
    await expect(
      executeLocatorOperation(
        'locator.count',
        { steps: [{ kind: 'frame', selector: 'iframe' }] },
        f.tab,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LOCATOR' });
  });
});

describe('locator.allTextContents', () => {
  function textsFixture() {
    const handle = { waitFor: vi.fn(async () => undefined) };
    const locator = {
      first: vi.fn(() => handle),
      allTextContents: vi.fn(async () => ['a']),
    };
    const tab = { page: { locator: () => locator } } as unknown as TabState;
    const args = {
      steps: [{ kind: 'locator', selector: '.row' }],
      timeoutMs: 50,
    };
    return { handle, locator, tab, args };
  }

  it('waits for the first match within the caller budget before reading', async () => {
    const f = textsFixture();
    await expect(
      executeLocatorOperation('locator.allTextContents', f.args, f.tab),
    ).resolves.toEqual(['a']);
    expect(f.handle.waitFor).toHaveBeenCalledExactlyOnceWith({
      state: 'attached',
      timeout: 50,
    });
  });

  it('resolves an empty read when nothing attaches in time', async () => {
    const f = textsFixture();
    const timeout = new Error('Timeout 50ms exceeded');
    timeout.name = 'TimeoutError';
    f.handle.waitFor.mockRejectedValue(timeout);
    f.locator.allTextContents.mockResolvedValue([]);
    await expect(
      executeLocatorOperation('locator.allTextContents', f.args, f.tab),
    ).resolves.toEqual([]);
  });

  it('propagates a wait failure that is not a timeout', async () => {
    const f = textsFixture();
    f.handle.waitFor.mockRejectedValue(new Error('Target crashed'));
    await expect(
      executeLocatorOperation('locator.allTextContents', f.args, f.tab),
    ).rejects.toThrow('Target crashed');
  });
});

describe('locator.evaluate bindings', () => {
  // The SDK emits scripts that read the free variables `element` and
  // `elements`; the runtime binds them when it compiles the script inside
  // the page. Run the real page-side callbacks here so a renamed binding on
  // either side surfaces as the ReferenceError it would be in production.
  it('binds element and elements for the page-side script', async () => {
    const evaluate = vi.fn(
      async (
        run: (element: unknown, source: string) => Promise<string>,
        source: string,
      ) => run({ tagName: 'BODY' }, source),
    );
    const evaluateAll = vi.fn(
      async (
        run: (elements: unknown[], source: string) => Promise<string>,
        source: string,
      ) => run([{}, {}], source),
    );
    const handle = { waitFor: vi.fn(async () => undefined) };
    const locator = { first: vi.fn(() => handle), evaluate, evaluateAll };
    const tab = { page: { locator: () => locator } } as unknown as TabState;
    const steps = [{ kind: 'locator', selector: 'body' }];
    await expect(
      executeLocatorOperation(
        'locator.evaluate',
        { steps, script: 'return element.tagName;', timeoutMs: 50 },
        tab,
      ),
    ).resolves.toBe('BODY');
    await expect(
      executeLocatorOperation(
        'locator.evaluateAll',
        { steps, script: 'return elements.length;', timeoutMs: 50 },
        tab,
      ),
    ).resolves.toBe(2);
  });
});

describe('locator.evaluateAll', () => {
  function evaluateAllFixture() {
    const handle = { waitFor: vi.fn(async () => undefined) };
    const locator = {
      first: vi.fn(() => handle),
      evaluateAll: vi.fn(async () => '["a"]'),
    };
    const tab = { page: { locator: () => locator } } as unknown as TabState;
    const args = {
      steps: [{ kind: 'locator', selector: '.row' }],
      script: 'return elements.length;',
      timeoutMs: 50,
    };
    return { handle, locator, tab, args };
  }

  it('waits for the first match within the caller budget before evaluating', async () => {
    const f = evaluateAllFixture();
    await expect(
      executeLocatorOperation('locator.evaluateAll', f.args, f.tab),
    ).resolves.toEqual(['a']);
    expect(f.handle.waitFor).toHaveBeenCalledExactlyOnceWith({
      state: 'attached',
      timeout: 50,
    });
  });

  it('still evaluates when nothing attaches in time', async () => {
    const f = evaluateAllFixture();
    const timeout = new Error('Timeout 50ms exceeded');
    timeout.name = 'TimeoutError';
    f.handle.waitFor.mockRejectedValue(timeout);
    f.locator.evaluateAll.mockResolvedValue('[]');
    await expect(
      executeLocatorOperation('locator.evaluateAll', f.args, f.tab),
    ).resolves.toEqual([]);
  });

  it('propagates a wait failure that is not a timeout', async () => {
    const f = evaluateAllFixture();
    f.handle.waitFor.mockRejectedValue(new Error('Target crashed'));
    await expect(
      executeLocatorOperation('locator.evaluateAll', f.args, f.tab),
    ).rejects.toThrow('Target crashed');
  });
});

describe('locator.downloadMedia', () => {
  function downloadFixture(media: Record<string, unknown>) {
    const anchor = {
      href: '',
      download: '',
      rel: '',
      style: {} as Record<string, string>,
      click: vi.fn(),
      remove: vi.fn(),
    };
    const fetchMock = vi.fn(
      async (
        _url: string,
      ): Promise<{
        ok: boolean;
        status?: number;
        blob: () => Promise<Blob>;
      }> => ({
        ok: true,
        blob: async () => new Blob(['bytes']),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      createElement: () => anchor,
      body: { append: vi.fn() },
      baseURI: 'https://site.example/',
    });
    vi.stubGlobal(
      'setTimeout',
      vi.fn(() => 0),
    );
    const element = {
      scrollIntoView: vi.fn(),
      closest: vi.fn((): unknown => media),
      querySelectorAll: vi.fn((_selector: string): unknown[] => []),
    };
    const locator = {
      evaluate: vi.fn(
        async (
          read: (element: unknown, budgetMs: number) => unknown,
          budgetMs?: number,
        ) => read(element, budgetMs ?? 100),
      ),
    };
    const tab = { page: { locator: () => locator } } as unknown as TabState;
    const args = {
      steps: [{ kind: 'locator', selector: 'img' }],
      timeoutMs: 100,
    };
    return { anchor, element, fetchMock, locator, tab, args };
  }

  it('downloads a fetched object URL so a cross-origin URL cannot navigate the tab', async () => {
    const f = downloadFixture({
      currentSrc: 'https://cdn.example.com/media/video.mp4',
    });
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).resolves.toBeNull();
    expect(f.fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://cdn.example.com/media/video.mp4',
      { signal: expect.any(AbortSignal) },
    );
    expect(f.anchor.href.startsWith('blob:')).toBe(true);
    expect(f.anchor.download).toBe('video.mp4');
    expect(f.anchor.click).toHaveBeenCalledOnce();
  });

  it.each([
    'blob:https://page.example/7c9e6679-7425-40de-944b-e07fc1f90ae7',
    'data:image/png;base64,iVBORw0KGgo=',
  ])('lets the browser name a download from %s by MIME type', async (url) => {
    const f = downloadFixture({ currentSrc: url });
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).resolves.toBeNull();
    expect(f.anchor.download).toBe('');
    expect(f.anchor.click).toHaveBeenCalledOnce();
  });

  it.each([
    'https://cdn.example.com/photo.jpg#preview',
    'https://cdn.example.com/photo.jpg?w=1#preview',
  ])(
    'strips the query and the fragment from the file name of %s',
    async (url) => {
      const f = downloadFixture({ currentSrc: url });
      await expect(
        executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
      ).resolves.toBeNull();
      expect(f.anchor.download).toBe('photo.jpg');
    },
  );

  it('prefers media contained in a located wrapper over an ancestor link', async () => {
    const f = downloadFixture({ href: '/product' });
    f.element.querySelectorAll.mockImplementation((selector: string) =>
      selector === 'img, video, source'
        ? [{ currentSrc: 'https://cdn.example.com/inner.webp' }]
        : [],
    );
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).resolves.toBeNull();
    expect(f.fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://cdn.example.com/inner.webp',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('prefers a contained image over an anchor that precedes it in document order', async () => {
    const f = downloadFixture({});
    f.element.querySelectorAll.mockImplementation((selector: string) =>
      selector === 'img, video, source'
        ? [{ currentSrc: 'https://cdn.example.com/photo.jpg' }]
        : [{ href: 'https://example.com/product' }],
    );
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).resolves.toBeNull();
    expect(f.fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://cdn.example.com/photo.jpg',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('reads the first srcset URL when a matched source exposes no src', async () => {
    const f = downloadFixture({});
    f.element.querySelectorAll.mockImplementation((selector: string) =>
      selector === 'img, video, source'
        ? [
            {
              srcset:
                'https://cdn.example.com/hero.webp 1x, https://cdn.example.com/hero@2x.webp 2x',
            },
            { src: 'https://cdn.example.com/hero.png' },
          ]
        : [],
    );
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).resolves.toBeNull();
    expect(f.fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://cdn.example.com/hero.webp',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('resolves a relative srcset candidate against the document base', async () => {
    const f = downloadFixture({});
    f.element.querySelectorAll.mockImplementation((selector: string) =>
      selector === 'img, video, source'
        ? [{ srcset: '/images/hero.webp 1x, /images/hero@2x.webp 2x' }]
        : [],
    );
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).resolves.toBeNull();
    expect(f.fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://site.example/images/hero.webp',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('keeps a srcset URL that itself contains a comma whole', async () => {
    const f = downloadFixture({});
    f.element.querySelectorAll.mockImplementation((selector: string) =>
      selector === 'img, video, source'
        ? [{ srcset: '/c_fill,w_400/hero.jpg 1x' }]
        : [],
    );
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).resolves.toBeNull();
    expect(f.fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://site.example/c_fill,w_400/hero.jpg',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('falls back to a source child when the located video has not loaded', async () => {
    const f = downloadFixture({});
    Object.assign(f.element, { currentSrc: '', src: '' });
    f.element.querySelectorAll.mockImplementation((selector: string) =>
      selector === 'img, video, source'
        ? [{ src: 'https://cdn.example.com/movie.mp4' }]
        : [],
    );
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).resolves.toBeNull();
    expect(f.fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://cdn.example.com/movie.mp4',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('reports the cross-origin policy when the page cannot read the resource', async () => {
    const f = downloadFixture({
      currentSrc: 'https://cdn.example.com/media/video.mp4',
    });
    f.fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).rejects.toThrow('cross-origin without CORS');
    expect(f.anchor.click).not.toHaveBeenCalled();
  });

  it('rejects a page-controlled URL with an unsupported scheme', async () => {
    const f = downloadFixture({ href: 'file:///etc/passwd' });
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).rejects.toThrow('Unsupported media URL scheme');
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('bounds the page-side transfer by the caller deadline', async () => {
    const f = downloadFixture({
      currentSrc: 'https://cdn.example.com/media/video.mp4',
    });
    f.locator.evaluate.mockReturnValue(new Promise(() => {}));
    await expect(
      executeLocatorOperation(
        'locator.downloadMedia',
        { ...f.args, timeoutMs: 50 },
        f.tab,
      ),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('falls back past an unloaded element\u2019s empty currentSrc', async () => {
    const f = downloadFixture({
      currentSrc: '',
      src: 'https://cdn.example.com/image.png',
    });
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).resolves.toBeNull();
    expect(f.fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://cdn.example.com/image.png',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('fails loudly when the fetch yields no body', async () => {
    const f = downloadFixture({ src: 'https://cdn.example.com/a.png' });
    f.fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      blob: async () => new Blob([]),
    });
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).rejects.toThrow('HTTP 403');
    expect(f.anchor.click).not.toHaveBeenCalled();
  });

  it('fails when the element exposes no downloadable URL', async () => {
    const f = downloadFixture({ currentSrc: '', src: '', href: '' });
    await expect(
      executeLocatorOperation('locator.downloadMedia', f.args, f.tab),
    ).rejects.toThrow('does not expose a downloadable URL');
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
});
