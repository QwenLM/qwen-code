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
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CommitAttributionService,
  computeCharContribution,
  type AttributionSnapshot,
  type FileAttribution,
  type StagedFileInfo,
} from './commitAttribution.js';

function makeStagedInfo(
  files: string[],
  diffSizes?: Record<string, number>,
  deleted?: string[],
  renamed?: Record<string, string>,
): StagedFileInfo {
  return {
    files,
    diffSizes: new Map(Object.entries(diffSizes ?? {})),
    deletedFiles: new Set(deleted ?? []),
    renamedFiles: new Map(Object.entries(renamed ?? {})),
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
  let service: CommitAttributionService;
  beforeEach(() => {
    CommitAttributionService.resetInstance();
    service = CommitAttributionService.getInstance();
  });
  const attr = (p: string) => service.getFileAttribution(p);
  const restore = (over: Partial<AttributionSnapshot>) =>
    service.restoreFromSnapshot({
      type: 'attribution-snapshot',
      surface: 'cli',
      fileStates: {},
      promptCount: 0,
      promptCountAtLastCommit: 0,
      ...over,
    });
  const fileState = (
    aiContribution: number,
    aiCreated: boolean,
    contentHash: string,
  ): FileAttribution => ({ aiContribution, aiCreated, contentHash });

  it('should return the same singleton instance', () => {
    const a = CommitAttributionService.getInstance();
    const b = CommitAttributionService.getInstance();
    expect(a).toBe(b);
  });

  it('should track new file creation', () => {
    service.recordEdit('/project/src/file.ts', null, 'hello world');
    expect(attr('/project/src/file.ts')!.aiCreated).toBe(true);
    expect(attr('/project/src/file.ts')!.aiContribution).toBe(11);
  });

  it('should NOT treat empty existing file as new file creation', () => {
    service.recordEdit('/project/empty.ts', '', 'new content');
    expect(attr('/project/empty.ts')!.aiCreated).toBe(false);
    expect(attr('/project/empty.ts')!.aiContribution).toBe(11);
  });

  it('should track edits with prefix/suffix algorithm', () => {
    service.recordEdit('/project/f.ts', 'Hello World', 'Hello world');
    expect(attr('/project/f.ts')!.aiContribution).toBe(1);
  });

  it('should accumulate contributions across multiple edits', () => {
    service.recordEdit('/project/f.ts', 'aaa', 'bbb'); // 3
    service.recordEdit('/project/f.ts', 'bbb', 'bbbccc'); // 3
    expect(attr('/project/f.ts')!.aiContribution).toBe(6);
  });

  // Out-of-band mutation: if `oldContent` doesn't match the contentHash of
  // AI's previous write, the file changed externally in between; drop the
  // accumulator so AI work the user has since overwritten isn't credited.
  it('should reset accumulator when oldContent diverges from AI last write', () => {
    service.recordEdit('/project/f.ts', 'abc', 'AI block of 100 chars padded');
    const after1 = attr('/project/f.ts')!;
    expect(after1.aiContribution).toBeGreaterThan(0);

    // The user paste-replaced the file in an external editor in between.
    service.recordEdit('/project/f.ts', 'user paste replacement', 'final');
    // Bounded by the divergent edit alone, not accumulated on after1.
    expect(attr('/project/f.ts')!.aiContribution).toBeLessThan(
      after1.aiContribution,
    );
  });

  // Fresh-file lifetime: AI re-creating a previously tracked, since-deleted
  // path (oldContent === null: nothing on disk) starts a new lifetime; the
  // deleted file's chars must not carry over and double-count.
  it('should reset accumulator when re-creating a previously-tracked deleted file', () => {
    service.recordEdit('/project/foo.ts', null, 'A'.repeat(100));
    const after1 = attr('/project/foo.ts')!;
    expect(after1.aiContribution).toBe(100);
    expect(after1.aiCreated).toBe(true);

    // Deleted (e.g. `rm foo.ts`), then re-created with shorter content.
    service.recordEdit('/project/foo.ts', null, 'short');
    const after2 = attr('/project/foo.ts')!;
    // Only the second write's chars (not 100 + 5); still a creation.
    expect(after2.aiContribution).toBe(5);
    expect(after2.aiCreated).toBe(true);
  });

  it('should NOT reset accumulator when oldContent matches AI last write', () => {
    service.recordEdit('/project/f.ts', 'abc', 'AI step one');
    const after1 = attr('/project/f.ts')!;
    // oldContent matches the post-first hash, so accumulation continues.
    service.recordEdit('/project/f.ts', 'AI step one', 'AI step two final');
    expect(attr('/project/f.ts')!.aiContribution).toBeGreaterThan(
      after1.aiContribution,
    );
  });

  // validateAgainst runs at commit time and drops entries whose recorded
  // post-write hash doesn't match the supplied content: catches user edits
  // made entirely outside Edit/Write (no recordEdit, so the input-hash
  // check above couldn't see them).
  describe('validateAgainst', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-validate-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    // Writes `onDisk` to tmpDir/name and records AI creating it with `ai`.
    function tracked(name: string, ai: string, onDisk = ai) {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, onDisk, 'utf-8');
      service.recordEdit(filePath, null, ai);
      return filePath;
    }

    it('drops entries whose content has diverged', () => {
      const filePath = tracked('diverged.ts', 'AI wrote this');
      expect(attr(filePath)).toBeDefined();
      service.validateAgainst(() => 'human replaced this');
      expect(attr(filePath)).toBeUndefined();
    });

    it('keeps entries whose content matches', () => {
      const filePath = tracked('unchanged.ts', 'AI wrote this');
      service.validateAgainst(() => 'AI wrote this');
      expect(attr(filePath)).toBeDefined();
    });

    it('keeps entries when getContent returns null (no comparison signal)', () => {
      const filePath = tracked('no-comparison.ts', 'will be queried');
      // null = "no committed blob / unreadable / out-of-scope": keep it.
      service.validateAgainst(() => null);
      expect(attr(filePath)).toBeDefined();
    });

    // BOM/CRLF normalisation: writeTextFile keeps the file's BOM and CRLF
    // choice regardless of AI's input string, so `git show` bytes can carry
    // a U+FEFF and CRLFs AI never wrote. The hash MUST canonicalise both
    // sides or every BOM/CRLF file is dropped on every commit.
    it('keeps entries when on-disk content has BOM but AI input did not', () => {
      // writeTextFile kept the BOM from the previous file version.
      const onDiskWithBom = '﻿export const foo = 42;';
      const filePath = tracked(
        'bom.ts',
        'export const foo = 42;',
        onDiskWithBom,
      );
      service.validateAgainst(() => onDiskWithBom);
      expect(attr(filePath)).toBeDefined();
    });

    it('keeps entries when on-disk uses CRLF but AI input used LF', () => {
      const onDiskCrlf = 'line one\r\nline two\r\n';
      const filePath = tracked('crlf.ts', 'line one\nline two\n', onDiskCrlf);
      service.validateAgainst(() => onDiskCrlf);
      expect(attr(filePath)).toBeDefined();
    });

    // The most common case: a Windows-edited file the model returned in
    // unix form (BOM + CRLF on disk, plain LF and no BOM from AI).
    it('keeps entries when on-disk has BOM AND CRLF, AI input had neither', () => {
      const onDisk = '﻿foo\r\nbar\r\n';
      const filePath = tracked('bom-crlf.ts', 'foo\nbar\n', onDisk);
      service.validateAgainst(() => onDisk);
      expect(attr(filePath)).toBeDefined();
    });

    // Legacy snapshot from before contentHash existed: empty contentHash
    // means no baseline to tell stale from fresh, so keep the entry even if
    // the reader returns different content.
    it('skips entries with empty contentHash (legacy snapshot)', () => {
      restore({ fileStates: { '/legacy.ts': fileState(50, false, '') } });
      service.validateAgainst(() => 'totally different');
      expect(attr('/legacy.ts')).toBeDefined();
    });

    // recordEdit canonicalises via realpathSync; after the leaf is unlinked
    // realpath throws, so realpathOrSelf canonicalises the parent and
    // rejoins the basename, keeping macOS /var ↔ /private/var lookups
    // working post-deletion.
    it('keeps deleted-file entries reachable via the original path', () => {
      const filePath = tracked('deleted.ts', 'will be deleted');
      fs.unlinkSync(filePath);
      expect(attr(filePath)).toBeDefined();
    });
  });

  it('should save session baseline on first edit', () => {
    service.recordEdit('/project/f.ts', 'original content', 'new content');
    // Baseline was saved from oldContent; verified indirectly: after clear,
    // it is gone.
    service.clearAttributions();
    expect(service.hasAttributions()).toBe(false);
  });

  it('should return defensive copies', () => {
    service.recordEdit('/project/f.ts', null, 'content');
    attr('/project/f.ts')!.aiContribution = 99999;
    expect(attr('/project/f.ts')!.aiContribution).not.toBe(99999);
  });

  describe('prompt counting', () => {
    it('should track prompt counts', () => {
      expect(service.getPromptCount()).toBe(0);

      service.incrementPromptCount();
      service.incrementPromptCount();
      service.incrementPromptCount();

      expect(service.getPromptCount()).toBe(3);
      expect(service.getPromptsSinceLastCommit()).toBe(3);
    });

    it('should reset prompts-since-commit counter on successful clear', () => {
      service.incrementPromptCount();
      service.incrementPromptCount();
      service.clearAttributions(true);

      expect(service.getPromptCount()).toBe(2);
      expect(service.getPromptsSinceLastCommit()).toBe(0);
    });

    it('should NOT reset prompts-since-commit on failed clear', () => {
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
      expect(service.getSurface()).toBe('cli');
    });
  });

  describe('snapshot / restore', () => {
    it('should serialize and restore state', () => {
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
      service.recordEdit('/project/f.ts', null, 'code');
      service.incrementPromptCount();
      service.incrementPromptCount();

      const staged = makeStagedInfo(['f.ts'], { 'f.ts': 100 });
      const note = service.generateNotePayload(staged, '/project');
      expect(note.promptCount).toBe(2);
    });

    it('should sanitize internal model codenames', () => {
      service.recordEdit('/project/f.ts', null, 'x');
      const staged = makeStagedInfo(['f.ts'], { 'f.ts': 10 });
      const generator = (model: string) =>
        service.generateNotePayload(staged, '/project', model).generator;

      expect(generator('qwen-72b')).toBe('Qwen-Coder');
      expect(generator('CustomAgent')).toBe('CustomAgent');
    });

    // AI chars count actual characters, but diffSize comes from `git diff
    // --stat` (~40 chars per changed line), so long-line edits leave aiChars
    // large while humanChars snaps to 0: aiChars + humanChars would exceed
    // the committed change magnitude without clamping.
    it('should clamp aiChars to diffSize so totals stay consistent', () => {
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

  // Paths are realpath'd at every entry/exit point so symlinked and
  // canonical forms collapse to one entry. On macOS (`/var` →
  // `/private/var`) edit.ts may record one form while git rev-parse reports
  // the other; without canonicalisation the lookup never matches and AI
  // attribution silently zeroes out.
  describe('symlink-aware path canonicalisation', () => {
    beforeEach(() => {
      // Map /var/... to /private/var/... (the macOS-ism); pass others through.
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
      service.recordEdit('/var/repo/src/main.ts', '', 'x'.repeat(50));
      // Either form works: both write and read are canonicalised.
      expect(attr('/var/repo/src/main.ts')).toBeDefined();
      expect(attr('/private/var/repo/src/main.ts')).toBeDefined();
    });

    it('matches diff paths when baseDir is the symlinked form', () => {
      service.recordEdit('/var/repo/src/main.ts', '', 'x'.repeat(80));

      // The loop canonicalises the symlinked baseDir before computing
      // path.relative against the (already-canonical) keys.
      const staged = makeStagedInfo(['src/main.ts'], { 'src/main.ts': 80 });
      const note = service.generateNotePayload(staged, '/var/repo');

      expect(note.files['src/main.ts']!.aiChars).toBe(80);
      expect(note.files['src/main.ts']!.percent).toBe(100);
    });

    it('clearAttributedFiles deletes by canonical key without realpath-ing the leaf', () => {
      service.recordEdit('/var/repo/src/deleted.ts', '', 'will be removed');
      expect(attr('/var/repo/src/deleted.ts')).toBeDefined();

      // Callers compose paths against a canonical baseDir (as
      // attachCommitAttribution does), so the leaf needn't exist.
      service.clearAttributedFiles(
        new Set(['/private/var/repo/src/deleted.ts']),
      );
      expect(attr('/var/repo/src/deleted.ts')).toBeUndefined();
    });

    it('moves attribution across committed renames before payload generation', () => {
      service.recordEdit('/var/repo/src/old.ts', '', 'renamed content');

      service.applyCommittedRenames(
        new Map([['src/old.ts', 'src/new.ts']]),
        '/private/var/repo',
      );

      expect(attr('/var/repo/src/old.ts')).toBeUndefined();
      expect(attr('/var/repo/src/new.ts')).toBeDefined();

      const staged = makeStagedInfo(['src/new.ts'], { 'src/new.ts': 80 }, [], {
        'src/old.ts': 'src/new.ts',
      });
      const note = service.generateNotePayload(staged, '/var/repo');
      expect(note.files['src/new.ts']!.aiChars).toBe(15);
      expect(note.files['src/new.ts']!.percent).toBe(19);
    });

    it('merges old-path attribution into an existing destination entry', () => {
      service.recordEdit('/var/repo/src/old.ts', '', 'old ai text');
      service.recordEdit('/var/repo/src/new.ts', '', 'new ai text');

      service.applyCommittedRenames(
        new Map([['src/old.ts', 'src/new.ts']]),
        '/private/var/repo',
      );

      expect(attr('/var/repo/src/new.ts')!.aiContribution).toBe(
        'old ai text'.length + 'new ai text'.length,
      );
      expect(attr('/var/repo/src/old.ts')).toBeUndefined();
    });

    it('canonicalises keys on snapshot restore', () => {
      // Snapshots written before the canonicalisation fix could carry either
      // form; restore normalises to canonical, so the canonical lookup works.
      restore({
        fileStates: { '/var/repo/src/legacy.ts': fileState(99, false, '') },
      });
      expect(attr('/private/var/repo/src/legacy.ts')!.aiContribution).toBe(99);
    });

    // A snapshot straddling the canonicalisation fix can carry both forms of
    // one file; once realpathOrSelf normalises them a plain `set()` would
    // let the second overwrite the first's aiContribution. Merge instead.
    it('merges duplicate entries collapsed by canonicalisation', () => {
      restore({
        fileStates: {
          '/var/repo/src/dup.ts': fileState(30, false, 'old'),
          '/private/var/repo/src/dup.ts': fileState(70, true, 'new'),
        },
      });

      const restored = attr('/private/var/repo/src/dup.ts')!;
      expect(restored.aiContribution).toBe(100);
      // aiCreated is OR'd: any form carrying true wins.
      expect(restored.aiCreated).toBe(true);
    });

    // A corrupted snapshot with promptCountAtLastCommit > promptCount would
    // surface a negative getPromptsSinceLastCommit() and a "(-3)-shotted"
    // trailer in PR text.
    it('clamps promptCountAtLastCommit to promptCount on restore', () => {
      restore({ promptCount: 5, promptCountAtLastCommit: 99 });
      expect(service.getPromptsSinceLastCommit()).toBe(0);
    });

    // `surface` lands verbatim in the git-notes payload and is a Map key;
    // non-strings would coerce to `[object Object]` etc. Fall back to the
    // current client surface.
    it.each([
      ['object', { foo: 'bar' }],
      ['number', 42],
      ['null', null],
      ['empty string', ''],
    ])(
      'falls back to client surface when snapshot.surface is non-string (%s)',
      (_label, badValue) => {
        restore({ surface: badValue as unknown as string });
        // getClientSurface() returns 'cli' in tests (no env var set).
        expect(service.getSurface()).toBe('cli');
      },
    );

    // Envelope-level corruption: a wrong `type` discriminator or non-object
    // top level must reset to a clean state instead of polluting
    // fileAttributions. The resume-time caller casts `unknown` to
    // AttributionSnapshot, so the runtime value could be anything.
    it.each([
      ['null', null],
      ['array', []],
      ['string', 'snapshot'],
      ['number', 42],
      ['wrong type discriminator', { type: 'something-else' }],
      ['missing type', { fileStates: {} }],
    ])(
      'resets to fresh state when snapshot envelope is malformed (%s)',
      (_label, badPayload) => {
        // Seed pre-existing state to confirm the reset clears it.
        service.recordEdit('/project/preexisting.ts', null, 'hello');
        expect(attr('/project/preexisting.ts')).toBeDefined();

        service.restoreFromSnapshot(
          badPayload as unknown as AttributionSnapshot,
        );
        expect(attr('/project/preexisting.ts')).toBeUndefined();
        expect(service.getSurface()).toBe('cli');
        expect(service.getPromptsSinceLastCommit()).toBe(0);
      },
    );

    // `fileStates` must be a plain object; Object.entries would otherwise
    // iterate an array's [index, value] pairs and seed numeric-string keys.
    it.each([
      ['array', []],
      ['string', 'oops'],
      ['number', 42],
      ['null', null],
    ])(
      'ignores non-object fileStates (%s) without polluting attribution map',
      (_label, badFileStates) => {
        restore({
          fileStates: badFileStates as unknown as Record<
            string,
            FileAttribution
          >,
        });
        expect(service.hasAttributions()).toBe(false);
      },
    );
  });
});
