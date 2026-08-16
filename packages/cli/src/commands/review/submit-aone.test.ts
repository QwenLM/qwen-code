/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  ghMock,
  ghWithInputMock,
  getPlatformReaderMock,
  stdoutMock,
  stderrMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ghWithInputMock: vi.fn(),
  getPlatformReaderMock: vi.fn(),
  stdoutMock: vi.fn(),
  stderrMock: vi.fn(),
}));

vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/gh.js')>();
  return {
    ...actual,
    gh: ghMock,
    ghWithInput: ghWithInputMock,
    setGhHost: vi.fn(),
    currentUser: vi.fn(() => 'someone-else'),
  };
});

// Steer detection to Aone so the refusal fires regardless of cwd.
vi.mock('./lib/platform/registry.js', () => ({
  getPlatformReader: getPlatformReaderMock,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: stdoutMock,
  writeStderrLine: stderrMock,
}));

import { runSubmit } from './submit.js';

let tmp: string;
let savedGhHost: string | undefined;

function base(over: Record<string, unknown> = {}) {
  return {
    pr: 1,
    repo: 'maxcompute/odps_src',
    review: join(tmp, 'review.json'),
    userAuthorized: true,
    dryRun: false,
    ...over,
  };
}

function postedJson(): { posted?: boolean; reason?: string } {
  const call = stdoutMock.mock.calls.map((c) => String(c[0])).join('');
  return JSON.parse(call) as { posted?: boolean; reason?: string };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'submit-aone-'));
  // The payload only needs to PARSE — the refusal fires before the payload
  // is validated or composed.
  writeFileSync(join(tmp, 'review.json'), '{}', 'utf8');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('submit refuses an Aone target with the exit-3 refusal shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
  });

  afterEach(() => {
    if (savedGhHost === undefined) delete process.env['GH_HOST'];
    else process.env['GH_HOST'] = savedGhHost;
    process.exitCode = undefined;
  });

  it('an AUTHORISED Aone run refuses with exit 3 + JSON, not a throw', () => {
    // The skill's Step 7 treats exit-3 + {"posted": false} as a complete,
    // correct outcome — a throw instead surfaces as a failed command an
    // agent might retry or route around.
    getPlatformReaderMock.mockReturnValue({ kind: 'aone' });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'aone-read-only-phase',
    });
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'posting review comments to Aone Code is not supported',
      ),
    );
    expect(ghMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('an UNAUTHORISED Aone run takes the normal auth-refusal path first', () => {
    // The refusal sits BELOW the authorisation gate: a default (non-posting)
    // run ends with the auth gate's own exit-3 shape, never the Aone one.
    getPlatformReaderMock.mockReturnValue({ kind: 'aone' });
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    const out = postedJson();
    expect(out.posted).toBe(false);
    expect(out.reason).not.toBe('aone-read-only-phase');
  });

  it('a padded Aone --host still refuses (detection sees the trimmed host)', () => {
    getPlatformReaderMock.mockImplementation(({ host }: { host?: string }) => ({
      kind: host === 'gitlab.alibaba-inc.com' ? 'aone' : 'github',
    }));
    expect(() =>
      runSubmit(base({ host: ' gitlab.alibaba-inc.com ' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'aone-read-only-phase',
    });
  });

  it('detects from GH_HOST too — an Aone-pointing env export is refused, not an opaque gh failure', () => {
    // Detection is fed the EFFECTIVE host (resolveGhHost: flag → GH_HOST
    // → undefined), so an operator's exported GH_HOST pointing at an Aone
    // host reaches the refusal instead of dying inside gh.
    let seenHost: string | undefined;
    getPlatformReaderMock.mockImplementation(({ host }: { host?: string }) => {
      seenHost = host;
      return { kind: host === 'gitlab.alibaba-inc.com' ? 'aone' : 'github' };
    });
    process.env['GH_HOST'] = 'gitlab.alibaba-inc.com';
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(seenHost).toBe('gitlab.alibaba-inc.com');
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'aone-read-only-phase',
    });
  });
});
