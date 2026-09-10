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
    pressSequentially: vi.fn(async () => undefined),
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
});
