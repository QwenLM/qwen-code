/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  authoredSkillName,
  qualifySkillName,
  skillRestrictionNames,
} from './types.js';

describe('extension skill qualified names', () => {
  it('spells an extension skill as <extensionName>:<authoredName>', () => {
    expect(qualifySkillName('rust', 'functions')).toBe('rust:functions');
    // `rust:chat` authored inside `rust` is concatenated, never parsed:
    // the result is `rust:rust:chat`, not `rust:chat`.
    expect(qualifySkillName('rust', 'rust:chat')).toBe('rust:rust:chat');
  });

  it('reads the authored spelling back, falling back to name', () => {
    expect(authoredSkillName({ name: 'rust:pdf', authoredName: 'pdf' })).toBe(
      'pdf',
    );
    // The manifest's own rows and every non-extension skill carry no
    // `authoredName`; a call site that forgot this fallback stops matching them.
    expect(authoredSkillName({ name: 'pdf' })).toBe('pdf');
  });

  it('names a restriction by both spellings when they differ', () => {
    expect(
      skillRestrictionNames({ name: 'rust:pdf', authoredName: 'pdf' }),
    ).toEqual(['rust:pdf', 'pdf']);
  });

  it('names a restriction once when there is one spelling', () => {
    expect(skillRestrictionNames({ name: 'pdf' })).toEqual(['pdf']);
    expect(skillRestrictionNames({ name: 'pdf', authoredName: 'pdf' })).toEqual(
      ['pdf'],
    );
  });

  it('normalizes the spellings it returns for matching', () => {
    expect(
      skillRestrictionNames({ name: 'Rust:PDF', authoredName: ' PDF ' }),
    ).toEqual(['rust:pdf', 'pdf']);
    // Normalizing before de-duplicating, so a case-only difference is one
    // spelling rather than a two-element array of the same entry.
    expect(skillRestrictionNames({ name: 'pdf', authoredName: 'PDF' })).toEqual(
      ['pdf'],
    );
  });

  it('keeps an authored name that itself contains the separator', () => {
    // `rust:chat` authored inside `rust` registers as `rust:rust:chat`.
    // Matching `chat` would require stripping the prefix, which is forbidden
    // because `:` is a legal skill-name character.
    expect(
      skillRestrictionNames({
        name: 'rust:rust:chat',
        authoredName: 'rust:chat',
      }),
    ).toEqual(['rust:rust:chat', 'rust:chat']);
  });
});
