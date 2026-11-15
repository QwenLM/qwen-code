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
    expect(normalizedBody).toContain(
      '/pkgdiet is the entry point for this bundled skill',
    );
    expect(normalizedBody).toContain('does not gate subagents');
    expect(body).toContain(
      '"${QWEN_CODE_CLI:-qwen}" mcp remove --scope user pkgdiet',
    );
    expect(normalizedBody).toContain(
      'installs the 2.x dependency tree at run time',
    );
    expect(normalizedBody).toContain('inherits its environment');
    expect(normalizedBody).toContain(
      'reads project policy files and cache if present',
    );
    expect(body).toContain('published by the skill author (om-tajne)');

    // Bootstrap checks, whole entry inspection, and ordering
    expect(normalizedBody).toContain(
      'Inspect configured MCP servers and tool availability',
    );
    expect(normalizedBody).toContain(
      'originates in project or workspace scope, treat it as untrusted',
    );
    expect(normalizedBody).toContain('do not advise approval');
    expect(normalizedBody).toContain('no extraneous fields');
    expect(body).not.toContain('"${QWEN_CODE_CLI:-qwen}" mcp approve pkgdiet');

    expect(normalizedBody).toContain('reinstalling will overwrite');
    expect(normalizedBody).toContain('~/.qwen/settings.json');
    expect(normalizedBody).toContain(
      'record its full configuration object verbatim',
    );

    expect(normalizedBody).toContain('If shell execution is sandboxed');
    expect(normalizedBody).toContain(
      'identity mismatch rather than a residual risk',
    );
    expect(normalizedBody).toContain('https://registry.npmjs.org/');

    expect(normalizedBody).toContain("serverName === 'pkgdiet'");
    expect(normalizedBody).toContain('mcp__pkgdiet__check_dependency');

    const inspectCheck = normalizedBody.indexOf(
      'Inspect configured MCP servers and tool availability',
    );
    const fastPath = normalizedBody.indexOf('skip to Instructions');
    const sandboxCheck = normalizedBody.indexOf(
      'If shell execution is sandboxed',
    );
    const registryCheck = normalizedBody.indexOf(
      'Check the active npm registry',
    );

    expect(inspectCheck).toBeGreaterThanOrEqual(0);
    expect(fastPath).toBeGreaterThan(inspectCheck);
    expect(sandboxCheck).toBeGreaterThan(inspectCheck);
    expect(registryCheck).toBeGreaterThan(sandboxCheck);

    const confirmation = normalizedBody.indexOf(
      'Use `ask_user_question` to ask whether to continue',
    );
    const installOption = normalizedBody.indexOf(
      '- Start the PkgDiet guardrail',
    );
    const cancelOption = normalizedBody.indexOf('- Cancel');
    const cmdIndex = normalizedBody.indexOf('"${QWEN_CODE_CLI:-qwen}" mcp add');
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
    expect(normalizedBody).toContain(
      'downloaded and started by every session in every project until',
    );
    expect(normalizedBody).toContain(
      'subagent, hook, workflow-script and external terminal installs are not gated',
    );
    expect(normalizedBody).toContain('NOT active');
    expect(normalizedBody).toContain(
      'restore any prior configuration recorded from `~/.qwen/settings.json`',
    );

    // Exact string pinning requested by review
    expect(body).toContain('pkgdiet@2.0.0 mcp');
    expect(body).not.toContain('@pkgdiet/mcp-server');
    expect(body).not.toContain('--command');
    expect(body).not.toContain('--args');
    expect(body).toContain(
      '"${QWEN_CODE_CLI:-qwen}" mcp add --scope user pkgdiet npx -y pkgdiet@2.0.0 mcp',
    );

    // Instructions contracts
    expect(body).toContain('ALLOW');
    expect(body).toContain('WARN');
    expect(body).toContain('BLOCK');
    expect(body).not.toMatch(/Pass status|Critical status/);

    // Policy files and cache gating
    expect(normalizedBody).toContain('.pkgdietrc.json');
    expect(normalizedBody).toContain('pkgdiet.config.json');
    expect(normalizedBody).toContain('package.json#pkgdiet');
    expect(normalizedBody).toContain('.pkgdiet-cache.json');
    expect(normalizedBody).toContain(
      'Refuse to rely on a project-committed `.pkgdiet-cache.json`',
    );

    // Registry redirects and local resolution
    expect(normalizedBody).toContain('.yarnrc.yml');
    expect(normalizedBody).toContain('bunfig.toml');
    expect(normalizedBody).toContain('node_modules/.bin');
    expect(normalizedBody).toContain('treat the verdict as not applicable');
    expect(normalizedBody).toContain(
      'resolves outside what the verdict covers and was not screened',
    );

    expect(normalizedBody).toContain('cannot be resolved');
    expect(normalizedBody).toContain('tool_call');
    expect(normalizedBody).toContain(
      'Never install a substitute the user has not explicitly approved',
    );
    expect(normalizedBody).toContain('not the transitive dependencies');
    expect(normalizedBody).toContain('not a specific version');
    expect(normalizedBody).toContain('could not evaluate this package');
    expect(normalizedBody).toContain(
      'read `reasons`. If they say the package was not evaluated',
    );
    expect(normalizedBody).toContain(
      'code mode, invoke it through `exec` using the `jsName`',
    );

    // Full sentence pinning for WARN and BLOCK
    expect(normalizedBody).toContain(
      'If verdict is WARN, report the reasons and ask the user',
    );
    expect(normalizedBody).toContain(
      'If verdict is BLOCK or missing, do not install',
    );
    expect(normalizedBody).toContain('Bound suggestions to at most 1 hop');

    expect(normalizedBody).toContain(
      'If the question cannot be shown, do not install and stop',
    );
    expect(body).toContain('at most once per session');

    const instructions = body.slice(body.indexOf('## Instructions'));
    expect(instructions).toContain('`npx`, `npm exec`, `bunx`, `pnpm dlx`');
  });
});
