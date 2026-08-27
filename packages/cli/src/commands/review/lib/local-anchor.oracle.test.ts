/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The git layer is scripted, not real: the shape these tests pin — a manual
// skip-worktree bit surviving on an IN-CONE path whose file was deleted — is
// version-dependent (git 2.43 retains the bit, 2.47 re-clears it and
// restores the file during `sparse-checkout set`), so real git on a modern
// machine cannot construct it end to end. The integration suite drives the
// constructible arms against real git; this file drives the 2.43 arms
// against the same production code with git's answers replayed.
const script = {
  lsFiles: '' as string,
  sparseBool: null as string | null,
  checkRules: '' as string,
  checkRulesThrows: false,
};
vi.mock('./git.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./git.js')>();
  return {
    ...real,
    gitRaw: (...args: string[]): Buffer => {
      if (args.includes('ls-files')) return Buffer.from(script.lsFiles);
      return real.gitRaw(...args);
    },
    gitOpt: (...args: string[]): string | null => {
      if (args.includes('core.sparseCheckout')) return script.sparseBool;
      return real.gitOpt(...args);
    },
    gitWithInputRaw: (input: Buffer, args: string[]): string => {
      if (args.includes('check-rules')) {
        if (script.checkRulesThrows) throw new Error('no such subcommand');
        return script.checkRules;
      }
      return real.gitWithInputRaw(input, args);
    },
  };
});

import { invisibleTrackedPaths } from './local-anchor.js';

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'oracle-')));
  script.lsFiles = '';
  script.sparseBool = null;
  script.checkRules = '';
  script.checkRulesThrows = false;
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('invisibleTrackedPaths — the check-rules arms real git cannot stage', () => {
  it('flags an absent IN-RULES path under sparse — the 2.43 hidden deletion', () => {
    // R18-3: git 2.43 retains a manual --skip-worktree on an in-cone path;
    // delete the file and every diff goes quiet while the bit hides the
    // deletion. Absence alone must not exempt — membership does: an
    // in-rules absent path is a deletion no round read.
    script.lsFiles = 'S in.ts\0S sub/out.ts\0';
    script.sparseBool = 'true';
    script.checkRules = 'in.ts\0'; // in.ts IS in the rules; sub/out.ts is not
    // Neither file exists on disk; only the out-of-rules one is exempt.
    expect(invisibleTrackedPaths(repo)).toEqual(['in.ts']);
  });

  it('exempts nothing when check-rules is unavailable — fail closed', () => {
    // An older git without the subcommand answers nothing: the exemption
    // stands down and the pre-exemption behaviour (flag every bit) returns —
    // a wedge on that git, never a certification.
    script.lsFiles = 'S sub/out.ts\0';
    script.sparseBool = 'true';
    script.checkRulesThrows = true;
    expect(invisibleTrackedPaths(repo)).toEqual(['sub/out.ts']);
  });

  it('an UNMEASURABLE out-of-rules path keeps flagging — only ENOENT is absence', () => {
    // R19-2: every lstat failure used to fold into "absent", so a PRESENT
    // flagged path under an unreadable ancestor was exempted and the oracle
    // read clean while `git diff` was blind to its bytes. ENOTDIR stages
    // the unmeasurable shape deterministically (EACCES needs a non-root
    // runner): the path runs through a regular FILE, so it cannot be
    // proven absent — and unmeasurable is uncertifiable.
    script.lsFiles = 'S f/x.ts\0';
    script.sparseBool = 'true';
    script.checkRules = ''; // out of the rules — exempt IF it were absent
    writeFileSync(join(repo, 'f'), 'a regular file, not a directory\n');
    expect(invisibleTrackedPaths(repo)).toEqual(['f/x.ts']);
  });

  it('an undecodable name is never exempted — U+FFFD cannot be measured', () => {
    // R19-1: the utf8 decode folds invalid bytes to U+FFFD; lstat on the
    // mangled spelling misses the PRESENT file and check-rules is fed a
    // name git never knew — both halves of the exemption run on a name
    // that is not the path's. The discipline hashWorktreeFiles and
    // revisionIdentities already apply lands here too: flagged, always.
    script.lsFiles = 'h b\uFFFD.dat\0';
    script.sparseBool = 'true';
    script.checkRules = '';
    expect(invisibleTrackedPaths(repo)).toEqual(['b\uFFFD.dat']);
  });

  it('a PRESENT out-of-rules path keeps flagging — a file can hide an edit', () => {
    // Out-of-rules but materialized: whatever put the file there, its bytes
    // are invisible to `git diff` while the bit stands — the exemption is
    // for paths with NOTHING on disk, only.
    script.lsFiles = 'S sub/out.ts\0';
    script.sparseBool = 'true';
    script.checkRules = '';
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, 'sub/out.ts'), 'export const b = 1;\n');
    expect(invisibleTrackedPaths(repo)).toEqual(['sub/out.ts']);
  });
});
