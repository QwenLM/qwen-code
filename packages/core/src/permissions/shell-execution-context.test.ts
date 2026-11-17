/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import {
  detectCommandSubstitution,
  normalizeMonitorCommand,
  stripShellCommandPrefixes,
} from '../utils/shell-utils.js';
import { PermissionManager } from './permission-manager.js';
import { hasUnsupportedShellSyntax } from './rule-parser.js';
import { extractShellOperationsAcrossCommand } from './shell-semantics.js';

interface Expected {
  decision?: 'allow' | 'ask' | 'deny' | 'not-allow';
  operation?: { virtualTool: string; filePath: string };
  operationsEmpty?: boolean;
  strictPrefixUnsupported?: boolean;
  substitution?: boolean;
}

interface Probe {
  id: string;
  command: string;
  expected: Expected;
  allow?: string[];
  deny?: string[];
  cwd?: string;
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const probes: Probe[] = [];
const add = (
  id: string,
  command: string,
  expected: Expected,
  options: Pick<Probe, 'allow' | 'deny' | 'cwd'> = {},
) => probes.push({ id, command, expected, ...options });

for (const command of [
  'cd /tmp || cd /var && echo x >protected',
  'cd /tmp || true; echo x >protected',
  'cd /tmp || true && echo x >protected',
  'cd /tmp || false; echo x >protected',
  'cd /tmp && true || true; echo x >protected',
  '! cd /tmp || echo x >protected',
  'cd /tmp && echo x >protected',
]) {
  add(`cwd join: ${command}`, command, { decision: 'not-allow' });
}
add('cwd background control', 'cd /tmp & echo x >protected', {
  decision: 'allow',
});
add('cwd pipeline control', 'cd /tmp | cat; echo x >protected', {
  decision: 'allow',
});

for (const command of [
  "env -S 'cat /etc/shadow'",
  "env -S 'cat\\_/etc/shadow'",
  "env -S '-i cat /etc/shadow'",
  "env --split-string='cat /etc/shadow'",
  'env -Scat /etc/shadow',
]) {
  add(
    `env argv: ${command}`,
    command,
    {
      decision: 'deny',
      operation: { virtualTool: 'read_file', filePath: '/etc/shadow' },
      strictPrefixUnsupported: true,
    },
    { deny: ['Read(//etc/shadow)'] },
  );
}
for (const command of [
  "env -S 'echo hi > /tmp/protected'",
  "env -S 'echo hi ; cat /etc/shadow'",
  "env -S 'echo hi' '> /tmp/protected'",
  "env -S 'echo' '$(cat /etc/shadow)'",
  'env -S \'echo "hi > /tmp/protected"\'',
]) {
  add(
    `env literal argv: ${command}`,
    command,
    { operationsEmpty: true },
    {
      deny: ['Read(//etc/shadow)', 'Edit(//tmp/protected)'],
    },
  );
}
// The real GNU env witness rejects this spelling as an executable name.
add(
  'env tab escape negative control',
  "env -S 'cat\\t/etc/shadow'",
  {
    operationsEmpty: true,
    strictPrefixUnsupported: true,
  },
  { deny: ['Read(//etc/shadow)'] },
);
add('env shell payload executes', "env -S 'sh -c' 'echo hi > /tmp/protected'", {
  decision: 'deny',
  operation: { virtualTool: 'write_file', filePath: '/tmp/protected' },
});
add(
  'env literal prefix argument boundary',
  "env -S 'printf %s' 'literal > /tmp/protected'",
  {
    operationsEmpty: true,
  },
);

for (const prefix of [
  'sudo -u root -E',
  'sudo -uroot -E',
  'stdbuf -o 0',
  'ionice --class=3',
  'timeout -k 2 --preserve-status 5',
  'doas -u root --',
  'env -u UNUSED --',
  'setsid -f --',
]) {
  add(
    `prefix operand boundary: ${prefix}`,
    `${prefix} sh -c 'echo hi > /tmp/protected'`,
    {
      decision: 'deny',
      operation: { virtualTool: 'write_file', filePath: '/tmp/protected' },
    },
  );
}

let nested = 'cat /etc/shadow';
for (let depth = 1; depth <= 6; depth++) {
  nested = `env -S ${quote(nested)}`;
  add(
    `env depth ${depth}`,
    nested,
    { decision: 'not-allow', strictPrefixUnsupported: true },
    {
      deny: ['Read(//etc/shadow)'],
    },
  );
}

for (const command of [
  "oksh -c 'echo hi > /tmp/protected'",
  'git ${x:- y} > $OUT push origin main',
]) {
  add(
    `caller guard without matching Bash allow: ${command}`,
    command,
    { decision: 'not-allow' },
    {
      allow: ['Bash(git status)'],
    },
  );
}

for (const [id, command, substitution] of [
  ['quoted closing brace', "echo ${x:-'x}'} # $(printf X)", false],
  [
    'double quoted brace in unquoted parameter',
    'echo ${x:-"x}"} # $(printf X)',
    false,
  ],
  [
    'parameter quote then next-line substitution',
    "echo ${x:-'x}'} # don't\nprintf '%s' $(printf X)",
    true,
  ],
  ['nested default after close', 'echo ${x:-${y:-value}} # $(printf X)', false],
  ['parameter trim escaped brace', 'echo ${x%\\}} # $(printf X)', false],
] as const) {
  add(`comment adjacency: ${id}`, command, { substitution });
}

for (const [id, command, target] of [
  [
    'lastpipe semicolon tail',
    'shopt -s lastpipe; printf x | cd /tmp; echo x >protected',
    '/tmp/protected',
  ],
  [
    'lastpipe AND tail',
    'shopt -s lastpipe; printf x | cd /tmp && echo x >protected',
    '/tmp/protected',
  ],
  [
    'lastpipe wrapper option',
    "bash -O lastpipe -c 'printf x | cd /tmp; echo x >protected'",
    '/tmp/protected',
  ],
  [
    'CDPATH export',
    'export CDPATH=/tmp; cd core && echo x >protected',
    '/tmp/core/protected',
  ],
  [
    'CDPATH quoted export',
    'export "CDPATH=/tmp"; cd core && echo x >protected',
    '/tmp/core/protected',
  ],
  [
    'CDPATH leading assignment control',
    'CDPATH=/tmp cd core && echo x >protected',
    '/tmp/core/protected',
  ],
  [
    'lastpipe combined cO option',
    "bash -cO lastpipe 'printf x | cd /tmp; echo x >protected'",
    '/tmp/protected',
  ],
  [
    'combined co option payload',
    "bash -co posix 'cd /tmp; echo x >protected'",
    '/tmp/protected',
  ],
  [
    'lastpipe BASHOPTS environment',
    "env BASHOPTS=lastpipe bash -c 'printf x | cd /tmp; echo x >protected'",
    '/tmp/protected',
  ],
  [
    'CDPATH printf variable assignment',
    'printf -v CDPATH %s /tmp; cd core && echo x >protected',
    '/tmp/core/protected',
  ],
  [
    'CDPATH env child shell',
    "env CDPATH=/tmp sh -c 'cd core && echo x >protected'",
    '/tmp/core/protected',
  ],
  [
    'CDPATH assigned child shell',
    "CDPATH=/tmp sh -c 'cd core && echo x >protected'",
    '/tmp/core/protected',
  ],
  [
    'CDPATH builtin export prefix',
    'builtin export CDPATH=/tmp; cd core && echo x >protected',
    '/tmp/core/protected',
  ],
] as const) {
  add(
    `cwd configuration: ${id}`,
    command,
    { decision: 'not-allow' },
    { deny: [`Edit(/${target})`] },
  );
}

for (const command of [
  'shopt -p lastpipe',
  'shopt lastpipe',
  'export MODE=test',
  "export NOTE='CDPATH=/tmp'",
]) {
  add(`cwd configuration query control: ${command}`, command, {
    decision: 'allow',
  });
}

describe('shell permission branch joins and prefix argument boundaries', () => {
  it.each(probes)('$id', async (probe) => {
    const cwd = probe.cwd ?? '/project';
    const pm = new PermissionManager({
      getPermissionsAllow: () => probe.allow ?? ['Bash(*)'],
      getPermissionsAsk: () => [],
      getPermissionsDeny: () => probe.deny ?? ['Edit(//tmp/protected)'],
      getProjectRoot: () => cwd,
      getCwd: () => cwd,
      getShellExecutionSandbox: () => true,
    });
    pm.initialize();
    const ctx = { toolName: 'run_shell_command', command: probe.command };
    const operations = extractShellOperationsAcrossCommand(probe.command, cwd);
    const decision = await pm.evaluate(ctx);
    const integrated = await evaluatePermissionRules(pm, 'allow', ctx);
    if (probe.expected.decision === 'not-allow') {
      expect.soft(decision, 'direct decision').not.toBe('allow');
      expect
        .soft(integrated.finalPermission, 'caller decision')
        .not.toBe('allow');
    } else if (probe.expected.decision) {
      expect.soft(decision, 'direct decision').toBe(probe.expected.decision);
      expect
        .soft(integrated.finalPermission, 'caller decision')
        .toBe(probe.expected.decision);
    }
    if (probe.expected.operation) {
      expect
        .soft(operations, 'required virtual operation')
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining(probe.expected.operation),
          ]),
        );
    }
    if (probe.expected.operationsEmpty) {
      expect.soft(operations, 'literal argv has no file effects').toEqual([]);
    }
    if (probe.expected.strictPrefixUnsupported) {
      expect
        .soft(
          stripShellCommandPrefixes(probe.command),
          'env -S remains unsupported for grants',
        )
        .toBeUndefined();
    }
    if (probe.expected.substitution !== undefined) {
      expect
        .soft(detectCommandSubstitution(probe.command), 'substitution')
        .toBe(probe.expected.substitution);
    }
  });

  it.each([
    ['core', 'not-allow'],
    ['./core', 'allow'],
    ['../core', 'allow'],
  ] as const)(
    'respects host CDPATH while resolving %s',
    async (target, expected) => {
      const previous = process.env['CDPATH'];
      process.env['CDPATH'] = '/tmp';
      try {
        const pm = new PermissionManager({
          getPermissionsAllow: () => ['Bash(*)'],
          getPermissionsAsk: () => [],
          getPermissionsDeny: () => ['Edit(//tmp/core/protected)'],
          getProjectRoot: () => '/project',
          getCwd: () => '/project',
          getShellExecutionSandbox: () => true,
        });
        pm.initialize();
        const ctx = {
          toolName: 'run_shell_command',
          command: `cd ${target} && echo x >protected`,
        };
        const decision = await pm.evaluate(ctx);
        const integrated = await evaluatePermissionRules(pm, 'allow', ctx);
        if (expected === 'not-allow') {
          expect.soft(decision).not.toBe('allow');
          expect.soft(integrated.finalPermission).not.toBe('allow');
        } else {
          expect.soft(decision).toBe('allow');
          expect.soft(integrated.finalPermission).toBe('allow');
        }
      } finally {
        if (previous === undefined) delete process.env['CDPATH'];
        else process.env['CDPATH'] = previous;
      }
    },
  );

  it.each([
    "oksh -c 'echo hi > /tmp/protected'",
    'git ${x:- y} > $OUT push origin main',
  ])(
    'preserves an existing YOLO allow when no rules restrict %s',
    async (command) => {
      const pm = new PermissionManager({
        getPermissionsAllow: () => [],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => [],
        getApprovalMode: () => 'yolo',
        getProjectRoot: () => '/project',
        getCwd: () => '/project',
        getShellExecutionSandbox: () => true,
      });
      pm.initialize();
      const ctx = { toolName: 'run_shell_command', command };
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
      expect(pm.hasRelevantRules(ctx)).toBe(false);
      expect(await evaluatePermissionRules(pm, 'allow', ctx)).toEqual({
        finalPermission: 'allow',
        pmForcedAsk: false,
      });
    },
  );
});

describe('monitor shell wrapper safety', () => {
  const makeManager = () => {
    const pm = new PermissionManager({
      getPermissionsAllow: () => ['Bash(*)'],
      getPermissionsAsk: () => [],
      getPermissionsDeny: () => ['Edit(//tmp/protected)'],
      getProjectRoot: () => '/project',
      getCwd: () => '/project',
      getShellExecutionSandbox: () => true,
    });
    pm.initialize();
    return pm;
  };

  describe.each(['', 'FOO=bar '])('prefix %s', (prefix) => {
    it.each([
      "bash -O lastpipe -c 'printf x | cd /tmp; echo x >protected'",
      "bash -cO lastpipe 'printf x | cd /tmp; echo x >protected'",
      "bash -co posix 'cd /tmp; echo x >protected'",
    ])('preserves unsupported wrapper semantics for %s', async (wrapper) => {
      const command = prefix + wrapper;
      const normalized = normalizeMonitorCommand(command);
      const ctx = { toolName: 'monitor', command };
      const pm = makeManager();
      expect.soft(normalized.spawnCommand).toBe(command);
      expect.soft(hasUnsupportedShellSyntax(command)).toBe(true);
      expect
        .soft(hasUnsupportedShellSyntax(normalized.safetyCommand))
        .toBe(true);
      expect.soft(await pm.evaluate(ctx)).not.toBe('allow');
      expect
        .soft((await evaluatePermissionRules(pm, 'allow', ctx)).finalPermission)
        .not.toBe('allow');
    });

    it('preserves ordinary wrapper approval and spawn command', async () => {
      const command = prefix + "bash -c 'echo ordinary'";
      const normalized = normalizeMonitorCommand(command);
      const ctx = { toolName: 'monitor', command };
      const pm = makeManager();
      expect(normalized.spawnCommand).toBe(command);
      expect(hasUnsupportedShellSyntax(command)).toBe(false);
      expect(hasUnsupportedShellSyntax(normalized.safetyCommand)).toBe(false);
      expect(await pm.evaluate(ctx)).toBe('allow');
      expect(
        (await evaluatePermissionRules(pm, 'allow', ctx)).finalPermission,
      ).toBe('allow');
    });
  });
});
