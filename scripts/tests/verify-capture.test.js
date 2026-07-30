/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const HELPER = path.join(repoRoot, 'scripts/verify-capture.mjs');
const ESC = String.fromCharCode(27);

// Every assertion here runs the real helper and inspects the real PNG. The
// point of this script is that the pipeline it replaces did NOT exist — four
// live /verify runs produced zero images because the skill named node-pty and
// Playwright, neither of which is installed. A test that only checked the
// skill's wording would have passed through all four of those rounds.
describe('verify-capture helper', () => {
  const run = (args, opts = {}) =>
    spawnSync('node', [HELPER, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      ...opts,
    });

  /** PNG signature — proves sharp actually rasterised, not that a file exists. */
  const isPng = (file) => {
    const head = readFileSync(file).subarray(0, 8);
    return head.equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  };

  const withDir = (fn) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'verify-capture-'));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /** A harness that emits a coloured A/B table, like a real one would. */
  const harness = (dir) => {
    const file = path.join(dir, 'harness.mjs');
    writeFileSync(
      file,
      [
        `const E = String.fromCharCode(27);`,
        `const g = (s) => \`\${E}[32m\${s}\${E}[0m\`;`,
        `const r = (s) => \`\${E}[1;31m\${s}\${E}[0m\`;`,
        `console.log('cell        base    head');`,
        `console.log(\`noisy       \${r('FAIL')}    \${g('PASS')}\`);`,
        `console.log(\`clean       \${g('PASS')}    \${g('PASS')}\`);`,
      ].join('\n'),
    );
    return file;
  };

  it('captures a command to a real PNG', () =>
    withDir((dir) => {
      const out = path.join(dir, 'evidence/01-ab.png');
      const res = run([
        '--out',
        out,
        '--cols',
        '40',
        '--title',
        'A/B: gate flips',
        '--',
        'node',
        harness(dir),
      ]);
      expect(res.status).toBe(0);
      expect(isPng(out)).toBe(true);
      // Geometry is reported so a caller can spot a blank or clipped capture.
      expect(res.stdout).toMatch(/\d+x\d+ \d+B 3 rows/);
      // Parent dirs are created — the skill tells the agent to write into
      // evidence/, which will not exist yet.
      expect(readFileSync(out).length).toBeGreaterThan(1000);
    }));

  it('accepts piped input as well as a command', () =>
    withDir((dir) => {
      const out = path.join(dir, 'piped.png');
      const res = run(['--out', out, '--cols', '40'], {
        input: `${ESC}[32mPASS${ESC}[0m 64/64\n`,
      });
      expect(res.status).toBe(0);
      expect(isPng(out)).toBe(true);
    }));

  // Capturing a failing base arm is the normal case for an A/B cell, so a
  // non-zero exit from the captured command must still produce an image.
  it('still captures when the captured command fails', () =>
    withDir((dir) => {
      const out = path.join(dir, 'failing.png');
      const res = run([
        '--out',
        out,
        '--',
        'node',
        '-e',
        'console.log("boom"); process.exit(3)',
      ]);
      expect(res.status).toBe(0);
      expect(res.stderr).toContain('command exited 3');
      expect(isPng(out)).toBe(true);
    }));

  // Colour and weight are the whole reason to render rather than paste text:
  // a red FAIL beside a green PASS is what makes the cell readable at a
  // glance.
  //
  // Each attribute is isolated against the SAME plain baseline. A single
  // "coloured and bold vs plain" comparison passes while EITHER attribute
  // survives — verified: mutating colour away, and mutating bold away, both
  // left that version green. This is the wrong-reason trap the skill warns
  // about, met in this file's own test.
  it('preserves colour and bold independently', () =>
    withDir((dir) => {
      const render = (name, input) => {
        const out = path.join(dir, `${name}.png`);
        expect(run(['--out', out, '--cols', '30'], { input }).status).toBe(0);
        expect(isPng(out)).toBe(true);
        return readFileSync(out);
      };
      const plain = render('plain', 'FAIL PASS\n');
      // Green, no bold — differs from plain ONLY if colour is applied.
      const colourOnly = render('colour', `${ESC}[32mFAIL PASS${ESC}[0m\n`);
      // Bold, no colour — differs from plain ONLY if weight is applied.
      const boldOnly = render('bold', `${ESC}[1mFAIL PASS${ESC}[0m\n`);
      expect(colourOnly.equals(plain), 'colour was dropped').toBe(false);
      expect(boldOnly.equals(plain), 'bold was dropped').toBe(false);
      // ...and the two attributes must not collapse onto the same rendering.
      expect(colourOnly.equals(boldOnly)).toBe(false);
    }));

  // A bare LF leaves xterm's cursor in the old column, so line 2 renders
  // indented by line 1's width and the capture looks like a staircase. The
  // helper normalises to CRLF; assert the rendered height matches the line
  // count rather than trusting that.
  it('renders one row per line, not a staircase', () =>
    withDir((dir) => {
      const out = path.join(dir, 'rows.png');
      const res = run(['--out', out, '--cols', '20'], {
        input: 'aaa\nbbb\nccc\nddd\n',
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('4 rows');
    }));

  it('trims trailing blank rows instead of padding to --rows', () =>
    withDir((dir) => {
      const tall = run(['--out', path.join(dir, 'a.png'), '--rows', '40'], {
        input: 'one\ntwo\n',
      });
      const short = run(['--out', path.join(dir, 'b.png'), '--rows', '4'], {
        input: 'one\ntwo\n',
      });
      expect(tall.stdout).toContain('2 rows');
      // Same content, same image, regardless of the row cap.
      expect(tall.stdout.split(' ')[1]).toBe(short.stdout.split(' ')[1]);
    }));

  describe('fails loudly rather than writing a broken image', () => {
    it('rejects a missing --out', () => {
      const res = run(['--', 'echo', 'hi']);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('--out is required');
    });

    it('rejects nonsense geometry', () =>
      withDir((dir) => {
        for (const bad of ['0', '-5', 'abc', '9999']) {
          const res = run(['--out', path.join(dir, 'x.png'), '--cols', bad]);
          expect(res.status, `--cols ${bad} was accepted`).toBe(1);
          expect(res.stderr).toContain('must be an integer');
        }
      }));

    it('rejects an unknown option instead of ignoring it', () =>
      withDir((dir) => {
        const res = run(['--out', path.join(dir, 'x.png'), '--width', '80']);
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('unknown option --width');
      }));

    // A blank capture is worse than none: it looks like evidence and shows
    // nothing. Exit 1 so the agent notices rather than publishing it.
    it('refuses to write an empty capture', () =>
      withDir((dir) => {
        const res = run(['--out', path.join(dir, 'empty.png')], { input: '' });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('nothing to render');
      }));

    it('reports a command that does not exist', () =>
      withDir((dir) => {
        const res = run([
          '--out',
          path.join(dir, 'x.png'),
          '--',
          'definitely-not-a-real-binary-xyz',
        ]);
        expect(res.status).toBe(1);
      }));
  });

  // The helper only helps if the skill points at it. Three rounds of
  // rewording failed because the named pipeline did not exist; assert the
  // dead route is gone and the live one is named.
  it('is the route the skill actually names', () => {
    const skill = readFileSync(
      path.join(repoRoot, '.qwen/skills/verify-pr/SKILL.md'),
      'utf8',
    );
    expect(skill).toContain('node scripts/verify-capture.mjs --out');
    expect(skill).toContain('no\n  browser and no pseudo-terminal');
    // The route that never existed must not be recommended again.
    expect(skill).not.toMatch(/Route: `terminal-capture` skill/);
    expect(skill).not.toMatch(/node-pty → xterm\.js → Playwright PNG/);
  });
});
