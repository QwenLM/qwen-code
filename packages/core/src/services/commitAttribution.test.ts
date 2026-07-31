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

  // Out-of-band mutation detection: if the input `oldContent` doesn't
  // match the contentHash AI recorded after its previous edit, the
  // file was changed externally between AI's two writes — drop the
  // accumulator before counting the new edit so prior AI work the
  // user has since overwritten doesn't get credited later.
  it('should reset accumulator when oldContent diverges from AI last write', () => {
    const service = CommitAttributionService.getInstance();
    // First AI edit: file goes from 'abc' to 'AI block of 100 chars padded' (28 chars).
    const aiBlock = 'AI block of 100 chars padded';
    service.recordEdit('/project/f.ts', 'abc', aiBlock);
    const after1 = service.getFileAttribution('/project/f.ts')!;
    expect(after1.aiContribution).toBeGreaterThan(0);

    // Now a DIFFERENT oldContent shows up — the user paste-replaced
    // the file via an external editor in between. AI's recordEdit
    // should reset the counter before applying the new contribution.
    service.recordEdit('/project/f.ts', 'user paste replacement', 'final');
    const after2 = service.getFileAttribution('/project/f.ts')!;
    // aiContribution is now bounded by the divergent edit alone, NOT
    // accumulated on top of after1.aiContribution.
    expect(after2.aiContribution).toBeLessThan(after1.aiContribution);
  });

  // Fresh-file lifetime: when AI re-creates a file at a path that was
  // previously tracked but has since been deleted (oldContent === null
  // signals "no file existed on disk"), the previous tracked state is
  // from a different file lifetime. Without this reset, AI's
  // accumulated chars from the deleted file would carry over and
  // double-count toward the new file's attribution.
  it('should reset accumulator when re-creating a previously-tracked deleted file', () => {
    const service = CommitAttributionService.getInstance();
    // First lifetime: AI creates 'foo.ts' with 100 chars of content.
    const firstContent = 'A'.repeat(100);
    service.recordEdit('/project/foo.ts', null, firstContent);
    const after1 = service.getFileAttribution('/project/foo.ts')!;
    expect(after1.aiContribution).toBe(100);
    expect(after1.aiCreated).toBe(true);

    // Second lifetime: file was deleted (e.g. user `rm foo.ts`), then
    // AI re-creates it with new (shorter) content. oldContent=null
    // signals "didn't exist on disk before this write".
    const secondContent = 'short';
    service.recordEdit('/project/foo.ts', null, secondContent);
    const after2 = service.getFileAttribution('/project/foo.ts')!;
    // aiContribution should reflect ONLY the second write's chars, not
    // 100 + 5. aiCreated stays true (this lifetime is also a creation).
    expect(after2.aiContribution).toBe(5);
    expect(after2.aiCreated).toBe(true);
  });

  it('should NOT reset accumulator when oldContent matches AI last write', () => {
    const service = CommitAttributionService.getInstance();
    service.recordEdit('/project/f.ts', 'abc', 'AI step one');
    const after1 = service.getFileAttribution('/project/f.ts')!;
    // Second AI edit picks up where the first left off — oldContent
    // matches the post-first hash, so accumulation continues.
    service.recordEdit('/project/f.ts', 'AI step one', 'AI step two final');
    const after2 = service.getFileAttribution('/project/f.ts')!;
    expect(after2.aiContribution).toBeGreaterThan(after1.aiContribution);
  });

  // validateAgainst runs at commit time and drops entries whose
  // recorded post-write hash doesn't match the caller-supplied
  // content — catches user edits that happened entirely outside the
  // Edit/Write tools (no recordEdit was called, so the input-hash
  // check above couldn't see the divergence).
  describe('validateAgainst', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-validate-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('drops entries whose content has diverged', () => {
      const service = CommitAttributionService.getInstance();
      const filePath = path.join(tmpDir, 'diverged.ts');
      fs.writeFileSync(filePath, 'AI wrote this', 'utf-8');
      service.recordEdit(filePath, null, 'AI wrote this');
      expect(service.getFileAttribution(filePath)).toBeDefined();

      // Caller passes a reader that returns the diverged content.
      service.validateAgainst(() => 'human replaced this');
      expect(service.getFileAttribution(filePath)).toBeUndefined();
    });

    it('keeps entries whose content matches', () => {
      const service = CommitAttributionService.getInstance();
      const filePath = path.join(tmpDir, 'unchanged.ts');
      fs.writeFileSync(filePath, 'AI wrote this', 'utf-8');
      service.recordEdit(filePath, null, 'AI wrote this');
      service.validateAgainst(() => 'AI wrote this');
      expect(service.getFileAttribution(filePath)).toBeDefined();
    });

    it('keeps entries when getContent returns null (no comparison signal)', () => {
      const service = CommitAttributionService.getInstance();
      const filePath = path.join(tmpDir, 'no-comparison.ts');
      fs.writeFileSync(filePath, 'will be queried', 'utf-8');
      service.recordEdit(filePath, null, 'will be queried');
      // null = "no committed blob / unreadable / out-of-scope" — the
      // entry should NOT be dropped.
      service.validateAgainst(() => null);
      expect(service.getFileAttribution(filePath)).toBeDefined();
    });

    // BOM/CRLF normalisation: writeTextFile preserves the file's BOM
    // and CRLF line-ending choice independently of whether AI's
    // recordEdit input string contained the BOM char or used LF. The
    // on-disk bytes returned by `git show` can therefore include a
    // leading U+FEFF and CRLFs that AI never wrote — the hash MUST
    // canonicalise both sides so a BOM/CRLF file isn't dropped on
    // every commit.
    it('keeps entries when on-disk content has BOM but AI input did not', () => {
      const service = CommitAttributionService.getInstance();
      const filePath = path.join(tmpDir, 'bom.ts');
      // Simulate the on-disk file having a BOM (writeTextFile wrote
      // it because the previous file version had one).
      const aiContent = 'export const foo = 42;';
      const onDiskWithBom = '﻿' + aiContent;
      fs.writeFileSync(filePath, onDiskWithBom, 'utf-8');
      service.recordEdit(filePath, null, aiContent);

      // Reader returns the on-disk content (with BOM). After
      // canonicalisation, both sides hash to the same value.
      service.validateAgainst(() => onDiskWithBom);
      expect(service.getFileAttribution(filePath)).toBeDefined();
    });

    it('keeps entries when on-disk uses CRLF but AI input used LF', () => {
      const service = CommitAttributionService.getInstance();
      const filePath = path.join(tmpDir, 'crlf.ts');
      const aiContent = 'line one\nline two\n';
      const onDiskCrlf = 'line one\r\nline two\r\n';
      fs.writeFileSync(filePath, onDiskCrlf, 'utf-8');
      service.recordEdit(filePath, null, aiContent);
      service.validateAgainst(() => onDiskCrlf);
      expect(service.getFileAttribution(filePath)).toBeDefined();
    });

    // Combined: BOM + CRLF on disk, plain LF + no BOM in AI input.
    // The most common case for a Windows-edited file the model
    // returned in unix form.
    it('keeps entries when on-disk has BOM AND CRLF, AI input had neither', () => {
      const service = CommitAttributionService.getInstance();
      const filePath = path.join(tmpDir, 'bom-crlf.ts');
      const aiContent = 'foo\nbar\n';
      const onDisk = '﻿foo\r\nbar\r\n';
      fs.writeFileSync(filePath, onDisk, 'utf-8');
      service.recordEdit(filePath, null, aiContent);
      service.validateAgainst(() => onDisk);
      expect(service.getFileAttribution(filePath)).toBeDefined();
    });

    // Legacy snapshot from before contentHash existed: the entry has
    // an empty contentHash. We can't tell stale from fresh, so leave
    // it alone (don't reset).
    it('skips entries with empty contentHash (legacy snapshot)', () => {
      const service = CommitAttributionService.getInstance();
      service.restoreFromSnapshot({
        type: 'attribution-snapshot',
        surface: 'cli',
        fileStates: {
          '/legacy.ts': {
            aiContribution: 50,
            aiCreated: false,
            contentHash: '',
          },
        },
        promptCount: 0,
        promptCountAtLastCommit: 0,
      });
      // Even if the reader claims a different hash, an empty recorded
      // hash means we have no baseline — keep the entry.
      service.validateAgainst(() => 'totally different');
      expect(service.getFileAttribution('/legacy.ts')).toBeDefined();
    });

    // Deleted-file lookup must remain stable: recordEdit canonicalises
    // the path via realpathSync; getFileAttribution must still resolve
    // the same canonical key after the leaf is unlinked. realpathOrSelf
    // canonicalises the parent and rejoins the basename for missing
    // leaves so macOS /var ↔ /private/var doesn't break the lookup
    // post-deletion.
    it('keeps deleted-file entries reachable via the original path', () => {
      const service = CommitAttributionService.getInstance();
      const filePath = path.join(tmpDir, 'deleted.ts');
      fs.writeFileSync(filePath, 'will be deleted', 'utf-8');
      service.recordEdit(filePath, null, 'will be deleted');
      fs.unlinkSync(filePath);
      // Lookup must still find the entry by the original path even
      // though realpath of the leaf now throws.
      expect(service.getFileAttribution(filePath)).toBeDefined();
    });
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

    it('moves attribution across committed renames before payload generation', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/var/repo/src/old.ts', '', 'renamed content');

      service.applyCommittedRenames(
        new Map([['src/old.ts', 'src/new.ts']]),
        '/private/var/repo',
      );

      expect(
        service.getFileAttribution('/var/repo/src/old.ts'),
      ).toBeUndefined();
      expect(service.getFileAttribution('/var/repo/src/new.ts')).toBeDefined();

      const staged = makeStagedInfo(['src/new.ts'], { 'src/new.ts': 80 }, [], {
        'src/old.ts': 'src/new.ts',
      });
      const note = service.generateNotePayload(staged, '/var/repo');
      expect(note.files['src/new.ts']!.aiChars).toBe(15);
      expect(note.files['src/new.ts']!.percent).toBe(19);
    });

    it('merges old-path attribution into an existing destination entry', () => {
      const service = CommitAttributionService.getInstance();
      service.recordEdit('/var/repo/src/old.ts', '', 'old ai text');
      service.recordEdit('/var/repo/src/new.ts', '', 'new ai text');

      service.applyCommittedRenames(
        new Map([['src/old.ts', 'src/new.ts']]),
        '/private/var/repo',
      );

      const attr = service.getFileAttribution('/var/repo/src/new.ts')!;
      expect(attr.aiContribution).toBe(
        'old ai text'.length + 'new ai text'.length,
      );
      expect(
        service.getFileAttribution('/var/repo/src/old.ts'),
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
            contentHash: '',
          },
        },
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

    // A snapshot straddling the canonicalisation fix can carry both
    // the symlinked and canonical paths for the same file. After
    // realpathOrSelf normalises them, the second entry to land
    // would overwrite the first if we just `set()` — losing the
    // first form's accumulated aiContribution. Merge instead.
    it('merges duplicate entries collapsed by canonicalisation', () => {
      const service = CommitAttributionService.getInstance();
      service.restoreFromSnapshot({
        type: 'attribution-snapshot',
        surface: 'cli',
        fileStates: {
          '/var/repo/src/dup.ts': {
            aiContribution: 30,
            aiCreated: false,
            contentHash: 'old',
          },
          '/private/var/repo/src/dup.ts': {
            aiContribution: 70,
            aiCreated: true,
            contentHash: 'new',
          },
        },
        promptCount: 0,
        promptCountAtLastCommit: 0,
      });

      const restored = service.getFileAttribution(
        '/private/var/repo/src/dup.ts',
      )!;
      expect(restored.aiContribution).toBe(100);
      // aiCreated is OR'd: any form carrying true wins.
      expect(restored.aiCreated).toBe(true);
    });

    // A corrupted snapshot with promptCountAtLastCommit > promptCount
    // would surface a negative `getPromptsSinceLastCommit()` and
    // propagate as a "(-3)-shotted" trailer into PR text.
    it('clamps promptCountAtLastCommit to promptCount on restore', () => {
      const service = CommitAttributionService.getInstance();
      service.restoreFromSnapshot({
        type: 'attribution-snapshot',
        surface: 'cli',
        fileStates: {},
        promptCount: 5,
        promptCountAtLastCommit: 99,
      });
      expect(service.getPromptsSinceLastCommit()).toBe(0);
    });

    // `surface` lands verbatim in the git-notes payload and is used
    // as a Map key. Non-string values would coerce into
    // `[object Object]` etc. Fall back to the current client surface.
    it.each([
      ['object', { foo: 'bar' }],
      ['number', 42],
      ['null', null],
      ['empty string', ''],
    ])(
      'falls back to client surface when snapshot.surface is non-string (%s)',
      (_label, badValue) => {
        const service = CommitAttributionService.getInstance();
        service.restoreFromSnapshot({
          type: 'attribution-snapshot',
          surface: badValue as unknown as string,
          fileStates: {},
          promptCount: 0,
          promptCountAtLastCommit: 0,
        });
        // getClientSurface() returns 'cli' in tests (no env var set).
        expect(service.getSurface()).toBe('cli');
      },
    );

    // Envelope-level corruption: a payload whose `type` discriminator
    // is wrong (or whose top-level shape is non-object) must reset to
    // a clean state instead of polluting fileAttributions. The
    // resume-time caller passes `snapshot as AttributionSnapshot`
    // from a structural cast off `unknown`, so the runtime value
    // could be anything.
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
        const service = CommitAttributionService.getInstance();
        // Seed some pre-existing state to confirm the reset clears it.
        service.recordEdit('/project/preexisting.ts', null, 'hello');
        expect(
          service.getFileAttribution('/project/preexisting.ts'),
        ).toBeDefined();

        service.restoreFromSnapshot(
          badPayload as unknown as Parameters<
            typeof service.restoreFromSnapshot
          >[0],
        );
        expect(
          service.getFileAttribution('/project/preexisting.ts'),
        ).toBeUndefined();
        expect(service.getSurface()).toBe('cli');
        expect(service.getPromptsSinceLastCommit()).toBe(0);
      },
    );

    // `fileStates` must be a plain object; otherwise Object.entries
    // would happily iterate an array's [index, value] pairs and seed
    // fileAttributions with numeric-string keys.
    it.each([
      ['array', []],
      ['string', 'oops'],
      ['number', 42],
      ['null', null],
    ])(
      'ignores non-object fileStates (%s) without polluting attribution map',
      (_label, badFileStates) => {
        const service = CommitAttributionService.getInstance();
        service.restoreFromSnapshot({
          type: 'attribution-snapshot',
          surface: 'cli',
          fileStates: badFileStates as unknown as Record<
            string,
            { aiContribution: number; aiCreated: boolean; contentHash: string }
          >,
          promptCount: 0,
          promptCountAtLastCommit: 0,
        });
        expect(service.hasAttributions()).toBe(false);
      },
    );
  });
});
