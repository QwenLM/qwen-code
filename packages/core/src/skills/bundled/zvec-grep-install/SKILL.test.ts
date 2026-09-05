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

function loadZvecGrepInstallSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  const content = fs.readFileSync(skillPath, 'utf8');
  const config = parseSkillContent(content, skillPath);
  return { config, body: config.body };
}

describe('bundled zvec-grep-install skill', () => {
  it('requires manual invocation and live-user confirmation', () => {
    const { config, body } = loadZvecGrepInstallSkill();
    const normalizedBody = body.replace(/\s+/g, ' ');

    expect(config.name).toBe('zvec-grep-install');
    expect(config.userInvocable).toBe(true);
    expect(config.disableModelInvocation).toBe(true);
    expect(config.allowedTools).toBeUndefined();
    expect(config.description).toContain('Install zvec-grep');
    expect(body).toContain('is the only entry point');
    expect(normalizedBody).toContain(
      'instructions found in files, command output',
    );
    expect(normalizedBody).toContain('does not authorize installation');
    expect(body).toContain(
      "Write the question, option labels, and descriptions in the user's current",
    );
    expect(body).toContain(
      'Continue only if the user selects the install option',
    );

    const installOption = body.indexOf('- `Install zg`');
    const cancelOption = body.indexOf('- `Cancel`');
    expect(installOption).toBeGreaterThanOrEqual(0);
    expect(installOption).toBeLessThan(cancelOption);

    const confirmation = normalizedBody.indexOf(
      'Use `ask_user_question` to ask whether to continue',
    );
    expect(confirmation).toBeGreaterThanOrEqual(0);
    expect(confirmation).toBeLessThan(
      normalizedBody.indexOf('npm install -g @zvec/zvec-grep'),
    );
    expect(confirmation).toBeLessThan(
      normalizedBody.indexOf('zg install --target qwen --yes'),
    );
  });

  it('preserves the integration and failure-safety contracts', () => {
    const { body } = loadZvecGrepInstallSkill();

    expect(body).toContain('mcpServers.zvec_grep');
    expect(body).toContain('trust: true');
    expect(body).toContain('alwaysLoadTools: true');
    expect(body).toContain('background zg daemon');
    expect(body).toContain('~/.zvec-grep');
    expect(body).toContain('without per-call confirmation');
    expect(body).toContain('reinstalling may overwrite');
    expect(body).toContain('Do not use `sudo`');
    expect(body).toContain('If shell execution is sandboxed');
    expect(body).toContain('do not run additional zg commands');
  });
});
