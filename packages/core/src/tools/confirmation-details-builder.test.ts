/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_WIRE_CONFIRMATION_DETAILS_BYTES,
  projectConfirmationDetailsForExternalUse,
} from './confirmation-details-builder.js';
import type { SerializableConfirmationDetails } from './confirmation-details.js';

function editDetails(overrides: {
  originalContent?: string | null;
  newContent?: string;
  fileDiff?: string;
}): SerializableConfirmationDetails {
  return {
    type: 'edit',
    title: 'Edit big.html',
    fileName: 'big.html',
    filePath: '/tmp/big.html',
    fileDiff: overrides.fileDiff ?? '--- a\n+++ b\n',
    originalContent:
      'originalContent' in overrides ? overrides.originalContent! : 'old body',
    newContent: overrides.newContent ?? 'new body',
    diffStat: {
      model_added_lines: 1,
      model_removed_lines: 1,
      model_added_chars: 8,
      model_removed_chars: 8,
      user_added_lines: 0,
      user_removed_lines: 0,
      user_added_chars: 0,
      user_removed_chars: 0,
    },
  };
}

function previewBeforeMarker(value: string): string {
  return value.split('\n... [')[0];
}

describe('projectConfirmationDetailsForExternalUse', () => {
  it('passes details through untouched within the budget', () => {
    const details = editDetails({});
    expect(projectConfirmationDetailsForExternalUse(details)).toBe(details);
  });

  it('passes undefined through', () => {
    expect(projectConfirmationDetailsForExternalUse(undefined)).toBeUndefined();
  });

  it('bounds edit details that exceed the budget', () => {
    const details = editDetails({
      originalContent: 'o'.repeat(400_000),
      newContent: 'n'.repeat(400_000),
      fileDiff: 'd'.repeat(400_000),
    });

    const projected = projectConfirmationDetailsForExternalUse(details);
    expect(projected).not.toBe(details);
    expect(projected.type).toBe('edit');
    if (projected.type !== 'edit') return;

    expect(projected.truncated).toBe(true);
    // Structural fields survive so hosts can still label the approval.
    expect(projected.fileName).toBe('big.html');
    expect(projected.filePath).toBe('/tmp/big.html');
    expect(projected.diffStat).toMatchObject({ model_added_lines: 1 });

    for (const field of [
      projected.fileDiff,
      projected.originalContent,
      projected.newContent,
    ]) {
      expect(field).not.toBeNull();
      expect(field).toContain('truncated for SDK transport');
      expect(Buffer.byteLength(field!, 'utf8')).toBeLessThan(128 * 1024);
    }

    const serialized = Buffer.byteLength(
      JSON.stringify(projected),
      'utf8',
    );
    expect(serialized).toBeLessThan(
      DEFAULT_MAX_WIRE_CONFIRMATION_DETAILS_BYTES,
    );
  });

  it('keeps a null originalContent null when projecting', () => {
    const details = editDetails({
      originalContent: null,
      newContent: 'n'.repeat(400_000),
    });
    const projected = projectConfirmationDetailsForExternalUse(details);
    if (projected?.type !== 'edit') throw new Error('expected edit details');
    expect(projected.originalContent).toBeNull();
    expect(projected.truncated).toBe(true);
  });

  it('leaves small fields untruncated when only one field is oversized', () => {
    const smallDiff = '--- a\n+++ b\n+new\n';
    const details = editDetails({
      originalContent: 'o'.repeat(400_000),
      fileDiff: smallDiff,
    });
    const projected = projectConfirmationDetailsForExternalUse(details);
    if (projected?.type !== 'edit') throw new Error('expected edit details');
    expect(projected.fileDiff).toBe(smallDiff);
    expect(projected.newContent).toBe('new body');
    expect(projected.originalContent).toContain('truncated for SDK transport');
  });

  it('does not split multi-byte code points at the cut', () => {
    const details = editDetails({
      originalContent: null,
      newContent: 'é'.repeat(200_000),
    });
    const projected = projectConfirmationDetailsForExternalUse(details);
    if (projected?.type !== 'edit') throw new Error('expected edit details');
    const preview = previewBeforeMarker(projected.newContent);
    expect(preview.length).toBeGreaterThan(0);
    expect(preview.charCodeAt(preview.length - 1)).not.toBe(0xfffd);
    // 2-byte chars: a 32 KiB byte cap holds 16 Ki chars, never a half char.
    expect(preview).toBe('é'.repeat(preview.length));
  });

  it('leaves over-budget non-edit details unchanged', () => {
    const details: SerializableConfirmationDetails = {
      type: 'exec',
      title: 'Run command',
      command: 'x'.repeat(400_000),
      rootCommand: 'x',
      rootCommands: ['x'],
    };
    expect(projectConfirmationDetailsForExternalUse(details)).toBe(details);
  });
});
