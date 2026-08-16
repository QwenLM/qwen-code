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
  authMock,
  stdoutMock,
  stderrMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ghWithInputMock: vi.fn(),
  getPlatformReaderMock: vi.fn(),
  authMock: vi.fn(),
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

// Steer detection so the refusal's environment arms fire regardless of cwd.
vi.mock('./lib/platform/registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/platform/registry.js')>();
  return {
    ...actual,
    getPlatformReader: getPlatformReaderMock,
  };
});

// Steer the authorisation gate (incl. the recordedHost it surfaces) — the
// real gate needs a session-scoped args file that does not exist under
// vitest.
vi.mock('./lib/authorization.js', () => ({
  reviewWriteAuthorization: authMock,
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
    // Default: authorised, no recorded host (the `--user-authorized` fast
    // path / bare pr-number target shape).
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
    });
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
    authMock.mockReturnValue({
      ok: false,
      why: '`--comment` was not in the review arguments',
    });
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
    // The refusal consults resolveGhHost (flag → GH_HOST → undefined): an
    // operator's exported GH_HOST pointing at an Aone host reaches the
    // refusal instead of dying inside gh. (The environment arm short-
    // circuits before the reader probe, so no host is asserted here — the
    // refusal shape itself is the proof.)
    getPlatformReaderMock.mockReturnValue({ kind: 'github' });
    process.env['GH_HOST'] = 'gitlab.alibaba-inc.com';
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'aone-read-only-phase',
    });
  });

  it('a RECORDED Aone host refuses even when the effective host is non-Aone', () => {
    // Fail-open close: a recorded codereview-URL target names an Aone host;
    // an ambient GH_HOST export (the Enterprise pattern) must not steer the
    // write past the read-only guarantee to the wrong host's same-named
    // repo.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: 'code.alibaba-inc.com',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'github' });
    process.env['GH_HOST'] = 'ghe.example.com';
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'aone-read-only-phase',
    });
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a RECORDED non-Aone host is not vetoed by an Aone cwd probe', () => {
    // Over-refusal close: the recorded pr-url binding is the explicit
    // signal the registry's precedence documents — a github.com review run
    // from inside an Aone-origin clone must still post.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: 'github.com',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'aone' });
    // Past the refusal the minimal `{}` payload fails its own consistency
    // check — the assertion is that the failure is THAT, not the Aone
    // refusal.
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).toThrow(/payload contradicts itself/);
    expect(process.exitCode).toBeUndefined();
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Aone Code is not supported'),
    );
  });
});
