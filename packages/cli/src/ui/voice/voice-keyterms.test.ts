/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoadedSettings } from '../../config/settings.js';
import { buildVoiceKeyterms } from './voice-keyterms.js';

/** Minimal LoadedSettings stand-in: buildVoiceKeyterms reads only these. */
function makeSettings(
  workspaceDir: string,
  opts: {
    keytermsFile?: string;
    systemKeytermsFile?: string;
    workspaceKeytermsFile?: string;
    isTrusted?: boolean;
  } = {},
): LoadedSettings {
  const {
    keytermsFile,
    systemKeytermsFile,
    workspaceKeytermsFile,
    isTrusted = true,
  } = opts;
  const voiceSettings = keytermsFile ? { voice: { keytermsFile } } : undefined;
  const systemVoiceSettings = systemKeytermsFile
    ? { voice: { keytermsFile: systemKeytermsFile } }
    : undefined;
  const workspaceVoiceSettings = workspaceKeytermsFile
    ? { voice: { keytermsFile: workspaceKeytermsFile } }
    : undefined;
  return {
    isTrusted,
    workspace: {
      path: path.join(workspaceDir, '.qwen', 'settings.json'),
      settings: { general: workspaceVoiceSettings },
    },
    system: { settings: { general: systemVoiceSettings } },
    user: { settings: { general: voiceSettings } },
    merged: {
      general: workspaceVoiceSettings ?? voiceSettings ?? {},
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
      vi.unstubAllEnvs();
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

    it('expands a tilde-prefixed keytermsFile', () => {
      vi.stubEnv('HOME', workspaceDir);
      vi.stubEnv('USERPROFILE', workspaceDir);
      fs.writeFileSync(path.join(workspaceDir, 'terms.txt'), 'HomeTerm\n');
      const terms = buildVoiceKeyterms(
        makeSettings(workspaceDir, { keytermsFile: '~/terms.txt' }),
      );
      expect(terms).toContain('HomeTerm');
    });

    it('honors a system-scoped keytermsFile setting', () => {
      const systemFile = path.join(workspaceDir, 'system-terms.txt');
      fs.writeFileSync(systemFile, 'SystemTerm\n');
      const terms = buildVoiceKeyterms(
        makeSettings(workspaceDir, { systemKeytermsFile: systemFile }),
      );
      expect(terms).toContain('SystemTerm');
    });

    it('prefers system-scoped keytermsFile over user-scoped keytermsFile', () => {
      const systemFile = path.join(workspaceDir, 'system-terms.txt');
      const userFile = path.join(workspaceDir, 'user-terms.txt');
      fs.writeFileSync(systemFile, 'SystemTerm\n');
      fs.writeFileSync(userFile, 'UserTerm\n');
      const terms = buildVoiceKeyterms(
        makeSettings(workspaceDir, {
          systemKeytermsFile: systemFile,
          keytermsFile: userFile,
        }),
      );
      expect(terms).toContain('SystemTerm');
      expect(terms).not.toContain('UserTerm');
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
      const long = Array.from(
        { length: 40 },
        (_, i) => `t${i}_${'x'.repeat(76)}`,
      ).join('\n');
      fs.writeFileSync(path.join(qwenDir, 'voice-keyterms.txt'), long);
      const terms = buildVoiceKeyterms(makeSettings(workspaceDir));
      const userTerms = terms.filter((term) => term.startsWith('t'));
      expect(terms.join(' ').length).toBeLessThanOrEqual(2000);
      expect(userTerms.length).toBeLessThan(40); // not all long terms fit
      expect(userTerms.length).toBeGreaterThan(0); // some user terms past globals
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

    it('does not read a hard-linked keyterms file', () => {
      const secret = path.join(workspaceDir, 'secret.txt');
      fs.writeFileSync(secret, 'HardLinkSecret\n');
      fs.linkSync(secret, path.join(qwenDir, 'voice-keyterms.txt'));
      const terms = buildVoiceKeyterms(makeSettings(workspaceDir));
      expect(terms).not.toContain('HardLinkSecret');
      expect(terms).toContain('TypeScript'); // globals only
    });

    it('does not follow a symlinked explicit keytermsFile', () => {
      const secret = path.join(workspaceDir, 'secret.txt');
      const link = path.join(workspaceDir, 'terms-link.txt');
      fs.writeFileSync(secret, 'SECRETKEYMATERIAL\n');
      fs.symlinkSync(secret, link);
      const terms = buildVoiceKeyterms(
        makeSettings(workspaceDir, { keytermsFile: link }),
      );
      expect(terms).not.toContain('SECRETKEYMATERIAL');
      expect(terms).toContain('TypeScript'); // globals only
    });

    it('does not load the default file through a symlinked .qwen directory', () => {
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'voice-keyterms-outside-'),
      );
      fs.rmSync(qwenDir, { recursive: true, force: true });
      fs.writeFileSync(
        path.join(outsideDir, 'voice-keyterms.txt'),
        'SECRETKEYMATERIAL\n',
      );
      fs.symlinkSync(outsideDir, qwenDir);
      try {
        const terms = buildVoiceKeyterms(makeSettings(workspaceDir));
        expect(terms).not.toContain('SECRETKEYMATERIAL');
        expect(terms).toContain('TypeScript'); // globals only
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('does not let relative keytermsFile escape the workspace root', () => {
      const outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'voice-keyterms-outside-'),
      );
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'EscapedTerm\n');
      try {
        const relativeEscape = path.relative(
          workspaceDir,
          path.join(outsideDir, 'secret.txt'),
        );
        const terms = buildVoiceKeyterms(
          makeSettings(workspaceDir, { keytermsFile: relativeEscape }),
        );
        expect(terms).not.toContain('EscapedTerm');
        expect(terms).toContain('TypeScript'); // globals only
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('ignores workspace-scoped keytermsFile settings', () => {
      const secret = path.join(workspaceDir, 'secret.txt');
      fs.writeFileSync(secret, 'SECRETKEYMATERIAL\n');
      const terms = buildVoiceKeyterms(
        makeSettings(workspaceDir, { workspaceKeytermsFile: secret }),
      );
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
