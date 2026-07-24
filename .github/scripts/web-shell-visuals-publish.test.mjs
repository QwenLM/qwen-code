/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildComment,
  classifyMagic,
  MAX_BYTES,
  MAX_CANDIDATES,
  MAX_GIFS,
  MAX_SCREENSHOTS,
  sanitizeName,
  selectImages,
  selectRenderShapingFiles,
} from './web-shell-visuals-publish.mjs';

const PNG = '89504e470d0a1a0a';
const GIF89 = '474946383961';
const GIF87 = '474946383761';

test('sanitizeName preserves the extension (regression: a trailing char broke the .png filter)', () => {
  assert.equal(
    sanitizeName('session-transcript-light.png'),
    'session-transcript-light.png',
  );
  assert.match(sanitizeName('model-dialog-dark.png'), /\.png$/);
  assert.match(sanitizeName('model-switch.gif'), /\.gif$/);
  // Disallowed characters become `_`, but the extension is untouched.
  assert.equal(sanitizeName('weird name!.png'), 'weird_name_.png');
  assert.equal(sanitizeName('trailing.png\n'), 'trailing.png_');
});

test('classifyMagic accepts real PNG/GIF magic and rejects mismatches', () => {
  assert.equal(classifyMagic('png', PNG), 'png');
  assert.equal(classifyMagic('gif', GIF89), 'gif');
  assert.equal(classifyMagic('gif', GIF87), 'gif');
  assert.equal(classifyMagic('png', GIF89), null); // GIF bytes in a .png
  assert.equal(classifyMagic('gif', PNG), null); // PNG bytes in a .gif
  assert.equal(classifyMagic('png', 'deadbeefdeadbeef'), null);
  assert.equal(classifyMagic('svg', PNG), null); // unknown extension
});

test('selectImages accepts valid images and keeps safe, extension-correct names', () => {
  const { accepted, warnings } = selectImages([
    { name: 'a-light.png', ext: 'png', size: 100, magic: PNG },
    { name: 'a-dark.png', ext: 'png', size: 100, magic: PNG },
    { name: 'model-switch.gif', ext: 'gif', size: 100, magic: GIF89 },
  ]);
  assert.equal(accepted.length, 3);
  assert.deepEqual(
    accepted.map((a) => a.safeName),
    ['a-light.png', 'a-dark.png', 'model-switch.gif'],
  );
  assert.deepEqual(warnings, []);
});

test('selectImages skips oversized and magic-invalid files', () => {
  let r = selectImages([
    { name: 'big.png', ext: 'png', size: MAX_BYTES + 1, magic: PNG },
  ]);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('exceeds')));

  r = selectImages([{ name: 'fake.png', ext: 'png', size: 10, magic: GIF89 }]);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('not a valid')));
});

test('selectImages caps screenshots per-kind WITHOUT starving gifs', () => {
  const many = [
    ...Array.from({ length: MAX_SCREENSHOTS + 5 }, (_, i) => ({
      name: `s${i}-light.png`,
      ext: 'png',
      size: 10,
      magic: PNG,
    })),
    { name: 'model-switch.gif', ext: 'gif', size: 10, magic: GIF89 },
  ];
  const { accepted } = selectImages(many);
  const png = accepted.filter((a) => a.kind === 'png').length;
  const gif = accepted.filter((a) => a.kind === 'gif').length;
  assert.equal(png, MAX_SCREENSHOTS); // screenshots capped
  assert.equal(gif, 1); // the gif survives the screenshot flood (not starved)
});

test('selectImages caps gifs per-kind', () => {
  const gifs = Array.from({ length: MAX_GIFS + 3 }, (_, i) => ({
    name: `flow${i}.gif`,
    ext: 'gif',
    size: 10,
    magic: GIF89,
  }));
  assert.equal(selectImages(gifs).accepted.length, MAX_GIFS);
});

test('selectImages bounds EXAMINED candidates so a junk flood cannot run forever', () => {
  const flood = Array.from({ length: MAX_CANDIDATES + 50 }, (_, i) => ({
    name: `x${i}.png`,
    ext: 'png',
    size: 10,
    magic: '00000000', // all invalid
  }));
  const { accepted, warnings } = selectImages(flood);
  assert.equal(accepted.length, 0);
  assert.ok(warnings.some((w) => w.includes('candidate files')));
});

test('buildComment lists before/after composites, labels flows, escapes, links the run', () => {
  const body = buildComment(
    [
      'session-transcript-light.png',
      'session-transcript-dark.png',
      'model-switch.gif',
    ],
    {
      rawBase: 'https://raw.example/imgs',
      shortSha: 'abc1234',
      runUrl: 'https://run.example/1',
    },
  );
  assert.match(body, /<!-- qwen:web-shell-visuals -->/);
  assert.match(body, /session-transcript-light\.png/);
  assert.match(body, /session-transcript-dark\.png/);
  assert.match(body, /Only \*\*screenshots\*\* that changed are shown/); // before/after framing
  assert.match(body, /model-switch\.gif/);
  assert.match(body, /Open the slash menu and switch model/); // flow label
  assert.match(body, /abc1234/);
  assert.match(body, /https:\/\/run\.example\/1/);
  // Each changed composite is listed as its own wide image (light + dark).
  const shotImgs = body
    .split('\n')
    .filter((l) => /^<img /.test(l) && /\.png/.test(l));
  assert.equal(shotImgs.length, 2);
  assert.doesNotMatch(body, /<table>/); // composites are a list, not a table
});

test('buildComment does not leak Object.prototype members as flow labels', () => {
  const body = buildComment(['toString.gif', 'constructor.gif'], {
    rawBase: 'r',
  });
  assert.doesNotMatch(body, /native code/);
  assert.match(body, /\*\*ToString\*\*/); // falls back to the prettified filename
});

test('buildComment says "no visual changes" when there are no composites', () => {
  const empty = buildComment([], { shortSha: 'abc1234' });
  assert.match(empty, /web-shell visual preview/);
  assert.doesNotMatch(empty, /<img /); // no screenshots, no flows
  assert.match(empty, /No screenshot changes against the PR base/);
});

test('buildComment lists a lone composite as one wide image (no light/dark table)', () => {
  const body = buildComment(['home-light.png'], { rawBase: 'r' });
  assert.match(body, /<img src="r\/home-light\.png" width="900"/);
  assert.doesNotMatch(body, /<table>/); // composites are a flat list now
  // A lone light shot no longer needs a dark-pair placeholder cell.
  assert.doesNotMatch(body, /<td>/);
});

// --- Empty-preview triage (coverage gap vs. genuinely no visual effect) ---

test('selectRenderShapingFiles keeps rendered .tsx/.css/.svg and drops logic/test/other-package edits', () => {
  const { files, total } = selectRenderShapingFiles([
    'packages/web-shell/client/components/WelcomeScreen.tsx',
    'packages/web-shell/client/components/worktree.module.css',
    'packages/webui/src/ui/button.tsx',
    'packages/web-shell/client/assets/icons/plan.svg',
    // Dropped: not a rendered extension...
    'packages/web-shell/client/hooks/useWorktree.ts',
    'packages/web-shell/client/types.d.ts',
    // ...not the rendered surface...
    'packages/core/src/utils/gitDiff.ts',
    'packages/web-shell/server/routes.tsx',
    'docs/web-shell.md',
    // ...or test/scenario code, which DRIVES the preview rather than being it.
    'packages/web-shell/client/e2e/visuals/screenshots.spec.ts',
    'packages/web-shell/client/components/Sidebar.test.tsx',
    'packages/web-shell/client/components/__tests__/Chip.tsx',
    // Blank lines from a trailing newline in the paths file.
    '',
    '   ',
  ]);
  assert.deepEqual(files, [
    'packages/web-shell/client/assets/icons/plan.svg',
    'packages/web-shell/client/components/WelcomeScreen.tsx',
    'packages/web-shell/client/components/worktree.module.css',
    'packages/webui/src/ui/button.tsx',
  ]);
  assert.equal(total, 4);
});

test('selectRenderShapingFiles caps the listed paths but reports the true total', () => {
  const many = Array.from(
    { length: 12 },
    (_, i) => `packages/web-shell/client/c/F${String(i).padStart(2, '0')}.tsx`,
  );
  const { files, total } = selectRenderShapingFiles(many, { maxListed: 3 });
  assert.equal(total, 12);
  assert.equal(files.length, 3);
  assert.equal(files[0], 'packages/web-shell/client/c/F00.tsx');
});

test('selectRenderShapingFiles tolerates a missing/undefined list', () => {
  assert.deepEqual(selectRenderShapingFiles(undefined), {
    files: [],
    total: 0,
  });
  assert.deepEqual(selectRenderShapingFiles([]), { files: [], total: 0 });
});

test('buildComment flags a possible COVERAGE GAP when UI changed but no view did', () => {
  const body = buildComment([], {
    shortSha: 'abc1234',
    changedPaths: [
      'packages/web-shell/client/components/WelcomeScreen.tsx',
      'packages/web-shell/client/hooks/useWorktree.ts', // logic — not listed
    ],
  });
  // The bare green check would read as "nothing broke"; it must not appear.
  assert.doesNotMatch(body, /✅/);
  assert.match(body, /1 render-shaping file:/); // singular
  assert.match(
    body,
    /`packages\/web-shell\/client\/components\/WelcomeScreen\.tsx`/,
  );
  assert.doesNotMatch(body, /useWorktree\.ts/);
  assert.match(body, /no scenario renders this UI/);
  assert.match(body, /screenshots\.spec\.ts/); // tells you where to fix it
});

test('buildComment keeps the green check when only non-rendering files changed', () => {
  const body = buildComment([], {
    shortSha: 'abc1234',
    changedPaths: [
      'packages/web-shell/client/hooks/useWorktree.ts',
      'packages/core/src/index.ts',
    ],
  });
  // A logic-only PR with no visual delta is EXPECTED — prompting here would
  // train everyone to ignore the prompt when it matters.
  assert.match(body, /✅ _No screenshot changes against the PR base\._/);
  assert.doesNotMatch(body, /coverage gap/);
});

test('buildComment does not triage when screenshots DID change', () => {
  const body = buildComment(['home-dark.png'], {
    rawBase: 'r',
    changedPaths: ['packages/web-shell/client/components/WelcomeScreen.tsx'],
  });
  assert.match(body, /<img /);
  assert.doesNotMatch(body, /coverage gap/);
  assert.doesNotMatch(body, /render-shaping/);
});

test('buildComment summarises the overflow instead of listing every path', () => {
  const body = buildComment([], {
    changedPaths: Array.from(
      { length: 10 },
      (_, i) =>
        `packages/web-shell/client/c/F${String(i).padStart(2, '0')}.tsx`,
    ),
  });
  assert.match(body, /10 render-shaping files:/); // plural
  assert.match(body, /_…and 2 more\._/); // 10 - MAX_LISTED_PATHS(8)
  assert.equal(body.split('\n').filter((l) => /^- `/.test(l)).length, 8);
});

test('buildComment neutralises a path that tries to break out of its code span', () => {
  const body = buildComment([], {
    changedPaths: [
      'packages/web-shell/client/`<img src=x onerror=alert(1)>`.tsx',
    ],
  });
  assert.doesNotMatch(body, /<img /); // the injected tag never becomes HTML
  assert.match(body, /&lt;img src=x/); // escaped, inside the code span
  // Exactly one path bullet, and it opens and closes its own span.
  const bullets = body.split('\n').filter((l) => /^- `/.test(l));
  assert.equal(bullets.length, 1);
  assert.equal((bullets[0].match(/`/g) ?? []).length, 2);
});

// --- Render-incomplete honesty (a failed scenario must not read as "no change") ---

test('buildComment: empty preview + renderIncomplete says RENDER FAILED, not no-change or coverage-gap', () => {
  const body = buildComment([], {
    shortSha: 'abc1234',
    runUrl: 'https://run.example/9',
    renderIncomplete: true,
    // Even with render-shaping files changed, a failed render must NOT show the
    // coverage-gap prompt — that would imply the render actually ran.
    changedPaths: ['packages/web-shell/client/components/WelcomeScreen.tsx'],
  });
  assert.match(body, /failed to render/i);
  assert.doesNotMatch(body, /✅/); // never the clean check
  assert.doesNotMatch(body, /No screenshot changes against the PR base/);
  assert.doesNotMatch(body, /coverage gap/); // coverage-gap prompt suppressed
  assert.doesNotMatch(body, /render-shaping/);
  assert.match(body, /https:\/\/run\.example\/9/); // links the run
});

test('buildComment: composites present + renderIncomplete warns the preview is PARTIAL', () => {
  const body = buildComment(['home-dark.png'], {
    rawBase: 'r',
    runUrl: 'https://run.example/9',
    renderIncomplete: true,
  });
  assert.match(body, /<img src="r\/home-dark\.png"/); // the shots that rendered still show
  assert.match(body, /failed to render/i); // ...prefixed by the partial-preview warning
  assert.match(body, /may be missing views/i);
});

test('buildComment: renderIncomplete false keeps the existing no-change / coverage-gap behavior', () => {
  // Complete render, no shots, no render-shaping files → the plain green check.
  const clean = buildComment([], {
    shortSha: 'abc1234',
    renderIncomplete: false,
    changedPaths: ['packages/core/src/index.ts'],
  });
  assert.match(clean, /✅ _No screenshot changes against the PR base\._/);
  assert.doesNotMatch(clean, /failed to render/i);

  // Complete render, no shots, render-shaping files → the coverage-gap prompt.
  const gap = buildComment([], {
    shortSha: 'abc1234',
    renderIncomplete: false,
    changedPaths: ['packages/web-shell/client/components/WelcomeScreen.tsx'],
  });
  assert.match(gap, /no scenario renders this UI/);
  assert.doesNotMatch(gap, /failed to render/i);
});

test('buildComment: render-failure note omits the run link when runUrl is absent', () => {
  const body = buildComment([], { renderIncomplete: true });
  assert.match(body, /failed to render/i);
  assert.doesNotMatch(body, /\[workflow run\]/); // no dangling empty link
});
