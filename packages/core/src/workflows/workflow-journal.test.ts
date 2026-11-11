/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeWorkflowJournalKey,
  WorkflowJournal,
} from './workflow-journal.js';

describe('WorkflowJournal', () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-journal-'));
    journalPath = path.join(tmpDir, 'journal.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns cached results for an unchanged prefix', async () => {
    const first = await WorkflowJournal.load(journalPath);
    const firstSlot = await first.nextCachedResult({
      prompt: 'read src',
      agentType: 'general-purpose',
    });
    await first.appendStarted(firstSlot.key, 'agent-1');
    await first.appendResult(firstSlot.key, {
      content: 'result 1',
      state: 'done',
      agentId: 'agent-1',
      agentType: 'general-purpose',
    });

    const resumed = await WorkflowJournal.load(journalPath);
    const cached = await resumed.nextCachedResult({
      prompt: 'read src',
      agentType: 'general-purpose',
    });

    expect(cached.result).toMatchObject({
      content: 'result 1',
      cached: true,
    });
  });

  it('skips corrupt journal lines while preserving valid cached results', async () => {
    const first = await WorkflowJournal.load(journalPath);
    const slot = await first.nextCachedResult({ prompt: 'survive corrupt tail' });
    await first.appendResult(slot.key, { content: 'cached', state: 'done' });
    await fs.appendFile(journalPath, '{"type":"result","key":');

    const resumed = await WorkflowJournal.load(journalPath);
    const cached = await resumed.nextCachedResult({
      prompt: 'survive corrupt tail',
    });

    expect(cached.result).toMatchObject({
      content: 'cached',
      cached: true,
    });
  });

  it('stops using cache after the first miss', async () => {
    const original = await WorkflowJournal.load(journalPath);
    const first = await original.nextCachedResult({ prompt: 'one' });
    await original.appendResult(first.key, { content: 'one', state: 'done' });
    const second = await original.nextCachedResult({ prompt: 'two' });
    await original.appendResult(second.key, { content: 'two', state: 'done' });

    const resumed = await WorkflowJournal.load(journalPath);
    const cachedFirst = await resumed.nextCachedResult({ prompt: 'one' });
    const changedSecond = await resumed.nextCachedResult({ prompt: 'changed' });
    const oldThird = await resumed.nextCachedResult({ prompt: 'two' });

    expect(cachedFirst.result?.content).toBe('one');
    expect(changedSecond.result).toBeUndefined();
    expect(oldThird.result).toBeUndefined();
  });

  it('persists audit events without treating them as cached results', async () => {
    const journal = await WorkflowJournal.load(journalPath);
    const slot = await journal.nextCachedResult({ prompt: 'skip me' });
    await journal.appendEvent(slot.key, {
      kind: 'skipped',
      attempt: 0,
      maxAttempts: 1,
      reason: 'user-skip',
    });

    const raw = await fs.readFile(journalPath, 'utf8');
    expect(raw).toContain('"type":"event"');
    expect(raw).toContain('"kind":"skipped"');

    const resumed = await WorkflowJournal.load(journalPath);
    const cached = await resumed.nextCachedResult({ prompt: 'skip me' });
    expect(cached.result).toBeUndefined();
  });

  it('excludes labels and phases from cache keys', () => {
    const keyA = computeWorkflowJournalKey('v2:', {
      prompt: 'same',
      agentType: 'reviewer',
      model: 'sonnet',
    });
    const keyB = computeWorkflowJournalKey('v2:', {
      prompt: 'same',
      agentType: 'reviewer',
      model: 'sonnet',
    });

    expect(keyA).toBe(keyB);
  });

  it('includes the workflow agent effort in cache keys', () => {
    const high = computeWorkflowJournalKey('v2:', {
      prompt: 'same',
      agentType: 'reviewer',
      effort: 'high',
    });
    const sameHigh = computeWorkflowJournalKey('v2:', {
      prompt: 'same',
      agentType: 'reviewer',
      effort: 'high',
    });
    const xhigh = computeWorkflowJournalKey('v2:', {
      prompt: 'same',
      agentType: 'reviewer',
      effort: 'xhigh',
    });

    expect(sameHigh).toBe(high);
    expect(xhigh).not.toBe(high);
  });
});
