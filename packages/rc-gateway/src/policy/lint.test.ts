/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintPolicyFile, formatPolicyLint } from './loader.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-policylint-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, body);
  return p;
}

describe('lintPolicyFile', () => {
  it('reports a valid file with its rule count', async () => {
    const p = await write(
      'ok.yaml',
      `rules:\n  - id: a\n    match: { tool: bash }\n    action: allow\n  - id: b\n    match: { tool: git }\n    action: deny\n`,
    );
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(true);
    expect(r.ruleCount).toBe(2);
    expect(r.deferred).toEqual([]);
  });

  it('reports a malformed file as invalid with the loader error', async () => {
    const p = await write(
      'bad.yaml',
      `rules:\n  - id: a\n    match: { tool: bash }\n    action: maybe\n`,
    );
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/action must be allow\/deny\/prompt/);
  });

  it('reports a non-mapping document as invalid', async () => {
    const p = await write('list.yaml', `- 1\n- 2\n`);
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must be a mapping/);
  });

  it('reports a missing file as invalid (not a silent pass)', async () => {
    const r = await lintPolicyFile(join(dir, 'nope.yaml'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/file not found/);
  });

  it('reports a non-ENOENT read error (e.g. a directory) as invalid without throwing', async () => {
    // Passing the temp DIR as the path → readFile rejects with EISDIR, the
    // non-ENOENT arm → {ok:false, "cannot read …"} (never throws).
    const r = await lintPolicyFile(dir);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot read/);
    expect(r.error).not.toMatch(/file not found/);
  });

  it('lists rules using the still-deferred maxPerWindow field', async () => {
    const p = await write(
      'deferred.yaml',
      `rules:\n  - id: quota\n    match: { tool: bash }\n    action: allow\n    maxPerWindow: { count: 5, windowSec: 60 }\n  - id: plain\n    match: { tool: git }\n    action: allow\n`,
    );
    const r = await lintPolicyFile(p);
    expect(r.ok).toBe(true);
    expect(r.deferred).toEqual(['quota']);
  });

  it('falls back to [index] for a deferred rule with no id', async () => {
    const p = await write(
      'noid.yaml',
      `rules:\n  - match: { tool: bash }\n    action: allow\n    maxPerWindow: { count: 1, windowSec: 1 }\n`,
    );
    const r = await lintPolicyFile(p);
    expect(r.deferred).toEqual(['[0]']);
  });
});

describe('formatPolicyLint', () => {
  it('renders a valid result', () => {
    expect(
      formatPolicyLint('/p.yaml', { ok: true, ruleCount: 3, deferred: [] }),
    ).toBe('✓ /p.yaml: valid (3 rule(s))');
  });

  it('appends a note when deferred rules are present', () => {
    const out = formatPolicyLint('/p.yaml', {
      ok: true,
      ruleCount: 2,
      deferred: ['quota'],
    });
    expect(out).toContain('✓ /p.yaml: valid (2 rule(s))');
    expect(out).toContain('maxPerWindow');
    expect(out).toContain('quota');
  });

  it('renders an invalid result', () => {
    expect(formatPolicyLint('/p.yaml', { ok: false, error: 'boom' })).toBe(
      '✖ /p.yaml: boom',
    );
  });
});
