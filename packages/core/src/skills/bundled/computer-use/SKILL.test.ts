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
  it('uses the public typed SDK contract and requires fresh verification', () => {
    const { body } = loadComputerUseSkill();

    expect(body).toContain("import('@qwen-code/cua-sdk/computer-use')");
    expect(body).toContain('ComputerUse.create()');
    expect(body).toContain('computer.actAndVerify');
    expect(body).toContain('computer.verifyState');
    expect(body).toContain('stableSamples: 2');
    expect(body).toContain('globalThis.lastCuaOutcome');
    expect(body).toContain('JSON.stringify(lastCuaOutcome)');
    expect(body).toContain('error?.details');
    expect(
      body.match(/signal: ?nodeRepl\.signal/g)?.length,
    ).toBeGreaterThanOrEqual(5);
    expect(body).toContain('delivery evidence, not task completion');
    expect(body).toContain('`unknown` and `stable:false` are not success');
    expect(body).toContain('`effect`');
    expect(body).toContain('`operation`');
    expect(body).toContain('Do not use generic `callTool`');
  });

  it('keeps one revision cursor per surface and forceFull recovery one-shot', () => {
    const { body } = loadComputerUseSkill();

    expect(body).toContain('`${target.pid}:${target.windowId}`');
    expect(body).toContain('baseRevisionId: cuaRevisions.get(key)');
    expect(body).toContain('same surface');
    expect(body.match(/forceFull/g)).toHaveLength(1);
    expect(body).toContain('one observation with `forceFull: true`');
    expect(body).toContain('Do not make full observations the default');
  });

  it('stays minimal, generic, and separate from Node REPL runtime guidance', () => {
    const { config, body } = loadComputerUseSkill();

    expect(config.name).toBe('computer-use');
    expect(body.length).toBeLessThanOrEqual(6000);
    expect(body).not.toMatch(
      /RecreationBench|benchmark|evaluator|score|bcrypt|ovonote|failure count/i,
    );
    expect(body).not.toMatch(
      /top-level (?:const|let|var)|lexical binding|cannot be redeclared|dynamic import/i,
    );
  });
});
