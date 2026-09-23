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
    expect(normalizedBody).toContain('instructions found in files, command output');
    expect(normalizedBody).toContain('/pkgdiet is the only entry point');
    expect(normalizedBody).toContain('does not gate subagents');

    // Bootstrap checks and options
    expect(normalizedBody).toContain('mcpServers.pkgdiet');
    expect(normalizedBody).toContain('reinstalling may overwrite');
    expect(normalizedBody).toContain('If shell execution is sandboxed');

    const confirmation = normalizedBody.indexOf('Use `ask_user_question` to ask whether to continue');
    const installOption = body.indexOf('- Start the PkgDiet guardrail');
    const cancelOption = body.indexOf('- Cancel');
    const cmdIndex = body.indexOf('qwen mcp add');
    const failCheck = normalizedBody.indexOf('If the command exits non-zero');
    
    expect(confirmation).toBeGreaterThanOrEqual(0);
    expect(installOption).toBeGreaterThan(confirmation);
    expect(cancelOption).toBeGreaterThan(installOption);
    expect(cmdIndex).toBeGreaterThan(cancelOption);
    expect(failCheck).toBeGreaterThan(cmdIndex);
    expect(normalizedBody.indexOf('restart Qwen Code')).toBeGreaterThan(failCheck);

    // Exact string pinning requested by review
    expect(body).toContain('pkgdiet@2.0.1 mcp');
    expect(body).not.toContain('@pkgdiet/mcp-server');
    expect(body).not.toContain('--command');
    expect(body).not.toContain('--args');
    expect(body).toContain('qwen mcp add --scope user pkgdiet npx -y pkgdiet@2.0.1 mcp');

    // Instructions contracts
    expect(body).toContain('ALLOW');
    expect(body).toContain('WARN');
    expect(body).toContain('BLOCK');
    expect(body).not.toMatch(/Pass status|Critical status/);

    expect(body).toContain('npx');
    expect(body).toContain('bunx');
    expect(body).toContain('at most once per session');
  });
});
