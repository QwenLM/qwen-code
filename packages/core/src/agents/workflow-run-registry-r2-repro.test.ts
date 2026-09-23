/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowRunRegistry,
  type WorkflowTaskRegistration,
} from './workflow-run-registry.js';

function completionFor(
  result: unknown,
  overrides: Partial<WorkflowTaskRegistration> & { snapshotPath?: string } = {},
) {
  const registry = new WorkflowRunRegistry();
  const completion = vi.fn();
  registry.setCompletionCallback(completion);
  registry.register({
    runId: 'wf_r2',
    meta: null,
    description: 'round two reproduction',
    status: 'running',
    startTime: 0,
    outputFile: '/tmp/wf_r2.jsonl',
    abortController: new AbortController(),
    notifyOnCompletion: true,
    ...overrides,
  } as WorkflowTaskRegistration);
  registry.complete('wf_r2', result, 1_000);
  const [display, model] = completion.mock.calls[0] as [string, string];
  return {
    display,
    model,
    resultBody: model.match(/<result>([\s\S]*?)<\/result>/)?.[1],
    registry,
  };
}

describe('PR 12415 round two reproduction', () => {
  it.each([
    undefined,
    '/tmp/runtime/projects/probe/workflows/wf_r2/journal.jsonl',
  ])(
    'includes the absolute registered snapshot path (journal=%s)',
    (journalPath) => {
      const snapshotPath = '/tmp/runtime/projects/probe/workflows/wf_r2.json';
      const { model } = completionFor('x'.repeat(30_000), {
        snapshotPath,
        ...(journalPath ? { journalPath } : {}),
      });
      const notice = model.match(
        /<result-truncated>([\s\S]*?)<\/result-truncated>/,
      )?.[1];
      expect(notice?.includes(snapshotPath)).toBe(true);
    },
  );

  it.each([false, true])(
    'retains application failures outside the result preview (background=%s)',
    (isBackgrounded) => {
      const result = { rows: 'x'.repeat(50_000), failed: ['fr'] };
      const { display, model, resultBody, registry } = completionFor(result, {
        isBackgrounded,
      });
      if (!isBackgrounded) {
        expect(display.includes('Reported failed: ["fr"]')).toBe(true);
      }
      expect(resultBody!.length).toBeLessThanOrEqual(25_000);
      expect(resultBody!.includes('failed')).toBe(false);
      expect(model.includes('<reported-failures>')).toBe(true);
      expect(
        model.match(/<reported-failures>([\s\S]*?)<\/reported-failures>/)?.[1],
      ).toContain('fr');
      expect(registry.get('wf_r2')?.result).toBe(result);
    },
  );

  it('keeps an emoji whole at the model preview boundary', () => {
    const { resultBody } = completionFor('x'.repeat(24_999) + '🙂');
    expect(resultBody!.length).toBeLessThanOrEqual(25_000);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(resultBody!)).toBe(false);
  });

  it('keeps an emoji whole at the display line boundary', () => {
    const { display } = completionFor('x'.repeat(4_087) + '🙂');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(display)).toBe(false);
  });

  it('retains readable failures when a sibling getter throws', () => {
    const { display } = completionFor({
      failed: ['fr'],
      get errors() {
        throw new Error('lazy load failed');
      },
    });
    expect(display.includes('Reported failed: ["fr"]')).toBe(true);
  });

  it('normalizes controls in both projections while retaining newlines', () => {
    const raw = '\u001b[31mred\u001b[0m\u0007 done\nplain';
    const { display, model, resultBody, registry } = completionFor(raw);
    expect(model.includes('\u001b')).toBe(false);
    expect(model.includes('\u0007')).toBe(false);
    expect(resultBody).toBe('red done\nplain');
    expect(display).toContain('Result: red done\nplain');
    expect(registry.get('wf_r2')?.result).toBe(raw);
  });

  it('does not truncate a short result merely because it contains many controls', () => {
    const raw = '\u001b[31m'.repeat(6_000) + 'ok';
    const { model, resultBody } = completionFor(raw);
    expect(model.includes('<result-truncated>')).toBe(false);
    expect(resultBody).toBe('ok');
  });

  it('finishes before an XML entity that would cross the budget', () => {
    const { resultBody, model } = completionFor({ rows: '&'.repeat(30_000) });
    expect(resultBody!.length).toBeLessThan(25_000);
    expect(resultBody).not.toMatch(/&[^;]*$/);
    expect(model.includes('<result-truncated>')).toBe(true);
  });
});
