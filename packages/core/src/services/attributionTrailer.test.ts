/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildGitNotesCommand } from './attributionTrailer.js';
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
  excludedGeneratedCount: 1,
  promptCount: 3,
};

describe('attributionTrailer', () => {
  describe('buildGitNotesCommand', () => {
    const TARGET_SHA = 'abc1234567890abcdef1234567890abcdef12345';

    it('should build a valid git notes invocation', () => {
      const cmd = buildGitNotesCommand(sampleNote, TARGET_SHA);
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
      // Note must target the captured SHA, not the symbolic `HEAD` —
      // otherwise a post-commit hook or chained command can move HEAD
      // between capture and exec, and `-f` lands the note on the
      // wrong commit.
      expect(cmd!.args.at(-1)).toBe(TARGET_SHA);
    });

    it('should pass the JSON note as a single argv entry (no shell quoting)', () => {
      // The `-f` flag is at args[3]; the note JSON sits at args[5] between
      // `-m` and the target commit. Returning argv (rather than a
      // shell-quoted command string) keeps the payload off the shell
      // parser entirely so quotes, command substitution, and
      // platform-specific escaping cannot break it on cmd.exe / PowerShell.
      const cmd = buildGitNotesCommand(sampleNote, TARGET_SHA)!;
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
        excludedGeneratedCount: 0,
      };
      for (let i = 0; i < 2000; i++) {
        hugeNote.files[
          `src/very/long/path/to/some/deeply/nested/file_${i}.ts`
        ] = { aiChars: 999999, humanChars: 999999, percent: 50 };
      }
      expect(buildGitNotesCommand(hugeNote, TARGET_SHA)).toBeNull();
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
      const cmd = buildGitNotesCommand(noteWithQuotes, TARGET_SHA);
      expect(cmd).not.toBeNull();
      const parsed = JSON.parse(cmd!.args[5]!);
      expect(parsed.files["it's-a-file.ts"].percent).toBe(67);
    });
  });
});
