/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_OUTPUT_STYLES,
  applyOutputStyle,
  getBuiltInOutputStyle,
  renderOutputStyleSection,
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

  it('attaches a turn reminder only to the behaviour-constraining styles', () => {
    const withReminder = BUILT_IN_OUTPUT_STYLES.filter(
      (style) => style.turnReminder,
    ).map((style) => style.name);
    expect(withReminder).toEqual(['Concise', 'Proactive']);
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
  it('renders the style under an active-style heading', () => {
    expect(renderOutputStyleSection(LAYERED)).toBe(
      '# Layered Style Active\n\nStyle body.',
    );
  });

  it('trims the prompt so the heading gap stays a single blank line', () => {
    expect(
      renderOutputStyleSection({ ...LAYERED, prompt: '\n\nStyle body.\n\n' }),
    ).toBe('# Layered Style Active\n\nStyle body.');
  });
});

describe('applyOutputStyle', () => {
  it('returns the base prompt unchanged when no style is active', () => {
    expect(applyOutputStyle('BASE', undefined)).toBe('BASE');
    expect(applyOutputStyle('BASE', null)).toBe('BASE');
  });

  it('appends a style that keeps the coding instructions', () => {
    expect(applyOutputStyle('BASE', LAYERED)).toBe(
      'BASE\n\n# Layered Style Active\n\nStyle body.',
    );
  });

  it('replaces the base prompt for a style that drops them', () => {
    expect(applyOutputStyle('BASE', REPLACING)).toBe(
      '# Replacing Style Active\n\nStyle body.',
    );
  });
});
