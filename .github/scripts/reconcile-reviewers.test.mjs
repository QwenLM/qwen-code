/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseMarker, reconcile, MARKER } from './reconcile-reviewers.mjs';

const MAINTAINERS = ['wenshao', 'tanzhenxin', 'yiliang114', 'LaZzyMan'];

describe('parseMarker', () => {
  it('parses a well-formed marker', () => {
    const body = `${MARKER} {"desired":["wenshao","tanzhenxin"]} -->`;
    assert.deepEqual(parseMarker(body), ['wenshao', 'tanzhenxin']);
  });

  it('returns [] for empty body', () => {
    assert.deepEqual(parseMarker(''), []);
  });

  it('returns [] for null/undefined body', () => {
    assert.deepEqual(parseMarker(null), []);
    assert.deepEqual(parseMarker(undefined), []);
  });

  it('returns [] for body without the marker prefix', () => {
    assert.deepEqual(parseMarker('some random comment'), []);
  });

  it('returns [] for malformed JSON in marker', () => {
    assert.deepEqual(parseMarker(`${MARKER} {broken json -->`), []);
  });

  it('returns [] when desired is not an array', () => {
    assert.deepEqual(parseMarker(`${MARKER} {"desired":"oops"} -->`), []);
  });

  it('returns [] when desired key is missing', () => {
    assert.deepEqual(parseMarker(`${MARKER} {"other":1} -->`), []);
  });

  it('handles empty desired array', () => {
    assert.deepEqual(parseMarker(`${MARKER} {"desired":[]} -->`), []);
  });
});

describe('reconcile', () => {
  it('first run: no marker, adds all desired maintainers', () => {
    const result = reconcile({
      desired: ['wenshao', 'tanzhenxin'],
      reviewed: [],
      current: [],
      markerBody: '',
      maintainers: MAINTAINERS,
    });
    assert.deepEqual(result.toAdd, ['tanzhenxin', 'wenshao']);
    assert.deepEqual(result.toRemove, []);
    assert.equal(result.unchanged, false);
  });

  it('stable re-run: set unchanged, no API calls needed', () => {
    const result = reconcile({
      desired: ['wenshao', 'tanzhenxin'],
      reviewed: [],
      current: ['wenshao', 'tanzhenxin'],
      markerBody: `${MARKER} {"desired":["tanzhenxin","wenshao"]} -->`,
      maintainers: MAINTAINERS,
    });
    assert.deepEqual(result.toAdd, []);
    assert.deepEqual(result.toRemove, []);
    assert.equal(result.unchanged, true);
  });

  it('subtracts already-reviewed users from desired', () => {
    const result = reconcile({
      desired: ['wenshao', 'tanzhenxin'],
      reviewed: ['wenshao'],
      current: ['tanzhenxin'],
      markerBody: `${MARKER} {"desired":["tanzhenxin","wenshao"]} -->`,
      maintainers: MAINTAINERS,
    });
    assert.deepEqual(result.toAdd, []);
    assert.deepEqual(result.toRemove, []);
    assert.equal(result.unchanged, true);
  });

  it('detects manually-dismissed reviewer and does not re-add', () => {
    // wenshao was in prev_desired, is not in current (dismissed),
    // and has not reviewed — so it was manually removed.
    const result = reconcile({
      desired: ['wenshao', 'tanzhenxin'],
      reviewed: [],
      current: ['tanzhenxin'],
      markerBody: `${MARKER} {"desired":["tanzhenxin","wenshao"]} -->`,
      maintainers: MAINTAINERS,
    });
    assert.deepEqual(result.toAdd, []);
    assert.deepEqual(result.toRemove, []);
    assert.equal(result.unchanged, true);
  });

  it('does not treat a reviewed user as manually dismissed', () => {
    // wenshao was in prev_desired, is not in current, but HAS reviewed
    // — GitHub removed them from requested_reviewers after their review.
    const result = reconcile({
      desired: ['wenshao', 'tanzhenxin'],
      reviewed: ['wenshao'],
      current: ['tanzhenxin'],
      markerBody: `${MARKER} {"desired":["tanzhenxin","wenshao"]} -->`,
      maintainers: MAINTAINERS,
    });
    assert.deepEqual(result.toAdd, []);
    assert.deepEqual(result.toRemove, []);
    assert.equal(result.unchanged, true);
  });

  it('removes maintainers no longer in desired', () => {
    const result = reconcile({
      desired: ['wenshao'],
      reviewed: [],
      current: ['wenshao', 'tanzhenxin'],
      markerBody: `${MARKER} {"desired":["tanzhenxin","wenshao"]} -->`,
      maintainers: MAINTAINERS,
    });
    assert.deepEqual(result.toAdd, []);
    assert.deepEqual(result.toRemove, ['tanzhenxin']);
    assert.equal(result.unchanged, false);
  });

  it('does not touch non-maintainer reviewers', () => {
    const result = reconcile({
      desired: ['wenshao'],
      reviewed: [],
      current: ['wenshao', 'external-user'],
      markerBody: '',
      maintainers: MAINTAINERS,
    });
    assert.deepEqual(result.toAdd, []);
    assert.deepEqual(result.toRemove, []);
    assert.equal(result.unchanged, true);
  });

  it('recovers from malformed marker (treats as first run)', () => {
    const result = reconcile({
      desired: ['wenshao'],
      reviewed: [],
      current: [],
      markerBody: `${MARKER} {corrupted!! -->`,
      maintainers: MAINTAINERS,
    });
    assert.deepEqual(result.toAdd, ['wenshao']);
    assert.deepEqual(result.toRemove, []);
    assert.equal(result.unchanged, false);
  });

  it('handles empty desired (no reviewers needed)', () => {
    const result = reconcile({
      desired: [],
      reviewed: [],
      current: ['wenshao'],
      markerBody: `${MARKER} {"desired":["wenshao"]} -->`,
      maintainers: MAINTAINERS,
    });
    assert.deepEqual(result.toAdd, []);
    assert.deepEqual(result.toRemove, ['wenshao']);
    assert.equal(result.unchanged, false);
  });

  it('persists pre-drift desired in the marker body', () => {
    const result = reconcile({
      desired: ['wenshao', 'tanzhenxin'],
      reviewed: [],
      current: ['tanzhenxin'],
      markerBody: `${MARKER} {"desired":["tanzhenxin","wenshao"]} -->`,
      maintainers: MAINTAINERS,
    });
    // wenshao is drift (dismissed), so final desired is just tanzhenxin,
    // but the marker records the pre-drift set for future drift detection.
    assert.deepEqual(result.toAdd, []);
    assert.deepEqual(result.toRemove, []);
    const parsed = parseMarker(result.markerBody);
    assert.deepEqual(parsed, ['tanzhenxin', 'wenshao']);
  });

  it('CLI produces valid JSON output', () => {
    const script = fileURLToPath(
      new URL('./reconcile-reviewers.mjs', import.meta.url),
    );
    const proc = spawnSync(
      process.execPath,
      [
        script,
        '--desired',
        '["wenshao"]',
        '--reviewed',
        '[]',
        '--current',
        '[]',
        '--marker-body',
        '',
        '--maintainers',
        JSON.stringify(MAINTAINERS),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(proc.status, 0, proc.stderr);
    const out = JSON.parse(proc.stdout);
    assert.deepEqual(out.toAdd, ['wenshao']);
    assert.deepEqual(out.toRemove, []);
    assert.equal(out.unchanged, false);
    assert.ok(out.markerBody.startsWith(MARKER));
  });
});
