/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import { assertFullIcuAvailable, icuSmallNeedsProbe } from './icu-check.js';

const okProbe = () => ({ status: 0 });
const segfaultProbe = () => ({ status: 139 });

describe('icuSmallNeedsProbe', () => {
  it('skips the probe on builds that record full ICU', () => {
    expect(icuSmallNeedsProbe(false)).toBe(false);
    expect(icuSmallNeedsProbe('false')).toBe(false);
  });

  it('probes on small-icu builds', () => {
    expect(icuSmallNeedsProbe(true)).toBe(true);
    expect(icuSmallNeedsProbe('true')).toBe(true);
  });

  it('probes when the build does not record icu_small', () => {
    expect(icuSmallNeedsProbe(undefined)).toBe(true);
    expect(icuSmallNeedsProbe(null)).toBe(true);
  });
});

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

  function withoutSegmenter(fn: () => void) {
    // force the needs-probe path by hiding Intl.Segmenter from this test's view
    const original = Intl.Segmenter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Intl as any).Segmenter = undefined;
    try {
      fn();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Intl as any).Segmenter = original;
    }
  }

  it('skips the probe entirely on this full-icu dev runtime', () => {
    // dev/CI Node reports icu_small=false, so the gate is closed here
    const probe = vi.fn(okProbe);
    assertFullIcuAvailable(probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it('exits with an actionable message when the probe child segfaults', () => {
    const { exitMock, written } = captureFailure();
    withoutSegmenter(() => {
      expect(() => assertFullIcuAvailable(segfaultProbe)).toThrow('exit:1');
    });
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(written.join('')).toContain('full ICU data');
    expect(written.join('')).toContain('nodejs-full-i18n');
  });

  it('passes when the probe child runs cleanly', () => {
    withoutSegmenter(() => {
      assertFullIcuAvailable(okProbe);
    });
  });

  it('treats a probe that cannot even spawn as missing ICU', () => {
    captureFailure();
    const throwingProbe = () => {
      throw new Error('spawn failed');
    };
    withoutSegmenter(() => {
      expect(() => assertFullIcuAvailable(throwingProbe)).toThrow('exit:1');
    });
  });

  it('runs the real child probe successfully on a healthy runtime', () => {
    // exercises defaultProbe and the real PROBE_SOURCE: a child Node process
    // iterates an Intl.Segmenter segmentation and must exit 0 here
    withoutSegmenter(() => {
      assertFullIcuAvailable();
    });
  });

  it('keeps a broken NODE_OPTIONS out of the probe child', () => {
    // without the scrub this child would die resolving the bogus --require
    // and the host would be misdiagnosed as ICU-less
    const hadOptions = 'NODE_OPTIONS' in process.env;
    const originalOptions = process.env['NODE_OPTIONS'];
    process.env['NODE_OPTIONS'] = '--require /nonexistent-icu-test-module';
    try {
      withoutSegmenter(() => {
        assertFullIcuAvailable();
      });
    } finally {
      if (hadOptions) {
        process.env['NODE_OPTIONS'] = originalOptions;
      } else {
        delete process.env['NODE_OPTIONS'];
      }
    }
  });
});
