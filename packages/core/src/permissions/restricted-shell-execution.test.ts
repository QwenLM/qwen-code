/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import {
  buildShellExecWarnings,
  detectCommandSubstitution,
  hasShellSubstitution,
  stripShellCommandPrefixes,
} from '../utils/shell-utils.js';
import { suggestCommandRules } from './command-rule-suggestions.js';
import {
  PermissionManager,
  splitCommandForRules,
} from './permission-manager.js';
import {
  hasUnsupportedShellSyntax,
  matchesRule,
  parseRule,
} from './rule-parser.js';
import { extractShellOperationsAcrossCommand } from './shell-semantics.js';

interface Probe {
  id: string;
  group: string;
  command: string;
  allow?: string[];
  deny?: string[];
  ask?: string[];
  cwd?: string;
  decision?: 'allow' | 'ask' | 'deny' | 'not-allow';
  unsupported?: boolean;
  substitution?: boolean;
  operation?: { virtualTool: string; filePath: string };
  unknownRelativeOperation?: boolean;
  splitCount?: number;
  prefixUnsupported?: boolean;
  restrictiveRule?: string;
  restrictiveMatch?: boolean;
  suggestions?: string[];
}

const protectedEdit = ['Edit(//tmp/protected)'];
const protectedRead = ['Read(//etc/shadow)'];
const probes: Probe[] = [];
function add(
  group: string,
  id: string,
  command: string,
  rest: Omit<Probe, 'id' | 'group' | 'command'> = {},
) {
  probes.push({ group, id, command, ...rest });
}

for (const command of ['source ./change-dir.sh', '. ./change-dir.sh']) {
  for (const operator of ['&&', '||', ';']) {
    add(
      'R6-2 cwd',
      `${command} ${operator}`,
      `${command} ${operator} git >protected push origin main`,
      {
        deny: protectedEdit,
        decision: 'not-allow',
        unknownRelativeOperation: true,
      },
    );
  }
  add(
    'R6-2 cwd',
    `${command} background control`,
    `${command} & git >protected push origin main`,
    {
      deny: protectedEdit,
      decision: 'allow',
    },
  );
}
for (const operator of ['||', ';', '&']) {
  add(
    'R6-2 cwd',
    `failed cd ${operator}`,
    `cd /nonexistent ${operator} echo x > settings.json`,
    {
      cwd: '/repo',
      deny: ['Edit(//repo/settings.json)'],
      decision: operator === ';' ? 'not-allow' : 'deny',
      ...(operator !== ';'
        ? {
            operation: {
              virtualTool: 'write_file',
              filePath: '/repo/settings.json',
            },
          }
        : {}),
    },
  );
}
add(
  'R6-2 cwd',
  'successful cd && control',
  'cd /tmp && echo x > settings.json',
  {
    cwd: '/repo',
    deny: ['Edit(//repo/settings.json)'],
    decision: 'allow',
    operation: { virtualTool: 'write_file', filePath: '/tmp/settings.json' },
  },
);
add(
  'R6-2 cwd',
  'absolute write after source control',
  'source ./change-dir.sh && echo x > /tmp/protected',
  {
    deny: protectedEdit,
    decision: 'deny',
    operation: { virtualTool: 'write_file', filePath: '/tmp/protected' },
  },
);

for (const prefix of ['env -S', 'env --split-string']) {
  add('R7-1 prefixes', prefix, `${prefix} 'cat /etc/shadow'`, {
    deny: protectedRead,
    decision: 'deny',
    operation: { virtualTool: 'read_file', filePath: '/etc/shadow' },
    prefixUnsupported: true,
  });
}
for (const prefix of [
  'sudo -E',
  'stdbuf -o0',
  'ionice -c3',
  'timeout --preserve-status 5',
  'doas -u root',
  'nohup -p',
  'unbuffer -p',
  'sudo',
  'timeout 5',
  'setsid -f',
]) {
  add('R7-1 prefixes', prefix, `${prefix} sh -c 'echo hi > /tmp/protected'`, {
    deny: protectedEdit,
    decision: 'deny',
    operation: { virtualTool: 'write_file', filePath: '/tmp/protected' },
  });
}
add(
  'R7-1 prefixes',
  'env assignment control',
  'env MODE=test cat /etc/shadow',
  {
    deny: protectedRead,
    decision: 'deny',
    operation: { virtualTool: 'read_file', filePath: '/etc/shadow' },
  },
);
add(
  'R7-1 prefixes',
  'sudo -D unknown cwd control',
  "sudo -D /tmp sh -c 'echo hi > protected'",
  {
    deny: protectedEdit,
    decision: 'ask',
    prefixUnsupported: true,
  },
);

for (const command of [
  "rm '' -rf /tmp/protected",
  'rm "" -rf /tmp/protected',
  'rm -rf /tmp/protected',
]) {
  add('R7-2 words and redirects', command, command, {
    deny: ['Bash(rm -rf *)'],
    decision: 'deny',
    restrictiveRule: 'Bash(rm -rf *)',
    restrictiveMatch: true,
  });
}
add(
  'R7-2 words and redirects',
  'empty argument before push',
  "git '' push origin main",
  {
    deny: ['Bash(git push)'],
    decision: 'deny',
    restrictiveRule: 'Bash(git push)',
    restrictiveMatch: true,
  },
);
add(
  'R7-2 words and redirects',
  'empty executable control',
  "'' git push origin main",
  {
    deny: ['Bash(git push)'],
    decision: 'not-allow',
    restrictiveRule: 'Bash(git push)',
    restrictiveMatch: false,
  },
);
for (const effect of ['deny', 'ask'] as const) {
  for (const target of [
    '/project/x/../protected',
    '/project/protected',
    '/project//protected',
  ]) {
    add(
      'R7-2 words and redirects',
      `${effect} ${target}`,
      `git >${target} push origin main`,
      {
        allow: ['Bash(git *)'],
        [effect]: ['Bash(git>/project/protected push *)'],
        decision: target.includes('..') ? 'not-allow' : effect,
      },
    );
  }
}
add(
  'R7-2 words and redirects',
  'redirect normalization never widens allow',
  'git >/project//protected push origin main',
  {
    allow: ['Bash(git>/project/protected push *)'],
    decision: 'ask',
  },
);

const substitutionCases: Array<[string, string, boolean]> = [
  [
    'comment apostrophe after parameter',
    `printf '%s' "\${A}" # don't\ncat $(printf /tmp/protected)`,
    true,
  ],
  [
    'closed parameter before comment',
    'echo "${HOME}" # replace with $(which python)',
    false,
  ],
  [
    'literal before comment control',
    'echo "hi" # replace with $(which python)',
    false,
  ],
  ['parameter trim hash then substitution', 'echo ${x% #}; $(printf X)', true],
  ['parameter default hash substitution', 'echo ${x:- #$(printf X)}', true],
  ['ordinary comment control', 'echo ok # $(printf X)', false],
  [
    'nested closed parameters before comment',
    'echo "${x:-${y}}" # $(printf X)',
    false,
  ],
  [
    'nested parameter then comment apostrophe',
    `echo "\${x:-\${y}}" # don't\nprintf '%s' $(printf X)`,
    true,
  ],
  ['continuation outside comment', 'echo "${x}" \\\n# $(printf X)', false],
  ['backslash at comment end', 'echo "${x}" # \\\n$(printf X)', true],
  ['single quoted parameter control', "echo '${x}' # $(printf X)", false],
  ['escaped parameter control', 'echo \\${x} # $(printf X)', false],
  ['quoted substitution literal control', "printf '%s' '$(printf X)'", false],
];
for (const [id, command, substitution] of substitutionCases) {
  add('R7-3 parameter comments', id, command, {
    substitution,
    ...(id === 'closed parameter before comment' ||
    id === 'literal before comment control'
      ? {
          unsupported: false,
          decision: 'allow' as const,
          suggestions: ['Bash(echo *)'],
        }
      : {}),
  });
}

for (const command of [
  'git ${x:- #} > $OUT push origin main',
  'git ${x:- y} > $OUT push origin main',
]) {
  add('R5-2 scanner parity', command, command, {
    allow: ['Bash(git *)'],
    deny: protectedEdit,
    unsupported: true,
    decision: 'not-allow',
  });
}
add(
  'R5-2 scanner parity',
  'comment-ending backslash leaves next command executable',
  'git status # note \\\nrm -rf /tmp/protected',
  {
    allow: ['Bash(git status)'],
    deny: ['Bash(rm -rf *)'],
    decision: 'deny',
    splitCount: 2,
  },
);
add(
  'R5-2 scanner parity',
  'ordinary newline comment control',
  'git status # note\nrm -rf /tmp/protected',
  {
    allow: ['Bash(git status)'],
    deny: ['Bash(rm -rf *)'],
    decision: 'deny',
    splitCount: 2,
  },
);
add(
  'R5-2 scanner parity',
  'comment content remains inert',
  'git status # rm -rf /tmp/protected',
  {
    allow: ['Bash(git status)'],
    deny: ['Bash(rm -rf *)'],
    decision: 'allow',
    splitCount: 1,
  },
);

for (const shell of [
  'oksh',
  'ksh93',
  'pdksh',
  'yash',
  'rbash',
  'busybox hush',
  'ksh',
]) {
  add(
    'R4-1 execution entries',
    shell,
    `${shell} -c 'echo hi > /tmp/protected'`,
    {
      deny: protectedEdit,
      unsupported: true,
      decision: 'ask',
    },
  );
}
for (const command of [
  "printf 'echo hi > /tmp/protected\\n' | sh",
  "printf 'echo hi > /tmp/protected\\n' | dash",
  'sh < script',
  "dash +x -c 'echo hi > /tmp/protected'",
]) {
  add('R4-1 execution entries', command, command, {
    deny: protectedEdit,
    unsupported: true,
    decision: 'ask',
  });
}
for (const prefix of ['!', 'time', 'time !']) {
  add(
    'R4-1 execution entries',
    `${prefix} protected read`,
    `${prefix} cat /etc/shadow`,
    {
      deny: protectedRead,
      decision: 'deny',
      operation: { virtualTool: 'read_file', filePath: '/etc/shadow' },
    },
  );
}
add(
  'R4-1 execution entries',
  'time ! conservative guard',
  'time ! cat /etc/secret',
  {
    deny: protectedEdit,
    unsupported: true,
    decision: 'ask',
  },
);
for (const command of ['gcc -c file.c', 'git -c user.name=test status']) {
  add('R4-1 execution entries', `non-shell -c control ${command}`, command, {
    deny: protectedEdit,
    unsupported: false,
    decision: 'allow',
  });
}

describe('R7 independently frozen permission boundaries', () => {
  it.each(probes)('$group: $id', async (probe) => {
    const cwd = probe.cwd ?? '/project';
    const pm = new PermissionManager({
      getPermissionsAllow: () => probe.allow ?? ['Bash(*)'],
      getPermissionsDeny: () => probe.deny ?? [],
      getPermissionsAsk: () => probe.ask ?? [],
      getProjectRoot: () => cwd,
      getCwd: () => cwd,
      getShellExecutionSandbox: () => true,
    });
    pm.initialize();
    const ctx = { toolName: 'run_shell_command', command: probe.command };
    const operations = extractShellOperationsAcrossCommand(probe.command, cwd);
    const decision = await pm.evaluate(ctx);
    const integrated = await evaluatePermissionRules(pm, 'allow', ctx);
    const unsupported = hasUnsupportedShellSyntax(probe.command);
    const substitution = detectCommandSubstitution(probe.command);
    const shellSubstitution = hasShellSubstitution(probe.command);
    const warnings = buildShellExecWarnings(probe.command, probe.command);
    const prefix = stripShellCommandPrefixes(probe.command);
    const parts = splitCommandForRules(probe.command, ctx.toolName);
    const rule = probe.restrictiveRule
      ? parseRule(probe.restrictiveRule)
      : null;
    const restrictiveMatch = rule
      ? matchesRule(
          rule,
          ctx.toolName,
          probe.command,
          undefined,
          undefined,
          { projectRoot: cwd, cwd },
          undefined,
          undefined,
          undefined,
          'canonical',
          undefined,
          true,
        )
      : undefined;
    const suggestions = probe.suggestions
      ? (await suggestCommandRules(probe.command, 'Bash')).permissionRules
      : undefined;
    const check = (field: string, actual: unknown, expected: unknown) => {
      expect.soft(actual, field).toEqual(expected);
    };
    if (probe.decision === 'not-allow') {
      check('decision does not allow', decision !== 'allow', true);
      check(
        'integrated decision does not allow',
        integrated.finalPermission !== 'allow',
        true,
      );
    } else if (probe.decision) {
      check('decision', decision, probe.decision);
      check('integrated decision', integrated.finalPermission, probe.decision);
    }
    if (probe.unsupported !== undefined)
      check('unsupported', unsupported, probe.unsupported);
    if (probe.substitution !== undefined) {
      check('substitution detector', substitution, probe.substitution);
      check('shell substitution gate', shellSubstitution, probe.substitution);
      check(
        'substitution warning',
        Boolean(warnings?.length),
        probe.substitution,
      );
    }
    if (probe.operation) {
      check(
        'required virtual operation',
        operations.some(
          (operation) =>
            operation.virtualTool === probe.operation?.virtualTool &&
            operation.filePath === probe.operation?.filePath,
        ),
        true,
      );
    }
    if (probe.unknownRelativeOperation) {
      check(
        'unknown relative virtual operation',
        operations.some(
          (operation) => operation.cwdUnknown && operation.pathMayDependOnCwd,
        ),
        true,
      );
    }
    if (probe.splitCount !== undefined)
      check('rule segment count', parts.length, probe.splitCount);
    if (probe.prefixUnsupported !== undefined)
      check(
        'unsupported prefix preserved',
        prefix === undefined,
        probe.prefixUnsupported,
      );
    if (probe.restrictiveMatch !== undefined)
      check('restrictive rule match', restrictiveMatch, probe.restrictiveMatch);
    if (probe.suggestions)
      check('suggested rules', suggestions, probe.suggestions);
  });
});
