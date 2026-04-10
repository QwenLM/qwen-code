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
    'src/main.ts': {
      aiCharsAdded: 150,
      aiCharsRemoved: 30,
      aiCreated: true,
      aiContributionPercent: 100,
    },
    'src/utils.ts': {
      aiCharsAdded: 45,
      aiCharsRemoved: 20,
      aiCreated: false,
      aiContributionPercent: 100,
    },
  },
  summary: {
    totalAiCharsAdded: 195,
    totalAiCharsRemoved: 50,
    totalFilesTouched: 2,
    overallAiPercent: 100,
  },
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

    it('should not include cd prefix (cwd handled by executor)', () => {
      const cmd = buildGitNotesCommand(sampleNote);
      expect(cmd).not.toBeNull();
      expect(cmd!).not.toContain('cd ');
      expect(cmd!.startsWith('git notes')).toBe(true);
    });

    it('should produce valid JSON in the note message', () => {
      const cmd = buildGitNotesCommand(sampleNote)!;
      // Extract the JSON from between the single quotes after -m
      const match = cmd.match(/-m '(.+)' HEAD/);
      expect(match).toBeTruthy();
      // The JSON may have escaped single quotes, unescape them
      const jsonStr = match![1].replace(/'\\''/g, "'");
      const parsed = JSON.parse(jsonStr);
      expect(parsed.version).toBe(1);
      expect(parsed.generator).toBe('Qwen-Coder');
    });

    it('should return null when note exceeds size limit', () => {
      const hugeNote: CommitAttributionNote = {
        ...sampleNote,
        files: {},
      };
      // Create a note with enough files to exceed 128KB
      for (let i = 0; i < 2000; i++) {
        hugeNote.files[
          `src/very/long/path/to/some/deeply/nested/file_${i}.ts`
        ] = {
          aiCharsAdded: 999999,
          aiCharsRemoved: 999999,
          aiCreated: true,
          aiContributionPercent: 100,
        };
      }
      const cmd = buildGitNotesCommand(hugeNote);
      expect(cmd).toBeNull();
    });

    it('should properly escape single quotes in JSON', () => {
      const noteWithQuotes: CommitAttributionNote = {
        ...sampleNote,
        files: {
          "it's-a-file.ts": {
            aiCharsAdded: 10,
            aiCharsRemoved: 5,
            aiCreated: false,
            aiContributionPercent: 100,
          },
        },
      };
      const cmd = buildGitNotesCommand(noteWithQuotes);
      expect(cmd).not.toBeNull();
      // Should not have unescaped single quotes that break the shell command
      // The pattern '...'\''...' is the correct shell escaping for single quotes
      expect(cmd).toContain("'\\''");
    });
  });

  describe('formatAttributionSummary', () => {
    it('should format a human-readable summary', () => {
      const summary = formatAttributionSummary(sampleNote);
      expect(summary).toContain('2 file(s) touched');
      expect(summary).toContain('Chars added: 195');
      expect(summary).toContain('removed: 50');
      expect(summary).toContain('src/main.ts');
      expect(summary).toContain('[created]');
    });
  });

  describe('getAttributionNotesRef', () => {
    it('should return the expected ref', () => {
      expect(getAttributionNotesRef()).toBe('refs/notes/ai-attribution');
    });
  });
});
