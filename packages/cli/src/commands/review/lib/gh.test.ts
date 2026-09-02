/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';

// Mock execFileSync before gh.ts is loaded. vi.mock is hoisted by vitest
// above all imports, so gh.ts sees the mock when it imports node:child_process.
const mockExecFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  default: { execFileSync: mockExecFileSync },
  execFileSync: mockExecFileSync,
}));

import {
  ghEnv,
  setGhHost,
  parseNdjson,
  gh,
  ghWithInput,
  ensureAuthenticated,
} from './gh.js';

// Host targeting is code, not prose: the subcommands thread `--host` here,
// and every gh child gets GH_HOST from ghEnv(). These tests pin the pure
// state machine; the spawn itself is exercised by the commands' own runs.
describe('setGhHost / ghEnv', () => {
  afterEach(() => setGhHost(undefined));

  it('defaults to inheriting the parent env untouched (undefined)', () => {
    expect(ghEnv()).toBeUndefined();
  });

  it('with a host set, extends the inherited env with GH_HOST', () => {
    setGhHost('github.example.com');
    const env = ghEnv();
    expect(env).toBeDefined();
    expect(env!['GH_HOST']).toBe('github.example.com');
    // Inherited keys survive — gh still needs PATH, HOME, its auth env.
    expect(env!['PATH']).toBe(process.env['PATH']);
  });

  it('accepts a host:port and resets on undefined or empty string', () => {
    setGhHost('ghe.internal:8443');
    expect(ghEnv()!['GH_HOST']).toBe('ghe.internal:8443');
    setGhHost('');
    expect(ghEnv()).toBeUndefined();
    setGhHost('ghe.internal');
    setGhHost(undefined);
    expect(ghEnv()).toBeUndefined();
  });

  it('rejects non-hostname input (an env value must never smuggle shell or spaces)', () => {
    expect(() => setGhHost('ghe.internal; rm -rf /')).toThrow(/--host/);
    expect(() => setGhHost('bad host')).toThrow(/--host/);
    expect(() => setGhHost('https://ghe.internal')).toThrow(/--host/);
  });
});

describe('parseNdjson (the paginated check-runs decode)', () => {
  it('parses one JSON value per non-blank line', () => {
    // `gh api --paginate <path> --jq '.check_runs[]'` applies the jq per page
    // and emits each element on its own line (NDJSON) — NOT one array, and NOT
    // the raw `{check_runs:[…]}{check_runs:[…]}` that a plain `--paginate` would
    // concatenate and make `JSON.parse` throw on. (`gh api` has no `--slurp`;
    // one real head had 508 check runs, so the first-page-only read missed 478.)
    expect(parseNdjson('{"name":"a"}\n{"name":"b"}\n{"name":"c"}')).toEqual([
      { name: 'a' },
      { name: 'b' },
      { name: 'c' },
    ]);
  });

  it('is strict by default — a non-JSON line throws rather than fail open', () => {
    // A check-runs snapshot feeds CI classification, and silently dropping a
    // malformed line could hide a *failing* run — the fail-open the pagination
    // fix closed, reintroduced by lenient parsing. So the default throws.
    expect(() =>
      parseNdjson('{"name":"a"}\ngh version 2.x available\n{"name":"b"}'),
    ).toThrow();
  });

  it('skips a non-JSON line only when explicitly non-strict', () => {
    // The opt-in for a caller that genuinely expects interleaved notices and
    // can tolerate a lost record — not the check-runs path.
    expect(
      parseNdjson('{"name":"a"}\ngh version 2.x available\n{"name":"b"}', {
        strict: false,
      }),
    ).toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('returns [] for an empty response and ignores blank lines', () => {
    expect(parseNdjson('')).toEqual([]);
    expect(parseNdjson('{"name":"a"}\n\n')).toEqual([{ name: 'a' }]);
  });
});

// ---------------------------------------------------------------------------
// Transient-error retry
// ---------------------------------------------------------------------------

function ghError(stderr: string): Error & { stderr: string } {
  const err = new Error(`gh: ${stderr}`) as Error & { stderr: string };
  err.stderr = stderr;
  return err;
}

describe('gh() transient-error retry', () => {
  let atomsWaitSpy: MockInstance<typeof Atomics.wait>;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    // Skip the real Atomics.wait delay so tests run instantly.
    atomsWaitSpy = vi.spyOn(Atomics, 'wait').mockReturnValue('ok');
  });

  afterEach(() => {
    atomsWaitSpy.mockRestore();
    setGhHost(undefined);
  });

  it('retries on HTTP 503 and succeeds, logging to stderr', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw ghError(
          'No server is currently available to service your request. (HTTP 503)',
        );
      })
      .mockReturnValueOnce('{"ok":true}\n');

    const result = gh('api', 'repos/o/r/pulls/1');
    expect(result).toBe('{"ok":true}');
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('retrying in 3000ms'),
    );
    stderrSpy.mockRestore();
  });

  it('retries up to MAX_RETRIES (2) then throws', () => {
    const err503 = ghError('server is currently unavailable (HTTP 503)');
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw err503;
      })
      .mockImplementationOnce(() => {
        throw err503;
      })
      .mockImplementationOnce(() => {
        throw err503;
      });

    expect(() => gh('api', 'repos/o/r/pulls/1')).toThrow(
      /server is currently unavailable/,
    );
    expect(mockExecFileSync).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('does not retry on non-transient errors (e.g. HTTP 404)', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw ghError('Not Found (HTTP 404)');
    });

    expect(() => gh('api', 'repos/o/r/pulls/999')).toThrow(/Not Found/);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('applies increasing delay between retries', () => {
    const err502 = ghError('Bad Gateway (HTTP 502)');
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw err502;
      })
      .mockImplementationOnce(() => {
        throw err502;
      })
      .mockReturnValueOnce('ok\n');

    gh('api', 'test');
    // Atomics.wait called with 3000ms then 6000ms
    expect(atomsWaitSpy).toHaveBeenCalledTimes(2);
    expect(atomsWaitSpy.mock.calls[0]![3]).toBe(3000);
    expect(atomsWaitSpy.mock.calls[1]![3]).toBe(6000);
  });
});

describe('ghWithInput() does NOT retry (non-idempotent POST)', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('throws immediately on HTTP 500 without retrying', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw ghError('Internal Server Error (HTTP 500)');
    });

    expect(() =>
      ghWithInput('{"body":"review"}', 'api', '--input', '-'),
    ).toThrow(/Internal Server Error/);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('passes input through on success', () => {
    mockExecFileSync.mockReturnValueOnce('{"id":1}\n');

    const result = ghWithInput('{"body":"review"}', 'api', '--input', '-');
    expect(result).toBe('{"id":1}');
    expect(mockExecFileSync.mock.calls[0]![2]).toHaveProperty(
      'input',
      '{"body":"review"}',
    );
  });
});

describe('ensureAuthenticated() transient retry', () => {
  let atomsWaitSpy: MockInstance<typeof Atomics.wait>;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    atomsWaitSpy = vi.spyOn(Atomics, 'wait').mockReturnValue('ok');
  });

  afterEach(() => {
    atomsWaitSpy.mockRestore();
  });

  it('retries once on transient failure then succeeds', () => {
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('keyring unlock failed');
      })
      .mockReturnValueOnce(Buffer.from(''));

    expect(() => ensureAuthenticated()).not.toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(atomsWaitSpy).toHaveBeenCalledTimes(1);
    expect(atomsWaitSpy.mock.calls[0]![3]).toBe(2000);
  });

  it('throws after one retry when auth genuinely fails', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not logged in');
    });

    expect(() => ensureAuthenticated()).toThrow(
      'gh CLI is not authenticated. Run `gh auth login` and retry.',
    );
    expect(mockExecFileSync).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
  });

  it('does not retry when gh is not installed (ENOENT)', () => {
    const enoent = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    mockExecFileSync.mockImplementation(() => {
      throw enoent;
    });

    expect(() => ensureAuthenticated()).toThrow(
      'gh CLI is not authenticated. Run `gh auth login` and retry.',
    );
    expect(mockExecFileSync).toHaveBeenCalledTimes(1); // no retry
    expect(atomsWaitSpy).not.toHaveBeenCalled();
  });
});
