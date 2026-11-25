/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES, PermissionModes } from '../manager/decision/index.js';
import {
  PERMISSION_MODE_CYCLE,
  getNextPermissionMode,
  isAcceptEditsMode,
  isAutoMode,
  isDefaultMode,
  isDontAskMode,
  isPlanStateBlockedByMode,
  isYoloMode,
  parsePermissionMode,
  resolveEffectiveMode,
} from './modes.js';
import {
  permissionModeColor,
  permissionModeShortTitle,
  permissionModeSymbol,
  permissionModeTitle,
} from './display.js';

describe('predicates', () => {
  it('each predicate accepts exactly its own mode', () => {
    const predicates = [
      [isDefaultMode, PermissionModes.Default],
      [isAcceptEditsMode, PermissionModes.AcceptEdits],
      [isAutoMode, PermissionModes.Auto],
      [isDontAskMode, PermissionModes.DontAsk],
      [isYoloMode, PermissionModes.Yolo],
    ] as const;

    for (const [predicate, own] of predicates) {
      for (const mode of PERMISSION_MODES) {
        expect(predicate(mode)).toBe(mode === own);
      }
    }
  });

  it('treats undefined as default', () => {
    expect(isDefaultMode(undefined)).toBe(true);
    expect(isAutoMode(undefined)).toBe(false);
  });

  it('blocks plan state only under dontAsk', () => {
    for (const mode of PERMISSION_MODES) {
      expect(isPlanStateBlockedByMode(mode)).toBe(
        mode === PermissionModes.DontAsk,
      );
    }
  });
});

describe('parsePermissionMode', () => {
  it('accepts every canonical name', () => {
    for (const mode of PERMISSION_MODES) {
      expect(parsePermissionMode(mode)).toBe(mode);
    }
  });

  it('accepts loose spellings of the same mode', () => {
    for (const spelling of [
      'acceptEdits',
      'accept-edits',
      'accept_edits',
      'ACCEPT EDITS',
    ]) {
      expect(parsePermissionMode(spelling)).toBe(PermissionModes.AcceptEdits);
    }
    expect(parsePermissionMode('DONT_ASK')).toBe(PermissionModes.DontAsk);
  });

  it('maps the historical names', () => {
    expect(parsePermissionMode('yolo')).toBe(PermissionModes.Yolo);
    expect(parsePermissionMode('bypass_permissions')).toBe(
      PermissionModes.Yolo,
    );
    expect(parsePermissionMode('accepting_edits')).toBe(
      PermissionModes.AcceptEdits,
    );
  });

  it('rejects plan and unknown input', () => {
    expect(parsePermissionMode('plan')).toBeUndefined();
    expect(parsePermissionMode('nonsense')).toBeUndefined();
    expect(parsePermissionMode('')).toBeUndefined();
    expect(parsePermissionMode(undefined)).toBeUndefined();
  });
});

describe('Shift+Tab cycle', () => {
  it('covers every mode exactly once', () => {
    expect([...PERMISSION_MODE_CYCLE].sort()).toEqual(
      [...PERMISSION_MODES].sort(),
    );
  });

  it('walks strict → permissive and wraps around', () => {
    expect(getNextPermissionMode(PermissionModes.DontAsk)).toBe(
      PermissionModes.Default,
    );
    expect(getNextPermissionMode(PermissionModes.Default)).toBe(
      PermissionModes.AcceptEdits,
    );
    expect(getNextPermissionMode(PermissionModes.AcceptEdits)).toBe(
      PermissionModes.Yolo,
    );
    expect(getNextPermissionMode(PermissionModes.Yolo)).toBe(
      PermissionModes.Auto,
    );
    expect(getNextPermissionMode(PermissionModes.Auto)).toBe(
      PermissionModes.DontAsk,
    );
  });

  it('restarts at default for unknown input', () => {
    expect(getNextPermissionMode(undefined)).toBe(PermissionModes.Default);
  });
});

describe('resolveEffectiveMode', () => {
  it('inherits the parent when the child declares nothing', () => {
    for (const parent of PERMISSION_MODES) {
      expect(resolveEffectiveMode(parent, undefined)).toBe(parent);
    }
  });

  it('lets a child of a default parent pick its own mode', () => {
    for (const child of PERMISSION_MODES) {
      expect(resolveEffectiveMode(PermissionModes.Default, child)).toBe(child);
    }
  });

  it('never lets a child override a parent that already decided', () => {
    const undemotable = [
      PermissionModes.DontAsk,
      PermissionModes.Yolo,
      PermissionModes.AcceptEdits,
      PermissionModes.Auto,
    ];
    for (const parent of undemotable) {
      for (const child of PERMISSION_MODES) {
        expect(resolveEffectiveMode(parent, child)).toBe(parent);
      }
    }
  });
});

describe('display', () => {
  it('gives every mode a title, short title and colour', () => {
    for (const mode of PERMISSION_MODES) {
      expect(permissionModeTitle(mode)).not.toBe('');
      expect(permissionModeShortTitle(mode)).not.toBe('');
      expect(permissionModeColor(mode)).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('marks the zero-popup modes with a symbol and the safe ones without', () => {
    for (const mode of [
      PermissionModes.Yolo,
      PermissionModes.DontAsk,
      PermissionModes.Auto,
    ]) {
      expect(permissionModeSymbol(mode)).not.toBe('');
    }
    expect(permissionModeSymbol(PermissionModes.Default)).toBe('');
    expect(permissionModeSymbol(PermissionModes.AcceptEdits)).toBe('');
  });

  it('falls back to default for undefined', () => {
    expect(permissionModeTitle(undefined)).toBe(
      permissionModeTitle(PermissionModes.Default),
    );
  });
});
