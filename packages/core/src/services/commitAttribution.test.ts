/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CommitAttributionService } from './commitAttribution.js';

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
    expect(service.getAttributions().size).toBe(0);
  });

  it('should track new file creation', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/path/to/file.ts', null, 'hello world');

    expect(service.hasAttributions()).toBe(true);
    const attr = service.getFileAttribution('/path/to/file.ts');
    expect(attr).toBeDefined();
    expect(attr!.aiCreated).toBe(true);
    expect(attr!.aiCharsAdded).toBe(11); // 'hello world'.length
  });

  it('should NOT treat empty existing file as new file creation', () => {
    const service = CommitAttributionService.getInstance();
    // oldContent = '' means the file existed but was empty
    service.recordEdit('/path/to/empty.ts', '', 'new content');

    const attr = service.getFileAttribution('/path/to/empty.ts');
    expect(attr).toBeDefined();
    expect(attr!.aiCreated).toBe(false);
    expect(attr!.aiCharsAdded).toBeGreaterThan(0);
  });

  it('should track edits to existing files', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/path/to/file.ts', 'old line\n', 'new line\nextra\n');

    const attr = service.getFileAttribution('/path/to/file.ts');
    expect(attr).toBeDefined();
    expect(attr!.aiCreated).toBe(false);
    expect(attr!.aiCharsAdded).toBeGreaterThan(0);
    expect(attr!.aiCharsRemoved).toBeGreaterThan(0);
  });

  it('should accumulate multiple edits to the same file', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/path/to/file.ts', 'aaa\n', 'bbb\n');
    service.recordEdit('/path/to/file.ts', 'bbb\n', 'ccc\nddd\n');

    const attr = service.getFileAttribution('/path/to/file.ts');
    expect(attr).toBeDefined();
    expect(attr!.aiCharsAdded).toBeGreaterThan(0);
  });

  it('should track multiple files independently', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/a.ts', null, 'content a');
    service.recordEdit('/b.ts', 'old', 'new');

    expect(service.getAttributions().size).toBe(2);
    expect(service.getFileAttribution('/a.ts')!.aiCreated).toBe(true);
    expect(service.getFileAttribution('/b.ts')!.aiCreated).toBe(false);
  });

  it('should clear attributions', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/file.ts', null, 'content');
    expect(service.hasAttributions()).toBe(true);

    service.clearAttributions();
    expect(service.hasAttributions()).toBe(false);
  });

  it('should return defensive copies from getFileAttribution', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/file.ts', null, 'content');

    const copy = service.getFileAttribution('/file.ts')!;
    copy.aiCharsAdded = 99999;

    // Internal state should be unaffected
    const fresh = service.getFileAttribution('/file.ts')!;
    expect(fresh.aiCharsAdded).not.toBe(99999);
  });

  describe('generateNotePayload', () => {
    it('should generate valid note payload', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/src/main.ts', null, 'console.log("hello");\n');
      service.recordEdit('/src/util.ts', 'old code\n', 'new code\nmore\n');

      const note = service.generateNotePayload('Qwen-Coder');
      expect(note.version).toBe(1);
      expect(note.generator).toBe('Qwen-Coder');
      expect(Object.keys(note.files)).toHaveLength(2);
      expect(note.summary.totalFilesTouched).toBe(2);
      expect(note.summary.totalAiCharsAdded).toBeGreaterThan(0);
    });

    it('should convert absolute paths to relative paths when baseDir is provided', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/home/user/project/src/main.ts', null, 'code');

      const note = service.generateNotePayload(
        'Qwen-Coder',
        '/home/user/project',
      );
      const filePaths = Object.keys(note.files);
      expect(filePaths).toHaveLength(1);
      expect(filePaths[0]).toBe('src/main.ts');
    });

    it('should keep absolute paths when baseDir is not provided', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/home/user/project/src/main.ts', null, 'code');

      const note = service.generateNotePayload('Qwen-Coder');
      const filePaths = Object.keys(note.files);
      expect(filePaths[0]).toBe('/home/user/project/src/main.ts');
    });

    it('should sanitize internal model codenames', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/file.ts', null, 'x');

      expect(service.generateNotePayload('qwen-72b').generator).toBe(
        'Qwen-Coder',
      );
      expect(service.generateNotePayload('qwen_coder_2.5').generator).toBe(
        'Qwen-Coder',
      );
      expect(service.generateNotePayload('qwen-max').generator).toBe(
        'Qwen-Coder',
      );
      expect(service.generateNotePayload('qwen-turbo').generator).toBe(
        'Qwen-Coder',
      );
    });

    it('should not sanitize non-internal names', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/file.ts', null, 'x');

      expect(service.generateNotePayload('CustomAgent').generator).toBe(
        'CustomAgent',
      );
    });
  });
});
