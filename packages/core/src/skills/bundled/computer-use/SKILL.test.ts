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
  const resource = (name: string) =>
    fs.readFileSync(
      path.join(path.dirname(skillPath), 'references', name),
      'utf-8',
    );
  return {
    config,
    body: config.body,
    macos: resource('macos.md'),
    legacy: resource('windows-linux.md'),
  };
}

describe('bundled computer-use skill', () => {
  it('routes one entrypoint by the connected driver platform to an existing resource', () => {
    const { config, body } = loadComputerUseSkill();
    expect(config.name).toBe('computer-use');
    expect(body).toContain('ComputerUse.create()');
    expect(body).toContain('await computer.getPlatform()');
    expect(body).toContain('references/macos.md');
    expect(body).toContain('references/windows-linux.md');
    expect(body).toContain('Read exactly one resource with `read_file`');
    expect(body).toContain('Skill base directory');
    expect(body).toContain('not the CLI or Node host operating system');
    expect(body).not.toContain('process.platform');
    expect(body).not.toContain('computer.getApp(');
    expect(body).not.toContain('computer.observeWindow(');
    expect(config.allowedTools).toBeUndefined();
  });

  it('exposes the macOS app workflow without native targeting or routing choices', () => {
    const { macos: body } = loadComputerUseSkill();
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
    const { macos: body } = loadComputerUseSkill();
    expect(body).toMatch(/After performing one or more UI actions/);
    expect(body).toMatch(/Batch actions whose target remains the same/);
    expect(body).toContain('Prefer this default diff output');
    expect(body).toContain('disableDiff: true');
    expect(body).toMatch(/window or session changes/);
    expect(body).toContain('maxTextChars?: number');
    expect(body).toContain('12,000 characters');
    expect(body).toContain('Only currently captured actionable IDs');
    expect(body).toMatch(
      /Partial, unconfirmed or cancelled actions must not be blindly repeated/,
    );
    expect(body).not.toMatch(
      /RecreationBench|benchmark|evaluator|score|failure count/i,
    );
  });

  it('requests screenshots separately and keeps the persistent REPL lifecycle', () => {
    const { macos: body } = loadComputerUseSkill();
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

  it('documents the macOS text methods and their uncertainty boundaries', () => {
    const { macos } = loadComputerUseSkill();
    expect(macos).toContain('app.selectText(37,');
    expect(macos).toContain("await app.paste('ready')");
    expect(macos).toContain("format?: 'text' | 'md' | 'html'");
    expect(macos).toContain(
      "selection?: 'text' | 'cursor_before' | 'cursor_after'",
    );
    expect(macos).toContain('immediately adjacent');
    expect(macos).toContain('Missing or');
    expect(macos).toContain('ambiguous matches fail');
    expect(macos).toContain('Observe state before');
    expect(macos).toContain('newer external clipboard change');
  });

  it('retains exact-window targeting and full actionable tokens for Windows/Linux', () => {
    const { legacy } = loadComputerUseSkill();
    expect(legacy).toContain('computer.listWindows(');
    expect(legacy).toContain('computer.observeWindow(target)');
    expect(legacy).toContain('windowId: selectedWindowId');
    expect(legacy).toContain('elementToken: string');
    expect(legacy).toContain('maxTextChars?: number');
    expect(legacy).toContain('12,000 characters');
    expect(legacy).toContain(
      'the first entry is not necessarily the task window',
    );
    expect(legacy).toContain(
      '`state.elements` remains the current full actionable element list',
    );
    expect(legacy).toContain("type DeliveryMode = 'background' | 'foreground'");
    expect(legacy).not.toMatch(
      /macOS|computer\.getApp|app\.getState|app\.paste|app\.selectText/,
    );
    expect(legacy).not.toContain('ComputerUse.create()');
  });
});
