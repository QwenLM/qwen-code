/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import { assertFullIcuAvailable, icuSmallNeedsProbe } from './icu-check.js';
import { scrubNodeOptionsLoaderFlags } from '../config/shared-env-keys.js';

const okProbe = () => ({ status: 0, signal: null });
const segfaultProbe = () => ({
  status: null,
  signal: 'SIGSEGV' as NodeJS.Signals,
});

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

  function withIcuSmall(value: unknown, fn: () => void) {
    // needsProbe() reads process.config.variables; the variables object is
    // frozen, but process.config itself is reconfigurable. Pin the branch
    // instead of asserting a property of the runner's Node build.
    const original = Object.getOwnPropertyDescriptor(process, 'config')!;
    const variables = {
      ...(original.value as { variables: Record<string, unknown> }).variables,
    };
    if (value === undefined) {
      delete variables['icu_small'];
    } else {
      variables['icu_small'] = value;
    }
    Object.defineProperty(process, 'config', {
      ...original,
      value: { ...(original.value as object), variables },
    });
    try {
      fn();
    } finally {
      Object.defineProperty(process, 'config', original);
    }
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

  it('skips the probe on builds that record full ICU', () => {
    withIcuSmall(false, () => {
      const probe = vi.fn(okProbe);
      assertFullIcuAvailable(probe);
      expect(probe).not.toHaveBeenCalled();
    });
  });

  it('probes on small-icu builds even when Intl.Segmenter exists', () => {
    withIcuSmall(true, () => {
      const probe = vi.fn(okProbe);
      assertFullIcuAvailable(probe);
      expect(probe).toHaveBeenCalledTimes(1);
    });
  });

  it('probes when the build does not record icu_small', () => {
    withIcuSmall(undefined, () => {
      const probe = vi.fn(okProbe);
      assertFullIcuAvailable(probe);
      expect(probe).toHaveBeenCalledTimes(1);
    });
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

  it('warns and continues when the probe process cannot even start', () => {
    // A spawn-level failure is not an ICU verdict: the host may be fine, and
    // refusing it would be a wrong diagnosis.
    const { exitMock, written } = captureFailure();
    const spawnErrorProbe = () => ({
      status: null,
      signal: null,
      error: new Error('spawn failed'),
    });
    withoutSegmenter(() => {
      assertFullIcuAvailable(spawnErrorProbe);
    });
    expect(exitMock).not.toHaveBeenCalled();
    expect(written.join('')).toContain('failed to start');
  });

  it('probes when the Intl binding itself is absent', () => {
    // no-icu builds can strip the Intl namespace entirely; the check must
    // report instead of throwing ReferenceError on `typeof Intl.Segmenter`
    const original = (globalThis as Record<string, unknown>)['Intl'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any)['Intl'] = undefined;
    try {
      const probe = vi.fn(okProbe);
      assertFullIcuAvailable(probe);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any)['Intl'] = original;
    }
  });

  it('forwards a parent --icu-data-dir to the probe child', () => {
    // a user who repairs ICU with Node's own flag has a working parent; the
    // child must get the same flag or it faults and misdiagnoses the host
    const original = process.execArgv;
    try {
      process.execArgv = ['--icu-data-dir=/tmp/fake-icu'];
      let captured: string[] = [];
      withoutSegmenter(() => {
        assertFullIcuAvailable((command, args) => {
          captured = args;
          return { status: 0, signal: null };
        });
      });
      expect(captured).toEqual([
        '--icu-data-dir=/tmp/fake-icu',
        '-e',
        expect.stringContaining('.segment('),
      ]);

      process.execArgv = ['--icu-data-dir', '/tmp/fake-icu'];
      captured = [];
      withoutSegmenter(() => {
        assertFullIcuAvailable((command, args) => {
          captured = args;
          return { status: 0, signal: null };
        });
      });
      expect(captured).toEqual([
        '--icu-data-dir',
        '/tmp/fake-icu',
        '-e',
        expect.stringContaining('.segment('),
      ]);
    } finally {
      process.execArgv = original;
    }
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

  it('keeps --icu-data-dir in NODE_OPTIONS while dropping its loader hooks', () => {
    // NODE_OPTIONS is a documented carrier of the ICU data path: the probe
    // child must keep that flag even while the bogus --require is scrubbed.
    const hadOptions = 'NODE_OPTIONS' in process.env;
    const originalOptions = process.env['NODE_OPTIONS'];
    process.env['NODE_OPTIONS'] =
      '--require /nonexistent-icu-test-module --icu-data-dir=/tmp/ignored-on-full-icu';
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

  it('drops only loader hooks from a NODE_OPTIONS value', () => {
    expect(
      scrubNodeOptionsLoaderFlags(
        '--require /bogus --icu-data-dir=/icu --max-old-space-size=4096 --import=./spy.mjs',
      ),
    ).toBe('--icu-data-dir=/icu --max-old-space-size=4096');
  });
});
