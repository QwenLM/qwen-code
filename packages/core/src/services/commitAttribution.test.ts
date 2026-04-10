/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommitAttributionService,
  computeCharContribution,
  type StagedFileInfo,
} from './commitAttribution.js';

// Helper to build StagedFileInfo from tracked files
function makeStagedInfo(
  files: string[],
  diffSizes?: Record<string, number>,
  deleted?: string[],
): StagedFileInfo {
  return {
    files,
    diffSizes: new Map(Object.entries(diffSizes ?? {})),
    deletedFiles: new Set(deleted ?? []),
  };
}

describe('computeCharContribution', () => {
  it('should return new content length for file creation', () => {
    expect(computeCharContribution('', 'hello world')).toBe(11);
  });

  it('should return old content length for file deletion', () => {
    expect(computeCharContribution('hello world', '')).toBe(11);
  });

  it('should handle same-length replacement via prefix/suffix', () => {
    // "Esc" → "esc" — only 1 char changed
    expect(computeCharContribution('Esc', 'esc')).toBe(1);
  });

  it('should handle insertion in the middle', () => {
    // "ab" → "aXb" — 1 char inserted
    expect(computeCharContribution('ab', 'aXb')).toBe(1);
  });

  it('should handle deletion in the middle', () => {
    // "aXb" → "ab" — 1 char deleted
    expect(computeCharContribution('aXb', 'ab')).toBe(1);
  });

  it('should handle complete replacement', () => {
    expect(computeCharContribution('abc', 'xyz')).toBe(3);
  });

  it('should return 0 for identical content', () => {
    expect(computeCharContribution('same', 'same')).toBe(0);
  });

  it('should handle multi-line changes', () => {
    const old = 'line1\nline2\nline3';
    const now = 'line1\nchanged\nline3';
    // common prefix = "line1\n" (6), common suffix = "\nline3" (6)
    // old changed = 17-6-6 = 5 ("line2"), new changed = 19-6-6 = 7 ("changed")
    expect(computeCharContribution(old, now)).toBe(7);
  });
});

describe('CommitAttributionService', () => {
  beforeEach(() => {
    CommitAttributionService.resetInstance();
  });

  it('should return the same singleton instance', () => {
    const a = CommitAttributionService.getInstance();
    const b = CommitAttributionService.getInstance();
    expect(a).toBe(b);
  });

  it('should start with no attributions', () => {
    const service = CommitAttributionService.getInstance();
    expect(service.hasAttributions()).toBe(false);
  });

  it('should track new file creation', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/src/file.ts', null, 'hello world');

    const attr = service.getFileAttribution('/project/src/file.ts');
    expect(attr).toBeDefined();
    expect(attr!.aiCreated).toBe(true);
    expect(attr!.aiContribution).toBe(11);
  });

  it('should NOT treat empty existing file as new file creation', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/empty.ts', '', 'new content');

    const attr = service.getFileAttribution('/project/empty.ts');
    expect(attr!.aiCreated).toBe(false);
    expect(attr!.aiContribution).toBe(11); // 'new content'.length
  });

  it('should track edits with prefix/suffix algorithm', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/f.ts', 'Hello World', 'Hello world');
    // Only 'W'→'w' changed: contribution = 1
    expect(service.getFileAttribution('/project/f.ts')!.aiContribution).toBe(1);
  });

  it('should accumulate contributions across multiple edits', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/f.ts', 'aaa', 'bbb'); // 3
    service.recordEdit('/project/f.ts', 'bbb', 'bbbccc'); // 3
    expect(service.getFileAttribution('/project/f.ts')!.aiContribution).toBe(6);
  });

  it('should record deletions', () => {
    const service = CommitAttributionService.getInstance();
    service.recordDeletion('/project/old.ts', 500);
    expect(service.getFileAttribution('/project/old.ts')!.aiContribution).toBe(
      500,
    );
  });

  it('should return defensive copies', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/f.ts', null, 'content');

    const copy = service.getFileAttribution('/project/f.ts')!;
    copy.aiContribution = 99999;

    expect(
      service.getFileAttribution('/project/f.ts')!.aiContribution,
    ).not.toBe(99999);
  });

  it('should clear attributions', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/f.ts', null, 'content');
    service.clearAttributions();
    expect(service.hasAttributions()).toBe(false);
  });

  describe('generateNotePayload', () => {
    it('should compute real AI/human percentages from staged info', () => {
      const service = CommitAttributionService.getInstance();
      // AI edited this file, contributing 200 chars
      service.recordEdit('/project/src/main.ts', '', 'x'.repeat(200));

      const staged = makeStagedInfo(['src/main.ts', 'src/human.ts'], {
        'src/main.ts': 400,
        'src/human.ts': 200,
      });

      const note = service.generateNotePayload(
        staged,
        '/project',
        'Qwen-Coder',
      );

      // main.ts: AI=200, human=max(0,400-200)=200 → 50%
      expect(note.files['src/main.ts']).toEqual({
        aiChars: 200,
        humanChars: 200,
        percent: 50,
      });

      // human.ts: not tracked → AI=0, human=200 → 0%
      expect(note.files['src/human.ts']).toEqual({
        aiChars: 0,
        humanChars: 200,
        percent: 0,
      });

      // Overall: AI=200, human=400 → 33%
      expect(note.summary.aiPercent).toBe(33);
      expect(note.summary.aiChars).toBe(200);
      expect(note.summary.humanChars).toBe(400);
    });

    it('should exclude generated files', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/project/src/main.ts', null, 'code');

      const staged = makeStagedInfo(
        ['src/main.ts', 'package-lock.json', 'dist/bundle.js'],
        {
          'src/main.ts': 100,
          'package-lock.json': 50000,
          'dist/bundle.js': 30000,
        },
      );

      const note = service.generateNotePayload(staged, '/project');

      expect(Object.keys(note.files)).toHaveLength(1);
      expect(note.files['src/main.ts']).toBeDefined();
      expect(note.excludedGenerated).toContain('package-lock.json');
      expect(note.excludedGenerated).toContain('dist/bundle.js');
    });

    it('should handle deleted files (human deletion)', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/project/src/keep.ts', null, 'code');

      const staged = makeStagedInfo(
        ['src/keep.ts', 'src/removed.ts'],
        { 'src/keep.ts': 100, 'src/removed.ts': 200 },
        ['src/removed.ts'],
      );

      const note = service.generateNotePayload(staged, '/project');
      // removed.ts: untracked deletion → human=200
      expect(note.files['src/removed.ts']!.humanChars).toBe(200);
      expect(note.files['src/removed.ts']!.aiChars).toBe(0);
    });

    it('should handle deleted files (AI deletion)', () => {
      const service = CommitAttributionService.getInstance();
      service.recordDeletion('/project/src/removed.ts', 300);

      const staged = makeStagedInfo(
        ['src/removed.ts'],
        { 'src/removed.ts': 400 },
        ['src/removed.ts'],
      );

      const note = service.generateNotePayload(staged, '/project');
      expect(note.files['src/removed.ts']!.aiChars).toBe(300);
    });

    it('should sanitize internal model codenames', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/project/f.ts', null, 'x');

      const staged = makeStagedInfo(['f.ts'], { 'f.ts': 10 });

      expect(
        service.generateNotePayload(staged, '/project', 'qwen-72b').generator,
      ).toBe('Qwen-Coder');
      expect(
        service.generateNotePayload(staged, '/project', 'qwen-max').generator,
      ).toBe('Qwen-Coder');
      expect(
        service.generateNotePayload(staged, '/project', 'CustomAgent')
          .generator,
      ).toBe('CustomAgent');
    });

    it('should convert absolute paths to relative', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/home/user/project/src/main.ts', null, 'code');

      const staged = makeStagedInfo(['src/main.ts'], { 'src/main.ts': 100 });
      const note = service.generateNotePayload(staged, '/home/user/project');

      expect(Object.keys(note.files)).toContain('src/main.ts');
    });
  });
});
