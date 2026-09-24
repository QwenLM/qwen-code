/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildPermissionCheckContext,
  evaluatePermissionRules,
} from '../../../core/permission-helpers.js';
import { PermissionManager } from '../../../permissions/permission-manager.js';
import { applySkillAllowedTools } from '../../../tools/skill-utils.js';
import { parseSkillContent } from '../../skill-load.js';

function loadBatchApiSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  const content = fs.readFileSync(skillPath, 'utf8');
  const config = parseSkillContent(content, skillPath);
  return { config, body: config.body };
}

function grantedPermissionManager(allowedTools: string[] | undefined) {
  const pm = new PermissionManager({
    getPermissionsAllow: () => undefined,
    getPermissionsAsk: () => undefined,
    getPermissionsDeny: () => undefined,
  });
  applySkillAllowedTools(pm, allowedTools);
  return pm;
}

describe('bundled batch-api skill', () => {
  it('is user-invoked only: the model can never switch a task to Batch', () => {
    const { config } = loadBatchApiSkill();

    expect(config.name).toBe('batch-api');
    expect(config.disableModelInvocation).toBe(true);
    expect(config.argumentHint).toBe('<task>');
  });

  it('pre-approves read tools only; the plan write and the paid run stay behind a prompt', async () => {
    const { config } = loadBatchApiSkill();

    expect(config.allowedTools).toEqual(['glob', 'grep_search', 'read_file']);
    const pm = grantedPermissionManager(config.allowedTools);
    // `read_file` expands to the read family in the permission rules;
    // every member of it is read-only.
    for (const tool of ['list_directory', 'zoom_image']) {
      await expect(
        evaluatePermissionRules(
          pm,
          'ask',
          buildPermissionCheckContext(tool, {}, ''),
        ),
      ).resolves.toMatchObject({ finalPermission: 'allow' });
    }
    // Writing the plan and `qwen batch run` (which spends money) must still
    // ask the user.
    for (const tool of ['write_file', 'edit']) {
      await expect(
        evaluatePermissionRules(
          pm,
          'ask',
          buildPermissionCheckContext(tool, {}, ''),
        ),
      ).resolves.toMatchObject({ finalPermission: 'ask' });
    }
  });

  it('checks readiness first and stops instead of doing the work realtime', () => {
    const { body } = loadBatchApiSkill();

    const check = body.indexOf('## 0. Check readiness');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(
      body.indexOf('## 4. Submit through the executor'),
    );
    expect(body).toContain('"${QWEN_CODE_CLI:-qwen}" batch check');
    expect(body).toContain('Never fall back to doing the transform yourself');
    // Every executor call goes through the session's own CLI first.
    expect(body).toContain('"${QWEN_CODE_CLI:-qwen}" batch run');
    // The paid submission is approved against a preview it must still match.
    const preview = body.indexOf('--dry-run');
    expect(preview).toBeGreaterThan(-1);
    expect(preview).toBeLessThan(body.indexOf('--expect <digest>'));
  });

  it('waits in a background shell, never polls from the model, never retries', () => {
    const { body } = loadBatchApiSkill();

    expect(body).toContain('batch collect <task-id> --wait');
    expect(body).toContain('is_background: true');
    expect(body).toContain('Do not poll or wait for the batch yourself');
    expect(body).toContain('Never retry automatically');
    expect(body).toContain('collects the task automatically');
  });
});
