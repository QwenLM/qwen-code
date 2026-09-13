/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import { assertFullIcuAvailable } from './icu-check.js';

const okProbe = () => ({ status: 0 });
const segfaultProbe = () => ({ status: 139 });

describe('assertFullIcuAvailable', () => {
  const originalExit = process.exit;
  const originalStderr = process.stderr.write;

  afterEach(() => {
    process.exit = originalExit;
    process.stderr.write = originalStderr;
    vi.restoreAllMocks();
  });

  function captureFailure() {
    const exitMock = vi.fn((code?: number) => {
      throw new Error(`exit:${code}`);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = exitMock;
    const written: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    return { exitMock, written };
  }

  it('passes silently on a full-icu runtime', () => {
    // this host (dev/CI Node) has full ICU, so no probe child should run
    assertFullIcuAvailable(okProbe);
  });

  it('exits with an actionable message when the probe child segfaults', () => {
    const { exitMock, written } = captureFailure();
    // force the needs-probe path by hiding Intl.Segmenter from this test's view
    const original = Intl.Segmenter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Intl as any).Segmenter = undefined;
    try {
      expect(() => assertFullIcuAvailable(segfaultProbe)).toThrow('exit:1');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Intl as any).Segmenter = original;
    }
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(written.join('')).toContain('full ICU data');
    expect(written.join('')).toContain('nodejs-full-i18n');
  });

  it('passes when the probe child runs cleanly', () => {
    const original = Intl.Segmenter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Intl as any).Segmenter = undefined;
    try {
      assertFullIcuAvailable(okProbe);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Intl as any).Segmenter = original;
    }
  });

  it('treats a probe that cannot even spawn as missing ICU', () => {
    captureFailure();
    const original = Intl.Segmenter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Intl as any).Segmenter = undefined;
    const throwingProbe = () => {
      throw new Error('spawn failed');
    };
    try {
      expect(() => assertFullIcuAvailable(throwingProbe)).toThrow('exit:1');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Intl as any).Segmenter = original;
    }
  });
});
