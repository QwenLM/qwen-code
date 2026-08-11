/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { startDwsEventProcess } from './dws-event-stream.js';

describe('DWS event process', () => {
  it('becomes ready, forwards NDJSON lines, and stops by closing stdin', async () => {
    let resolveLine!: (line: string) => void;
    const line = new Promise<string>((resolve) => {
      resolveLine = resolve;
    });
    const onError = vi.fn();
    const fixture = fileURLToPath(
      new URL('./fixtures/dws-event-source.mjs', import.meta.url),
    );

    const subscription = await startDwsEventProcess(
      process.execPath,
      [fixture],
      resolveLine,
      onError,
    );

    await expect(line).resolves.toBe('{"type":"fixture"}');
    subscription.stop();
    await expect(subscription.closed).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});
