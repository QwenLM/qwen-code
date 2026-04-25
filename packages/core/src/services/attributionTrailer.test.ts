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
    it('should build a valid git notes command', () => {
      const cmd = buildGitNotesCommand(sampleNote);
      expect(cmd).not.toBeNull();
      expect(cmd).toContain(
        'git notes --ref=refs/notes/ai-attribution add -f -m',
      );
      expect(cmd).toContain('HEAD');
      expect(cmd).toContain('"Qwen-Coder"');
    });

    it('should not include cd prefix', () => {
      const cmd = buildGitNotesCommand(sampleNote)!;
      expect(cmd).not.toContain('cd ');
      expect(cmd.startsWith('git notes')).toBe(true);
    });

    it('should produce valid JSON in the note', () => {
      const cmd = buildGitNotesCommand(sampleNote)!;
      const match = cmd.match(/-m '(.+)' HEAD/);
      expect(match).toBeTruthy();
      const jsonStr = match![1].replace(/'\\''/g, "'");
      const parsed = JSON.parse(jsonStr);
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

    it('should properly escape single quotes in JSON', () => {
      const noteWithQuotes: CommitAttributionNote = {
        ...sampleNote,
        files: {
          "it's-a-file.ts": { aiChars: 10, humanChars: 5, percent: 67 },
        },
      };
      const cmd = buildGitNotesCommand(noteWithQuotes);
      expect(cmd).not.toBeNull();
      expect(cmd).toContain("'\\''");
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
