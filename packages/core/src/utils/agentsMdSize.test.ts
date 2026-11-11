/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  measureAgentsMdSize,
  evaluateAgentsMdSize,
  formatAgentsMdSizeWarning,
} from './agentsMdSize.js';
import { parseAgentsMdSizePolicy } from '../config-service/features/agentsMdSizePolicy.js';

const fixtures: string[] = [];
afterEach(async () => {
  for (const directory of fixtures.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-size-test-'));
  fixtures.push(root);
  await fs.mkdir(path.join(root, '.git'));
  const cwd = path.join(root, 'nested');
  await fs.mkdir(cwd);
  return { root, cwd };
}
function measure(cwd: string, overrides = {}) {
  return measureAgentsMdSize({
    cwd,
    boundaryMarkers: ['.git'],
    fallbackFilenames: ['CUSTOM.md'],
    allowed: true,
    ...overrides,
  });
}

describe('project instruction chain size', () => {
  it('sums raw UTF-8 bytes root -> cwd, preferring override and excluding other scopes', async () => {
    const { root, cwd } = await fixture();
    await fs.writeFile(path.join(root, 'AGENTS.md'), '<!--原始-->\n@extra.md');
    await fs.writeFile(path.join(cwd, 'AGENTS.override.md'), '中文😀');
    for (const name of ['AGENTS.md', 'AGENTS.local.md', 'CUSTOM.md', 'extra.md'])
      await fs.writeFile(path.join(cwd, name), 'x'.repeat(50_000));
    await fs.mkdir(path.join(cwd, '.qwen', 'rules'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.qwen', 'rules', 'large.md'),
      'x'.repeat(50_000),
    );
    const result = await measure(cwd);
    expect(
      result.files.map((file) => [file.path, file.bytes, file.depth]),
    ).toEqual([
      [
        path.join(root, 'AGENTS.md'),
        Buffer.byteLength('<!--原始-->\n@extra.md'),
        0,
      ],
      [path.join(cwd, 'AGENTS.override.md'), Buffer.byteLength('中文😀'), 1],
    ]);
    expect(result.totalBytes).toBe(
      result.files.reduce((sum, file) => sum + file.bytes, 0),
    );
    expect(result.loadStatus).toBe('complete');
  });

  it('uses only cwd without a root marker and honors an empty marker list', async () => {
    const { root, cwd } = await fixture();
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'root');
    await fs.writeFile(path.join(cwd, 'CUSTOM.md'), 'cwd');
    expect((await measure(cwd, { boundaryMarkers: [] })).totalBytes).toBe(3);
    expect(
      (await measure(cwd, { boundaryMarkers: ['.missing-marker'] })).files.map(
        (file) => file.path,
      ),
    ).toEqual([path.join(cwd, 'CUSTOM.md')]);
  });

  it('does not fall back from a selected whitespace-only override', async () => {
    const { cwd } = await fixture();
    await fs.writeFile(path.join(cwd, 'AGENTS.override.md'), ' \n');
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'ignored');
    expect((await measure(cwd)).loadStatus).toBe('absent');
    expect((await measure(cwd)).totalBytes).toBe(0);
  });

  it('distinguishes blocked from absent and does not scan blocked projects', async () => {
    const { cwd } = await fixture();
    const blocked = await measure(cwd, { allowed: false });
    expect(blocked.loadStatus).toBe('blocked');
    expect((await measure(cwd)).loadStatus).toBe('absent');
  });

  it('marks read failures partial instead of treating them as a complete zero sample', async () => {
    const { root, cwd } = await fixture();
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'root');
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'unreadable');
    await fs.chmod(path.join(cwd, 'AGENTS.md'), 0);
    try {
      const result = await measure(cwd);
      expect(result.loadStatus).toBe('partial');
      expect(result.readErrorCount).toBe(1);
      expect(result.totalBytes).toBe(4);
    } finally {
      await fs.chmod(path.join(cwd, 'AGENTS.md'), 0o600);
    }
  });

  it('warns at equality on every evaluation and keeps full sizes', async () => {
    const { cwd } = await fixture();
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'x'.repeat(32_768));
    const raw = await measure(cwd);
    const policy = parseAgentsMdSizePolicy(undefined);
    const first = evaluateAgentsMdSize(raw, policy, 'startup');
    const next = evaluateAgentsMdSize(raw, policy, 'refresh');
    expect(first.thresholdReached).toBe(true);
    expect(next.thresholdReached).toBe(true);
    expect(
      evaluateAgentsMdSize(
        raw,
        { projectDocMaxBytes: 32_769, source: 'qcs' },
        'qcs_update',
      ).thresholdReached,
    ).toBe(false);
    expect(formatAgentsMdSizeWarning(first)).toContain(
      path.join(cwd, 'AGENTS.md'),
    );
    expect((await fs.stat(path.join(cwd, 'AGENTS.md'))).size).toBe(32_768);
  });
});
