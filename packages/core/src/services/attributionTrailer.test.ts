/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildGitNotesCommand,
  formatAttributionSummary,
  getAttributionNotesRef,
} from './attributionTrailer.js';
import type { CommitAttributionNote } from './commitAttribution.js';

const sampleNote: CommitAttributionNote = {
  version: 1,
  generator: 'Qwen-Coder',
  files: {
    'src/main.ts': { aiChars: 150, humanChars: 50, percent: 75 },
    'src/utils.ts': { aiChars: 0, humanChars: 200, percent: 0 },
  },
  summary: {
    aiPercent: 38,
    aiChars: 150,
    humanChars: 250,
    totalFilesTouched: 2,
    surfaces: ['cli'],
  },
  surfaceBreakdown: { cli: { aiChars: 150, percent: 38 } },
  excludedGenerated: ['package-lock.json'],
  promptCount: 3,
};

describe('attributionTrailer', () => {
  describe('buildGitNotesCommand', () => {
    it('should build a valid git notes invocation', () => {
      const cmd = buildGitNotesCommand(sampleNote);
      expect(cmd).not.toBeNull();
      expect(cmd!.command).toBe('git');
      expect(cmd!.args.slice(0, 6)).toEqual([
        'notes',
        '--ref=refs/notes/ai-attribution',
        'add',
        '-f',
        '-m',
        // index 5 is the JSON note payload, asserted below
        cmd!.args[5],
      ]);
      expect(cmd!.args.at(-1)).toBe('HEAD');
    });

    it('should pass the JSON note as a single argv entry (no shell quoting)', () => {
      // The `-f` flag is at args[3]; the note JSON sits at args[5] between
      // `-m` and `HEAD`. Returning argv (rather than a shell-quoted command
      // string) keeps the payload off the shell parser entirely so quotes,
      // command substitution, and platform-specific escaping cannot break
      // it on cmd.exe / PowerShell.
      const cmd = buildGitNotesCommand(sampleNote)!;
      const noteArg = cmd.args[5]!;
      const parsed = JSON.parse(noteArg);
      expect(parsed.version).toBe(1);
      expect(parsed.summary.aiPercent).toBe(38);
      expect(parsed.files['src/main.ts'].percent).toBe(75);
    });

    it('should return null when note exceeds size limit', () => {
      const hugeNote: CommitAttributionNote = {
        ...sampleNote,
        files: {},
        excludedGenerated: [],
      };
      for (let i = 0; i < 2000; i++) {
        hugeNote.files[
          `src/very/long/path/to/some/deeply/nested/file_${i}.ts`
        ] = { aiChars: 999999, humanChars: 999999, percent: 50 };
      }
      expect(buildGitNotesCommand(hugeNote)).toBeNull();
    });

    it('should leave single quotes literal in the argv payload', () => {
      // The previous string-based command needed bash-style quote escaping.
      // With argv, the apostrophe stays literal — the executor passes it
      // through to git unmolested.
      const noteWithQuotes: CommitAttributionNote = {
        ...sampleNote,
        files: {
          "it's-a-file.ts": { aiChars: 10, humanChars: 5, percent: 67 },
        },
      };
      const cmd = buildGitNotesCommand(noteWithQuotes);
      expect(cmd).not.toBeNull();
      const parsed = JSON.parse(cmd!.args[5]!);
      expect(parsed.files["it's-a-file.ts"].percent).toBe(67);
    });
  });

  describe('formatAttributionSummary', () => {
    it('should format a human-readable summary', () => {
      const summary = formatAttributionSummary(sampleNote);
      expect(summary).toContain('38% AI');
      expect(summary).toContain('2 file(s)');
      expect(summary).toContain('AI chars: 150');
      expect(summary).toContain('Human chars: 250');
      expect(summary).toContain('src/main.ts');
      expect(summary).toContain('75% AI');
      expect(summary).toContain('Excluded generated: 1 file(s)');
    });
  });

  describe('getAttributionNotesRef', () => {
    it('should return the expected ref', () => {
      expect(getAttributionNotesRef()).toBe('refs/notes/ai-attribution');
    });
  });
});
