/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Staging + comment generation for the web-shell visuals publish workflow.
 *
 * Extracted from the inline workflow so the image validation and comment
 * construction — the parts that consume UNTRUSTED PR output and were
 * previously untested — have unit coverage. (A shell sanitizer bug once
 * appended `_` to every filename and silently produced an empty preview; the
 * pure functions here are covered by web-shell-visuals-publish.test.mjs.)
 *
 * The pure helpers (`sanitizeName`, `classifyMagic`, `selectImages`,
 * `buildComment`) are exported and tested. The file also runs as a CLI for the
 * workflow:
 *   node web-shell-visuals-publish.mjs stage   <screenshotsDir> <gifsDir> <stageDir>
 *   node web-shell-visuals-publish.mjs comment <stageDir> <rawBase> <shortSha> <runUrl> <bodyFile> [changedPathsFile]
 */

import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Bounds on UNTRUSTED artifact content: cap files EXAMINED (so a flood of junk
// can't burn the budget before valid files), files ACCEPTED, and per-file size.
export const MAX_CANDIDATES = 200;
export const MAX_SCREENSHOTS = 20;
export const MAX_GIFS = 6;
export const MAX_BYTES = 3 * 1024 * 1024;

const PNG_MAGIC = '89504e470d0a1a0a';
const GIF_MAGICS = new Set(['474946383961', '474946383761']); // GIF89a / GIF87a

const FLOW_LABELS = {
  'model-switch': 'Open the slash menu and switch model',
  'prompt-stream': 'Submit a prompt and watch the reply stream in',
};

/**
 * Sanitize to the hosted-filename charset WITHOUT corrupting the extension.
 * (The shell version captured `basename` through a pipe, turning its trailing
 * newline into `_` and breaking the `.png`/`.gif` filter — this cannot.)
 */
export function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Classify by first-bytes magic hex → 'png' | 'gif' | null. */
export function classifyMagic(ext, magicHex) {
  const hex = String(magicHex).toLowerCase();
  if (ext === 'png') return hex.slice(0, 16) === PNG_MAGIC ? 'png' : null;
  if (ext === 'gif') return GIF_MAGICS.has(hex.slice(0, 12)) ? 'gif' : null;
  return null;
}

/**
 * Pure selection over candidates `[{ name, ext, size, magic }]` (in order):
 * apply the examined/accepted/size caps and magic validation. Returns
 * `{ accepted: [{ name, safeName, kind }], warnings: string[] }`.
 */
export function selectImages(candidates, opts = {}) {
  const maxCandidates = opts.maxCandidates ?? MAX_CANDIDATES;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  // Per-kind caps so a large screenshot set can't starve the flow GIFs: a
  // shared total cap over PNG-first candidates would let >=N screenshots
  // silently drop every GIF from the preview.
  const maxPerKind = {
    png: opts.maxScreenshots ?? MAX_SCREENSHOTS,
    gif: opts.maxGifs ?? MAX_GIFS,
  };
  const kindCount = { png: 0, gif: 0 };
  const accepted = [];
  const warnings = [];
  let examined = 0;
  for (const c of candidates) {
    examined += 1;
    if (examined > maxCandidates) {
      warnings.push(`examined ${maxCandidates} candidate files; stopping`);
      break;
    }
    if (c.size > maxBytes) {
      warnings.push(`${c.name} exceeds ${maxBytes} bytes; skipping`);
      continue;
    }
    const kind = classifyMagic(c.ext, c.magic);
    if (!kind) {
      warnings.push(`${c.name} is not a valid ${c.ext}; skipping`);
      continue;
    }
    if (kindCount[kind] >= maxPerKind[kind]) {
      warnings.push(
        `reached the ${kind} cap (${maxPerKind[kind]}); skipping ${c.name}`,
      );
      continue;
    }
    kindCount[kind] += 1;
    accepted.push({
      name: c.name,
      safeName: sanitizeName(basename(c.name)),
      kind,
    });
  }
  return { accepted, warnings };
}

/**
 * Directories that feed the rendered bundle. Kept in sync with the `paths:`
 * trigger in .github/workflows/web-shell-visuals.yml — that trigger decides
 * whether we render at all; this decides whether a "nothing changed" RESULT
 * deserves a second look.
 */
const RENDER_SHAPING_PREFIXES = [
  'packages/web-shell/client/',
  'packages/webui/src/',
];

/**
 * Extensions that change what a view LOOKS like. Deliberately narrow: a `.ts`
 * hook/util/type edit routinely lands with no visual delta, and flagging those
 * would train everyone to ignore the prompt. `.css` covers `.module.css`; every
 * `.svg` under the render surface is a bundled UI icon (client/assets/icons),
 * so a changed icon that moves no pixel is the same coverage signal.
 */
const RENDER_SHAPING_EXT = /\.(tsx|css|svg)$/i;

/** Test + scenario code DRIVES the preview; it is not the UI under preview. */
const NOT_PRODUCT_UI =
  /(^|\/)(__tests__|__mocks__|e2e)\/|\.(test|spec)\.[jt]sx?$/i;

/** How many paths to name before collapsing the rest into a count. */
export const MAX_LISTED_PATHS = 8;

/**
 * Pick the changed paths that shape rendering, from the PR's full file list.
 * Returns `{ files, total }` — `files` capped at `maxListed`, `total` the full
 * count, so the caller can say "and N more" without re-deriving it.
 *
 * This exists because "no view changed" is ambiguous: it means either "this
 * change genuinely has no visual effect" or "no scenario renders this UI at
 * all". The second is a COVERAGE gap that has shipped silently three times
 * (#7035 primary label, #7221 worktree badge, #7365 empty-state toggle), each
 * time caught only because a human happened to notice the missing image.
 */
export function selectRenderShapingFiles(paths, opts = {}) {
  const maxListed = opts.maxListed ?? MAX_LISTED_PATHS;
  const matched = [];
  for (const raw of paths ?? []) {
    const p = String(raw).trim();
    if (!p) continue;
    if (!RENDER_SHAPING_PREFIXES.some((prefix) => p.startsWith(prefix)))
      continue;
    if (!RENDER_SHAPING_EXT.test(p)) continue;
    if (NOT_PRODUCT_UI.test(p)) continue;
    matched.push(p);
  }
  matched.sort();
  return { files: matched.slice(0, maxListed), total: matched.length };
}

/** Self-defending HTML escaping for interpolated values. */
export const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const pretty = (s) =>
  s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Render a path inside a code span without letting it escape. Backticks would
 * close the span (and let the rest of the path inject markdown/HTML), so they
 * go; `esc` then neutralises the remainder. Both are no-ops for real paths.
 */
const codePath = (p) => `\`${esc(String(p).replace(/[`\r\n]/g, ''))}\``;

/**
 * Pure comment builder. `files` is the list of staged filenames (png + gif).
 * `ctx` is `{ rawBase, shortSha, runUrl, changedPaths }`, where `changedPaths`
 * is the PR's full changed-file list (used only to triage an empty preview).
 * Returns the markdown body.
 */
export function buildComment(files, ctx = {}) {
  const rawBase = ctx.rawBase ?? '';
  const shortSha = ctx.shortSha ?? '';
  const runUrl = ctx.runUrl ?? '';
  const url = (name) => `${rawBase}/${encodeURIComponent(name)}`;

  // Screenshots are before/after COMPOSITES (`<view>-<theme>.png`), one per
  // changed view+theme. The compositor already dropped unchanged views, so an
  // empty set means "no visual change vs main". The before/after labels and the
  // view name are burned into each image, so we just list them.
  const shots = files.filter((f) => /\.png$/i.test(f)).sort();
  const gifs = files.filter((f) => /\.gif$/i.test(f)).sort();

  const out = [];
  out.push('<!-- qwen:web-shell-visuals -->');
  out.push('### 🖼️ web-shell visual preview');
  out.push(
    `Rendered against a mock daemon (no real backend): the PR base vs this PR head \`${esc(shortSha)}\`. Only **screenshots** that changed are shown (flows below, if any, are head-only) — refreshes on every push.`,
  );
  out.push('');

  out.push('#### Screenshots · before / after');
  out.push('');
  if (shots.length > 0) {
    for (const f of shots) {
      out.push(
        `<img src="${url(f)}" width="900" alt="${esc(f.replace(/\.png$/i, ''))} before/after">`,
      );
      out.push('');
    }
  } else {
    // An empty preview is ambiguous, so say WHICH of the two things it means.
    // "No view changed" is only a clean bill of health if nothing that shapes a
    // view was touched; when render-shaping files DID change, the same result
    // may instead mean no scenario renders them — a coverage gap that reads as
    // reassurance if we print a bare green check (see selectRenderShapingFiles).
    const shaping = selectRenderShapingFiles(ctx.changedPaths);
    if (shaping.total > 0) {
      const noun = shaping.total === 1 ? 'file' : 'files';
      out.push(
        `ℹ️ _No screenshot changed against the PR base_ — but this PR edits ${shaping.total} render-shaping ${noun}:`,
      );
      out.push('');
      for (const f of shaping.files) out.push(`- ${codePath(f)}`);
      if (shaping.total > shaping.files.length) {
        out.push(`- _…and ${shaping.total - shaping.files.length} more._`);
      }
      out.push('');
      out.push(
        'Either the change has no visual effect (logic, plumbing, a state the scenarios never reach), or **no scenario renders this UI** — in which case the preview cannot see it, and an empty result is a coverage gap rather than a clean bill of health. To make it visible, add a scenario to `packages/web-shell/client/e2e/visuals/screenshots.spec.ts` that seeds whatever state the UI is gated on; it then appears here as a head-only (NEW) capture.',
      );
      out.push('');
    } else {
      out.push('✅ _No screenshot changes against the PR base._');
      out.push('');
    }
  }

  if (gifs.length > 0) {
    out.push('#### Flows');
    out.push('');
    for (const g of gifs) {
      const key = g.replace(/\.gif$/i, '');
      // Own-property only: `FLOW_LABELS[key]` would otherwise inherit
      // Object.prototype members, so a `toString.gif` would render the function
      // source as the label.
      const label = Object.hasOwn(FLOW_LABELS, key)
        ? FLOW_LABELS[key]
        : pretty(key);
      out.push(`**${esc(label)}**`);
      out.push('');
      out.push(`<img src="${url(g)}" width="640" alt="${esc(key)} flow">`);
      out.push('');
    }
  }

  if (runUrl) {
    out.push(
      `<sub>Full-resolution recordings (.webm) are attached to the <a href="${esc(runUrl)}">workflow run</a>.</sub>`,
    );
  }
  out.push('');
  out.push('— _Qwen Code · web-shell visuals_');
  return out.join('\n') + '\n';
}

// --- I/O layer (exercised by the CLI; not part of the unit-tested surface) ---

function readMagicHex(path, n = 8) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read).toString('hex');
  } finally {
    closeSync(fd);
  }
}

function gatherCandidates(dir, ext) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith(`.${ext}`))
    .sort()
    .map((n) => {
      const path = join(dir, n);
      let size = Infinity;
      let magic = '';
      try {
        size = statSync(path).size;
        magic = readMagicHex(path);
      } catch {
        // Unreadable entry: leave size=Infinity/magic='' so it is skipped.
      }
      return { name: n, ext, size, magic, path };
    });
}

function stageCli(screenshotsDir, gifsDir, stageDir) {
  const candidates = [
    ...gatherCandidates(screenshotsDir, 'png'),
    ...gatherCandidates(gifsDir, 'gif'),
  ];
  const { accepted, warnings } = selectImages(candidates);
  for (const w of warnings) process.stderr.write(`::warning::${w}\n`);
  mkdirSync(stageDir, { recursive: true });
  const byName = new Map(candidates.map((c) => [c.name, c.path]));
  for (const a of accepted) {
    copyFileSync(byName.get(a.name), join(stageDir, a.safeName));
  }
  // stdout = accepted count (the workflow reads it to decide whether to post).
  process.stdout.write(`${accepted.length}\n`);
}

function commentCli(stageDir, rawBase, shortSha, runUrl, bodyFile, pathsFile) {
  let files = [];
  try {
    files = readdirSync(stageDir);
  } catch {
    // Missing stage dir → empty preview body.
  }
  // Newline-delimited changed paths, via a file rather than argv: a PR can
  // change thousands of files, and paths are attacker-influenced (fork PRs).
  // Best-effort — if the workflow's API call failed the file is absent/empty,
  // and the comment falls back to the plain "no screenshot changes" line.
  let changedPaths = [];
  if (pathsFile) {
    try {
      changedPaths = readFileSync(pathsFile, 'utf8').split('\n');
    } catch {
      // Unreadable → treat as "unknown", not as "nothing changed".
    }
  }
  const body = buildComment(files, { rawBase, shortSha, runUrl, changedPaths });
  writeFileSync(bodyFile, body);
  process.stderr.write(`Comment body: ${body.split('\n').length} lines.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'stage') {
    stageCli(rest[0], rest[1], rest[2]);
  } else if (cmd === 'comment') {
    commentCli(rest[0], rest[1], rest[2], rest[3], rest[4], rest[5]);
  } else {
    process.stderr.write(`unknown command: ${cmd ?? '(none)'}\n`);
    process.exit(2);
  }
}
