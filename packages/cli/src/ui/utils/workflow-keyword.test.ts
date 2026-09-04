/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  detectWorkflowKeyword,
  buildWorkflowSteeringNotice,
} from './workflow-keyword.js';

describe('detectWorkflowKeyword', () => {
  it.each([
    ['build me a workflow for this', true],
    ['Workflow this please', true],
    ['can you run a workflow?', true],
    ['WORKFLOW', true],
    ['the workflow.', true],
  ])('matches the standalone word: %s', (text, expected) => {
    expect(detectWorkflowKeyword(text)).toBe(expected);
  });

  it.each([
    ['fix the workflows list', false], // plural — not the bare word
    ['this is a dataflow problem', false], // substring, not a word
    ['my-workflow-runner crashed', false], // hyphen-joined
    ['just a normal request', false],
    ['', false],
  ])('does not over-match: %s', (text, expected) => {
    expect(detectWorkflowKeyword(text)).toBe(expected);
  });
});

describe('buildWorkflowSteeringNotice', () => {
  it('names the Workflow tool and stays a soft nudge', () => {
    const notice = buildWorkflowSteeringNotice();
    expect(notice).toContain('Workflow tool');
    expect(notice).toContain('workflow');
    // Soft, not forced — the model keeps discretion.
    expect(notice).toMatch(/proceed normally/i);
  });
});
