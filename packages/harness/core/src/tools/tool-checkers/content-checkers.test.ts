/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  skillRuleMatches,
  webFetchRuleCandidates,
  workflowPermissionContent,
} from './content-checkers.js';

describe('skillRuleMatches', () => {
  it('matches exactly, ignoring a leading slash', () => {
    expect(skillRuleMatches('review', 'review')).toBe(true);
    expect(skillRuleMatches('/review', 'review')).toBe(true);
    expect(skillRuleMatches('review', 'review-pr')).toBe(false);
  });

  it('treats a trailing :* as a prefix', () => {
    expect(skillRuleMatches('review:*', 'review-pr')).toBe(true);
    expect(skillRuleMatches('review:*', 'review')).toBe(true);
    expect(skillRuleMatches('review:*', 'plan')).toBe(false);
  });
});

describe('workflowPermissionContent', () => {
  it('identifies a workflow by name, falling back to its script path', () => {
    expect(workflowPermissionContent({ name: 'nightly' })).toBe('nightly');
    expect(workflowPermissionContent({ scriptPath: '/tmp/w.mjs' })).toBe(
      '/tmp/w.mjs',
    );
    expect(workflowPermissionContent({})).toBeUndefined();
  });
});

describe('webFetchRuleCandidates', () => {
  it('offers the host, and the host with path when there is one', () => {
    expect(webFetchRuleCandidates('https://docs.example.com/')).toEqual([
      'docs.example.com',
    ]);
    expect(webFetchRuleCandidates('https://docs.example.com/guide')).toEqual([
      'docs.example.com',
      'docs.example.com/guide',
    ]);
  });

  it('offers nothing for an unparseable URL', () => {
    expect(webFetchRuleCandidates('not a url')).toEqual([]);
  });
});
