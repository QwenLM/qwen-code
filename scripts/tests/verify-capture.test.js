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
// point of this script is that the browser pipeline it replaces never produced
// an image in four live /verify runs — it needed a browser and a route that is
// not installed as a unit. A test that only checked the skill's wording would
// have passed through all four of those rounds.
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
      // isPng reads from evidence/01-ab.png, so a pass also proves the helper
      // created the parent dir the skill tells the agent to write into.
      expect(isPng(out)).toBe(true);
      // Geometry is reported so a caller can spot a blank or clipped capture.
      // The canvas size is deterministic — cols fix the width, the row count
      // the height — so assert it exactly; the compressed byte length varies
      // with the platform's font rasterisation and flaked on Linux (846B for a
      // render that was >1000B on macOS).
      expect(res.stdout).toMatch(/360x96 \d+B 3 rows/);
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
  // a red FAIL beside a green PASS is what makes the cell readable at a glance.
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

  // Regression: U+FE0F (the emoji variation selector in ⚠️) sent Pango looking
  // for a colour-emoji font and abort()ing in native code on macOS — no PNG, no
  // diagnostic, exit 133. The helper strips it and the base codepoint renders.
  // No other test fed the helper a non-ASCII byte.
  it('renders non-ASCII and emoji without aborting', () =>
    withDir((dir) => {
      const out = path.join(dir, 'emoji.png');
      const res = run(['--out', out, '--cols', '40'], {
        input: 'warn ⚠️ history gap 中文 café\n',
      });
      expect(res.status).toBe(0);
      expect(isPng(out)).toBe(true);
    }));

  // escapeXml guards every rendered cell and the title; feed it XML-hostile
  // content (common in test output: expect(a < b), foo & bar) so a deleted
  // escape rule cannot silently corrupt the SVG and ship a broken image.
  it('escapes XML special characters in rendered text', () =>
    withDir((dir) => {
      const out = path.join(dir, 'xml.png');
      const res = run(
        ['--out', out, '--cols', '40', '--title', 'a < b & "c"'],
        { input: 'expect(a < b) & foo > bar "q"\n' },
      );
      expect(res.status).toBe(0);
      expect(isPng(out)).toBe(true);
    }));

  // scrollback: 0 keeps only the last --rows lines, so a taller input loses its
  // header with no visible sign. The helper must say so on stderr rather than
  // ship an image that looks complete but starts halfway down.
  it('warns when input is taller than --rows', () =>
    withDir((dir) => {
      const out = path.join(dir, 'tall.png');
      const res = run(['--out', out, '--rows', '4'], {
        input: 'l1\nl2\nl3\nl4\nl5\nl6\n',
      });
      expect(res.status).toBe(0);
      expect(isPng(out)).toBe(true);
      expect(res.stderr).toContain('warning: input has 6 lines');
      expect(res.stderr).toContain('dropped the top 2');
    }));

  describe('fails loudly rather than writing a broken image', () => {
    it('rejects a missing --out', () => {
      const res = run(['--', 'echo', 'hi']);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('--out is required');
    });

    it('rejects nonsense geometry', () =>
      withDir((dir) => {
        // Both flags share one validation loop; feed both so a mutation
        // dropping 'rows' from it cannot survive the suite.
        for (const flag of ['--cols', '--rows']) {
          for (const bad of ['0', '-5', 'abc', '9999']) {
            const res = run(['--out', path.join(dir, 'x.png'), flag, bad]);
            expect(res.status, `${flag} ${bad} was accepted`).toBe(1);
            expect(res.stderr).toContain('must be an integer');
          }
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

  // The helper only helps if the skill points at it. Three rounds of rewording
  // failed because the named pipeline never produced an image; assert the slow
  // browser route is no longer the recommendation and the live command is named.
  it('is the route the skill actually names', () => {
    const skill = readFileSync(
      path.join(repoRoot, '.qwen/skills/verify-pr/SKILL.md'),
      'utf8',
    );
    // Flatten whitespace so a prose reflow cannot break these, like the sibling
    // test in qwen-triage-workflow.test.js.
    const flat = skill.replace(/\s+/g, ' ');
    expect(flat).toContain('node scripts/verify-capture.mjs --out');
    expect(flat).toContain('no browser and no pseudo-terminal');
    // The slow browser pipeline must not be the recommended route again...
    expect(flat).not.toContain('Route: `terminal-capture` skill');
    expect(flat).not.toMatch(/node-pty → xterm\.js → Playwright PNG/);
    // ...but the skill must still point at it for the captures this helper
    // cannot do (an ink TUI or a browser page), so the route stays discoverable.
    expect(flat).toContain('see the `terminal-capture` skill');
  });
});
