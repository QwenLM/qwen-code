/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPrompt, recordedPromptPath } from './prompt-record.js';
import { createWorkflowBatch, readWorkflowBatches } from './workflow-batch.js';

describe('review workflow batch selection', () => {
  let dir: string;
  let plan: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-batch-'));
    plan = join(dir, 'plan.json');
    writeFileSync(plan, '{}');
    recordPrompt(plan, 'verify--a', 'verify shard A exactly');
    recordPrompt(plan, 'reverse-audit--round-1', 'audit round one exactly');
    recordPrompt(plan, 'old-wave', 'must not be selected');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function manifest(keys: string[], name = 'batch.json'): string {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(createWorkflowBatch(plan, keys)));
    return file;
  }

  it('merges only explicitly selected keys, preserving their exact prompts', () => {
    const files = [
      manifest(['verify--a']),
      manifest(['reverse-audit--round-1'], 'audit.json'),
    ];
    expect(readWorkflowBatches(plan, files)).toEqual([
      { key: 'verify--a', prompt: 'verify shard A exactly' },
      { key: 'reverse-audit--round-1', prompt: 'audit round one exactly' },
    ]);
  });
  it('rejects duplicate keys across manifests', () => {
    const file = manifest(['verify--a']);
    expect(() => readWorkflowBatches(plan, [file, file])).toThrow(/duplicate/);
  });
  it('rejects another plan and a recaptured run at the same path', () => {
    const file = manifest(['verify--a']);
    const other = join(dir, 'other.json');
    writeFileSync(other, '{}');
    expect(() => readWorkflowBatches(other, [file])).toThrow(/another plan/);
    utimesSync(
      plan,
      new Date(Date.now() + 10000),
      new Date(Date.now() + 10000),
    );
    expect(() => readWorkflowBatches(plan, [file])).toThrow(/another plan/);
  });
  it.each(['missing', 'stale', 'changed'])(
    'rejects a %s selected record',
    (mode) => {
      const file = manifest(['verify--a']);
      const record = recordedPromptPath(plan, 'verify--a');
      if (mode === 'missing') rmSync(record);
      if (mode === 'stale') utimesSync(record, new Date(0), new Date(0));
      if (mode === 'changed')
        recordPrompt(plan, 'verify--a', 'different shard');
      expect(() => readWorkflowBatches(plan, [file])).toThrow(
        /missing, stale or changed/,
      );
    },
  );
  it('refuses empty selections, unrecorded keys and malformed manifests', () => {
    expect(() => createWorkflowBatch(plan, [])).toThrow(/nonempty/);
    expect(() => createWorkflowBatch(plan, ['unrecorded'])).toThrow(/missing/);
    expect(() => readWorkflowBatches(plan, [])).toThrow(/no manifests/);
    const file = join(dir, 'bad.json');
    writeFileSync(file, 'null');
    expect(() => readWorkflowBatches(plan, [file])).toThrow(/another plan/);
  });
});
