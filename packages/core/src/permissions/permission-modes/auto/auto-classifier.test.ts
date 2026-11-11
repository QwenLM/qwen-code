/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LlmAutoJudge } from './auto-judge.js';

/**
 * `AutoClassifier` is process-wide; everything it caches is keyed by session id
 * and everything per agent lives on that agent's view. These tests are about
 * that ownership, not about the classifier's judgement — `classifier.test.ts`
 * covers the prompt and `resolver.test.ts` the decision procedure.
 */

import { describe, it, expect } from 'vitest';
import {
  AutoClassifier,
  type AutoClassifierSession,
} from './auto-classifier.js';
import { buildClassifierSystemPrompt } from './classifier.js';
import type { AutoModeDenial } from './denials.js';
import type { PermissionRules } from '../../manager/decision/index.js';

function denial(display: string): AutoModeDenial {
  return { toolName: 'Bash', display, reason: 'blocked', timestamp: 1 };
}

function rules(...allow: string[]): PermissionRules {
  return { allow: { userSettings: allow }, deny: {}, ask: {} };
}

function session(
  id: string,
  overrides: Partial<AutoClassifierSession> = {},
): AutoClassifierSession {
  return {
    getSessionId: () => id,
    getMessages: () => [],
    getToolLookup: () => ({ get: () => undefined }),
    ...overrides,
  };
}

class TestClassifier extends AutoClassifier {
  protected override readJevSettings() {
    return { classifier: 'llm' as const };
  }
}

describe('AutoClassifier — views', () => {
  it('creates one view per (session, agent) pair', () => {
    const classifier = new TestClassifier();
    expect(classifier.getView('s1', 'agent')).toBe(
      classifier.getView('s1', 'agent'),
    );
    expect(classifier.getView('s1', 'agent')).not.toBe(
      classifier.getView('s2', 'agent'),
    );
    expect(classifier.getView('s1', 'agent')).not.toBe(
      classifier.getView('s1', 'other'),
    );
  });

  it('releases a view without touching its siblings', () => {
    const classifier = new TestClassifier();
    const view = classifier.getView('s1', 'agent');
    classifier.releaseView('s1', 'agent');
    expect(classifier.getView('s1', 'agent')).not.toBe(view);
    expect(classifier.getView('s1', 'other')).toBe(
      classifier.getView('s1', 'other'),
    );
  });

  it('drops every view and every session slot on disposeSession', () => {
    const classifier = new TestClassifier();
    const view = classifier.getView('s1', 'agent');
    classifier.recordDenial('s1', denial('rm -rf /'));
    classifier.setNeedsExitAttachment('s1', true);
    classifier.disposeSession('s1');
    expect(classifier.getView('s1', 'agent')).not.toBe(view);
    expect(classifier.getDenials('s1')).toEqual([]);
    expect(classifier.consumeNeedsExitAttachment('s1')).toBe(false);
  });
});

describe('AutoClassifier — availability', () => {
  it('is available when the session supplies an LLM judge', () => {
    const classifier = new TestClassifier();
    expect(classifier.isAvailable(undefined)).toBe(false);
    expect(classifier.isAvailable(session('s1'))).toBe(false);
    expect(
      classifier.isAvailable(
        session('s1', { judges: { llm: new LlmAutoJudge(async () => ({ shouldBlock: false, reason: '' })) } }),
      ),
    ).toBe(true);
  });

  it('folds user rules into the system prompt', () => {
    const classifier = new TestClassifier();
    expect(classifier.buildSystemPrompt({ allow: ['Rule one'] })).toContain(
      'Rule one',
    );
    expect(classifier.buildSystemPrompt()).toBe(
      buildClassifierSystemPrompt(undefined),
    );
  });
});

describe('AutoClassifier — per-session state', () => {
  it('keeps refusal lists separate', () => {
    const classifier = new TestClassifier();
    classifier.recordDenial('first', denial('first session command'));
    expect(classifier.getDenials('first')).toHaveLength(1);
    expect(classifier.getDenials('second')).toEqual([]);

    classifier.clearDenials('second');
    expect(classifier.getDenials('first')).toHaveLength(1);
  });

  it('truncates the display field and evicts past the cap', () => {
    const classifier = new TestClassifier();
    classifier.recordDenial('s1', denial('x'.repeat(500)));
    expect(classifier.getDenials('s1')[0].display).toHaveLength(200);
    for (let i = 0; i < 25; i++) {
      classifier.recordDenial('s1', denial(`command ${i}`));
    }
    const denials = classifier.getDenials('s1');
    expect(denials).toHaveLength(20);
    expect(denials[19].display).toBe('command 24');
  });

  it('keeps the exit flag per session and one-shot', () => {
    const classifier = new TestClassifier();
    expect(classifier.consumeNeedsExitAttachment('first')).toBe(false);
    classifier.setNeedsExitAttachment('first', true);
    expect(classifier.consumeNeedsExitAttachment('second')).toBe(false);
    expect(classifier.consumeNeedsExitAttachment('first')).toBe(true);
    expect(classifier.consumeNeedsExitAttachment('first')).toBe(false);
  });

  it('keeps the dangerous-rule stash per session', () => {
    const classifier = new TestClassifier();
    const original = rules('Bash(python:*)');
    const stripped = classifier.stripDangerousAllowRules('first', original);
    expect(stripped.allow.userSettings).toEqual([]);

    // A different session never sees the first session's stash.
    expect(
      classifier.restoreDangerousAllowRules('second', stripped).allow
        .userSettings,
    ).toEqual([]);
    expect(
      classifier.restoreDangerousAllowRules('first', stripped).allow
        .userSettings,
    ).toEqual(['Bash(python:*)']);
  });
});
