/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';

const {
  ghMock,
  ensureAuthenticatedMock,
  setGhHostMock,
  writeStdoutLineMock,
  writeFileSyncMock,
  mkdirSyncMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ensureAuthenticatedMock: vi.fn(),
  setGhHostMock: vi.fn(),
  writeStdoutLineMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
}));

vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    gh: ghMock,
    ensureAuthenticated: ensureAuthenticatedMock,
    setGhHost: setGhHostMock,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const mock = {
    ...actual,
    mkdirSync: mkdirSyncMock,
    writeFileSync: writeFileSyncMock,
    // assertWritableOutPath must not consult AMBIENT filesystem state through
    // the partial mock: a stray directory at the shared /tmp path would fail
    // the suite for a reason invisible in the repo.
    existsSync: () => false,
    statSync: () => {
      throw new Error('statSync: path does not exist (mocked)');
    },
  };
  return { ...mock, default: mock };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: writeStdoutLineMock,
  writeStderrLineSafe: vi.fn(),
}));

import { issueContextCommand, runIssueContext } from './issue-context.js';

const ARGS = {
  prNumber: 9077,
  repo: 'QwenLM/qwen-code',
  out: '/tmp/issue-context.md',
  extraIssues: [],
};

/** Same-repo extra requests, in the subcommand's RequestedIssue shape. */
function ex(...numbers: number[]) {
  return numbers.map((number) => ({ number, ownerRepo: 'QwenLM/qwen-code' }));
}

function mockClosing(refs: unknown[]): void {
  ghMock.mockReturnValueOnce(JSON.stringify({ closingIssuesReferences: refs }));
}

function mockIssue(title: string, comments: unknown[] = []): void {
  ghMock.mockReturnValueOnce(JSON.stringify({ title, body: '', comments }));
}

describe('runIssueContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
  });

  it('fetches each closing issue from its own repository and renders body + comments', () => {
    mockClosing([
      {
        number: 9078,
        repository: { name: 'qwen-code', owner: { login: 'QwenLM' } },
      },
    ]);
    ghMock.mockReturnValueOnce(
      JSON.stringify({
        title: 'the bug',
        body: 'repro steps',
        comments: [
          {
            author: { login: 'maintainer' },
            body: 'confirmed',
            createdAt: '2026-08-01',
          },
        ],
      }),
    );

    const result = runIssueContext(ARGS);

    expect(ghMock).toHaveBeenNthCalledWith(
      1,
      'pr',
      'view',
      '9077',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'closingIssuesReferences',
    );
    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      'issue',
      'view',
      '9078',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'title,body,comments',
    );
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      dirname(resolve('/tmp/issue-context.md')),
      { recursive: true },
    );
    // The write TARGET, not just the content: a redirected write that still
    // reported the right body used to ship green (#9194).
    expect(writeFileSyncMock.mock.calls[0][0]).toBe(
      resolve('/tmp/issue-context.md'),
    );
    expect(written).toContain('untrusted user input');
    expect(written).toContain('## Issue #9078 of QwenLM/qwen-code: the bug');
    expect(written).toContain('repro steps');
    expect(written).toContain('**maintainer** (2026-08-01):');
    expect(written).toContain('confirmed');
    // The placeholder never accompanies a rendered thread.
    expect(written).not.toContain('_(no comments)_');
    expect(result.closingIssues).toEqual([
      { number: 9078, ownerRepo: 'QwenLM/qwen-code', title: 'the bug' },
    ]);
    expect(result.unfetchable).toEqual([]);
    expect(result.outPath).toBe(resolve('/tmp/issue-context.md'));
  });

  it('uses the reference repository, not the PR repo, for cross-repo issues', () => {
    mockClosing([
      {
        number: 42,
        repository: { name: 'other', owner: { login: 'acme' } },
      },
    ]);
    mockIssue('elsewhere');

    const result = runIssueContext(ARGS);

    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      'issue',
      'view',
      '42',
      '--repo',
      'acme/other',
      '--json',
      'title,body,comments',
    );
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('_(no comments)_');
    expect(result.unfetchable).toEqual([]);
  });

  it('writes an explicit empty-statement when no closing issues are linked', () => {
    mockClosing([]);
    const result = runIssueContext(ARGS);
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('No closing issues are linked');
    // No extras were requested — the extras section must be ABSENT, not
    // empty (its header asserts "requested explicitly").
    expect(written).not.toContain('Additionally fetched issues');
    expect(result.closingIssues).toEqual([]);
  });

  it('renders an indented first line verbatim (no trim) — it is the code block', () => {
    mockClosing([
      {
        number: 9,
        repository: { name: 'qwen-code', owner: { login: 'QwenLM' } },
      },
    ]);
    ghMock.mockReturnValueOnce(
      JSON.stringify({
        title: 't',
        body: '    at Object.<anonymous> (/tmp/repro.js:1:1)',
        comments: [
          {
            author: { login: 'm' },
            body: '  indented comment first line',
            createdAt: '',
          },
        ],
      }),
    );
    runIssueContext(ARGS);
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain(
      '\n    at Object.<anonymous> (/tmp/repro.js:1:1)',
    );
    expect(written).toContain('\n  indented comment first line');
  });

  it('a failed extra lands in unfetchable too (JSON and file agree)', () => {
    mockClosing([]);
    ghMock.mockImplementationOnce(() => {
      throw new Error('HTTP 404: Not Found');
    });
    const result = runIssueContext({ ...ARGS, extraIssues: ex(555) });
    expect(result.unfetchable).toEqual([
      {
        number: 555,
        ownerRepo: 'QwenLM/qwen-code',
        error: 'HTTP 404: Not Found',
      },
    ]);
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain(
      '## Issue #555 of QwenLM/qwen-code — could not be fetched',
    );
  });

  it('cross-repo closing refs keep their own repo in the result JSON', () => {
    mockClosing([
      {
        number: 42,
        repository: { name: 'other', owner: { login: 'acme' } },
      },
    ]);
    mockIssue('elsewhere');
    const result = runIssueContext(ARGS);
    expect(result.closingIssues).toEqual([
      { number: 42, ownerRepo: 'acme/other', title: 'elsewhere' },
    ]);
  });

  it('the extras section header does not claim NOT-in-closing when discovery failed', () => {
    ghMock.mockImplementationOnce(() => {
      throw new Error('HTTP 403: secondary rate limit');
    });
    mockIssue('five');
    runIssueContext({ ...ARGS, extraIssues: ex(555) });
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain(
      'Additionally fetched issues (referenced by the PR context; the closing set could not be checked)',
    );
    expect(written).not.toContain('NOT in the closing set');
  });

  it('fetches --issue extras from the PR repo, marks them as not-closing, and dedups closing numbers', () => {
    mockClosing([
      {
        number: 9078,
        repository: { name: 'qwen-code', owner: { login: 'QwenLM' } },
      },
    ]);
    mockIssue('closing one');
    mockIssue('referenced only');

    runIssueContext({ ...ARGS, extraIssues: ex(555, 9078) });

    // 9078 is already in the same-repo closing set — only 555 is fetched.
    expect(ghMock).toHaveBeenCalledTimes(3);
    expect(ghMock).toHaveBeenNthCalledWith(
      3,
      'issue',
      'view',
      '555',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'title,body,comments',
    );
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    // Pin the FULL header wording, not a prefix: the 'NOT in the closing
    // set' clause is the claim a reader acts on, and only the negative
    // (discovery-failed) case used to be asserted (#9194).
    expect(written).toContain(
      'Additionally fetched issues (referenced by the PR context, NOT in the closing set)',
    );
    expect(written).toContain(
      '## Issue #555 of QwenLM/qwen-code: referenced only',
    );
  });

  it('a cross-repo closing number does not shadow a same-numbered extra', () => {
    mockClosing([
      {
        number: 42,
        repository: { name: 'other', owner: { login: 'acme' } },
      },
    ]);
    mockIssue('closing elsewhere');
    mockIssue('our own 42');

    runIssueContext({ ...ARGS, extraIssues: ex(42) });

    // The extra targets the PR repo's own #42 — a different issue from the
    // acme/other#42 closing ref, so both fetches must happen.
    expect(ghMock).toHaveBeenNthCalledWith(
      3,
      'issue',
      'view',
      '42',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'title,body,comments',
    );
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('## Issue #42 of acme/other: closing elsewhere');
    expect(written).toContain('## Issue #42 of QwenLM/qwen-code: our own 42');
  });

  it('dedups repeated --issue values', () => {
    mockClosing([]);
    mockIssue('five');
    runIssueContext({ ...ARGS, extraIssues: ex(5, 5) });
    // one closing-issues call + exactly one issue fetch
    expect(ghMock).toHaveBeenCalledTimes(2);
  });

  it('a repo-qualified extra is fetched from its OWN repository', () => {
    mockClosing([]);
    mockIssue('referenced elsewhere');
    runIssueContext({
      ...ARGS,
      extraIssues: [{ number: 7, ownerRepo: 'acme/widgets' }],
    });
    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      'issue',
      'view',
      '7',
      '--repo',
      'acme/widgets',
      '--json',
      'title,body,comments',
    );
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain(
      '## Issue #7 of acme/widgets: referenced elsewhere',
    );
  });

  it('a repo-qualified extra matching a closing ref dedups by (repo, number)', () => {
    mockClosing([
      {
        number: 42,
        repository: { name: 'widgets', owner: { login: 'acme' } },
      },
    ]);
    mockIssue('the closing one');
    // Same issue as the closing ref, requested repo-qualified — fetched once.
    runIssueContext({
      ...ARGS,
      extraIssues: [{ number: 42, ownerRepo: 'ACME/Widgets' }],
    });
    expect(ghMock).toHaveBeenCalledTimes(2); // discovery + one fetch
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).not.toContain('Additionally fetched issues');
  });

  it('an unreadable issue degrades to an explicit section, not an abort', () => {
    mockClosing([
      {
        number: 1,
        repository: { name: 'qwen-code', owner: { login: 'QwenLM' } },
      },
      {
        number: 2,
        repository: { name: 'restricted', owner: { login: 'acme' } },
      },
    ]);
    mockIssue('readable');
    ghMock.mockImplementationOnce(() => {
      throw new Error('HTTP 404: Not Found');
    });

    const result = runIssueContext(ARGS);

    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('## Issue #1 of QwenLM/qwen-code: readable');
    expect(written).toContain(
      '## Issue #2 of acme/restricted — could not be fetched',
    );
    expect(written).toContain('HTTP 404');
    expect(result.closingIssues).toEqual([
      { number: 1, ownerRepo: 'QwenLM/qwen-code', title: 'readable' },
    ]);
    expect(result.unfetchable).toEqual([
      {
        number: 2,
        ownerRepo: 'acme/restricted',
        error: 'HTTP 404: Not Found',
      },
    ]);
  });

  it('surfaces the gh-version floor for closingIssuesReferences', () => {
    ghMock.mockImplementationOnce(() => {
      throw new Error(
        'Unknown JSON field: "closingIssuesReferences"\navailable fields: …',
      );
    });
    // Discovery failure degrades into the evidence file (with the upgrade
    // hint), it does not abort the command — extras remain fetchable.
    const result = runIssueContext(ARGS);
    expect(result.discoveryError).toMatch(/gh >= 2\.72\.0/);
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('Closing-issue discovery FAILED');
    expect(written).toContain('gh >= 2.72.0');
    expect(written).not.toContain('No closing issues are linked');
  });

  it('still fetches --issue extras when discovery fails', () => {
    ghMock.mockImplementationOnce(() => {
      throw new Error('HTTP 403: secondary rate limit');
    });
    mockIssue('five');
    const result = runIssueContext({ ...ARGS, extraIssues: ex(555) });
    expect(result.discoveryError).toBe('HTTP 403: secondary rate limit');
    const written = writeFileSyncMock.mock.calls[0][1] as string;
    expect(written).toContain('## Issue #555 of QwenLM/qwen-code: five');
    expect(result.closingIssues).toEqual([]);
  });

  it('dedups extras against the closing set case-insensitively', () => {
    mockClosing([
      {
        number: 9078,
        repository: { name: 'qwen-code', owner: { login: 'QwenLM' } },
      },
    ]);
    mockIssue('closing one');
    // Hand-typed lowercase --repo, and the extra carries the user-typed
    // lowercase coordinate (the real handler path: `ownerRepo: or ?? repo`)
    // against the closing ref's canonical casing — this is what exercises
    // the toLowerCase() fold in the dedup key.
    runIssueContext({
      ...ARGS,
      repo: 'qwenlm/qwen-code',
      extraIssues: [{ number: 9078, ownerRepo: 'qwenlm/qwen-code' }],
    });
    // one discovery call + one issue fetch — no duplicate section
    expect(ghMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the PR repo for a closing ref with no repository payload', () => {
    // GraphQL's Issue.repository is NON_NULL, so this is a defensive branch —
    // pinned so a later "simplification" to a throw or a hardcode goes red.
    mockClosing([{ number: 77 }]);
    mockIssue('orphan ref');
    runIssueContext(ARGS);
    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      'issue',
      'view',
      '77',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'title,body,comments',
    );
  });
});

describe('issueContextCommand handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    process.exitCode = undefined;
  });

  it('threads --host to setGhHost before the first gh call', () => {
    mockClosing([]);
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
      host: 'ghe.example.com',
    });
    expect(setGhHostMock).toHaveBeenCalledWith('ghe.example.com');
    const ghOrder = ghMock.mock.invocationCallOrder[0];
    const authOrder = ensureAuthenticatedMock.mock.invocationCallOrder[0];
    const hostOrder = setGhHostMock.mock.invocationCallOrder[0];
    // ensureAuthenticated spawns the first real gh process (`gh auth
    // status`), so the ordering must hold against it too, not just the
    // data call.
    expect(hostOrder).toBeLessThan(Math.min(authOrder, ghOrder));
    // The other half of the invariant (#9194): the data fetch must not
    // precede authentication — a gh call that beats `gh auth status` races
    // the very credential it depends on.
    expect(authOrder).toBeLessThan(ghOrder);
  });

  it('exits 2 on a usage error (malformed --repo)', () => {
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: '../escape',
      out: '/tmp/ic.md',
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
    // The usage error must preempt the auth gate — `gh auth login` can
    // never repair the invocation.
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('a discovery failure degrades into the file (exit 0 with discoveryError)', () => {
    ghMock.mockImplementationOnce(() => {
      throw new Error('HTTP 500');
    });
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
    });
    expect(process.exitCode).toBeUndefined();
    expect(setGhHostMock).toHaveBeenCalledWith(undefined);
    expect(writeStdoutLineMock).toHaveBeenCalledWith(
      expect.stringContaining('"discoveryError":"HTTP 500"'),
    );
  });

  it('wires --issue through to the extra fetch', () => {
    mockClosing([]);
    mockIssue('five');
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
      issue: [555],
    });
    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      'issue',
      'view',
      '555',
      '--repo',
      'QwenLM/qwen-code',
      '--json',
      'title,body,comments',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('parses the documented repo-qualified grammar (--issue owner/repo#n)', () => {
    // The handler regex is the only parser of this grammar; pin it end to
    // end so a capture-group/# mutation can't hand runIssueContext a wrong
    // (number, ownerRepo) pair with the suite green.
    mockClosing([]);
    mockIssue('referenced elsewhere');
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
      issue: ['acme/widgets#7'],
    });
    expect(ghMock).toHaveBeenNthCalledWith(
      2,
      'issue',
      'view',
      '7',
      '--repo',
      'acme/widgets',
      '--json',
      'title,body,comments',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects a traversal-shaped qualified coordinate before any fetch', () => {
    // The regex syntactically admits `..` and dash-leading owners; the
    // isOwnerRepo clause is the only rejection. `--issue` is model-sourced
    // (Agent 0 builds the qualified form), so pin the refusal: a usage error
    // must stay exit 2, never degrade into an 'unfetchable' section.
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
      issue: ['../evil#7'],
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a non-positive pr_number or --issue, without calling gh or auth', () => {
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 0,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
    });
    expect(process.exitCode).toBe(2);
    // Reset so the second assertion verifies the guard assigns the code,
    // not that it rides the first invocation's residue.
    process.exitCode = undefined;
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
      issue: [0],
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a fractional pr_number — the isInteger half of the guard (#9194)', () => {
    // The non-positive cases above exercise `<= 0`; the `Number.isInteger`
    // half used to be untested, so a guard that only checked positivity
    // would ship green and let `1.5` reach the gh call.
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1.5,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on an empty --out (classified before any fetch)', () => {
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '',
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a whitespace-only --out', () => {
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: ' ',
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 2 on a malformed --host (setGhHost TypeError → usage class)', () => {
    setGhHostMock.mockImplementationOnce(() => {
      throw new TypeError('--host must be a hostname');
    });
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
      host: 'bad host; rm -rf /',
    });
    expect(process.exitCode).toBe(2);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('exits 1 on an auth failure (runtime class, not usage)', () => {
    ensureAuthenticatedMock.mockImplementationOnce(() => {
      throw new Error('gh CLI is not authenticated');
    });
    (issueContextCommand.handler as (a: unknown) => void)({
      _: [],
      $0: 'qwen',
      pr_number: 1,
      repo: 'QwenLM/qwen-code',
      out: '/tmp/ic.md',
    });
    expect(process.exitCode).toBe(1);
    expect(ghMock).not.toHaveBeenCalled();
  });
});
