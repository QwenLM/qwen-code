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

function loadComputerUseSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  const content = fs.readFileSync(skillPath, 'utf8');
  const config = parseSkillContent(content, skillPath);
  return { config, body: config.body };
}

describe('bundled computer-use skill', () => {
  it('preserves the Codex API-surface and workflow structure', () => {
    const { body } = loadComputerUseSkill();

    expect(body).toContain('## API surface');
    expect(body).toContain('## Workflow');
    expect(body).toContain('### 1. Initialize');
    expect(body).toContain('### 2. Actions using app');
    expect(body).not.toContain('## Essential API');
    expect(body).not.toContain('## Observe and act');
  });

  it('maps the Codex action-batch workflow onto the typed SDK', () => {
    const { body } = loadComputerUseSkill();

    expect(body).toContain("import('@qwen-code/cua-sdk/computer-use')");
    expect(body).toContain('ComputerUse.create()');
    expect(body).toContain('computer.listApps()');
    expect(body).toContain('computer.listWindows({ pid: matches[0].pid })');
    expect(body).toContain('computer.observeWindow(target)');
    expect(body).toMatch(/After performing one or more UI actions/);
    expect(body).toMatch(/Perform one or more actions, and then fetch/);
    expect(body).toContain('hotkey:');
    expect(body).toContain('modifiers?: string[]');
    expect(body).not.toMatch(/after every action/i);
  });

  it('maps Codex diff guidance to automatic cursors and disableDiff', () => {
    const { body } = loadComputerUseSkill();

    expect(body).toMatch(/accessibility tree will be returned\s+as a diff/);
    expect(body).toContain('Prefer this default diff output');
    expect(body).toContain('disableDiff?: boolean');
    expect(body).toContain('`disableDiff: true` only when');
    expect(body.match(/disableDiff/g)).toHaveLength(2);
    expect(body).toMatch(
      /`state\.elements` remains the current full actionable/,
    );
    expect(body).not.toMatch(/full response replaces the previous token set/i);
    expect(body).not.toMatch(/discard tokens from before/i);
    expect(body).toContain('automation_id?: string');
    expect(body).toMatch(
      /disregard the text[\s\S]*get the full tree next time/,
    );
    expect(body).not.toMatch(/baseRevisionId|revisionId|cuaRevisions/);
    expect(body).not.toContain('forceFull');
  });

  it('exposes only real typed SDK names and screenshot data', () => {
    const { config, body } = loadComputerUseSkill();

    expect(config.name).toBe('computer-use');
    expect(body).toContain('type ComputerUse =');
    expect(body).toContain('elementToken: string');
    expect(body).toContain('doubleClick:');
    expect(body).toContain('rightClick:');
    expect(body).toContain('modifier?: string[]');
    expect(body).toContain('deliveryMode?: DeliveryMode');
    expect(body).toContain('includeScreenshot?: boolean');
    expect(body).toContain('image.dataBase64');
    expect(body).toContain(
      'Reset the Node REPL only when no other persistent state is needed.',
    );
    expect(body).not.toMatch(/sky\.|get_app_state|element_index/);
    expect(body).not.toMatch(/computer\.(?:paste|selectText)/);
    expect(body).not.toMatch(/verifyState|actAndVerify|callTool/);
  });

  it('keeps screenshot capture independent from full AX observations', () => {
    const { body } = loadComputerUseSkill();
    const screenshotSection = body.split('## Reading screenshots')[1];
    const screenshotExample =
      screenshotSection.match(/```js([\s\S]*?)```/)?.[1];

    expect(screenshotSection).toContain(
      '`includeScreenshot: true` is the parameter that requests a screenshot.',
    );
    expect(screenshotSection).not.toContain('disableDiff');
    expect(screenshotExample).toContain('includeScreenshot: true');
    expect(screenshotExample).not.toContain('disableDiff');
    expect(screenshotExample).toContain('nodeRepl.write(state.text)');
  });

  it('stays generic and free of benchmark-specific policy', () => {
    const { body } = loadComputerUseSkill();

    expect(body).not.toMatch(
      /RecreationBench|benchmark|evaluator|score|bcrypt|ovonote|failure count/i,
    );
  });
});
