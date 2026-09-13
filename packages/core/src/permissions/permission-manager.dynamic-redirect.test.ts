/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { PermissionManager } from './permission-manager.js';
import type { PermissionManagerConfig } from './permission-manager.js';
import {
  extractShellOperations,
  extractShellOperationsAcrossCommand,
} from './shell-semantics.js';

function makeManager(
  allow: string[] = ['Bash(printf PAYLOAD)'],
  deny: string[] = ['WriteFileTool(protected.txt)'],
  ask: string[] = [],
): PermissionManager {
  const config: PermissionManagerConfig = {
    getPermissionsAllow: () => allow,
    getPermissionsAsk: () => ask,
    getPermissionsDeny: () => deny,
    getProjectRoot: () => '/repo',
    getCwd: () => '/repo',
  };
  const pm = new PermissionManager(config);
  pm.initialize();
  return pm;
}

describe('dynamic redirect permission floor', () => {
  it('does not let $PWD redirect bypass a Write deny through a Bash allow', async () => {
    await expect(
      makeManager().evaluate({
        toolName: 'run_shell_command',
        command: 'printf PAYLOAD >"$PWD/protected.txt"',
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
  });

  it('does not let ${PWD} redirect bypass the conservative floor', async () => {
    await expect(
      makeManager().evaluate({
        toolName: 'run_shell_command',
        command: 'printf PAYLOAD >"${PWD}/protected.txt"',
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
  });

  it('handles a separate-token dynamic redirect conservatively', async () => {
    await expect(
      makeManager().evaluate({
        toolName: 'run_shell_command',
        command: 'printf PAYLOAD > "$PWD/protected.txt"',
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
  });

  it('preserves numeric file-descriptor redirect targets', async () => {
    await expect(
      makeManager().evaluate({
        toolName: 'run_shell_command',
        command: 'printf PAYLOAD 3>protected.txt >&3',
        cwd: '/repo',
      }),
    ).resolves.toBe('deny');
  });

  it.each([
    'printf PAYLOAD 2>&1',
    'printf PAYLOAD >&3',
    'printf PAYLOAD >&-',
    'printf PAYLOAD 2>& 1',
    'printf PAYLOAD >& 3',
    'printf PAYLOAD >& -',
    'printf PAYLOAD 2> &1',
    'printf PAYLOAD 2> &-',
  ])('does not treat fd duplication as a file write: %s', (command) => {
    expect(
      extractShellOperations(command, '/repo').filter(
        (op) => op.virtualTool === 'write_file',
      ),
    ).toEqual([]);
  });
  it.each([
    'printf PAYLOAD >| protected.txt',
    'printf PAYLOAD >{protected,x}.txt',
    'printf PAYLOAD >protecte{d..d}.txt',
    'printf PAYLOAD > >(tee protected.txt)',
    'echo "$(echo hi > protected.txt)"',
    'printf PAYLOAD foo1>protected.txt',
    'printf PAYLOAD > my\\ $X.txt',
    'printf PAYLOAD > \\\nprotected.txt',
    'printf PAYLOAD > protected.txt</etc/hostname',
    "echo '2>&' > protected.txt",
    "echo $'a\\'b' > protected.txt",
    'printf PAYLOAD \\>> "$PWD/protected.txt"',
    'printf PAYLOAD >protected$SUF.txt',
    'printf PAYLOAD >`pwd`/protected.txt',
    'printf PAYLOAD >&protected.txt',
    'printf PAYLOAD {tmpfd}>protected.txt',
    'echo payload >protec*.txt',
    'echo hi>protected.txt',
  ])(
    'fails closed for AST-confirmed redirect/write form: %s',
    async (command) => {
      await expect(
        makeManager(['Bash(*)']).evaluate({
          toolName: 'run_shell_command',
          command,
          cwd: '/repo',
        }),
      ).resolves.not.toBe('allow');
    },
  );

  it('preserves command semantics when stderr target is dynamic', async () => {
    const config: PermissionManagerConfig = {
      getPermissionsAllow: () => ['Bash(mv *)'],
      getPermissionsAsk: () => [],
      getPermissionsDeny: () => ['WriteFileTool(b.txt)'],
      getProjectRoot: () => '/repo',
      getCwd: () => '/repo',
    };
    const pm = new PermissionManager(config);
    pm.initialize();
    await expect(
      pm.evaluate({
        toolName: 'run_shell_command',
        command: 'mv a.txt b.txt 2> $ERR',
        cwd: '/repo',
      }),
    ).resolves.toBe('deny');
  });

  it('does not create a write op for spaced /dev/null redirect', () => {
    expect(
      extractShellOperations('cat /etc/passwd 2> /dev/null', '/repo').filter(
        (op) => op.virtualTool === 'write_file',
      ),
    ).toEqual([]);
  });

  it.each([
    'printf PAYLOAD >>"$PWD/protected.txt"',
    'printf PAYLOAD >> "$PWD/protected.txt"',
  ])('fails closed for dynamic append redirect: %s', async (command) => {
    await expect(
      makeManager().evaluate({
        toolName: 'run_shell_command',
        command,
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
  });

  it('preserves a separate-token numeric-fd file write', async () => {
    await expect(
      makeManager().evaluate({
        toolName: 'run_shell_command',
        command: 'printf PAYLOAD 3> protected.txt',
        cwd: '/repo',
      }),
    ).resolves.toBe('deny');
  });

  it('fails closed for assignment-only dynamic redirect', async () => {
    await expect(
      makeManager(['Bash(*)']).evaluate({
        toolName: 'run_shell_command',
        command: 'FOO=bar >"$PWD/protected.txt"',
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
  });

  it('keeps spaced fd duplication out of Write permission matching', async () => {
    await expect(
      makeManager().evaluate({
        toolName: 'run_shell_command',
        command: 'printf PAYLOAD 2>& 1',
        cwd: '/repo',
      }),
    ).resolves.toBe('allow');
  });

  it('treats <> as a read-write file redirect', async () => {
    const operations = extractShellOperations(
      'printf PAYLOAD <> protected.txt',
      '/repo',
    );
    expect(operations).toContainEqual({
      virtualTool: 'write_file',
      filePath: '/repo/protected.txt',
    });
    await expect(
      makeManager().evaluate({
        toolName: 'run_shell_command',
        command: 'printf PAYLOAD <> protected.txt',
        cwd: '/repo',
      }),
    ).resolves.toBe('deny');
  });

  it('fails closed for a dynamic <> destination', async () => {
    await expect(
      makeManager().evaluate({
        toolName: 'run_shell_command',
        command: 'printf PAYLOAD <> "$PWD/protected.txt"',
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
  });

  it('keeps absolute numeric-fd redirect targets independent of dynamic cwd', () => {
    const write = extractShellOperationsAcrossCommand(
      'cd $DYN && cat x 3>/abs/out',
      '/repo',
    ).find(
      (op) => op.virtualTool === 'write_file' && op.filePath === '/abs/out',
    );
    expect(write).toBeDefined();
    expect(write?.pathMayDependOnCwd).toBe(false);
  });

  it.each([
    'printf PAYLOAD > out.txt # > $X',
    '[[ $a > $b ]]',
    'printf PAYLOAD &> log.txt',
    'printf PAYLOAD &>> log.txt',
    '(echo err >&2)',
    '(printf PAYLOAD >&3)',
    'printf x >&2<input',
    'echo "a > $X b"',
  ])(
    'does not invent a filesystem write from non-write shell syntax: %s',
    async (command) => {
      await expect(
        makeManager(['Bash(*)'], ['WriteFileTool(secret.txt)']).evaluate({
          toolName: 'run_shell_command',
          command,
          cwd: '/repo',
        }),
      ).resolves.toBe('allow');
    },
  );

  it('keeps spaced read-write /dev/null redirects exempt', async () => {
    await expect(
      makeManager(['Bash(*)'], ['WriteFileTool']).evaluate({
        toolName: 'run_shell_command',
        command: 'cat x <> /dev/null',
        cwd: '/repo',
      }),
    ).resolves.toBe('allow');
  });

  it('does not turn a quoted redirect-like cp argument into shell syntax', async () => {
    await expect(
      makeManager(['Bash(*)'], ['WriteFileTool(secret.txt)']).evaluate({
        toolName: 'run_shell_command',
        command: "cp '3>' protected.txt secret.txt",
        cwd: '/repo',
      }),
    ).resolves.not.toBe('allow');
  });

  it('fails closed for a named-user tilde redirect target', async () => {
    await expect(
      makeManager(['Bash(*)'], ['WriteFileTool(/root/protected.txt)']).evaluate(
        {
          toolName: 'run_shell_command',
          command: 'printf PAYLOAD > ~root/protected.txt',
          cwd: '/repo',
        },
      ),
    ).resolves.not.toBe('allow');
  });

  it('fails closed after a named-user tilde cd target', async () => {
    await expect(
      makeManager(['Bash(*)'], ['WriteFileTool(/root/secret.txt)']).evaluate({
        toolName: 'run_shell_command',
        command: 'cd ~root && echo x > secret.txt',
        cwd: '/repo',
      }),
    ).resolves.not.toBe('allow');
  });

  it.each([
    'bash -c \'printf PAYLOAD >"$PWD/protected.txt"\'',
    'bash -lc \'printf PAYLOAD >"$PWD/protected.txt"\'',
    'sh -c \'printf PAYLOAD >"$PWD/protected.txt"\'',
    'timeout 2 bash -c \'printf PAYLOAD >"$PWD/protected.txt"\'',
  ])(
    'fails closed for wrapped dynamic redirect payload: %s',
    async (command) => {
      await expect(
        makeManager(['Bash(*)']).evaluate({
          toolName: 'run_shell_command',
          command,
          cwd: '/repo',
        }),
      ).resolves.not.toBe('allow');
    },
  );

  it('does not reconcile a redirect against an unrelated suffix-colliding write', async () => {
    await expect(
      makeManager(['Bash(*)']).evaluate({
        toolName: 'run_shell_command',
        command: 'cp a.txt dir/protected.txt && echo hi>protected.txt',
        cwd: '/repo',
      }),
    ).resolves.not.toBe('allow');
  });

  it('keeps quoted tilde redirects out of home-expansion allows', async () => {
    await expect(
      makeManager(
        ['Bash(*)', 'WriteFileTool(~/**)'],
        ['WriteFileTool(/repo/**)'],
      ).evaluate({
        toolName: 'run_shell_command',
        command: "printf PAYLOAD > '~/pwn.txt'",
        cwd: '/repo',
      }),
    ).resolves.not.toBe('allow');
  });

  it.each([
    'cd -P ~root && echo x > secret.txt',
    'cd ~root\necho x > secret.txt',
    '(cd ~root; echo x > secret.txt)',
    'if [ -d x ]; then cd ~root && echo x > secret.txt; fi',
    'builtin cd ~root && echo x > secret.txt',
    'cd ~+ && echo x > secret.txt',
    'cd ~root </dev/null && echo x > secret.txt',
    'cd ~root >/dev/null && echo x > secret.txt',
    'cd ~root 2>&1 && echo x > secret.txt',
    'pushd ~root </dev/null && echo x > secret.txt',
  ])('fails closed after named-tilde cwd: %s', async (command) => {
    await expect(
      makeManager(['Bash(*)'], ['WriteFileTool(secret.txt)']).evaluate({
        toolName: 'run_shell_command',
        command,
        cwd: '/repo',
      }),
    ).resolves.not.toBe('allow');
  });

  it.each([
    "touch '>x' && mv '>x' secret.txt",
    "cp '3>' a b && echo x > log.txt",
    "if true; then cp '3>' protected.txt secret.txt; fi",
    "sudo cp '3>' a b",
  ])(
    'fails closed for quoted redirect-like write argument: %s',
    async (command) => {
      await expect(
        makeManager(['Bash(*)'], ['WriteFileTool(secret.txt)']).evaluate({
          toolName: 'run_shell_command',
          command,
          cwd: '/repo',
        }),
      ).resolves.not.toBe('allow');
    },
  );

  it.each([
    'false && cd /tmp; echo hi > secret.txt',
    'true || cd /tmp; echo hi > secret.txt',
  ])('does not trust a short-circuit-skipped cd: %s', async (command) => {
    await expect(
      makeManager(['Bash(*)'], ['WriteFileTool(secret.txt)']).evaluate({
        toolName: 'run_shell_command',
        command,
        cwd: '/repo',
      }),
    ).resolves.not.toBe('allow');
  });

  it.each([
    'echo secret > 123',
    'echo secret > -x',
    'echo secret > --weird',
    'echo secret >> 123',
    'echo secret 1> 123',
    'cat <> 123',
  ])(
    'extracts redirect filenames rejected by command-argument heuristics: %s',
    (command) => {
      expect(
        extractShellOperations(command, '/repo').some(
          (op) => op.virtualTool === 'write_file' && op.filePath,
        ),
      ).toBe(true);
    },
  );

  it('makes an AST-only write relevant without a Bash rule', async () => {
    const pm = makeManager([], ['WriteFileTool(protected.txt)']);
    await expect(
      pm.hasRelevantRules({
        toolName: 'run_shell_command',
        command: 'printf PAYLOAD > >(tee protected.txt)',
        cwd: '/repo',
      }),
    ).resolves.toBe(true);
  });

  it('keeps spaced fd close out of the conservative AST floor', async () => {
    await expect(
      makeManager(['Bash(*)'], ['WriteFileTool']).evaluate({
        toolName: 'run_shell_command',
        command: 'printf PAYLOAD 2> &-',
        cwd: '/repo',
      }),
    ).resolves.toBe('allow');
  });

  it('does not treat quoted named-tilde text as cwd mutation', async () => {
    await expect(
      makeManager(['Bash(*)'], ['WriteFileTool(secret.txt)']).evaluate({
        toolName: 'run_shell_command',
        command: 'echo "x; cd ~root && y" > notes.txt',
        cwd: '/repo',
      }),
    ).resolves.toBe('allow');
  });

  it('keeps bare absolute redirects independent of dynamic cwd', () => {
    for (const command of [
      'cd $DYN && cat x >/abs/out',
      'cd $DYN && cat x >>/abs/out',
    ]) {
      const write = extractShellOperationsAcrossCommand(command, '/repo').find(
        (op) => op.virtualTool === 'write_file' && op.filePath === '/abs/out',
      );
      expect(write?.pathMayDependOnCwd).toBe(false);
    }
  });

  it('keeps assignment-only unresolved redirect visible at extractor level', () => {
    expect(
      extractShellOperations('FOO=bar >"$PWD/protected.txt"', '/repo'),
    ).toContainEqual({
      virtualTool: 'write_file',
      cwdUnknown: true,
      pathMayDependOnCwd: true,
    });
  });

  it('normalizes parent-directory redirects before AST reconciliation', async () => {
    await expect(
      makeManager(['Bash(*)'], ['WriteFileTool(secret.txt)']).evaluate({
        toolName: 'run_shell_command',
        command: 'echo x > ../out.txt',
        cwd: '/repo',
      }),
    ).resolves.toBe('allow');
  });

  it('keeps a glued absolute redirect independent of dynamic cwd', async () => {
    await expect(
      makeManager(['Bash(*)'], ['WriteFileTool(secret.txt)']).evaluate({
        toolName: 'run_shell_command',
        command: 'cd $DYN && cat x >/abs/out',
        cwd: '/repo',
      }),
    ).resolves.toBe('allow');
  });
});
