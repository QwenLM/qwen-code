/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
      const res = run(
        [
          '--out',
          out,
          '--cols',
          '40',
          '--title',
          'A/B: gate flips',
          '--',
          'node',
          harness(dir),
        ],
        {
          env: { ...process.env, NO_COLOR: 'true' },
        },
      );
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

  // stdout and stderr are collected separately by spawnSync; joining them with
  // an empty separator glues a partial stdout line to the first stderr line,
  // producing a line that never appeared on the real terminal.
  it('separates stdout and stderr with a newline', () =>
    withDir((dir) => {
      const out = path.join(dir, 'both-streams.png');
      const res = run([
        '--out',
        out,
        '--cols',
        '40',
        '--',
        'node',
        '-e',
        'process.stdout.write("result: 42"); process.stderr.write("warning: flaky")',
      ]);
      expect(res.status).toBe(0);
      expect(isPng(out)).toBe(true);
      // Two separate lines, not one glued "result: 42warning: flaky".
      expect(res.stdout).toContain('2 rows');
    }));

  // console.log-terminated stdout already ends with \n; the old join('\n')
  // inserted a phantom blank row between stdout and stderr.
  it('does not insert a phantom blank row when stdout ends with a newline', () =>
    withDir((dir) => {
      const out = path.join(dir, 'no-phantom.png');
      const res = run([
        '--out',
        out,
        '--cols',
        '40',
        '--',
        'node',
        '-e',
        'console.log("result: 42"); process.stderr.write("warning: flaky\\n")',
      ]);
      expect(res.status).toBe(0);
      expect(isPng(out)).toBe(true);
      expect(res.stdout).toContain('2 rows');
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

  // 256-colour and truecolor sequences produce getFgColor() values >= 16,
  // which the bounds guard maps to FG_DEFAULT (#d4d4d4). Decode pixels and
  // assert the fallback grey is present, so deleting the guard cannot ship
  // fill="undefined" (which librsvg paints black) while the test stays green.
  it('renders 256-colour and truecolor via the default-grey fallback', async () => {
    let png;
    withDir((dir) => {
      const out = path.join(dir, 'fallback.png');
      const res = run(['--out', out], {
        input: `${ESC}[38;5;200mFAIL${ESC}[0m ${ESC}[38;2;255;100;0mFAIL${ESC}[0m\n`,
      });
      expect(res.status).toBe(0);
      expect(isPng(out)).toBe(true);
      png = readFileSync(out);
    });
    const sharp = createRequire(import.meta.url)('sharp');
    const { data, info } = await sharp(png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    // FG_DEFAULT is #d4d4d4. Text is anti-aliased, and how many pixels land
    // exactly on it depends on the host's font rasterisation: hosts without
    // fontconfig fonts render almost entirely blended pixels, so the exact
    // scan flaked. Count bright near-neutral pixels instead — both ends of
    // the blend axis (#d4d4d4 over #1e1e1e) are neutral, so every blend of
    // them is at any coverage, while a tinted FG_DEFAULT or the hardcoded
    // #9cdcfe title fill is not and cannot satisfy the count in the
    // fallback's place. The spread tolerance absorbs subpixel antialiasing.
    // Deleting the guard ships fill="undefined", which librsvg paints black,
    // and black on #1e1e1e never reaches this bright.
    let fallbackPixels = 0;
    for (let i = 0; i + 2 < data.length; i += info.channels) {
      const spread =
        Math.max(data[i], data[i + 1], data[i + 2]) -
        Math.min(data[i], data[i + 1], data[i + 2]);
      if (
        data[i] >= 0x80 &&
        data[i + 1] >= 0x80 &&
        data[i + 2] >= 0x80 &&
        spread <= 12
      ) {
        fallbackPixels += 1;
      }
    }
    expect(
      fallbackPixels,
      '256-colour text did not render as #d4d4d4',
    ).toBeGreaterThan(0);
  });

  // SGR 30 maps to #1e1e1e — identical to the canvas BG — so black-foreground
  // text (the normal way to label a coloured badge, e.g. vitest's project
  // badge) vanished as black-on-black. The helper lifts it to the default
  // grey; assert the rendered pixels contain something other than the background
  // colour, which a black-on-black render cannot. sharp's PNG bytes are not
  // run-to-run deterministic, so compare pixels, not file bytes.
  it('keeps black-foreground text readable instead of black-on-black', async () => {
    let png;
    withDir((dir) => {
      const out = path.join(dir, 'black.png');
      expect(
        run(['--out', out, '--cols', '30'], {
          input: `${ESC}[30mFAIL PASS${ESC}[0m\n`,
        }).status,
      ).toBe(0);
      // Read the bytes before withDir removes the dir; decode them below.
      png = readFileSync(out);
    });
    const sharp = createRequire(import.meta.url)('sharp');
    const { data, info } = await sharp(png)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const BG = 0x1e; // #1e1e1e canvas background
    let visible = false;
    for (let i = 0; i + 2 < data.length; i += info.channels) {
      if (data[i] !== BG || data[i + 1] !== BG || data[i + 2] !== BG) {
        visible = true;
        break;
      }
    }
    expect(visible, 'SGR 30 rendered as black-on-black').toBe(true);
  });

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

  // scrollback: 0 keeps only the last --rows rows, so a taller input loses its
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
      expect(res.stderr).toContain('warning: input occupies 6 terminal rows');
      expect(res.stderr).toContain('dropped the top 3');
    }));

  // A line wider than --cols wraps into ceil(len / cols) terminal rows, so
  // the top can be dropped even when the newline count is under --rows.
  it('warns when wrapped lines exceed --rows', () =>
    withDir((dir) => {
      const out = path.join(dir, 'wrapped.png');
      const longLine = 'a'.repeat(20);
      const res = run(['--out', out, '--cols', '10', '--rows', '4'], {
        input: `${longLine}\n${longLine}\n${longLine}\n`,
      });
      expect(res.status).toBe(0);
      expect(isPng(out)).toBe(true);
      expect(res.stderr).toContain('warning: input occupies 6 terminal rows');
      expect(res.stderr).toContain('dropped the top 3');
    }));

  // The defect the guard exists for: at EXACTLY --rows newline-terminated lines
  // the final CRLF still scrolls the top line off the scrollback-less viewport,
  // yet the old `wrappedRows > opts.rows` test stayed silent. Usable capacity is
  // rows - 1, so exactly --rows lines must warn that one was dropped.
  it('warns at exactly --rows lines, where the top line is already gone', () =>
    withDir((dir) => {
      const out = path.join(dir, 'boundary.png');
      const res = run(['--out', out, '--rows', '4'], {
        input: 'l1\nl2\nl3\nl4\n',
      });
      expect(res.status).toBe(0);
      expect(isPng(out)).toBe(true);
      expect(res.stderr).toContain('warning: input occupies 4 terminal rows');
      expect(res.stderr).toContain('dropped the top 1');
    }));

  // Non-newline-terminated input of exactly --rows lines fits: no final CRLF
  // scrolls the viewport, so the usable capacity is rows, not rows - 1.
  it('does not warn for non-newline-terminated input that fits --rows', () =>
    withDir((dir) => {
      const out = path.join(dir, 'no-nl.png');
      const res = run(['--out', out, '--rows', '4'], {
        input: 'l1\nl2\nl3\nl4',
      });
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain('warning');
    }));

  describe('fails loudly rather than writing a broken image', () => {
    it('rejects a missing --out', () => {
      const res = run(['--', 'echo', 'hi']);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('--out is required');
    });

    it('rejects a flag with no value', () => {
      for (const flag of ['--out', '--cols', '--rows', '--title']) {
        const res = run([flag]);
        expect(res.status, `${flag} accepted without a value`).toBe(1);
        expect(res.stderr).toContain('needs a value');
      }
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
