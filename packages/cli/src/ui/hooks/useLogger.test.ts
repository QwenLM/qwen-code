/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { useLogger } from './useLogger.js';

const pending = vi.hoisted(
  () => [] as Array<{ sessionId: string; finish: () => void }>,
);
vi.mock('@qwen-code/qwen-code-core/core/logger.js', () => ({
  Logger: class {
    constructor(readonly sessionId: string) {}
    initialize() {
      return new Promise<void>((finish) =>
        pending.push({ sessionId: this.sessionId, finish }),
      );
    }
  },
}));

beforeEach(() => {
  pending.length = 0;
});

it('never exposes the previous session logger during asynchronous initialization', async () => {
  const storage = {} as Storage;
  const { result, rerender } = renderHook(({ id }) => useLogger(storage, id), {
    initialProps: { id: 'old' },
  });
  expect(result.current).toBeNull();
  await act(async () => pending[0].finish());
  const oldLogger = result.current;
  expect(oldLogger).not.toBeNull();
  rerender({ id: 'new' });
  expect(result.current).toBeNull();
  await act(async () => pending[1].finish());
  expect(result.current).not.toBeNull();
  expect(result.current).not.toBe(oldLogger);
});

it('ignores a late old initialization and invalidates a changed storage owner', async () => {
  const oldStorage = {} as Storage;
  const newStorage = {} as Storage;
  const { result, rerender, unmount } = renderHook(
    ({ id, storage }) => useLogger(storage, id),
    { initialProps: { id: 'old', storage: oldStorage } },
  );
  rerender({ id: 'new', storage: oldStorage });
  await act(async () => pending[1].finish());
  const newLogger = result.current;
  await act(async () => pending[0].finish());
  expect(result.current).toBe(newLogger);
  rerender({ id: 'new', storage: newStorage });
  expect(result.current).toBeNull();
  unmount();
  await act(async () => pending[2].finish());
  expect(result.current).toBeNull();
});
