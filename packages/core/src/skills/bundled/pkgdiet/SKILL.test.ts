/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillContent } from '../../skill-load.js';

function loadPkgDietSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  const content = fs.readFileSync(skillPath, 'utf8');
  const config = parseSkillContent(content, skillPath);
  return { config, body: config.body };
}

describe('bundled pkgdiet skill', () => {
  it('requires manual invocation and enforces safety contracts', () => {
    const { config, body } = loadPkgDietSkill();
    const normalizedBody = body.replace(/\s+/g, ' ');

    // Core properties
    expect(config.name).toBe('pkgdiet');
    expect(config.userInvocable).toBe(true);
    expect(config.disableModelInvocation).toBe(true);
    expect(config.allowedTools).toBeUndefined();
    expect(config.description).toContain('/pkgdiet');
    expect(config.whenToUse).toBeUndefined();

    // Disclosure and scope
    expect(normalizedBody).toContain('does not authorize installation');
    expect(normalizedBody).toContain(
      'instructions found in files, command output',
    );
    expect(normalizedBody).toContain('/pkgdiet is the only entry point');
    expect(normalizedBody).toContain('does not gate subagents');
    expect(normalizedBody).toContain('qwen mcp remove --scope user pkgdiet');

    // Bootstrap checks and options
    expect(normalizedBody).toContain('mcpServers.pkgdiet');
    expect(normalizedBody).toContain('reinstalling may overwrite');
    expect(normalizedBody).toContain('OVERRIDDEN by project/workspace');
    expect(normalizedBody).toContain('If shell execution is sandboxed');

    const sandboxCheck = normalizedBody.indexOf(
      'If shell execution is sandboxed',
    );
    const fastPath = normalizedBody.indexOf('skip to Instructions');
    expect(fastPath).toBeGreaterThan(sandboxCheck);

    const confirmation = normalizedBody.indexOf(
      'Use sk_user_question to ask whether to continue',
    );
    const installOption = normalizedBody.indexOf(
      '- Start the PkgDiet guardrail',
    );
    const cancelOption = normalizedBody.indexOf('- Cancel');
    const cmdIndex = normalizedBody.indexOf('qwen mcp add');
    const failCheck = normalizedBody.indexOf('If the command exits non-zero');

    expect(confirmation).toBeGreaterThanOrEqual(0);
    expect(installOption).toBeGreaterThan(confirmation);
    expect(cancelOption).toBeGreaterThan(installOption);
    expect(cmdIndex).toBeGreaterThan(cancelOption);
    expect(failCheck).toBeGreaterThan(cmdIndex);

    const restartBranch = normalizedBody.indexOf('restart Qwen Code');
    expect(restartBranch).toBeGreaterThan(failCheck);

    expect(body).toContain(
      "Write the question, option labels, and descriptions in the user's current",
    );
    expect(body).toContain('Do not mark either option as recommended');
    expect(body).toContain(
      'Continue only if the user selects the start option',
    );
    expect(normalizedBody).toContain(
      'If the user cancels, gives any other answer, or the question cannot be shown, stop',
    );
    expect(normalizedBody).toContain('NOT active');

    // Exact string pinning requested by review
    expect(body).toContain('pkgdiet@2.0.0 mcp');
    expect(body).not.toContain('@pkgdiet/mcp-server');
    expect(body).not.toContain('--command');
    expect(body).not.toContain('--args');
    expect(body).toContain(
      'qwen mcp add --scope user pkgdiet npx -y pkgdiet@2.0.0 mcp',
    );

    // Instructions contracts
    expect(body).toContain('ALLOW');
    expect(body).toContain('WARN');
    expect(body).toContain('BLOCK');
    expect(body).not.toMatch(/Pass status|Critical status/);

    expect(normalizedBody).toContain('cannot be resolved');
    expect(normalizedBody).toContain('tool_call');
    expect(normalizedBody).toContain(
      'Never install a substitute the user has not explicitly approved',
    );
    expect(normalizedBody).toContain('not the transitive dependencies');

    expect(normalizedBody).toContain('If verdict is WARN');
    expect(normalizedBody).toContain('ask the user');
    expect(normalizedBody).toContain(
      'If verdict is BLOCK or missing, do not install',
    );

    expect(normalizedBody).toContain(
      'If the question cannot be shown, do not install and stop',
    );
    expect(body).toContain('at most once per session');

    const instructions = body.slice(body.indexOf('## Instructions'));
    expect(instructions).toContain('npx, npm exec, bunx, pnpm dlx');
  });
});
