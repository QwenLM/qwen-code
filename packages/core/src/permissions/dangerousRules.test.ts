/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  findDangerousAllowRules,
  isDangerousAgentRule,
  isDangerousAllowRule,
  isDangerousBashRule,
  isDangerousSkillRule,
} from './dangerousRules.js';
import { ToolNames } from '../tools/tool-names.js';
import type { PermissionRule } from './types.js';

function bashRule(specifier?: string): PermissionRule {
  return {
    raw: specifier ? `Bash(${specifier})` : 'Bash',
    toolName: ToolNames.SHELL,
    specifier,
  };
}

describe('isDangerousBashRule', () => {
  it('flags tool-level Bash (no specifier)', () => {
    expect(isDangerousBashRule(bashRule())).toBe(true);
  });

  it('flags Bash(*)', () => {
    expect(isDangerousBashRule(bashRule('*'))).toBe(true);
  });

  it('flags Bash() (empty specifier)', () => {
    expect(isDangerousBashRule(bashRule(''))).toBe(true);
  });

  it.each([
    'bash',
    'sh',
    'zsh',
    'fish',
    'python',
    'python3',
    'node',
    'deno',
    'bun',
    'ruby',
    'perl',
    // Modern package runners — `npx <pkg>` / `uvx <pkg>` / `pipx <pkg>`
    // / `dlx <pkg>` / `go run` all fetch + execute arbitrary external
    // code by name. `Bash(npx *)` was specifically called out as a
    // common "always allow" pattern that previously slipped past the
    // classifier in AUTO.
    'npx',
    'pnpx',
    'uvx',
    'pipx',
    'dlx',
    'go',
  ])('flags interpreter %s as bare name', (interp) => {
    expect(isDangerousBashRule(bashRule(interp))).toBe(true);
  });

  it.each(['npx *', 'uvx *', 'pipx *', 'go run *', 'go install *'])(
    'flags modern-runner wildcard %s — common attack pattern via fetch-and-execute',
    (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    },
  );

  it.each(['python:*', 'node:*', 'bash:*'])(
    'flags interpreter prefix-form %s',
    (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    },
  );

  it.each(['python*', 'node*', 'bash*'])(
    'flags interpreter wildcard-form %s',
    (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    },
  );

  it('flags python -c style command-line wildcards', () => {
    expect(isDangerousBashRule(bashRule('python -c *'))).toBe(true);
    expect(isDangerousBashRule(bashRule('node -e *'))).toBe(true);
  });

  it('does NOT flag specific safe commands', () => {
    expect(isDangerousBashRule(bashRule('git status'))).toBe(false);
    expect(isDangerousBashRule(bashRule('npm test'))).toBe(false);
    expect(isDangerousBashRule(bashRule('ls -la'))).toBe(false);
  });

  it('does NOT flag specific interpreter scripts', () => {
    // "python script.py" is a specific command, not an interpreter wildcard.
    expect(isDangerousBashRule(bashRule('python script.py'))).toBe(false);
  });

  it('does NOT flag specific colon-form rules (concrete suffix is a user-allowed concrete command)', () => {
    // Regression: `Bash(python3:run-tests)` and similar are concrete
    // user-allow rules — same shape as `Bash(npm run test)`. They were
    // previously over-flagged as "interpreter + colon = dangerous",
    // silently stripping intentional user allow lists in AUTO mode.
    expect(isDangerousBashRule(bashRule('python3:run-tests'))).toBe(false);
    expect(isDangerousBashRule(bashRule('python:./scripts/build.py'))).toBe(
      false,
    );
    expect(isDangerousBashRule(bashRule('node:dist/index.js'))).toBe(false);
    expect(isDangerousBashRule(bashRule('cargo:build'))).toBe(false);
  });

  it('DOES flag empty-suffix and wildcard-suffix colon-form rules', () => {
    // `python:` (empty suffix) and `python:*` are interpreter-with-no-
    // specifier — every command runs. Still dangerous.
    expect(isDangerousBashRule(bashRule('python:'))).toBe(true);
    expect(isDangerousBashRule(bashRule('python:*'))).toBe(true);
    expect(isDangerousBashRule(bashRule('node:*'))).toBe(true);
  });

  it('is case-insensitive on the specifier', () => {
    expect(isDangerousBashRule(bashRule('PYTHON'))).toBe(true);
    expect(isDangerousBashRule(bashRule('NODE*'))).toBe(true);
  });

  it('returns false for non-Bash tools', () => {
    expect(
      isDangerousBashRule({
        raw: 'Read',
        toolName: ToolNames.READ_FILE,
      }),
    ).toBe(false);
  });

  // ── Regression guards added during PR #4151 review ────────────────────
  describe('extended interpreter coverage', () => {
    it.each([
      'php',
      'lua',
      'julia',
      'r',
      'rscript',
      'groovy',
      'cargo',
      'npm',
      'pnpm',
      'yarn',
      'make',
      'gradle',
      'mvn',
      'pwsh',
      'powershell',
      'awk',
    ])('flags %s as a dangerous interpreter (bare name)', (interp) => {
      expect(isDangerousBashRule(bashRule(interp))).toBe(true);
    });

    it.each(['tsx -e *', 'ssh prod-host -- *', 'bunx -p dangerous-pkg *'])(
      'flags new interpreter, remote shell, or runner wildcard %s',
      (s) => {
        expect(isDangerousBashRule(bashRule(s))).toBe(true);
      },
    );

    it.each([
      'tsx',
      'ssh',
      'bunx',
      'bash.exe',
      'cmd',
      'cmd.exe',
      'pwsh.exe',
      'powershell.exe',
    ])('flags new interpreter, remote shell, or runner bare name %s', (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    });

    it.each([
      'python.exe -c *',
      'node.exe -e *',
      'tsx.exe -e *',
      'bunx.exe -p dangerous-pkg *',
      'C:\\Python\\python.exe -c *',
      'C:\\Python\\python.exe:*',
      'C:\\Python\\python:*',
      'C:\\Program Files\\Python\\python.exe -c *',
    ])('flags Windows executable suffix wildcard %s', (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    });

    it.each([
      'C:\\Python\\python.exe',
      'C:\\nodejs\\node.exe',
      'C:\\Users\\me\\bin\\tsx.exe',
      'C:\\Program Files\\Python\\python.exe',
    ])('flags bare Windows interpreter path %s', (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    });

    it('normalizes Windows executable suffixes in both directions', () => {
      expect(isDangerousBashRule(bashRule('cmd *'))).toBe(true);
      expect(isDangerousBashRule(bashRule('cmd.exe *'))).toBe(true);
    });

    it.each([
      'cmd /c *',
      'cmd.exe /c *',
      'bash.exe -c *',
      'powershell.exe -Command *',
      'pwsh.exe -Command *',
    ])('flags Windows shell wildcard %s', (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    });

    it.each([
      'bun run *',
      'deno run *',
      'npm run *',
      'cargo run *',
      'pnpm exec *',
    ])('flags multi-word interpreter subcommand %s', (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    });

    it.each([
      '/usr/bin/python3 *',
      '/opt/homebrew/bin/node *',
      '/bin/bash -c *',
    ])('flags absolute-path interpreter form %s', (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    });

    it.each([
      'tsx script.tsx',
      'ssh prod-host -- ls',
      'cmd /c script.bat',
      'cmd.exe /c script.bat',
      'pwsh.exe -File script.ps1',
      'powershell.exe -File script.ps1',
      'python.exe script.py',
      'node.exe script.js',
      'bunx eslint .',
      'C:\\Python\\python.exe script.py',
      'C:\\Program Files\\Python\\python.exe script.py',
    ])('does NOT flag concrete commands using new tokens %s', (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(false);
    });

    it('flags Monitor allow rules with the same interpreter logic', () => {
      // Monitor is a long-running shell-command runner; broad allow rules
      // on it bypass the AUTO classifier just like Bash(...) ones.
      expect(
        isDangerousBashRule({
          raw: 'Monitor',
          toolName: ToolNames.MONITOR,
        }),
      ).toBe(true);
      expect(
        isDangerousBashRule({
          raw: 'Monitor(*)',
          toolName: ToolNames.MONITOR,
          specifier: '*',
        }),
      ).toBe(true);
      expect(
        isDangerousBashRule({
          raw: 'Monitor(python*)',
          toolName: ToolNames.MONITOR,
          specifier: 'python*',
        }),
      ).toBe(true);
      // Literal concrete Monitor command is NOT flagged.
      expect(
        isDangerousBashRule({
          raw: 'Monitor(tail -f log)',
          toolName: ToolNames.MONITOR,
          specifier: 'tail -f log',
        }),
      ).toBe(false);
    });
  });
});

describe('isDangerousAgentRule', () => {
  it('flags any Agent allow rule regardless of specifier', () => {
    expect(
      isDangerousAgentRule({
        raw: 'Agent',
        toolName: ToolNames.AGENT,
      }),
    ).toBe(true);
    expect(
      isDangerousAgentRule({
        raw: 'Agent(coder)',
        toolName: ToolNames.AGENT,
        specifier: 'coder',
      }),
    ).toBe(true);
  });

  it('returns false for non-Agent tools', () => {
    expect(
      isDangerousAgentRule({ raw: 'Bash', toolName: ToolNames.SHELL }),
    ).toBe(false);
  });
});

describe('isDangerousSkillRule', () => {
  it('flags any Skill allow rule', () => {
    expect(
      isDangerousSkillRule({ raw: 'Skill', toolName: ToolNames.SKILL }),
    ).toBe(true);
    expect(
      isDangerousSkillRule({
        raw: 'Skill(pdf)',
        toolName: ToolNames.SKILL,
        specifier: 'pdf',
      }),
    ).toBe(true);
  });
});

describe('isDangerousAllowRule (aggregate)', () => {
  it('returns true for any dangerous category', () => {
    expect(isDangerousAllowRule(bashRule())).toBe(true);
    expect(
      isDangerousAllowRule({ raw: 'Agent', toolName: ToolNames.AGENT }),
    ).toBe(true);
    expect(
      isDangerousAllowRule({ raw: 'Skill', toolName: ToolNames.SKILL }),
    ).toBe(true);
  });

  it('returns false for safe rules', () => {
    expect(
      isDangerousAllowRule({
        raw: 'Read',
        toolName: ToolNames.READ_FILE,
      }),
    ).toBe(false);
    expect(isDangerousAllowRule(bashRule('git status'))).toBe(false);
  });
});

describe('findDangerousAllowRules', () => {
  it('returns only the dangerous subset', () => {
    const rules: PermissionRule[] = [
      bashRule('git status'), // safe
      bashRule('python'), // dangerous (interpreter)
      { raw: 'Read', toolName: ToolNames.READ_FILE }, // safe
      { raw: 'Agent', toolName: ToolNames.AGENT }, // dangerous (any Agent)
    ];
    const dangerous = findDangerousAllowRules(rules);
    expect(dangerous).toHaveLength(2);
    expect(dangerous.map((r) => r.toolName).sort()).toEqual(
      [ToolNames.AGENT, ToolNames.SHELL].sort(),
    );
  });

  it('returns empty array when input contains no dangerous rules', () => {
    const rules: PermissionRule[] = [
      bashRule('git log'),
      { raw: 'Read', toolName: ToolNames.READ_FILE },
    ];
    expect(findDangerousAllowRules(rules)).toEqual([]);
  });
});
