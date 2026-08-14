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
const ghWithInputPlainMock = vi.hoisted(() =>
  vi.fn((_input: string, ..._rest: string[]) => ''),
);
vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/gh.js')>();
  return {
    ...actual,
    gh: ghMock,
    // Two DISTINCT mocks: aliasing them hid which function a write actually
    // used, and the retry-vs-not split is the point of having two.
    ghWithInput: ghWithInputPlainMock,
    ghWithInputRetried: ghWithInputMock,
    setGhHost: setGhHostMock,
  };
});

const setGhHostMock = vi.hoisted(() => vi.fn((_h: string) => {}));

const stderrSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
const stdoutSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: stdoutSpy,
  writeStderrLine: stderrSpy,
}));

// The handler resolves `review.comment` through `operatorReviewSettings` —
// pin the view it reads so the wiring leg below does not depend on the
// running developer's settings.json. The direct refusal assertions call
// runPublishAssets and never touch this mock; the handler-path tests below
// do.
const reviewSettingsMock = vi.hoisted(() =>
  vi.fn((): Record<string, unknown> => ({})),
);
vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...actual,
    // The production call carries `{ skipWorkspaceSettings: true }` — the
    // authorisation default resolves from operator scopes only. A caller that
    // forgets the flag reads the workspace-polluted view instead; the guards
    // that redden are submit.test.ts's handler-level refusal test,
    // review-settings.test.ts's direct assertion, and this file's
    // handler-level refusal test. The direct runPublishAssets refusals
    // bypass the handler.
    loadSettings: vi.fn((...callArgs: unknown[]) => {
      const opts = callArgs[1] as
        | { skipWorkspaceSettings?: boolean }
        | undefined;
      return {
        merged: {
          review: opts?.skipWorkspaceSettings
            ? reviewSettingsMock()
            : { attribution: false, comment: true, effort: 'low' },
        },
      };
    }),
  };
});

const { runPublishAssets, publishAssetsCommand } = await import(
  './publish-assets.js'
);

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
  let savedGhHostMain: string | undefined;

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
    // GH_HOST is an input to this command (effectiveHost); a developer's or
    // dogfooding session's exported value must not leak into URL assertions.
    savedGhHostMain = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    reviewSettingsMock.mockReturnValue({});
    ghMock.mockReset();
    ghWithInputMock.mockReset();
    // mockReset, not mockClear: a sibling block's persistent
    // mockImplementation (the malformed-GH_HOST test) survives mockClear.
    setGhHostMock.mockReset();
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
    if (savedGhHostMain !== undefined) {
      process.env['GH_HOST'] = savedGhHostMain;
    } else delete process.env['GH_HOST'];
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

  // The handler-path counterpart of run(): every handler-level leg calls
  // this, so the yargs-facing argument shape lives in exactly one place and
  // a one-leg-only edit (a renamed key silenced by the `as never` cast) is
  // structurally impossible.
  async function runHandler(
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    await publishAssetsCommand.handler?.({
      _: [],
      $0: 'qwen',
      pr: 8346,
      files: [pngFile('a.png')],
      out: join(dir, 'manifest.json'),
      'user-authorized': false,
      'skill-args': argsFile,
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

  it('the standing review.comment setting authorises publishing without --comment', () => {
    // The two callers of the shared gate must agree on what authorises a
    // run: submit accepts the setting, so publish-assets must too — or a
    // run that posts the review still refuses to publish its evidence.
    writeFileSync(argsFile, '8346\n'); // no --comment
    happyGh();
    run({ files: [pngFile('a.png')], defaultComment: true });
    expect(process.exitCode).toBeUndefined();
    expect(ghWithInputMock).toHaveBeenCalled();
  });

  it('wires the standing review.comment setting through the handler', async () => {
    // Wiring leg: dropping `defaultComment` from the handler call leaves the
    // direct runPublishAssets test green while production refuses. The
    // workspace-polluted mock stands guard on the scope flag at the same
    // time — it answers a flag-less call with comment:true.
    writeFileSync(argsFile, '8346\n'); // no --comment
    reviewSettingsMock.mockReturnValue({ comment: true });
    happyGh();
    await runHandler({ files: [pngFile('wired.png')] });
    expect(process.exitCode).toBeUndefined();
    expect(ghWithInputMock).toHaveBeenCalled();
  });

  it('the handler refuses when neither flag nor setting authorises — the polluted view must not decide', async () => {
    // The refusal counterpart of the wiring leg above: setting off, no
    // `--comment` in the recorded arguments. If the handler's loadSettings
    // call drops `skipWorkspaceSettings`, the workspace-polluted mock view
    // answers comment:true and this refusal becomes a publish — the exact
    // regression review-settings.ts documents (a repository-controlled
    // .qwen/settings.json deciding to publish for every reviewer).
    writeFileSync(argsFile, '8346\n'); // no --comment
    reviewSettingsMock.mockReturnValue({}); // setting off
    happyGh();
    await runHandler({ files: [pngFile('refused.png')] });
    expect(process.exitCode).toBe(3);
    expect(ghWithInputMock).not.toHaveBeenCalled();
    expect(ghMock).not.toHaveBeenCalled();
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
    // Every write in this command is idempotent and must ride the RETRIED
    // variant; the non-retrying ghWithInput is submit's, not ours.
    expect(ghWithInputPlainMock).not.toHaveBeenCalled();
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

  it('refuses the whole batch when one file fails validation — exit 3, not a crash', () => {
    // A validation refusal speaks the same language as every other gate in
    // this command: exit 3 and {"published": false} on stdout, never an
    // uncaught throw (which would surface as yargs exit 1 with a stack trace
    // and an empty stdout).
    happyGh();
    const good = pngFile('a.png');
    const bad = join(dir, 'evil.svg');
    writeFileSync(bad, '<svg/>');
    run({ files: [good, bad] });
    expect(process.exitCode).toBe(3);
    const why = (stderrSpy.mock.calls.map((c) => c[0]) as string[]).join(' ');
    expect(why).toContain('evil.svg');
    // All-or-nothing: nothing was pushed, not even the good file.
    expect(ghWithInputMock).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ published: false }),
    );
  });

  it('refuses bytes that are not the image their name claims — exit 3, nothing pushed', () => {
    // The extension allowlist is only as strong as the bytes behind it: a
    // shell script named evidence.png must refuse on CONTENT, before any
    // upload happens.
    happyGh();
    const impostor = join(dir, 'evidence.png');
    writeFileSync(impostor, '#!/bin/sh\necho pwned\n');
    run({ files: [impostor] });
    expect(process.exitCode).toBe(3);
    const why = (stderrSpy.mock.calls.map((c) => c[0]) as string[]).join(' ');
    expect(why).toContain('not a recognized image');
    expect(ghWithInputMock).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ published: false }),
    );
  });

  it('refuses the whole batch when one file fails the CONTENT ruling', () => {
    // The extension gate has its two-file twin above; the content gate needs
    // the same shape, or a future edit that ruled content for only the first
    // prepared file would publish an impostor riding behind a good file.
    happyGh();
    const good = join(dir, 'a.png');
    writeFileSync(
      good,
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const impostor = join(dir, 'impostor.png');
    writeFileSync(impostor, '#!/bin/sh\n');
    run({ files: [good, impostor] });
    expect(process.exitCode).toBe(3);
    const why = (stderrSpy.mock.calls.map((c) => c[0]) as string[]).join(' ');
    // The full path names the file exactly once — the validator's reason
    // carries no basename of its own, so there is no stuttered duplicate,
    // and two same-named files from different directories stay tellable
    // apart.
    expect(why).toContain(`${JSON.stringify(impostor)}: content is`);
    expect(ghWithInputMock).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ published: false }),
    );
  });

  it('publishes a webp whose bytes match — the slice covers the WEBP signature', () => {
    // The content ruling sniffs a 16-byte slice, and WEBP's signature runs
    // to its fourcc at bytes 12-15: a slice shorter than 16 would
    // false-refuse every real WEBP at publish time while the unit tests
    // (full headers) stayed green.
    happyGh();
    const shot = join(dir, 'shot.webp');
    writeFileSync(
      shot,
      Uint8Array.from(
        [...'RIFF\u0000\u0000\u0000\u0000WEBPVP8 '].map((c) => c.charCodeAt(0)),
      ),
    );
    run({ files: [shot] });
    expect(process.exitCode).toBeUndefined();
    expect(ghWithInputMock).toHaveBeenCalled();
  });

  it('refuses an unreadable file the same way', () => {
    run({ files: [join(dir, 'absent.png')] });
    expect(process.exitCode).toBe(3);
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
    // BEFORE any API call — the test name's claim, now asserted: a refactor
    // that moved the setGhHost below the first gh call would route the branch
    // lookup at github.com and only then switch hosts.
    const firstApiOrder = Math.min(
      ...[...ghMock.mock.invocationCallOrder, Number.POSITIVE_INFINITY],
      ...[
        ...ghWithInputMock.mock.invocationCallOrder,
        Number.POSITIVE_INFINITY,
      ],
    );
    expect(setGhHostMock.mock.invocationCallOrder[0]).toBeLessThan(
      firstApiOrder,
    );
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

describe('publish-assets — round-2 review pins', () => {
  let dir: string;
  let argsFile: string;
  let savedSessionId: string | undefined;
  let savedGhHost: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-assets-r2-'));
    argsFile = join(dir, 'args.txt');
    writeFileSync(argsFile, '8346 --comment\n');
    process.env['QWEN_REVIEW_ASSETS_REPO'] = 'owner/assets';
    savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    reviewSettingsMock.mockReturnValue({});
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
    if (savedGhHost !== undefined) process.env['GH_HOST'] = savedGhHost;
    else delete process.env['GH_HOST'];
    process.exitCode = undefined;
  });

  const png = (name: string): string => {
    const p = join(dir, name);
    writeFileSync(p, Buffer.from('89504e470d0a1a0a0000000d', 'hex'));
    return p;
  };
  const baseArgs = () =>
    ({
      pr: 8346,
      reviewedRepo: undefined,
      files: [png('a.png')],
      findings: undefined,
      findingsOut: undefined,
      out: join(dir, 'm.json'),
      host: undefined,
      userAuthorized: false,
      skillArgs: argsFile,
    }) as never;

  it('an operator-exported GH_HOST routes AND names the URLs — one host, both jobs', () => {
    // With --host absent, gh children inherit the parent env; routing at the
    // operator's Enterprise host while the URLs claimed github.com made every
    // returned URL a 404. The env is part of the input: read once, used for
    // both.
    process.env['GH_HOST'] = 'ghe.corp.example';
    ghMock.mockImplementation((...a: string[]) =>
      a.includes('.object.sha') ? 'headsha' : '{}',
    );
    ghWithInputMock.mockImplementation(() => '{}');
    runPublishAssets(baseArgs());
    expect(process.exitCode).toBeUndefined();
    expect(setGhHostMock).toHaveBeenCalledWith('ghe.corp.example');
    const manifest = JSON.parse(readFileSync(join(dir, 'm.json'), 'utf8'));
    expect(manifest.published[0].url).toMatch(
      /^https:\/\/ghe\.corp\.example\//,
    );
  });

  it('a non-404 branch-lookup failure is rethrown, never read as "branch missing"', () => {
    // A 403 rate-limit answered by the create path would bury the real error
    // under the create's 422. The mock 403s ONLY the branch ref lookup —
    // every later call would succeed — so a regression that swallowed the 403
    // would visibly proceed to the default-branch lookup, and the
    // exactly-one-call assertion below would name it. (The first shape threw
    // 403 from every call, which a broadened swallow still passed; measured
    // vacuous by this PR's own review.)
    ghMock.mockImplementation((...a: string[]) => {
      if (String(a[1] ?? '').includes(`git/ref/heads/pr-assets/`)) {
        throw new Error('HTTP 403: rate limit exceeded');
      }
      if (a.includes('.default_branch')) return 'main';
      if (a.includes('.object.sha')) return 'basesha';
      return '{}';
    });
    ghWithInputMock.mockImplementation(() => '{}');
    expect(() => runPublishAssets(baseArgs())).toThrow(/403/);
    expect(ghWithInputMock).not.toHaveBeenCalled();
    // Rethrown AT the lookup: the default-branch query was never reached.
    expect(ghMock).toHaveBeenCalledTimes(1);
  });

  it('an empty assets repo is named as the condition it is', () => {
    // GitHub reports a default_branch even for an empty repo; the base-sha
    // 404 must not read as branch-missing.
    let refCalls = 0;
    ghMock.mockImplementation((...a: string[]) => {
      const path = String(a[1] ?? '');
      if (path.includes('git/ref/heads/')) {
        refCalls += 1;
        throw new Error('HTTP 404: Not Found');
      }
      if (a.includes('.default_branch') || path === 'repos/owner/assets') {
        return 'main';
      }
      return '{}';
    });
    expect(() => runPublishAssets(baseArgs())).toThrow(/appears to be empty/);
    expect(refCalls).toBe(2);
  });

  it('a PUT failure naming 422 only in the API path is rethrown', () => {
    // execFileSync embeds the command line in err.message, and the remote
    // path bakes in the PR number — evidence for PR #4220 must not read a 401
    // as "already exists".
    writeFileSync(argsFile, '4220 --comment\n');
    ghMock.mockImplementation((...a: string[]) =>
      a.includes('.object.sha') ? 'headsha' : '{}',
    );
    ghWithInputMock.mockImplementation(() => {
      throw new Error(
        'Command failed: gh api -X PUT repos/owner/assets/contents/4220-review/abc-a.png — HTTP 401: Bad credentials',
      );
    });
    expect(() =>
      runPublishAssets({ ...(baseArgs() as object), pr: 4220 } as never),
    ).toThrow(/401/);
    // One attempt per file — no sha-lookup retry was triggered by the "422"
    // digits in the path.
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
  });
});

describe('publish-assets — round-3 self-review pins', () => {
  let dir: string;
  let argsFile: string;
  let savedSessionId: string | undefined;
  let savedGhHost: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-assets-r3-'));
    argsFile = join(dir, 'args.txt');
    writeFileSync(argsFile, '8346 --comment\n');
    process.env['QWEN_REVIEW_ASSETS_REPO'] = 'owner/assets';
    savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    reviewSettingsMock.mockReturnValue({});
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
    if (savedGhHost !== undefined) process.env['GH_HOST'] = savedGhHost;
    else delete process.env['GH_HOST'];
    process.exitCode = undefined;
  });

  const png = (name: string): string => {
    const p = join(dir, name);
    writeFileSync(p, Buffer.from('89504e470d0a1a0a0000000d', 'hex'));
    return p;
  };
  const baseArgs = () =>
    ({
      pr: 8346,
      reviewedRepo: undefined,
      files: [png('a.png')],
      findings: undefined,
      findingsOut: undefined,
      out: join(dir, 'm.json'),
      host: undefined,
      userAuthorized: false,
      skillArgs: argsFile,
    }) as never;

  it('a malformed operator GH_HOST is a refusal naming its source, not a TypeError', () => {
    process.env['GH_HOST'] = 'not a hostname';
    // Once, not persistent: a lingering implementation leaks into sibling
    // blocks whose beforeEach only mockClear()ed — measured by this PR's own
    // review as a cross-block failure with GH_HOST exported.
    setGhHostMock.mockImplementationOnce(() => {
      throw new TypeError('--host must be a hostname');
    });
    runPublishAssets(baseArgs());
    expect(process.exitCode).toBe(3);
    const why = (stderrSpy.mock.calls.map((c) => c[0]) as string[]).join(' ');
    expect(why).toContain('GH_HOST environment variable');
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('an unreadable findings artifact keeps the refusal contract', () => {
    runPublishAssets({
      ...(baseArgs() as object),
      files: undefined,
      findings: join(dir, 'absent.json'),
    } as never);
    expect(process.exitCode).toBe(3);
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ published: false }),
    );
  });

  it('a non-JSON findings artifact keeps the refusal contract too', () => {
    const bad = join(dir, 'findings.json');
    writeFileSync(bad, 'not json');
    runPublishAssets({
      ...(baseArgs() as object),
      files: undefined,
      findings: bad,
    } as never);
    expect(process.exitCode).toBe(3);
  });

  it('a branch-create 422 that is NOT already-exists surfaces, never swallowed', () => {
    // "Object does not exist" (a bad base sha) is also a 422; treating it as
    // success would leave every later PUT failing against a branch that was
    // never created, far from the cause. The mock fails ONLY the refs POST —
    // PUTs would succeed — so a regression that swallowed this 422 would
    // sail on to a PUT and the no-PUT assertion below would name it. (The
    // first shape of this test threw the same message from every call, which
    // a broadened swallow still passed; measured vacuous by this PR's own
    // review.)
    ghMock
      .mockImplementationOnce(() => {
        throw new Error('HTTP 404: Not Found');
      })
      .mockImplementationOnce(() => 'main')
      .mockImplementationOnce(() => 'basesha');
    ghWithInputMock.mockImplementation((_input: string, ...rest: string[]) => {
      if (rest.join(' ').includes('git/refs')) {
        throw new Error('HTTP 422: Validation Failed — Object does not exist');
      }
      return '{}';
    });
    expect(() => runPublishAssets(baseArgs())).toThrow(/Object does not exist/);
    // The create failed and nothing may proceed past it: no contents PUT.
    const putCalls = (ghWithInputMock as Mock).mock.calls.filter((c) =>
      String(c.slice(1).join(' ')).includes('/contents/'),
    );
    expect(putCalls).toHaveLength(0);
  });
});

describe('publish-assets — round-4 pins', () => {
  let dir: string;
  let argsFile: string;
  let savedSessionId: string | undefined;
  let savedGhHost: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-assets-r4-'));
    argsFile = join(dir, 'args.txt');
    writeFileSync(argsFile, '8346 --comment\n');
    process.env['QWEN_REVIEW_ASSETS_REPO'] = 'owner/assets';
    savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    reviewSettingsMock.mockReturnValue({});
    ghMock.mockReset();
    ghWithInputMock.mockReset();
    setGhHostMock.mockReset();
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
    if (savedGhHost !== undefined) process.env['GH_HOST'] = savedGhHost;
    else delete process.env['GH_HOST'];
    process.exitCode = undefined;
  });

  const png = (name: string): string => {
    const p = join(dir, name);
    writeFileSync(p, Buffer.from('89504e470d0a1a0a0000000d', 'hex'));
    return p;
  };
  const okGh = (): void => {
    ghMock.mockImplementation((...a: string[]) =>
      a.includes('.object.sha') ? 'headsha' : '{}',
    );
    ghWithInputMock.mockImplementation(() => '{}');
  };
  const baseArgs = () =>
    ({
      pr: 8346,
      reviewedRepo: undefined,
      files: [png('a.png')],
      findings: undefined,
      findingsOut: undefined,
      out: join(dir, 'm.json'),
      host: undefined,
      userAuthorized: false,
      skillArgs: argsFile,
    }) as never;

  it('a double-fired branch create ("Reference already exists") is success', () => {
    // The positive half of the idempotency swallow: a proxy 502 that GitHub
    // in fact processed answers the retried POST with already-exists, and the
    // publish must proceed. Inverting the swallow condition would fail here.
    ghMock
      .mockImplementationOnce(() => {
        throw new Error('HTTP 404: Not Found');
      })
      .mockImplementationOnce(() => 'main')
      .mockImplementationOnce(() => 'basesha')
      .mockImplementation((...a: string[]) =>
        a.includes('.object.sha') ? 'headsha' : '{}',
      );
    ghWithInputMock.mockImplementation((_i: string, ...rest: string[]) => {
      if (rest.join(' ').includes('git/refs')) {
        throw new Error('HTTP 422: Reference already exists');
      }
      return '{}';
    });
    runPublishAssets(baseArgs());
    expect(process.exitCode).toBeUndefined();
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ published: true, count: 1 }),
    );
  });

  it('accepts the canonical report shape its own --findings-out writes', () => {
    // An idempotent re-run feeds this command its own output: the
    // { findings: [...] } report, not a bare array. Dropping the fallback
    // must fail here, not in a user's pipeline.
    okGh();
    const img = png('shot.png');
    const artifact = join(dir, 'report.json');
    writeFileSync(
      artifact,
      JSON.stringify({
        findings: [
          {
            id: 'R1-1',
            severity: 'Critical',
            summary: 'panel clips',
            failureScenario: '80 cols clips',
            file: 'src/p.ts',
            assetFiles: [img],
          },
        ],
        counts: {},
        outcomesRecorded: false,
      }),
    );
    const outArtifact = join(dir, 'report-out.json');
    runPublishAssets({
      ...(baseArgs() as object),
      files: undefined,
      findings: artifact,
      findingsOut: outArtifact,
    } as never);
    expect(process.exitCode).toBeUndefined();
    const updated = JSON.parse(readFileSync(outArtifact, 'utf8'));
    expect(updated.findings[0].assets).toHaveLength(1);
  });

  it('an Enterprise-URL authorisation refuses a host-less (github.com) write', () => {
    // The gate binds the host in BOTH directions: absent --host and GH_HOST
    // means the write routes at github.com, which must not pass an
    // authorisation the user recorded for their Enterprise host.
    writeFileSync(
      argsFile,
      'https://ghe.corp.example/reviewed/upstream/pull/8346 --comment\n',
    );
    runPublishAssets(baseArgs());
    expect(process.exitCode).toBe(3);
    const why = (stderrSpy.mock.calls.map((c) => c[0]) as string[]).join(' ');
    expect(why).toContain('ghe.corp.example');
    expect(why).toContain('github.com');
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a github.com-URL authorisation still passes a host-less write', () => {
    writeFileSync(
      argsFile,
      'https://github.com/reviewed/upstream/pull/8346 --comment\n',
    );
    okGh();
    runPublishAssets(baseArgs());
    expect(process.exitCode).toBeUndefined();
  });
});

describe('publish-assets — empty is two different things', () => {
  let dir: string;
  let argsFile: string;
  let savedSessionId: string | undefined;
  let savedGhHost: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-assets-empty-'));
    argsFile = join(dir, 'args.txt');
    writeFileSync(argsFile, '8346 --comment\n');
    process.env['QWEN_REVIEW_ASSETS_REPO'] = 'owner/assets';
    // Same guards as the sibling blocks: the skillArgs seam is honoured only
    // with no session id; GH_HOST feeds effectiveHost; and mockReset (never
    // mockClear) removes a sibling's persistent throwing implementation.
    savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    reviewSettingsMock.mockReturnValue({});
    ghMock.mockReset();
    ghWithInputMock.mockReset();
    setGhHostMock.mockReset();
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
    if (savedGhHost !== undefined) process.env['GH_HOST'] = savedGhHost;
    else delete process.env['GH_HOST'];
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
  let savedGhHost: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-assets-host-'));
    argsFile = join(dir, 'args.txt');
    process.env['QWEN_REVIEW_ASSETS_REPO'] = 'owner/assets';
    savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
    delete process.env['QWEN_CODE_SESSION_ID'];
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    reviewSettingsMock.mockReturnValue({});
    ghMock.mockReset();
    ghWithInputMock.mockReset();
    setGhHostMock.mockReset();
    stderrSpy.mockClear();
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['QWEN_REVIEW_ASSETS_REPO'];
    if (savedSessionId !== undefined) {
      process.env['QWEN_CODE_SESSION_ID'] = savedSessionId;
    }
    if (savedGhHost !== undefined) process.env['GH_HOST'] = savedGhHost;
    else delete process.env['GH_HOST'];
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
