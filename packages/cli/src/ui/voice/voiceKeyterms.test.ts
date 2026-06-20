/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildVoiceKeyterms } from './voiceKeyterms.js';

describe('buildVoiceKeyterms', () => {
  it('includes the global vocabulary by default', () => {
    const terms = buildVoiceKeyterms();
    expect(terms).toContain('TypeScript');
    expect(terms).toContain('worktree');
  });

  it('adds project basename and branch tokens', () => {
    const terms = buildVoiceKeyterms({
      projectRoot: '/home/me/qwen-code',
      gitBranch: 'feat/voice-mvp',
    });
    expect(terms).toContain('qwen-code');
    expect(terms).toContain('voice');
    expect(terms).toContain('mvp');
    expect(terms).toContain('feat');
  });

  it('extracts identifiers from recent file basenames', () => {
    const terms = buildVoiceKeyterms({
      recentFiles: ['src/ui/voiceRecorder.ts', 'native/audio_capture.cc'],
    });
    expect(terms).toContain('voice');
    expect(terms).toContain('Recorder');
    expect(terms).toContain('audio');
    expect(terms).toContain('capture');
  });

  it('dedupes case-insensitively, filters length, and caps at 50', () => {
    const recentFiles = Array.from({ length: 80 }, (_, i) => `module${i}.ts`);
    const terms = buildVoiceKeyterms({ recentFiles });
    expect(terms.length).toBeLessThanOrEqual(50);
    // No 1-2 char terms.
    expect(terms.every((t) => t.length >= 3)).toBe(true);
    // No case-insensitive duplicates.
    const lower = terms.map((t) => t.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });
});
