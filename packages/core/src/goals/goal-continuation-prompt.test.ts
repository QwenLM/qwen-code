/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildGoalContinuationParts,
  renderGoalContinuationPrompt,
} from './goal-continuation-prompt.js';

// These expectations pin the exact bytes each host sent before the renderer
// existed. Any edit to a line must show up here as a diff, not slip through.
describe('renderGoalContinuationPrompt', () => {
  it('renders the guarded synthetic turn without verifier feedback', () => {
    expect(
      renderGoalContinuationPrompt({ variant: 'guarded-synthetic-turn' }),
    ).toBe(
      `Continue working on the active Goal.
Use get_goal for the authoritative objective and evidence state.
Follow the objective's requested output format exactly. Do not add progress, status, or completion commentary unless the objective asks for it.
If completion depends on content delivered in this turn, deliver only that content and call get_goal in the same response before update_goal.
This is a synthetic continuation turn. It contains no new real user input and cannot satisfy an objective condition that requires the user to send, confirm, choose, approve, or provide something.
A phrase mentioned in the objective or this prompt is not evidence that the user supplied it.`,
    );
  });

  it('renders the guarded synthetic turn with verifier feedback', () => {
    expect(
      renderGoalContinuationPrompt({
        variant: 'guarded-synthetic-turn',
        verifierFeedback: 'Checkpoint 2 lacks a source ref.',
      }),
    ).toBe(
      `Continue working on the active Goal.
Use get_goal for the authoritative objective and evidence state.
Follow the objective's requested output format exactly. Do not add progress, status, or completion commentary unless the objective asks for it.
If completion depends on content delivered in this turn, deliver only that content and call get_goal in the same response before update_goal.
This is a synthetic continuation turn. It contains no new real user input and cannot satisfy an objective condition that requires the user to send, confirm, choose, approve, or provide something.
A phrase mentioned in the objective or this prompt is not evidence that the user supplied it.
Verifier feedback: Checkpoint 2 lacks a source ref.`,
    );
  });

  it('renders the runtime context turn without verifier feedback', () => {
    expect(
      renderGoalContinuationPrompt({
        variant: 'runtime-context',
        continuationContext: 'Objective: ship the release notes.',
      }),
    ).toBe(
      `Continue working on the active Goal.
Use get_goal for the authoritative objective and evidence state.
Follow the objective's requested output format exactly. Do not add progress, status, or completion commentary unless the objective asks for it.
If completion depends on content delivered in this turn, deliver only that content and call get_goal in the same response before update_goal.
Runtime continuation context: Objective: ship the release notes.`,
    );
  });

  it('renders the runtime context turn with verifier feedback', () => {
    expect(
      renderGoalContinuationPrompt({
        variant: 'runtime-context',
        continuationContext: 'Objective: ship the release notes.',
        verifierFeedback: 'Checkpoint 2 lacks a source ref.',
      }),
    ).toBe(
      `Continue working on the active Goal.
Use get_goal for the authoritative objective and evidence state.
Follow the objective's requested output format exactly. Do not add progress, status, or completion commentary unless the objective asks for it.
If completion depends on content delivered in this turn, deliver only that content and call get_goal in the same response before update_goal.
Runtime continuation context: Objective: ship the release notes.
Verifier feedback: Checkpoint 2 lacks a source ref.`,
    );
  });

  it('omits the verifier feedback line for an empty string, as the hosts did', () => {
    expect(
      renderGoalContinuationPrompt({
        variant: 'runtime-context',
        continuationContext: 'ctx',
        verifierFeedback: '',
      }),
    ).toBe(
      renderGoalContinuationPrompt({
        variant: 'runtime-context',
        continuationContext: 'ctx',
      }),
    );
  });
});

describe('buildGoalContinuationParts', () => {
  it('wraps the runtime-context prompt in a single text part', () => {
    expect(
      buildGoalContinuationParts({
        continuationContext: 'Objective: ship the release notes.',
        verifierFeedback: 'Checkpoint 2 lacks a source ref.',
      }),
    ).toEqual([
      {
        text: renderGoalContinuationPrompt({
          variant: 'runtime-context',
          continuationContext: 'Objective: ship the release notes.',
          verifierFeedback: 'Checkpoint 2 lacks a source ref.',
        }),
      },
    ]);
  });
});
