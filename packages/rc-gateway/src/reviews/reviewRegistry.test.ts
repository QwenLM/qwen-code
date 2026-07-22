/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewRegistry } from './reviewRegistry.js';

describe('ReviewRegistry', () => {
  it('registers, persists 0600, and finds by session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reviews-'));
    const path = join(dir, 'reviews.json');
    const t = 1000;
    const reg = await ReviewRegistry.open(path, () => t);
    const rec = await reg.register({
      sessionId: 's1',
      target: { kind: 'pr', number: 42 },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'tok1',
    });
    expect(rec.reviewId).toBeTruthy();
    expect(rec.status).toBe('running');
    expect(reg.findBySessionId('s1')?.reviewId).toBe(rec.reviewId);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.reviews).toHaveLength(1);
  });

  it('setStatus refuses to leave a terminal status and stamps finishedAt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reviews-'));
    let t = 5;
    const reg = await ReviewRegistry.open(join(dir, 'r.json'), () => t);
    const rec = await reg.register({
      sessionId: 's',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'auto',
      triggeredByTokenId: 'x',
    });
    t = 9;
    expect(await reg.setStatus(rec.reviewId, 'completed')).toBe(true);
    expect(reg.get(rec.reviewId)?.finishedAt).toBe(new Date(9).toISOString());
    expect(await reg.setStatus(rec.reviewId, 'cancelled')).toBe(false);
  });

  it('reconcile marks non-live running reviews orphaned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reviews-'));
    const reg = await ReviewRegistry.open(join(dir, 'r.json'), () => 1);
    const a = await reg.register({
      sessionId: 'live',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'x',
    });
    const b = await reg.register({
      sessionId: 'gone',
      target: { kind: 'local' },
      comment: false,
      autofix: false,
      approvalLeg: 'vote',
      triggeredByTokenId: 'x',
    });
    const orphaned = await reg.reconcile(['live']);
    expect(orphaned).toEqual([b.reviewId]);
    expect(reg.get(a.reviewId)?.status).toBe('running');
    expect(reg.get(b.reviewId)?.status).toBe('orphaned');
  });
});
