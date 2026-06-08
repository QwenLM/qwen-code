/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, loadPolicyFile, PolicyError } from './loader.js';

describe('loadPolicy', () => {
  it('parses valid YAML and fills in defaults', () => {
    const policy = loadPolicy(`
version: 1
rules:
  - id: allow-tests
    match:
      tool: bash
      argsGlob: "npm test*"
    action: allow
`);
    expect(policy.version).toBe(1);
    expect(policy.defaults).toEqual({
      action: 'prompt',
      requireScope: 'approve',
    });
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0].id).toBe('allow-tests');
    expect(policy.rules[0].action).toBe('allow');
    expect(policy.rules[0].match.tool).toBe('bash');
  });

  it('honors explicit defaults', () => {
    const policy = loadPolicy(`
defaults:
  action: deny
  requireScope: owner
`);
    expect(policy.defaults).toEqual({ action: 'deny', requireScope: 'owner' });
    expect(policy.rules).toEqual([]);
  });

  it('throws PolicyError when parsed doc is not a plain object', () => {
    expect(() => loadPolicy('- a\n- b')).toThrow(PolicyError);
    expect(() => loadPolicy('42')).toThrow(PolicyError);
  });

  it('treats empty/null document as an empty policy with defaults', () => {
    const policy = loadPolicy('');
    expect(policy.defaults).toEqual({
      action: 'prompt',
      requireScope: 'approve',
    });
    expect(policy.rules).toEqual([]);
  });

  it('throws PolicyError on invalid defaults.action', () => {
    expect(() => loadPolicy('defaults:\n  action: maybe')).toThrow(PolicyError);
  });

  it('throws PolicyError when a rule is missing action', () => {
    expect(() => loadPolicy('rules:\n  - match:\n      tool: bash')).toThrow(
      PolicyError,
    );
  });

  it('throws PolicyError on an invalid rule action', () => {
    expect(() =>
      loadPolicy('rules:\n  - match: {tool: bash}\n    action: maybe'),
    ).toThrow(PolicyError);
  });

  it('throws PolicyError when a rule match is not an object', () => {
    expect(() =>
      loadPolicy('rules:\n  - match: "bash"\n    action: allow'),
    ).toThrow(PolicyError);
  });

  it('throws PolicyError when a rule is not an object', () => {
    expect(() => loadPolicy('rules:\n  - "bash"')).toThrow(PolicyError);
  });

  it('ignores unknown top-level and rule fields (forward-compat)', () => {
    const policy = loadPolicy(`
unknownTop: hello
rules:
  - match: {tool: bash}
    action: allow
    futureField: 99
`);
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0].action).toBe('allow');
  });
});

describe('loadPolicyFile', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns null when the file is absent', async () => {
    const result = await loadPolicyFile(
      join(tmpdir(), 'does-not-exist-policy-xyz.yaml'),
    );
    expect(result).toBeNull();
  });

  it('parses a present file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-policy-'));
    const path = join(dir, 'policy.yaml');
    await writeFile(
      path,
      'rules:\n  - match: {tool: bash}\n    action: deny\n',
    );
    const policy = await loadPolicyFile(path);
    expect(policy).not.toBeNull();
    expect(policy!.rules[0].action).toBe('deny');
  });
});
