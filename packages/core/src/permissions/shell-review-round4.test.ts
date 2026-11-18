/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import { gateCommandError } from '../services/cron-gate.js';
import { suggestCommandRules } from './command-rule-suggestions.js';
import { PermissionManager } from './permission-manager.js';
import { extractShellOperationsAcrossCommand } from './shell-semantics.js';

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const makeManager = (deny: string[], allow = ['Bash(*)']) => {
  const manager = new PermissionManager({
    getPermissionsAllow: () => allow,
    getPermissionsAsk: () => [],
    getPermissionsDeny: () => deny,
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getShellExecutionSandbox: () => true,
  });
  manager.initialize();
  return manager;
};

describe('reachable working-directory effects', () => {
  it.each([
    ['cd /tmp || true && echo x > protected', '/tmp/protected'],
    ['cd /tmp || true && echo x > protected', '/project/protected'],
    ['cd /tmp || cd /var && echo x > protected', '/tmp/protected'],
    ['cd /tmp || cd /var && echo x > protected', '/var/protected'],
    ['cd /tmp || true; cat protected', '/tmp/protected'],
    ['cd /tmp && true || true; echo x > protected', '/tmp/protected'],
    ['! cd /tmp || echo x > protected', '/tmp/protected'],
    ["cd /tmp || true && bash -c 'echo x > protected'", '/tmp/protected'],
    [
      'cd /tmp || true && cd child || true; echo x > protected',
      '/tmp/child/protected',
    ],
  ])('keeps the deny for %s at %s', async (command, filePath) => {
    const read = command.includes('cat protected');
    const manager = makeManager([`${read ? 'Read' : 'Edit'}(/${filePath})`]);
    expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          virtualTool: read ? 'read_file' : 'write_file',
          filePath,
        }),
      ]),
    );
    for (const toolName of ['run_shell_command', 'monitor']) {
      const context = { toolName, command };
      expect(await manager.evaluate(context)).toBe('deny');
      expect(
        (await evaluatePermissionRules(manager, 'allow', context))
          .finalPermission,
      ).toBe('deny');
    }
  });

  it.each([
    ['cd /tmp && echo x > protected', '/tmp/protected'],
    ['cd /tmp & echo x > protected', '/project/protected'],
    ['cd /tmp | cat; echo x > protected', '/project/protected'],
  ])('does not invent another path for %s', (command, filePath) => {
    expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual([
      { virtualTool: 'write_file', filePath },
    ]);
  });
});

describe('multiline heredoc headers', () => {
  it.each(['"', "'", "$'"])(
    'retains a write following a multiline %s word',
    async (openingQuote) => {
      const closingQuote = openingQuote.endsWith("'") ? "'" : '"';
      const command = `cat <<EOF ${openingQuote}abc\ndef${closingQuote} > /tmp/protected\nbody\nEOF`;
      const manager = makeManager(['Edit(//tmp/protected)']);
      expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            virtualTool: 'write_file',
            filePath: '/tmp/protected',
          }),
        ]),
      );
      expect(
        await manager.evaluate({ toolName: 'run_shell_command', command }),
      ).toBe('deny');
    },
  );

  it.each(['&&', '||', '|'])(
    'does not turn a body after %s into shell effects',
    (operator) => {
      const command = `cat <<EOF ${operator}\necho x > /tmp/protected\nEOF\ntrue`;
      expect(
        extractShellOperationsAcrossCommand(command, '/project'),
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filePath: '/tmp/protected' }),
        ]),
      );
    },
  );
});

describe('effects at the shell unwrap limit', () => {
  it.each(['cat /etc/shadow', 'printf %s literal'])(
    'inspects a final env argv without executing literal data: %s',
    async (payload) => {
      let command = `env -S ${quote(payload)}`;
      for (let depth = 0; depth < 4; depth++) {
        command = `bash -c ${quote(command)}`;
      }
      const operations = extractShellOperationsAcrossCommand(
        command,
        '/project',
      );
      const manager = makeManager(['Read(//etc/shadow)']);
      const context = { toolName: 'run_shell_command', command };
      if (payload.startsWith('cat')) {
        expect(operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              virtualTool: 'read_file',
              filePath: '/etc/shadow',
            }),
          ]),
        );
        expect(await manager.evaluate(context)).toBe('deny');
      } else {
        expect(operations).toEqual([]);
        expect(
          await evaluatePermissionRules(manager, 'allow', context),
        ).toEqual({
          finalPermission: 'ask',
          pmForcedAsk: true,
        });
      }
    },
  );
});

describe('unmodeled execution entrances', () => {
  it.each([
    "bash --login -c 'echo ordinary'",
    "bash -lc 'echo ordinary'",
    "bash -ic 'echo ordinary'",
    "bash -c -l 'echo ordinary'",
    "bash -c -i 'echo ordinary'",
    "bash -c +x 'echo ordinary'",
    "bash --rcfile /tmp/startup -c 'echo ordinary'",
    "bash --debugger -c 'echo ordinary'",
    "bash -C -c 'echo ordinary'",
    'busybox env cat /etc/shadow',
    'busybox nice cat /etc/shadow',
    "busybox msh -c 'cat /etc/shadow'",
    'busybox find /tmp -exec cat /etc/shadow \\;',
    'busybox awk \'BEGIN { system("cat /etc/shadow") }\'',
    'taskset 1 cat /etc/shadow',
    'chroot /tmp cat /etc/shadow',
    'flock /tmp/lock cat /etc/shadow',
    'setpriv --no-new-privs cat /etc/shadow',
    'unshare cat /etc/shadow',
    'prlimit --cpu=1 cat /etc/shadow',
    'chrt 1 cat /etc/shadow',
    'watch cat /etc/shadow',
    "script -qc 'cat /etc/shadow' /dev/null",
    'PATH=/tmp/override git status',
    'LD_PRELOAD=/tmp/lib.so git status',
    'LD_LIBRARY_PATH=/tmp/lib git status',
    'env PATH=/tmp/override git status',
    'env LD_PRELOAD=/tmp/lib.so git status',
    'env LD_LIBRARY_PATH=/tmp/lib git status',
  ])('retains explicit confirmation for %s', async (command) => {
    const manager = makeManager([
      'Read(//etc/shadow)',
      'Edit(//tmp/protected)',
    ]);
    for (const toolName of ['run_shell_command', 'monitor']) {
      const context = { toolName, command };
      expect(await evaluatePermissionRules(manager, 'allow', context)).toEqual({
        finalPermission: 'ask',
        pmForcedAsk: true,
      });
    }
  });

  it.each([
    "bash -c 'echo ordinary'",
    "bash -c -- 'echo ordinary'",
    "bash --noprofile --norc -c 'echo ordinary'",
    "bash -ec 'echo ordinary'",
    "bash +x -c 'echo ordinary'",
    'FOO=bar git status',
    'env FOO=bar git status',
    'mapfile -t lines < input',
    'mapfile -d -C lines < input',
    'mapfile -dC lines < input',
    'readarray -d -- lines < input',
    'mapfile -- lines < input',
    'echo PATH=/tmp/override',
  ])('preserves ordinary grants for %s', async (command) => {
    const manager = makeManager([
      'Read(//etc/shadow)',
      'Edit(//tmp/protected)',
    ]);
    expect(
      await evaluatePermissionRules(manager, 'allow', {
        toolName: 'run_shell_command',
        command,
      }),
    ).toEqual({ finalPermission: 'allow', pmForcedAsk: false });
  });
});

describe.each(['mapfile', 'readarray'])(
  'known %s callback file effects',
  (builtin) => {
    it.each([
      ["-C 'echo x > /tmp/protected'", 'write_file', '/tmp/protected'],
      ["-d -- -C 'echo x > /tmp/protected'", 'write_file', '/tmp/protected'],
      ["-C 'cat /etc/shadow'", 'read_file', '/etc/shadow'],
      ["-C 'printf first' -C 'cat /etc/shadow'", 'read_file', '/etc/shadow'],
    ])(
      'retains the explicit deny for callback %s',
      async (options, virtualTool, filePath) => {
        const command = `${builtin} ${options} -c 1 < input`;
        const manager = makeManager([
          'Read(//etc/shadow)',
          'Edit(//tmp/protected)',
        ]);
        expect(
          extractShellOperationsAcrossCommand(command, '/project'),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ virtualTool, filePath }),
          ]),
        );
        for (const toolName of ['run_shell_command', 'monitor']) {
          const context = { toolName, command };
          expect(await manager.evaluate(context)).toBe('deny');
          expect(
            (await evaluatePermissionRules(manager, 'allow', context))
              .finalPermission,
          ).toBe('deny');
        }
      },
    );
  },
);

describe('scheduled gate background inspection', () => {
  it.each([
    "( bash -c './probe.sh &' )",
    "(bash -c './probe.sh &')",
    "true && ( bash -c './probe.sh &' )",
    "( ( bash -c './probe.sh &' ) )",
  ])('rejects a child script backgrounded inside %s', (command) => {
    expect(gateCommandError(command)).not.toBeNull();
  });

  it.each([
    "( bash -c './probe.sh' )",
    "echo '( bash -c data )'",
    "printf '%s' 'literal & data'",
    "echo $(printf '%s' literal)",
  ])('keeps a foreground or literal control: %s', (command) => {
    expect(gateCommandError(command)).toBeNull();
  });
});

describe.each(['Bash', 'Monitor'] as const)(
  '%s wrapper rule suggestions',
  (toolName) => {
    it('does not offer a blanket shell grant for an inner git command', async () => {
      const command = "bash -c 'git > /dev/null push origin main'";
      expect(await suggestCommandRules(command, toolName)).toEqual({
        permissionRules: [],
      });
    });

    it('still offers the eligible unwrapped git command', async () => {
      const command = 'git > /dev/null push origin main';
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        toolName,
      );
      expect(permissionRules.length).toBeGreaterThan(0);
      const manager = makeManager([], permissionRules);
      expect(
        await manager.evaluate({
          toolName: toolName === 'Bash' ? 'run_shell_command' : 'monitor',
          command,
        }),
      ).toBe('allow');
    });
  },
);
