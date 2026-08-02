/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ghMock = vi.hoisted(() => vi.fn((..._args: string[]) => ''));
const ghWithInputMock = vi.hoisted(() =>
  vi.fn((_input: string, ..._rest: string[]) => ''),
);
vi.mock('./lib/gh.js', () => ({
  gh: ghMock,
  ghWithInput: ghWithInputMock,
  setGhHost: setGhHostMock,
}));

const setGhHostMock = vi.hoisted(() => vi.fn((_h: string) => {}));

const stderrSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
const stdoutSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: stdoutSpy,
  writeStderrLine: stderrSpy,
}));

const { runPublishAssets } = await import('./publish-assets.js');

// A 1x1 PNG, enough bytes to be a plausible file and stable to hash.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c626001000000ffff03000006000557' +
    'bfabd40000000049454e44ae426082',
  'hex',
);

describe('publish-assets', () => {
  let dir: string;
  let argsFile: string;
  let savedSessionId: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-assets-'));
    argsFile = join(dir, 'args.txt');
    writeFileSync(argsFile, '8346 --comment\n');
    process.env['QWEN_REVIEW_ASSETS_REPO'] = 'owner/assets';
    // The skillArgs test seam is honoured only when no session id is present;
    // running this suite from inside an active Qwen Code session would
    // otherwise route the gate at the real session-scoped path and fail eight
    // of these tests for reasons that have nothing to do with the code.
    savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    ghMock.mockReset();
    ghWithInputMock.mockReset();
    setGhHostMock.mockClear();
    stdoutSpy.mockClear();
    stderrSpy.mockClear();
    process.exitCode = undefined;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['QWEN_REVIEW_ASSETS_REPO'];
    if (savedSessionId !== undefined) {
      process.env['QWEN_CODE_SESSION_ID'] = savedSessionId;
    }
    process.exitCode = undefined;
  });

  function pngFile(name: string): string {
    const p = join(dir, name);
    writeFileSync(p, PNG);
    return p;
  }

  function happyGh(): void {
    // Branch exists; PUTs succeed; the post-upload head read answers the sha.
    ghMock.mockImplementation((...args: string[]) =>
      args.includes('.object.sha') ? 'headsha1234567890' : '{}',
    );
    ghWithInputMock.mockImplementation(() => '{}');
  }

  function run(overrides: Record<string, unknown> = {}): void {
    runPublishAssets({
      pr: 8346,
      reviewedRepo: undefined,
      files: undefined,
      findings: undefined,
      findingsOut: undefined,
      out: join(dir, 'manifest.json'),
      host: undefined,
      userAuthorized: false,
      skillArgs: argsFile,
      ...overrides,
    } as never);
  }

  it('refuses without a designated repo — exit 3, nothing written', () => {
    delete process.env['QWEN_REVIEW_ASSETS_REPO'];
    run({ files: [pngFile('a.png')] });
    expect(process.exitCode).toBe(3);
    expect(ghWithInputMock).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ published: false }),
    );
  });

  it('refuses an unauthorised run — same gate as submit, exit 3', () => {
    writeFileSync(argsFile, '8346\n'); // no --comment
    run({ files: [pngFile('a.png')] });
    expect(process.exitCode).toBe(3);
    expect(ghWithInputMock).not.toHaveBeenCalled();
    const why = (stderrSpy.mock.calls.map((c) => c[0]) as string[]).join(' ');
    expect(why).toContain('not authorised');
  });

  it('binds authorisation to the target PR, not to a mood', () => {
    writeFileSync(argsFile, '999 --comment\n');
    run({ files: [pngFile('a.png')] });
    expect(process.exitCode).toBe(3);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('publishes with --user-authorized when no args file authorises', () => {
    writeFileSync(argsFile, '8346\n');
    happyGh();
    run({ files: [pngFile('a.png')], userAuthorized: true });
    expect(process.exitCode).toBeUndefined();
    expect(ghWithInputMock).toHaveBeenCalled();
  });

  it('publishes, writes a manifest with commit-pinned URLs', () => {
    happyGh();
    const f = pngFile('evidence.png');
    run({ files: [f] });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    );
    expect(manifest.repo).toBe('owner/assets');
    expect(manifest.branch).toBe('pr-assets/8346-review');
    expect(manifest.commitSha).toBe('headsha1234567890');
    expect(manifest.published).toHaveLength(1);
    const p = manifest.published[0];
    expect(p.file).toBe(f);
    expect(p.url).toBe(
      `https://github.com/owner/assets/raw/headsha1234567890/${p.remotePath}`,
    );
    expect(p.remotePath).toMatch(/^8346-review\/[0-9a-f]{12}-evidence\.png$/);
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ published: true, count: 1 }),
    );
  });

  it('creates the branch when missing, from the default branch head', () => {
    // First ref lookup throws (missing branch); the creation path then asks
    // for the default branch and its head; the post-upload head read follows.
    ghMock
      .mockImplementationOnce(() => {
        throw new Error('HTTP 404');
      })
      .mockImplementationOnce(() => 'main')
      .mockImplementationOnce(() => 'basesha')
      .mockImplementationOnce(() => 'headsha1234567890');
    ghWithInputMock.mockImplementation(() => '{}');
    run({ files: [pngFile('a.png')] });
    expect(process.exitCode).toBeUndefined();
    const createCall = (ghWithInputMock as Mock).mock.calls[0];
    expect(JSON.parse(createCall[0] as string)).toEqual({
      ref: 'refs/heads/pr-assets/8346-review',
      sha: 'basesha',
    });
    // Ref paths keep their slashes literal — GitHub's documented form; %2F
    // routes inconsistently and a 404 here would 422 the create on re-runs.
    const refCall = (ghMock as Mock).mock.calls[0];
    expect(refCall[1]).toBe(
      'repos/owner/assets/git/ref/heads/pr-assets/8346-review',
    );
    expect(String(refCall[1])).not.toContain('%2F');
  });

  it('retries an existing path with its blob sha — idempotent re-run', () => {
    ghMock.mockImplementation((...args: string[]) => {
      // branch ref exists; content sha lookup answers the retry
      if (String(args[1] ?? '').includes('/contents/')) return 'blobsha';
      if (args.includes('.object.sha')) return 'headsha1234567890';
      return '{}';
    });
    ghWithInputMock
      .mockImplementationOnce(() => {
        throw new Error('HTTP 422: sha required');
      })
      .mockImplementationOnce(() => '{}');
    run({ files: [pngFile('a.png')] });
    expect(process.exitCode).toBeUndefined();
    const retry = JSON.parse(
      (ghWithInputMock as Mock).mock.calls[1][0] as string,
    );
    expect(retry.sha).toBe('blobsha');
  });

  it('rethrows a non-exists PUT failure instead of burying it in a sha lookup', () => {
    // A 401 answered by a catch-all retry would surface as a confusing
    // secondary error from the contents GET; the original must be the error.
    ghMock.mockImplementation((...args: string[]) =>
      args.includes('.object.sha') ? 'headsha1234567890' : '{}',
    );
    ghWithInputMock.mockImplementation(() => {
      throw new Error('HTTP 401: Bad credentials');
    });
    expect(() => run({ files: [pngFile('a.png')] })).toThrow(/401/);
    // Exactly one PUT attempt — no retry, no contents lookup.
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
  });

  it('authorises a URL-shaped --comment without binding it to the assets repo', () => {
    // The reviewed repo (from the URL) differs from the fork-hosted assets
    // repo; the designation itself is the consent for the destination, so the
    // gate binds the PR number, not the assets repo.
    writeFileSync(
      argsFile,
      'https://github.com/reviewed/upstream/pull/8346 --comment\n',
    );
    happyGh();
    run({ files: [pngFile('a.png')] });
    expect(process.exitCode).toBeUndefined();
    expect(ghWithInputMock).toHaveBeenCalled();
  });

  it('binds --reviewed-repo against a URL-shaped authorisation when given', () => {
    writeFileSync(
      argsFile,
      'https://github.com/reviewed/upstream/pull/8346 --comment\n',
    );
    happyGh();
    run({ files: [pngFile('a.png')], reviewedRepo: 'someone/else' });
    expect(process.exitCode).toBe(3);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('refuses the whole batch when one file fails validation', () => {
    happyGh();
    const good = pngFile('a.png');
    const bad = join(dir, 'evil.svg');
    writeFileSync(bad, '<svg/>');
    expect(() => run({ files: [good, bad] })).toThrow(/evil\.svg/);
    // All-or-nothing: nothing was pushed, not even the good file.
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('weaves published URLs into the findings artifact by assetFiles', () => {
    happyGh();
    const img = pngFile('shot.png');
    const findingsIn = join(dir, 'findings.json');
    writeFileSync(
      findingsIn,
      JSON.stringify([
        {
          id: 'R1-1',
          severity: 'Critical',
          summary: 'TUI renders the panel off-screen.',
          failureScenario: 'Open the panel at 80 columns; it clips.',
          file: 'src/panel.ts',
          line: 3,
          assetFiles: [img],
        },
        {
          id: 'R1-2',
          severity: 'Suggestion',
          summary: 'No evidence attached here.',
          failureScenario: 'n/a cost: none',
          file: 'src/other.ts',
        },
      ]),
    );
    const findingsOut = join(dir, 'findings-out.json');
    run({ findings: findingsIn, findingsOut });
    const report = JSON.parse(readFileSync(findingsOut, 'utf8'));
    const withAssets = report.findings.find(
      (f: { id: string }) => f.id === 'R1-1',
    );
    expect(withAssets.assets).toHaveLength(1);
    expect(withAssets.assets[0]).toMatch(
      /^https:\/\/github\.com\/owner\/assets\/raw\/headsha1234567890\//,
    );
    // The local paths survive for provenance; the untouched finding is intact.
    expect(withAssets.assetFiles).toEqual([img]);
    const without = report.findings.find(
      (f: { id: string }) => f.id === 'R1-2',
    );
    expect(without.assets).toBeUndefined();
  });

  it('routes GitHub Enterprise calls through setGhHost before any API call', () => {
    happyGh();
    run({ files: [pngFile('a.png')], host: 'github.example.com' });
    expect(process.exitCode).toBeUndefined();
    expect(setGhHostMock).toHaveBeenCalledWith('github.example.com');
    // And the manifest URLs carry the host.
    const manifest = JSON.parse(
      readFileSync(join(dir, 'manifest.json'), 'utf8'),
    );
    expect(manifest.published[0].url).toMatch(
      /^https:\/\/github\.example\.com\//,
    );
  });

  it('refuses a non-integer --pr before any gate can be bypassed around it', () => {
    // With --user-authorized the authorization gate never re-parses the
    // target, so a NaN from yargs `type: 'number'` would otherwise reach
    // branch creation as `pr-assets/NaN-review`.
    run({ pr: Number.NaN, files: [pngFile('a.png')], userAuthorized: true });
    expect(process.exitCode).toBe(3);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('refuses an empty run rather than creating an empty branch', () => {
    run({ files: [] });
    expect(process.exitCode).toBe(3);
    expect(ghMock).not.toHaveBeenCalled();
  });
});

describe('publish-assets — empty is two different things', () => {
  let dir: string;
  let argsFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-assets-empty-'));
    argsFile = join(dir, 'args.txt');
    writeFileSync(argsFile, '8346 --comment\n');
    process.env['QWEN_REVIEW_ASSETS_REPO'] = 'owner/assets';
    stdoutSpy.mockClear();
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['QWEN_REVIEW_ASSETS_REPO'];
    process.exitCode = undefined;
  });

  it('a findings artifact with no assetFiles is an ordinary no-op, exit 0', () => {
    // An orchestrator may call publish-assets unconditionally on every posting
    // run; a review whose findings carry no images must not manufacture a
    // failure for the FIX loop to "repair".
    const findingsIn = join(dir, 'findings.json');
    writeFileSync(
      findingsIn,
      JSON.stringify([
        {
          id: 'f1',
          severity: 'Suggestion',
          summary: 'text-only finding',
          failureScenario: 'cost: none',
          file: 'a.ts',
        },
      ]),
    );
    runPublishAssets({
      pr: 8346,
      reviewedRepo: undefined,
      files: undefined,
      findings: findingsIn,
      findingsOut: undefined,
      out: join(dir, 'manifest.json'),
      host: undefined,
      userAuthorized: false,
      skillArgs: argsFile,
    } as never);
    expect(process.exitCode).toBeUndefined();
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ published: false, count: 0 }),
    );
  });
});

describe('publish-assets — host binds even without --reviewed-repo', () => {
  let dir: string;
  let argsFile: string;
  let savedSessionId: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-assets-host-'));
    argsFile = join(dir, 'args.txt');
    process.env['QWEN_REVIEW_ASSETS_REPO'] = 'owner/assets';
    savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    ghMock.mockReset();
    ghWithInputMock.mockReset();
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['QWEN_REVIEW_ASSETS_REPO'];
    if (savedSessionId !== undefined) {
      process.env['QWEN_CODE_SESSION_ID'] = savedSessionId;
    }
    process.exitCode = undefined;
  });

  it('refuses a host mismatch when the repo binding is absent', () => {
    // The host check must stand outside the repo guard: an Enterprise-host
    // authorisation must not publish evidence for a github.com run of the
    // same PR number just because --reviewed-repo was omitted.
    writeFileSync(
      argsFile,
      'https://ghe.example.com/reviewed/upstream/pull/8346 --comment\n',
    );
    const img = join(dir, 'a.png');
    writeFileSync(img, Buffer.from('89504e470d0a1a0a', 'hex'));
    runPublishAssets({
      pr: 8346,
      reviewedRepo: undefined,
      files: [img],
      findings: undefined,
      findingsOut: undefined,
      out: join(dir, 'm.json'),
      host: 'github.other.com',
      userAuthorized: false,
      skillArgs: argsFile,
    } as never);
    expect(process.exitCode).toBe(3);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });
});
