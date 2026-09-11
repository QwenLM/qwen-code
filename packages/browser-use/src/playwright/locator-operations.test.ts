/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('releases every modifier when a later chord token is rejected', async () => {
    const f = pressFixture();
    f.locator.press.mockRejectedValue(new Error('Unknown key: "Esc"'));
    await expect(
      executeLocatorOperation('locator.press', f.args, f.tab),
    ).rejects.toThrow('Unknown key');
    expect(f.keyboard.up).toHaveBeenCalledTimes(4);
    expect(f.keyboard.up).toHaveBeenCalledWith('Control');
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
    });
    vi.stubGlobal(
      'setTimeout',
      vi.fn(() => 0),
    );
    const element = {
      scrollIntoView: vi.fn(),
      closest: vi.fn(() => media),
      querySelector: vi.fn(() => null),
    };
    const locator = {
      evaluate: vi.fn(async (read: (element: unknown) => unknown) =>
        read(element),
      ),
    };
    const tab = { page: { locator: () => locator } } as unknown as TabState;
    const args = {
      steps: [{ kind: 'locator', selector: 'img' }],
      timeoutMs: 100,
    };
    return { anchor, fetchMock, locator, tab, args };
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
    );
    expect(f.anchor.href.startsWith('blob:')).toBe(true);
    expect(f.anchor.download).toBe('video.mp4');
    expect(f.anchor.click).toHaveBeenCalledOnce();
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
