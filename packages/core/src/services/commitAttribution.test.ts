/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Stub `fs.realpathSync` so the symlink-aware tests below can simulate
// macOS-style `/var` ↔ `/private/var` mapping without needing a real
// symlink in the filesystem. Other tests don't touch realpath, so the
// pass-through default keeps them unaffected.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

import * as fs from 'node:fs';
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

      const snapshot = service.toSnapshot();
      expect(snapshot.type).toBe('attribution-snapshot');
      expect(snapshot.promptCount).toBe(2);
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

    // Long-line edits inflate the tracked AI char count (we count actual
    // characters), but diffSize comes from `git diff --stat` which
    // approximates each changed line as ~40 chars. Without clamping,
    // aiChars stays large while humanChars snaps to 0, leaving
    // aiChars+humanChars > the committed change magnitude.
    it('should clamp aiChars to diffSize so totals stay consistent', () => {
      const service = CommitAttributionService.getInstance();
      // Big AI edit but small reported diff (one long-line change).
      service.recordEdit('/project/src/big.ts', '', 'x'.repeat(1000));

      const staged = makeStagedInfo(['src/big.ts'], { 'src/big.ts': 40 });
      const note = service.generateNotePayload(staged, '/project');

      const detail = note.files['src/big.ts']!;
      expect(detail.aiChars).toBe(40);
      expect(detail.humanChars).toBe(0);
      // aiChars + humanChars now equals the reported diff size.
      expect(detail.aiChars + detail.humanChars).toBe(40);
      expect(note.summary.aiChars).toBe(40);
    });
  });

  // The service realpath's file paths at every entry/exit point so a
  // symlinked vs canonical absolute path collapses to one entry. This
  // matters most on macOS (`/var` → `/private/var`), where edit.ts
  // can record a path under one form while git rev-parse reports the
  // other — without canonicalisation, the lookup never matches and
  // AI attribution silently zeroes out.
  describe('symlink-aware path canonicalisation', () => {
    beforeEach(() => {
      // Map any /var/... input to /private/var/... (the macOS-ism).
      // Anything else passes through unchanged.
      vi.mocked(fs.realpathSync).mockImplementation(((input: unknown) => {
        const s = String(input);
        if (s.startsWith('/var/')) return s.replace('/var/', '/private/var/');
        if (s === '/var') return '/private/var';
        return s;
      }) as unknown as typeof fs.realpathSync);
    });
    afterEach(() => {
      vi.mocked(fs.realpathSync).mockReset();
    });

    it('records and looks up under the canonical path', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/var/repo/src/main.ts', '', 'x'.repeat(50));

      // Lookup with EITHER form should work — the service canonicalises
      // both write and read.
      expect(service.getFileAttribution('/var/repo/src/main.ts')).toBeDefined();
      expect(
        service.getFileAttribution('/private/var/repo/src/main.ts'),
      ).toBeDefined();
    });

    it('matches diff paths when baseDir is the symlinked form', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/var/repo/src/main.ts', '', 'x'.repeat(80));

      // generateNotePayload receives the symlinked baseDir; the loop
      // canonicalises it before computing path.relative against the
      // (already-canonical) keys.
      const staged = makeStagedInfo(['src/main.ts'], { 'src/main.ts': 80 });
      const note = service.generateNotePayload(staged, '/var/repo');

      expect(note.files['src/main.ts']!.aiChars).toBe(80);
      expect(note.files['src/main.ts']!.percent).toBe(100);
    });

    it('clearAttributedFiles deletes by canonical key without realpath-ing the leaf', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/var/repo/src/deleted.ts', '', 'will be removed');
      expect(
        service.getFileAttribution('/var/repo/src/deleted.ts'),
      ).toBeDefined();

      // Caller composes paths against a canonical baseDir (mirrors
      // attachCommitAttribution's pattern), so the leaf doesn't need
      // to exist for the delete to find the right key.
      service.clearAttributedFiles(
        new Set(['/private/var/repo/src/deleted.ts']),
      );
      expect(
        service.getFileAttribution('/var/repo/src/deleted.ts'),
      ).toBeUndefined();
    });

    it('canonicalises keys on snapshot restore', () => {
      const service = CommitAttributionService.getInstance();
      service.restoreFromSnapshot({
        type: 'attribution-snapshot',
        surface: 'cli',
        // Snapshot written before the canonicalisation fix could carry
        // either form; restore should normalise to canonical.
        fileStates: {
          '/var/repo/src/legacy.ts': {
            aiContribution: 99,
            aiCreated: false,
            contentHash: 'abc',
          },
        },
        baselines: {},
        promptCount: 0,
        promptCountAtLastCommit: 0,
      });

      // Lookup under the canonical form succeeds even though the
      // snapshot wrote the symlink form.
      expect(
        service.getFileAttribution('/private/var/repo/src/legacy.ts')!
          .aiContribution,
      ).toBe(99);
    });
  });
});
