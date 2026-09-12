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
  const config = parseSkillContent(
    fs.readFileSync(skillPath, 'utf-8'),
    skillPath,
  );
  return { config, body: config.body };
}

describe('bundled computer-use skill', () => {
  it('exposes the app workflow without native targeting or routing choices', () => {
    const { config, body } = loadComputerUseSkill();
    expect(config.name).toBe('computer-use');
    expect(body).toContain('ComputerUse.create()');
    expect(body).toContain('computer.getApp(');
    expect(body).toContain('app.getState(');
    expect(body).toContain('app.click(37)');
    expect(body).not.toMatch(
      /deliveryMode|delivery_mode|foreground|background|elementToken|element_token|windowId|window_id|\bpid\b/,
    );
    expect(body).not.toContain('computer.observeWindow(');
    expect(body).not.toContain('computer.listWindows(');
  });

  it('preserves batching, incremental observation and safe refresh guidance', () => {
    const { body } = loadComputerUseSkill();
    expect(body).toMatch(/After performing one or more UI actions/);
    expect(body).toMatch(/Batch actions whose target remains the same/);
    expect(body).toContain('Prefer this default diff output');
    expect(body).toContain('disableDiff: true');
    expect(body).toMatch(/window or session changes/);
    expect(body).toMatch(
      /Partial, unconfirmed or cancelled actions must not be blindly repeated/,
    );
    expect(body).not.toMatch(
      /RecreationBench|benchmark|evaluator|score|failure count/i,
    );
  });

  it('requests screenshots separately and keeps the persistent REPL lifecycle', () => {
    const { body } = loadComputerUseSkill();
    const screenshotSection = body.split('## Reading screenshots')[1];
    expect(screenshotSection).toContain('includeScreenshot: true');
    expect(screenshotSection).not.toContain('disableDiff');
    expect(screenshotSection).toContain('image.dataBase64');
    expect(screenshotSection).toContain('nodeRepl.write(state.text)');
    expect(body).toContain('await computer.close()');
    expect(body).toContain(
      'Reset the Node REPL only when no other persistent state is needed.',
    );
  });
});
