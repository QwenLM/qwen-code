/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_OUTPUT_STYLES,
  DEFAULT_OUTPUT_STYLE_TURN_REMINDER,
  applyOutputStyle,
  getBuiltInOutputStyle,
  getOutputStyleTurnReminder,
  renderOutputStyleSection,
  resolveEffectiveOutputStyle,
  type OutputStyleDefinition,
} from './output-styles.js';

const LAYERED: OutputStyleDefinition = {
  name: 'Layered',
  source: 'built-in',
  description: 'test style that keeps the coding instructions',
  keepCodingInstructions: true,
  prompt: 'Style body.',
};

const REPLACING: OutputStyleDefinition = {
  ...LAYERED,
  name: 'Replacing',
  keepCodingInstructions: false,
};

describe('built-in output styles', () => {
  it('ships the four documented styles', () => {
    expect(BUILT_IN_OUTPUT_STYLES.map((style) => style.name)).toEqual([
      'Concise',
      'Proactive',
      'Explanatory',
      'Learning',
    ]);
  });

  it('gives every style a description and a non-empty prompt', () => {
    for (const style of BUILT_IN_OUTPUT_STYLES) {
      expect(style.description.trim()).not.toBe('');
      expect(style.prompt.trim()).not.toBe('');
      expect(style.source).toBe('built-in');
    }
  });

  it('keeps the coding instructions for every built-in style', () => {
    // A built-in style refines how coding work is reported, so none of them
    // may drop the mandates and safety sections of the base prompt.
    for (const style of BUILT_IN_OUTPUT_STYLES) {
      expect(style.keepCodingInstructions).toBe(true);
    }
  });

  it('gives every style a turn reminder, generic or style-specific', () => {
    for (const style of BUILT_IN_OUTPUT_STYLES) {
      const reminder = getOutputStyleTurnReminder(style);
      expect(reminder.startsWith(`${style.name} output style is active.`)).toBe(
        true,
      );
      expect(reminder.trim()).not.toBe(`${style.name} output style is active.`);
    }
  });

  it('uses the style-specific reminder when one is defined', () => {
    const concise = getBuiltInOutputStyle('Concise')!;
    expect(concise.turnReminder).toBeDefined();
    expect(getOutputStyleTurnReminder(concise)).toBe(
      `Concise output style is active. ${concise.turnReminder}`,
    );
  });

  it('falls back to the generic reminder for a style without one', () => {
    const explanatory = getBuiltInOutputStyle('Explanatory')!;
    expect(explanatory.turnReminder).toBeUndefined();
    expect(getOutputStyleTurnReminder(explanatory)).toBe(
      `Explanatory output style is active. ${DEFAULT_OUTPUT_STYLE_TURN_REMINDER}`,
    );
  });

  it('falls back to the generic reminder for a style with an empty one', () => {
    // Style files arrive in the follow-up PR; an empty `turnReminder:` key
    // must not render a reminder with no guidance in it.
    expect(getOutputStyleTurnReminder({ ...LAYERED, turnReminder: '' })).toBe(
      `Layered output style is active. ${DEFAULT_OUTPUT_STYLE_TURN_REMINDER}`,
    );
  });

  it('has no duplicate names', () => {
    const names = BUILT_IN_OUTPUT_STYLES.map((style) =>
      style.name.toLowerCase(),
    );
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('getBuiltInOutputStyle', () => {
  it('resolves a style by exact name', () => {
    expect(getBuiltInOutputStyle('Concise')?.name).toBe('Concise');
  });

  it('resolves case-insensitively and ignores surrounding whitespace', () => {
    expect(getBuiltInOutputStyle('  eXpLaNaToRy ')?.name).toBe('Explanatory');
  });

  it('returns undefined for an unknown name', () => {
    expect(getBuiltInOutputStyle('nope')).toBeUndefined();
    expect(getBuiltInOutputStyle('')).toBeUndefined();
  });
});

describe('renderOutputStyleSection', () => {
  it('names the style with an Output Style heading', () => {
    expect(renderOutputStyleSection(LAYERED)).toBe(
      '# Output Style: Layered\nStyle body.',
    );
  });

  it('trims the prompt so the heading gap stays a single newline', () => {
    expect(
      renderOutputStyleSection({ ...LAYERED, prompt: '\n\nStyle body.\n\n' }),
    ).toBe('# Output Style: Layered\nStyle body.');
  });
});

describe('applyOutputStyle', () => {
  it('returns the base prompt unchanged when no style is active', () => {
    expect(applyOutputStyle('BASE', undefined)).toBe('BASE');
    expect(applyOutputStyle('BASE', null)).toBe('BASE');
  });

  it('appends the style section to the base prompt', () => {
    expect(applyOutputStyle('BASE', LAYERED)).toBe(
      'BASE\n\n# Output Style: Layered\nStyle body.',
    );
  });

  it('still appends when the style drops the coding instructions', () => {
    // keepCodingInstructions selects which sections the base was built from;
    // it never suppresses the style section itself.
    expect(applyOutputStyle('BASE', REPLACING)).toBe(
      'BASE\n\n# Output Style: Replacing\nStyle body.',
    );
  });
});

describe('resolveEffectiveOutputStyle', () => {
  const learning = getBuiltInOutputStyle('Learning')!;
  const concise = getBuiltInOutputStyle('Concise')!;

  it('returns undefined when no style is active', () => {
    expect(
      resolveEffectiveOutputStyle(undefined, 'interactive'),
    ).toBeUndefined();
    expect(resolveEffectiveOutputStyle(null, 'headless')).toBeUndefined();
  });

  it('drops Learning in headless mode, where its handoff can never be answered', () => {
    expect(resolveEffectiveOutputStyle(learning, 'headless')).toBeUndefined();
  });

  it('keeps Learning where a reply can arrive', () => {
    expect(resolveEffectiveOutputStyle(learning, 'interactive')).toBe(learning);
    expect(resolveEffectiveOutputStyle(learning, 'acp')).toBe(learning);
  });

  it('keeps every other style in every mode', () => {
    for (const mode of ['interactive', 'headless', 'acp'] as const) {
      expect(resolveEffectiveOutputStyle(concise, mode)).toBe(concise);
      expect(resolveEffectiveOutputStyle(LAYERED, mode)).toBe(LAYERED);
    }
  });
});
