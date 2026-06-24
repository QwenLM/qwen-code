/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoadedSettings } from '../../config/settings.js';
import { buildVoiceKeyterms } from './voice-keyterms.js';

/** Minimal LoadedSettings stand-in: buildVoiceKeyterms reads only these. */
function makeSettings(
  workspaceDir: string,
  opts: { keytermsFile?: string; isTrusted?: boolean } = {},
): LoadedSettings {
  const { keytermsFile, isTrusted = true } = opts;
  return {
    isTrusted,
    workspace: { path: path.join(workspaceDir, '.qwen', 'settings.json') },
    merged: {
      general: keytermsFile ? { voice: { keytermsFile } } : {},
    },
  } as unknown as LoadedSettings;
}

describe('buildVoiceKeyterms', () => {
  it('returns the static global vocabulary', () => {
    const terms = buildVoiceKeyterms();
    expect(terms).toContain('TypeScript');
    expect(terms).toContain('worktree');
  });

  it('does not include project- or branch-derived terms (no metadata sent)', () => {
    const terms = buildVoiceKeyterms();
    expect(terms).not.toContain('qwen-code');
    expect(terms).not.toContain('mvp');
  });

  describe('custom keyterms file', () => {
    let workspaceDir: string;
    let qwenDir: string;

    beforeEach(() => {
      workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-keyterms-'));
      qwenDir = path.join(workspaceDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    it('auto-loads .qwen/voice-keyterms.txt and merges with the globals', () => {
      fs.writeFileSync(
        path.join(qwenDir, 'voice-keyterms.txt'),
        'Kubernetes\nGraphQL\n',
      );
      const terms = buildVoiceKeyterms(makeSettings(workspaceDir));
      expect(terms).toContain('Kubernetes');
      expect(terms).toContain('GraphQL');
      expect(terms).toContain('TypeScript'); // globals still present
    });

    it('ignores blank lines and "#" comments (including indented comments)', () => {
      fs.writeFileSync(
        path.join(qwenDir, 'voice-keyterms.txt'),
        '# project terms\n\n  Kubernetes  \n   # indented comment\n',
      );
      const terms = buildVoiceKeyterms(makeSettings(workspaceDir));
      expect(terms).toContain('Kubernetes');
      expect(terms).not.toContain('# project terms');
      expect(terms).not.toContain('# indented comment');
    });

    it('honors an explicit absolute keytermsFile over auto-discovery', () => {
      // Auto-discovery file would yield "Auto"; the explicit one wins.
      fs.writeFileSync(path.join(qwenDir, 'voice-keyterms.txt'), 'Auto\n');
      const explicit = path.join(workspaceDir, 'glossary.txt');
      fs.writeFileSync(explicit, 'Explicit\n');
      const terms = buildVoiceKeyterms(
        makeSettings(workspaceDir, { keytermsFile: explicit }),
      );
      expect(terms).toContain('Explicit');
      expect(terms).not.toContain('Auto');
    });

    it('honors an explicit relative keytermsFile over auto-discovery', () => {
      fs.writeFileSync(path.join(qwenDir, 'voice-keyterms.txt'), 'Auto\n');
      fs.writeFileSync(path.join(workspaceDir, 'rel.txt'), 'RelativeWins\n');
      const terms = buildVoiceKeyterms(
        makeSettings(workspaceDir, { keytermsFile: 'rel.txt' }),
      );
      expect(terms).toContain('RelativeWins');
      expect(terms).not.toContain('Auto');
    });

    it('resolves a relative keytermsFile from the workspace root', () => {
      fs.writeFileSync(path.join(workspaceDir, 'terms.txt'), 'RelativeTerm\n');
      const terms = buildVoiceKeyterms(
        makeSettings(workspaceDir, { keytermsFile: 'terms.txt' }),
      );
      expect(terms).toContain('RelativeTerm');
    });

    it('dedupes case-insensitively and keeps the global casing', () => {
      fs.writeFileSync(
        path.join(qwenDir, 'voice-keyterms.txt'),
        'typescript\nKubernetes\n',
      );
      const terms = buildVoiceKeyterms(makeSettings(workspaceDir));
      expect(terms).toContain('TypeScript');
      expect(terms).not.toContain('typescript');
      expect(
        terms.filter((t) => t.toLowerCase() === 'typescript'),
      ).toHaveLength(1);
    });

    it('falls back to the globals when the file is missing', () => {
      const terms = buildVoiceKeyterms(
        makeSettings(workspaceDir, { keytermsFile: 'does-not-exist.txt' }),
      );
      expect(terms).toContain('TypeScript');
      expect(terms).toContain('worktree');
    });

    it('caps by term count for a file of many short terms', () => {
      const many = Array.from({ length: 1000 }, (_, i) => `term${i}`).join(
        '\n',
      );
      fs.writeFileSync(path.join(qwenDir, 'voice-keyterms.txt'), many);
      const terms = buildVoiceKeyterms(makeSettings(workspaceDir));
      expect(terms).toHaveLength(200);
      expect(terms.join(' ').length).toBeLessThanOrEqual(2000);
    });

    it('caps by total length for a file of few long terms', () => {
      // 40 × 80-char terms blow the 2000-char budget long before the 200-term
      // count cap, so the char budget must bind.
      const long = Array.from({ length: 40 }, () => 'x'.repeat(80)).join('\n');
      fs.writeFileSync(path.join(qwenDir, 'voice-keyterms.txt'), long);
      const terms = buildVoiceKeyterms(makeSettings(workspaceDir));
      expect(terms.join(' ').length).toBeLessThanOrEqual(2000);
      expect(terms.length).toBeLessThan(40); // not all long terms fit
      expect(terms.length).toBeGreaterThan(31); // some user terms past the globals
    });

    it('does not read a keyterms file in an untrusted workspace', () => {
      fs.writeFileSync(
        path.join(qwenDir, 'voice-keyterms.txt'),
        'ShouldNotLoad\n',
      );
      const terms = buildVoiceKeyterms(
        makeSettings(workspaceDir, { isTrusted: false }),
      );
      expect(terms).not.toContain('ShouldNotLoad');
      expect(terms).toContain('TypeScript'); // globals still returned
    });

    it('does not follow a symlinked keyterms file (no secret exfiltration)', () => {
      const secret = path.join(workspaceDir, 'secret.txt');
      fs.writeFileSync(secret, 'SECRETKEYMATERIAL\n');
      fs.symlinkSync(secret, path.join(qwenDir, 'voice-keyterms.txt'));
      const terms = buildVoiceKeyterms(makeSettings(workspaceDir));
      expect(terms).not.toContain('SECRETKEYMATERIAL');
      expect(terms).toContain('TypeScript'); // globals only
    });

    it('ignores a keyterms file larger than the size cap', () => {
      const huge = `HugeTermMarker\n${'x\n'.repeat(40 * 1024)}`; // > 64 KB
      fs.writeFileSync(path.join(qwenDir, 'voice-keyterms.txt'), huge);
      const terms = buildVoiceKeyterms(makeSettings(workspaceDir));
      expect(terms).not.toContain('HugeTermMarker');
      expect(terms).toContain('TypeScript'); // globals only
    });
  });
});
