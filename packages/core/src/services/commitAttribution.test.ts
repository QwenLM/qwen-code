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
    expect(computeCharContribution('Esc', 'esc')).toBe(1);
  });

  it('should handle insertion in the middle', () => {
    expect(computeCharContribution('ab', 'aXb')).toBe(1);
  });

  it('should handle deletion in the middle', () => {
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
    expect(computeCharContribution(old, now)).toBe(7); // "changed" > "line2"
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

  it('should track new file creation', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/src/file.ts', null, 'hello world');

    const attr = service.getFileAttribution('/project/src/file.ts');
    expect(attr!.aiCreated).toBe(true);
    expect(attr!.aiContribution).toBe(11);
    expect(attr!.contentHash).toBeTruthy();
  });

  it('should NOT treat empty existing file as new file creation', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/empty.ts', '', 'new content');

    const attr = service.getFileAttribution('/project/empty.ts');
    expect(attr!.aiCreated).toBe(false);
    expect(attr!.aiContribution).toBe(11);
  });

  it('should track edits with prefix/suffix algorithm', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/f.ts', 'Hello World', 'Hello world');
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

  it('should save session baseline on first edit', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/f.ts', 'original content', 'new content');

    // Baseline should have been saved from oldContent
    // We can verify indirectly: after clear, baseline is gone
    service.clearAttributions();
    expect(service.hasAttributions()).toBe(false);
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

  describe('prompt counting', () => {
    it('should track prompt counts', () => {
      const service = CommitAttributionService.getInstance();
      expect(service.getPromptCount()).toBe(0);

      service.incrementPromptCount();
      service.incrementPromptCount();
      service.incrementPromptCount();

      expect(service.getPromptCount()).toBe(3);
      expect(service.getPromptsSinceLastCommit()).toBe(3);
    });

    it('should reset prompts-since-commit counter on successful clear', () => {
      const service = CommitAttributionService.getInstance();
      service.incrementPromptCount();
      service.incrementPromptCount();
      service.clearAttributions(true);

      expect(service.getPromptCount()).toBe(2);
      expect(service.getPromptsSinceLastCommit()).toBe(0);
    });

    it('should NOT reset prompts-since-commit on failed clear', () => {
      const service = CommitAttributionService.getInstance();
      service.incrementPromptCount();
      service.incrementPromptCount();
      service.recordEdit('/project/f.ts', null, 'x');
      service.clearAttributions(false);

      // File data cleared, but prompt counter preserved
      expect(service.hasAttributions()).toBe(false);
      expect(service.getPromptCount()).toBe(2);
      expect(service.getPromptsSinceLastCommit()).toBe(2);
    });
  });

  describe('surface tracking', () => {
    it('should default to cli surface', () => {
      const service = CommitAttributionService.getInstance();
      expect(service.getSurface()).toBe('cli');
    });
  });

  describe('snapshot / restore', () => {
    it('should serialize and restore state', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/project/f.ts', null, 'hello');
      service.incrementPromptCount();
      service.incrementPromptCount();
      service.incrementPermissionPromptCount();

      const snapshot = service.toSnapshot();
      expect(snapshot.type).toBe('attribution-snapshot');
      expect(snapshot.promptCount).toBe(2);
      expect(snapshot.permissionPromptCount).toBe(1);
      expect(Object.keys(snapshot.fileStates)).toHaveLength(1);

      // Restore into a fresh instance
      CommitAttributionService.resetInstance();
      const restored = CommitAttributionService.getInstance();
      restored.restoreFromSnapshot(snapshot);

      expect(restored.getPromptCount()).toBe(2);
      expect(restored.getFileAttribution('/project/f.ts')!.aiContribution).toBe(
        5,
      );
    });
  });

  describe('generateNotePayload', () => {
    it('should compute real AI/human percentages', () => {
      const service = CommitAttributionService.getInstance();
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

      expect(note.files['src/main.ts']!.percent).toBe(50);
      expect(note.files['src/human.ts']!.percent).toBe(0);
      expect(note.summary.aiPercent).toBe(33);
      expect(note.summary.surfaces).toContain('cli');
      expect(note.surfaceBreakdown['cli']).toBeDefined();
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
      expect(note.excludedGenerated).toContain('package-lock.json');
      expect(note.excludedGenerated).toContain('dist/bundle.js');
    });

    it('should include promptCount', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/project/f.ts', null, 'code');
      service.incrementPromptCount();
      service.incrementPromptCount();

      const staged = makeStagedInfo(['f.ts'], { 'f.ts': 100 });
      const note = service.generateNotePayload(staged, '/project');
      expect(note.promptCount).toBe(2);
    });

    it('should sanitize internal model codenames', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/project/f.ts', null, 'x');
      const staged = makeStagedInfo(['f.ts'], { 'f.ts': 10 });

      expect(
        service.generateNotePayload(staged, '/project', 'qwen-72b').generator,
      ).toBe('Qwen-Coder');
      expect(
        service.generateNotePayload(staged, '/project', 'CustomAgent')
          .generator,
      ).toBe('CustomAgent');
    });
  });

  describe('generatePRAttribution', () => {
    it('should generate enhanced PR attribution text', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/project/src/main.ts', '', 'x'.repeat(200));
      service.incrementPromptCount();
      service.incrementPromptCount();
      service.incrementPromptCount();

      const staged = makeStagedInfo(['src/main.ts'], { 'src/main.ts': 200 });
      const text = service.generatePRAttribution(staged, '/project');

      expect(text).toContain('🤖 Generated with Qwen Code');
      expect(text).toContain('3-shotted');
      expect(text).toContain('Qwen-Coder');
    });

    it('should return default text when no data', () => {
      const service = CommitAttributionService.getInstance();
      const staged = makeStagedInfo([], {});
      const text = service.generatePRAttribution(staged, '/project');
      expect(text).toBe('🤖 Generated with Qwen Code');
    });
  });
});
