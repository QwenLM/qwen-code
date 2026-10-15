/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { levelLabel, skillOriginLabel } from './skill-level-label.js';

describe('levelLabel', () => {
  it('names each level', () => {
    expect(levelLabel('project')).toBe('Project');
    expect(levelLabel('user')).toBe('User');
    expect(levelLabel('extension')).toBe('Extension');
    expect(levelLabel('bundled')).toBe('Bundled');
  });
});

describe('skillOriginLabel', () => {
  it('names the owning extension for an extension skill', () => {
    expect(
      skillOriginLabel({
        level: 'extension',
        extensionDisplayName: 'Rust',
        extensionName: 'rust',
      }),
    ).toBe('(Extension: Rust)');
  });

  it('falls back to the extension id when no display name is set', () => {
    expect(
      skillOriginLabel({ level: 'extension', extensionName: 'rust' }),
    ).toBe('(Extension: rust)');
  });

  it('keeps the level word for every other level', () => {
    // The level is what tells the reader the prefix was assigned by the loader
    // rather than authored by a human.
    expect(skillOriginLabel({ level: 'bundled' })).toBe('(Bundled)');
    expect(skillOriginLabel({ level: 'project' })).toBe('(Project)');
    expect(skillOriginLabel({ level: 'user' })).toBe('(User)');
  });

  it('does not name an owner for a skill that has no extension', () => {
    // A stale `extensionDisplayName` on a non-extension row must not leak into
    // the label — the level, not the presence of the field, decides.
    expect(
      skillOriginLabel({
        level: 'user',
        extensionName: 'rust',
        extensionDisplayName: 'Rust',
      }),
    ).toBe('(User)');
  });

  it('never recovers the owner from the skill name', () => {
    // `:` is legal inside an authored skill name, so `rust:chat` inside the
    // `rust` extension has no owner to reparse; only the stored fields count.
    expect(skillOriginLabel({ level: 'extension', name: 'rust:chat' })).toBe(
      '(Extension: unknown)',
    );
  });
});
