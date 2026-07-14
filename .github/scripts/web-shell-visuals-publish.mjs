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
 *   node web-shell-visuals-publish.mjs comment <stageDir> <rawBase> <shortSha> <runUrl> <bodyFile>
 */

import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Bounds on UNTRUSTED artifact content: cap files EXAMINED (so a flood of junk
// can't burn the budget before valid files), files ACCEPTED, and per-file size.
export const MAX_CANDIDATES = 200;
export const MAX_IMAGES = 14;
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
  const maxImages = opts.maxImages ?? MAX_IMAGES;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const accepted = [];
  const warnings = [];
  let examined = 0;
  for (const c of candidates) {
    examined += 1;
    if (examined > maxCandidates) {
      warnings.push(`examined ${maxCandidates} candidate files; stopping`);
      break;
    }
    if (accepted.length >= maxImages) {
      warnings.push(`reached the ${maxImages}-image cap; skipping the rest`);
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
    accepted.push({
      name: c.name,
      safeName: sanitizeName(basename(c.name)),
      kind,
    });
  }
  return { accepted, warnings };
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
 * Pure comment builder. `files` is the list of staged filenames (png + gif).
 * `ctx` is `{ rawBase, shortSha, runUrl }`. Returns the markdown body.
 */
export function buildComment(files, ctx = {}) {
  const rawBase = ctx.rawBase ?? '';
  const shortSha = ctx.shortSha ?? '';
  const runUrl = ctx.runUrl ?? '';
  const url = (name) => `${rawBase}/${encodeURIComponent(name)}`;

  const shots = files.filter((f) => /\.png$/i.test(f));
  const views = new Map();
  for (const f of shots) {
    const m = f.match(/^(.*)-(light|dark)\.png$/i);
    if (!m) continue;
    const [, view, theme] = m;
    const entry = views.get(view) || {};
    entry[theme.toLowerCase()] = f;
    views.set(view, entry);
  }
  const gifs = files.filter((f) => /\.gif$/i.test(f)).sort();

  const out = [];
  out.push('<!-- qwen:web-shell-visuals -->');
  out.push('### 🖼️ web-shell visual preview');
  out.push(
    `Auto-rendered from this PR head \`${esc(shortSha)}\` against a mock daemon (no real backend). Refreshes on every push.`,
  );
  out.push('');

  if (views.size > 0) {
    out.push('#### Screenshots · light / dark');
    out.push('');
    out.push('<table>');
    out.push('<tr><th align="left">view</th><th>light</th><th>dark</th></tr>');
    for (const [view, pair] of [...views.entries()].sort()) {
      const light = pair.light
        ? `<img src="${url(pair.light)}" width="360" alt="${esc(view)} light">`
        : '—';
      const dark = pair.dark
        ? `<img src="${url(pair.dark)}" width="360" alt="${esc(view)} dark">`
        : '—';
      out.push(
        `<tr><td valign="top"><sub>${esc(pretty(view))}</sub></td><td>${light}</td><td>${dark}</td></tr>`,
      );
    }
    out.push('</table>');
    out.push('');
  }

  if (gifs.length > 0) {
    out.push('#### Flows');
    out.push('');
    for (const g of gifs) {
      const key = g.replace(/\.gif$/i, '');
      out.push(`**${esc(FLOW_LABELS[key] || pretty(key))}**`);
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

function commentCli(stageDir, rawBase, shortSha, runUrl, bodyFile) {
  let files = [];
  try {
    files = readdirSync(stageDir);
  } catch {
    // Missing stage dir → empty preview body.
  }
  const body = buildComment(files, { rawBase, shortSha, runUrl });
  writeFileSync(bodyFile, body);
  process.stderr.write(`Comment body: ${body.split('\n').length} lines.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'stage') {
    stageCli(rest[0], rest[1], rest[2]);
  } else if (cmd === 'comment') {
    commentCli(rest[0], rest[1], rest[2], rest[3], rest[4]);
  } else {
    process.stderr.write(`unknown command: ${cmd ?? '(none)'}\n`);
    process.exit(2);
  }
}
