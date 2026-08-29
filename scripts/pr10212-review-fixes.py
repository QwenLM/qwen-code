from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one marker, found {count}')
    return text.replace(old, new, 1)


def replace_region(text: str, start_marker: str, end_marker: str, new: str, label: str) -> str:
    try:
        start = text.index(start_marker)
        end = text.index(end_marker, start)
    except ValueError as exc:
        raise SystemExit(f'{label}: marker not found') from exc
    return text[:start] + new + '\n\n' + text[end:]


# ---------------------------------------------------------------------------
# rule-parser.ts
# ---------------------------------------------------------------------------
p = Path('packages/core/src/permissions/rule-parser.ts')
s = p.read_text()

new_matches = r'''export function matchesCommandPattern(
  pattern: string,
  command: string,
): boolean {
  // This function matches a single pattern against a single simple command.
  // Compound command splitting is handled by the caller (PermissionManager).
  const normalizedCommand = normalizeCommandForPermissionMatch(command);
  const normalizedPattern = collapseUnquotedWhitespace(pattern.trim());

  // Special case: lone `*` matches any single command.
  if (normalizedPattern === '*') {
    return true;
  }

  if (!normalizedPattern.includes('*')) {
    // An assignment-only rule is an identity, not a command prefix. Without
    // this guard `Bash(FOO=bar)` would authorize `FOO=bar <anything>`.
    if (isAssignmentOnlyPermissionPattern(normalizedPattern)) {
      return normalizedCommand === normalizedPattern;
    }

    // No wildcards: prefix matching (backward compat).
    // "git commit" matches "git commit" and "git commit -m test"
    // but NOT "gitcommit".
    return (
      normalizedCommand === normalizedPattern ||
      normalizedCommand.startsWith(normalizedPattern + ' ')
    );
  }

  // Build regex from glob pattern with word-boundary semantics.
  let regex = '^';
  let pos = 0;

  while (pos < normalizedPattern.length) {
    const starIdx = normalizedPattern.indexOf('*', pos);
    if (starIdx === -1) {
      regex += escapeRegex(normalizedPattern.substring(pos));
      break;
    }

    const literalBefore = normalizedPattern.substring(pos, starIdx);

    if (starIdx > 0 && normalizedPattern[starIdx - 1] === ' ') {
      const literalWithoutTrailingSpace = literalBefore.slice(0, -1);
      regex += escapeRegex(literalWithoutTrailingSpace);
      regex += '( .*)?';
    } else {
      regex += escapeRegex(literalBefore);
      regex += '.*';
    }

    pos = starIdx + 1;
  }

  regex += '$';

  try {
    return new RegExp(regex, 's').test(normalizedCommand);
  } catch {
    return normalizedCommand === normalizedPattern;
  }
}'''

s = replace_region(
    s,
    'export function matchesCommandPattern(',
    '/**\n * Match a glob pattern against a value',
    new_matches,
    'matchesCommandPattern',
)

new_env_helpers = r'''export const ENV_ASSIGNMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/;

function permissionMatchTokens(command: string): string[] {
  const tokens: string[] = [];
  for (const token of parse(command)) {
    if (typeof token === 'string') {
      tokens.push(token);
    } else if (token && typeof token === 'object' && 'op' in token) {
      if (
        token.op === 'glob' &&
        'pattern' in token &&
        typeof token.pattern === 'string'
      ) {
        // shell-quote represents unquoted * / ? words as glob tokens. Keep
        // the original word so env assignments remain recognizable.
        tokens.push(token.pattern);
      } else if (typeof token.op === 'string') {
        tokens.push(token.op);
      }
    }
  }
  return tokens;
}

/**
 * Return a shell command with only leading NAME=value assignments removed.
 * Restrictive deny/ask matching uses this legacy identity in addition to the
 * full identity so the new allow hardening can never narrow a restriction.
 */
export function stripLeadingVariableAssignments(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;

  try {
    const tokens = permissionMatchTokens(trimmed);
    let firstCommandToken = 0;
    while (
      firstCommandToken < tokens.length &&
      ENV_ASSIGNMENT_REGEX.test(tokens[firstCommandToken]!)
    ) {
      firstCommandToken++;
    }
    if (firstCommandToken === 0) return trimmed;
    return tokens.slice(firstCommandToken).join(' ');
  } catch {
    return trimmed;
  }
}

/** Collapse shell-equivalent whitespace outside quotes while retaining quotes. */
function collapseUnquotedWhitespace(command: string): string {
  let result = '';
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  let pendingSpace = false;

  for (const ch of command) {
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      if (pendingSpace && result) result += ' ';
      pendingSpace = false;
      result += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      result += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      if (pendingSpace && result) result += ' ';
      pendingSpace = false;
      quote = ch;
      result += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (result) pendingSpace = true;
      continue;
    }
    if (pendingSpace && result) result += ' ';
    pendingSpace = false;
    result += ch;
  }

  return result;
}

function isAssignmentOnlyPermissionPattern(pattern: string): boolean {
  try {
    const tokens = permissionMatchTokens(pattern);
    return (
      tokens.length > 0 && tokens.every((token) => ENV_ASSIGNMENT_REGEX.test(token))
    );
  } catch {
    return false;
  }
}

function normalizeCommandForPermissionMatch(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;

  try {
    const tokens = permissionMatchTokens(trimmed);
    let firstCommandToken = 0;
    while (
      firstCommandToken < tokens.length &&
      ENV_ASSIGNMENT_REGEX.test(tokens[firstCommandToken]!)
    ) {
      firstCommandToken++;
    }

    // Allow rules bind to the complete env-prefixed execution identity, but
    // shell-equivalent unquoted whitespace is canonicalized on both sides.
    if (firstCommandToken > 0) {
      return collapseUnquotedWhitespace(trimmed);
    }

    return tokens.join(' ');
  } catch {
    return collapseUnquotedWhitespace(trimmed);
  }
}'''

s = replace_region(
    s,
    'const ENV_ASSIGNMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/;',
    '// ─────────────────────────────────────────────────────────────────────────────\n// File path matching (gitignore-style)',
    new_env_helpers,
    'env helpers',
)
p.write_text(s)


# ---------------------------------------------------------------------------
# permission-manager.ts — restrictive rules match full + stripped identities.
# ---------------------------------------------------------------------------
p = Path('packages/core/src/permissions/permission-manager.ts')
s = p.read_text()
s = replace_once(
    s,
    '  splitCompoundCommand,\n  SHELL_TOOL_NAMES,',
    '  splitCompoundCommand,\n  stripLeadingVariableAssignments,\n  SHELL_TOOL_NAMES,',
    'permission-manager import',
)

restrictive_args = '''\n    const restrictiveCommand =\n      command !== undefined && SHELL_TOOL_NAMES.has(toolName)\n        ? stripLeadingVariableAssignments(command)\n        : command;\n    const restrictiveMatchArgs = [\n      toolName,\n      restrictiveCommand,\n      filePath,\n      domain,\n      pathCtx,\n      specifier,\n      toolParams,\n      toolAliases,\n    ] as const;\n'''
match_args = '''    const matchArgs = [\n      toolName,\n      command,\n      filePath,\n      domain,\n      pathCtx,\n      specifier,\n      toolParams,\n      toolAliases,\n    ] as const;\n'''


def patch_method(text: str, start: str, end: str, transform, label: str) -> str:
    try:
        i = text.index(start)
        j = text.index(end, i)
    except ValueError as exc:
        raise SystemExit(f'{label}: method marker not found') from exc
    region = text[i:j]
    region = transform(region)
    return text[:i] + region + text[j:]


def add_restrictive_args(region: str, label: str) -> str:
    return replace_once(region, match_args, match_args + restrictive_args, label)


def patch_evaluate_single(region: str) -> str:
    region = add_restrictive_args(region, 'evaluateSingle matchArgs')
    region = replace_once(
        region,
        "        if (matchesRule(rule, ...matchArgs, 'canonical')) return 'deny';",
        "        if (\n          matchesRule(rule, ...matchArgs, 'canonical') ||\n          (restrictiveCommand !== command &&\n            matchesRule(rule, ...restrictiveMatchArgs, 'canonical'))\n        )\n          return 'deny';",
        'evaluateSingle deny',
    )
    region = replace_once(
        region,
        "        if (matchesRule(rule, ...matchArgs, 'canonical')) return 'ask';",
        "        if (\n          matchesRule(rule, ...matchArgs, 'canonical') ||\n          (restrictiveCommand !== command &&\n            matchesRule(rule, ...restrictiveMatchArgs, 'canonical'))\n        )\n          return 'ask';",
        'evaluateSingle ask',
    )
    return region


s = patch_method(
    s,
    '  private evaluateSingle(',
    '  /**\n   * Evaluate a list of virtual operations',
    patch_evaluate_single,
    'evaluateSingle',
)


def patch_find_deny(region: str) -> str:
    region = add_restrictive_args(region, 'findMatchingDenyRule matchArgs')
    region = replace_once(
        region,
        "      if (matchesRule(rule, ...matchArgs, 'canonical')) {\n        return rule.raw;\n      }",
        "      if (\n        matchesRule(rule, ...matchArgs, 'canonical') ||\n        (restrictiveCommand !== command &&\n          matchesRule(rule, ...restrictiveMatchArgs, 'canonical'))\n      ) {\n        return rule.raw;\n      }",
        'findMatchingDenyRule match',
    )
    return region


s = patch_method(
    s,
    '  findMatchingDenyRule(',
    '  // ---------------------------------------------------------------------------\n  // Shell command helper',
    patch_find_deny,
    'findMatchingDenyRule',
)


def patch_relevant(region: str) -> str:
    region = add_restrictive_args(region, 'hasRelevantRules matchArgs')
    old = '''    return (\n      restrictiveRules.some((rule) =>\n        matchesRule(rule, ...matchArgs, 'canonical'),\n      ) || allowRules.some((rule) => matchesRule(rule, ...matchArgs))\n    );'''
    new = '''    return (\n      restrictiveRules.some(\n        (rule) =>\n          matchesRule(rule, ...matchArgs, 'canonical') ||\n          (restrictiveCommand !== command &&\n            matchesRule(rule, ...restrictiveMatchArgs, 'canonical')),\n      ) || allowRules.some((rule) => matchesRule(rule, ...matchArgs))\n    );'''
    return replace_once(region, old, new, 'hasRelevantRules return')


s = patch_method(
    s,
    '  hasRelevantRules(',
    '  /**\n   * Returns true when the invocation is matched by an explicit `ask` rule.',
    patch_relevant,
    'hasRelevantRules',
)


def patch_ask(region: str) -> str:
    region = add_restrictive_args(region, 'hasMatchingAskRule matchArgs')
    old = '''    return askRules.some((rule) =>\n      matchesRule(rule, ...matchArgs, 'canonical'),\n    );'''
    new = '''    return askRules.some(\n      (rule) =>\n        matchesRule(rule, ...matchArgs, 'canonical') ||\n        (restrictiveCommand !== command &&\n          matchesRule(rule, ...restrictiveMatchArgs, 'canonical')),\n    );'''
    return replace_once(region, old, new, 'hasMatchingAskRule return')


s = patch_method(
    s,
    '  hasMatchingAskRule(',
    '  private hasAskRuleForTool(',
    patch_ask,
    'hasMatchingAskRule',
)
p.write_text(s)


# ---------------------------------------------------------------------------
# shellAstParser.ts — generated Always-Allow rules retain env assignments.
# ---------------------------------------------------------------------------
p = Path('packages/core/src/utils/shellAstParser.ts')
s = p.read_text()
new_extract = r'''function extractRuleFromCommand(commandNode: SyntaxNode): string | null {
  const rootName = getCommandName(commandNode);
  if (!rootName) return null;

  const nameNode = commandNode.childForFieldName('name');
  const envPrefix = nameNode
    ? commandNode.namedChildren
        .filter(
          (child) =>
            /^variable_assignments?$/.test(child.type) &&
            child.endIndex <= nameNode.startIndex,
        )
        .map((child) => child.text)
        .join(' ')
    : '';
  const qualifiedRoot = envPrefix ? `${envPrefix} ${rootName}` : rootName;

  const argNodes = getArgumentNodes(commandNode);
  const argTexts = argNodes.map((n) => n.text);

  // Skip leading flags to find potential subcommand
  let idx = 0;
  while (idx < argTexts.length && argTexts[idx]!.startsWith('-')) {
    idx++;
  }

  const knownSubs = KNOWN_SUBCOMMANDS[rootName];
  let rule = qualifiedRoot;

  if (knownSubs && knownSubs.size > 0 && idx < argTexts.length) {
    const potentialSub = argTexts[idx]!.toLowerCase();
    if (knownSubs.has(potentialSub)) {
      rule = `${qualifiedRoot} ${argTexts[idx]!}`;

      // Docker multi-level: docker compose <sub>
      if (
        rootName === 'docker' &&
        potentialSub === 'compose' &&
        idx + 1 < argTexts.length
      ) {
        const composeSub = argTexts[idx + 1]!.toLowerCase();
        if (DOCKER_COMPOSE_SUBCOMMANDS.has(composeSub)) {
          rule = `${qualifiedRoot} compose ${argTexts[idx + 1]!}`;
          if (idx + 2 < argTexts.length) {
            rule += ' *';
          }
          return rule;
        }
      }

      if (idx + 1 < argTexts.length) {
        rule += ' *';
      }
      return rule;
    }
  }

  if (argTexts.length > 0) {
    rule += ' *';
  }

  return rule;
}'''
s = replace_region(
    s,
    'function extractRuleFromCommand(commandNode: SyntaxNode): string | null {',
    '/**\n * Recursively extract rules from a statement node.',
    new_extract,
    'extractRuleFromCommand',
)
p.write_text(s)


# ---------------------------------------------------------------------------
# shellAstParser.test.ts — pin env-aware grant generation.
# ---------------------------------------------------------------------------
p = Path('packages/core/src/utils/shellAstParser.test.ts')
s = p.read_text()
old = '''    it('handles env var prefix', async () => {\n      expect(await extractCommandRules('FOO=bar npm install')).toEqual([\n        'npm install',\n      ]);\n    });'''
new = '''    it('preserves env var prefixes in generated rules', async () => {\n      expect(await extractCommandRules('FOO=bar npm install')).toEqual([\n        'FOO=bar npm install',\n      ]);\n      expect(await extractCommandRules('FOO=bar npm install express')).toEqual([\n        'FOO=bar npm install *',\n      ]);\n      expect(await extractCommandRules('FOO=bar docker compose up -d')).toEqual([\n        'FOO=bar docker compose up *',\n      ]);\n    });'''
s = replace_once(s, old, new, 'shellAstParser env test')
p.write_text(s)


# ---------------------------------------------------------------------------
# Dedicated regression suite — all review acceptance criteria.
# ---------------------------------------------------------------------------
p = Path('packages/core/src/permissions/rule-parser.env-prefix.test.ts')
p.write_text(r'''/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import { extractCommandRules } from '../utils/shellAstParser.js';
import {
  findDangerousAllowRules,
  isDangerousBashRule,
} from './dangerousRules.js';
import { PermissionManager } from './permission-manager.js';
import type { PermissionManagerConfig } from './permission-manager.js';
import { matchesCommandPattern, parseRule } from './rule-parser.js';

function makeConfig(
  allow: string[] = [],
  ask: string[] = [],
  deny: string[] = [],
): PermissionManagerConfig {
  return {
    getPermissionsAllow: () => allow,
    getPermissionsAsk: () => ask,
    getPermissionsDeny: () => deny,
    getProjectRoot: () => '/repo',
    getCwd: () => '/repo',
    getApprovalMode: () => 'default',
  };
}

describe('matchesCommandPattern environment prefixes', () => {
  it('keeps plain commands matching', () => {
    expect(matchesCommandPattern('npm --version', 'npm --version')).toBe(true);
    expect(matchesCommandPattern('python3 *', 'python3 -c "print(1)"')).toBe(
      true,
    );
  });

  it('does not let static env prefixes inherit exact or prefix rules', () => {
    expect(
      matchesCommandPattern('npm --version', 'FOO=bar npm --version'),
    ).toBe(false);
    expect(matchesCommandPattern('npm', 'FOO=bar npm --version')).toBe(false);
  });

  it('does not let NODE_OPTIONS widen an npm allow rule', () => {
    expect(
      matchesCommandPattern(
        'npm --version',
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
      ),
    ).toBe(false);
  });

  it('does not let GIT_CONFIG_* widen a git allow rule', () => {
    expect(
      matchesCommandPattern(
        'git status --short',
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=/tmp/fsmonitor.sh git status --short',
      ),
    ).toBe(false);
  });

  it('also covers both substitution forms from #10192', () => {
    expect(
      matchesCommandPattern(
        'npm --version',
        'X=$(printf hidden) npm --version',
      ),
    ).toBe(false);
    expect(
      matchesCommandPattern(
        'npm --version',
        'X=`printf hidden` npm --version',
      ),
    ).toBe(false);
  });

  it('allows an env-prefixed command only when the rule includes it', () => {
    expect(
      matchesCommandPattern(
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
      ),
    ).toBe(true);
    expect(
      matchesCommandPattern(
        'PYTHONPATH=/tmp/lib python3 *',
        'PYTHONPATH=/tmp/lib python3 -c "print(1)"',
      ),
    ).toBe(true);
  });

  it('preserves quoted env values while canonicalizing unquoted whitespace', () => {
    expect(
      matchesCommandPattern('FOO="a b" npm', 'FOO="a b" npm'),
    ).toBe(true);
    expect(
      matchesCommandPattern('FOO=bar rm *', 'FOO=bar\trm -rf /'),
    ).toBe(true);
    expect(
      matchesCommandPattern('FOO=bar rm *', 'FOO=bar  rm -rf /'),
    ).toBe(true);
    expect(
      matchesCommandPattern('FOO=bar\trm *', 'FOO=bar rm -rf /'),
    ).toBe(true);
  });

  it('keeps glob-valued env assignments intact instead of normalizing them to glob', () => {
    expect(
      matchesCommandPattern(
        'NODE_OPTIONS=* npm *',
        'NODE_OPTIONS=--require=*evil.cjs npm --version',
      ),
    ).toBe(true);
    expect(
      matchesCommandPattern(
        'NODE_OPTIONS=--require=*evil.cjs npm --version',
        'NODE_OPTIONS=--require=*evil.cjs npm --version',
      ),
    ).toBe(true);
    expect(
      matchesCommandPattern('FOO=? npm', 'FOO=? npm'),
    ).toBe(true);
  });

  it('does not widen assignment-only rules into arbitrary commands', () => {
    expect(matchesCommandPattern('FOO=bar', 'FOO=bar')).toBe(true);
    expect(matchesCommandPattern('FOO=bar', 'FOO=bar curl evil.sh')).toBe(
      false,
    );
  });

  it('keeps the intentional Bash(*) allow-all behavior', () => {
    expect(
      matchesCommandPattern(
        '*',
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
      ),
    ).toBe(true);
  });
});

describe('restrictive rules retain legacy env-prefix coverage', () => {
  it('keeps deny and ask rules restrictive for env-prefixed commands', async () => {
    const denyPm = new PermissionManager(
      makeConfig(['Bash(*)'], [], ['Bash(rm -rf *)']),
    );
    denyPm.initialize();
    await expect(
      denyPm.evaluate({
        toolName: 'run_shell_command',
        command: 'FOO=1 rm -rf /',
        cwd: '/repo',
      }),
    ).resolves.toBe('deny');
    expect(
      denyPm.findMatchingDenyRule({
        toolName: 'run_shell_command',
        command: 'FOO=1 rm -rf /',
        cwd: '/repo',
      }),
    ).toBe('Bash(rm -rf *)');

    const askPm = new PermissionManager(
      makeConfig(['Bash(*)'], ['Bash(git push *)']),
    );
    askPm.initialize();
    const askCtx = {
      toolName: 'run_shell_command',
      command: 'FOO=bar git push --force',
      cwd: '/repo',
    } as const;
    await expect(askPm.evaluate(askCtx)).resolves.toBe('ask');
    expect(askPm.hasMatchingAskRule(askCtx)).toBe(true);
  });

  it('hardens the production hasRelevantRules gate', async () => {
    const pm = new PermissionManager(makeConfig([], [], ['Bash(rm -rf *)']));
    pm.initialize();
    const result = await evaluatePermissionRules(pm, 'allow', {
      toolName: 'run_shell_command',
      command: 'FOO=1 rm -rf /',
      cwd: '/repo',
    });
    expect(result.finalPermission).toBe('deny');
  });

  it('does not let a virtual Read allow downgrade the env-prefix ask decision', async () => {
    const pm = new PermissionManager(
      makeConfig(['Bash(cat /repo/file)', 'Read']),
    );
    pm.initialize();
    await expect(
      pm.evaluate({
        toolName: 'run_shell_command',
        command: 'NODE_OPTIONS=--require=/tmp/preload.cjs cat /repo/file',
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
  });
});

describe('env-prefixed grant generation and AUTO classification', () => {
  it('round-trips an Always-Allow rule through the matcher', async () => {
    const rules = await extractCommandRules('FOO=bar npm install');
    expect(rules).toEqual(['FOO=bar npm install']);

    const pm = new PermissionManager(makeConfig([`Bash(${rules[0]})`]));
    pm.initialize();
    await expect(
      pm.evaluate({
        toolName: 'run_shell_command',
        command: 'FOO=bar npm install',
        cwd: '/repo',
      }),
    ).resolves.toBe('allow');
  });

  it('classifies env-prefixed interpreter allows as dangerous in AUTO mode', () => {
    const python = parseRule('Bash(X=1 python *)');
    const npx = parseRule('Bash(FOO=bar npx *)');
    expect(isDangerousBashRule(python)).toBe(true);
    expect(isDangerousBashRule(npx)).toBe(true);
    expect(findDangerousAllowRules([python, npx])).toEqual([python, npx]);
  });
});
''')

print('PR 10212 source and regression patches applied')
