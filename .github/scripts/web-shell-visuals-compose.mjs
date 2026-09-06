/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Before/after compositor for the web-shell visuals preview.
 *
 * Given a `before/` (rendered from the PR's merge-base — the PR base) and an
 * `after/` (rendered from the PR head) set of `<view>-<theme>.png` screenshots,
 * pixel-diff each pair and, for the views that actually CHANGED, stitch a
 * single labelled "PR base (before) | this PR (after)" composite into `outDir`
 * (reusing the `<view>-<theme>.png` name so the publish step lists it as-is).
 *
 * Unchanged views are dropped — so a PR with no visual impact produces no
 * composites (the comment then says "no visual change") and a feature PR shows
 * exactly the surface it moved, with no per-PR understanding required. A view
 * present only in `after/` (a scenario the PR adds) is emitted after-only and
 * tagged NEW.
 *
 * The pure helpers (`parseShot`, `isChanged`, `planWork`) are exported and unit
 * -tested in web-shell-visuals-compose.test.mjs. The browser diff+stitch runs
 * as a CLI:
 *   node web-shell-visuals-compose.mjs <beforeDir> <afterDir> <outDir>
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// % of pixels that must differ for a view to count as "changed". Kept low so a
// small-but-real change (an icon swap ~24×24, a one-word label) still registers
// — this is the exact failure mode the preview exists to catch. The fraction is
// measured AFTER the cluster denoise (see MIN_CLUSTER_NEIGHBORS): base and head
// render in SEPARATE CI jobs, so font anti-aliasing is not bit-identical
// between them and a text-heavy view scatters ~0.1-0.3% of isolated edge pixels
// that would otherwise cross this line; the denoise erodes that scatter to ~0.
// At 1280×800, 0.02% ≈ 205 px.
export const CHANGED_PCT_THRESHOLD = 0.02;
// A pixel "differs" when |ΔR|+|ΔG|+|ΔB| exceeds this (ignores imperceptible AA).
export const PER_PIXEL_DELTA = 30;
// Minimum of the 8 neighbours that must ALSO differ for a differing pixel to be
// counted. Cross-job font-AA leaves a scatter of isolated / 1px-wide differing
// pixels along glyph edges (a 1px-line pixel has 2 differing neighbours, an
// isolated one has 0) — below this cutoff they erode to nothing, while a real
// change (badge, chip, icon, panel) is a solid block whose interior keeps 5-8.
export const MIN_CLUSTER_NEIGHBORS = 4;
// Display width of each panel in the stitched composite.
export const PANEL_WIDTH = 560;

/**
 * Count differing pixels that sit in a cluster: (x,y) counts only when at least
 * `minNeighbors` of its 8 neighbours also differ. `changed` is a row-major 0/1
 * mask of length `width*height`. Pure + deterministic (unit-tested); this is
 * what drops cross-job font-AA scatter before the changed fraction is measured.
 */
export function countDenoisedChanges(
  changed,
  width,
  height,
  minNeighbors = MIN_CLUSTER_NEIGHBORS,
) {
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!changed[y * width + x]) continue;
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (changed[ny * width + nx]) neighbors++;
        }
      }
      if (neighbors >= minNeighbors) count++;
    }
  }
  return count;
}

/** Unpack a base64, LSB-first bit-mask into a 0/1 Uint8Array of length `n`. */
export function unpackBitMask(base64, n) {
  const buf = Buffer.from(base64, 'base64');
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (buf[i >> 3] >> (i & 7)) & 1;
  return out;
}

/** Parse `<view>-<light|dark>.png` → `{ view, theme }` or null (ignore others). */
export function parseShot(name) {
  const m = basename(String(name)).match(/^(.*)-(light|dark)\.png$/i);
  return m ? { view: m[1], theme: m[2].toLowerCase() } : null;
}

/**
 * Decide whether a view changed. A view with no baseline (added by the PR)
 * counts as changed so it is shown (after-only, NEW). Otherwise it is changed
 * only when the differing-pixel fraction reaches the threshold.
 */
export function isChanged(
  { hasBefore, changedPct },
  threshold = CHANGED_PCT_THRESHOLD,
) {
  if (!hasBefore) return true;
  return changedPct >= threshold;
}

/**
 * Pure plan over filenames: for each real `<view>-<theme>.png` in `after`,
 * whether a same-named baseline exists in `before`. Sorted, deterministic.
 */
export function planWork(afterNames, beforeNames) {
  const before = new Set(
    (beforeNames ?? []).filter((n) => parseShot(n)).map((n) => basename(n)),
  );
  return (afterNames ?? [])
    .filter((n) => parseShot(n))
    .map((n) => basename(n))
    .sort()
    .map((name) => ({ name, hasBefore: before.has(name) }));
}

const dataUri = (path) =>
  `data:image/png;base64,${readFileSync(path).toString('base64')}`;

// Minimal HTML-escape for values interpolated into the composite markup. The
// view/theme come from PR-controlled filenames and render only in the capture
// job's own Chromium (which already runs PR code — no boundary crossed), so
// this is purely hygiene, keeping that safety argument obvious.
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Self-describing composite: the before/after labels and the diff magnitude are
// burned into the image, so it reads correctly even opened on its own.
function compositeHtml({
  view,
  theme,
  hasBefore,
  changedPct,
  beforeUri,
  afterUri,
}) {
  const badge = hasBefore
    ? `${changedPct.toFixed(1)}% changed`
    : 'new scenario';
  const beforePanel = hasBefore
    ? `<figure style="margin:0"><figcaption style="font:600 12px system-ui;color:#6b7280;text-align:center;margin-bottom:6px">PR base (before)</figcaption><img src="${beforeUri}" style="display:block;width:${PANEL_WIDTH}px;border:1px solid #cbd5e1;border-radius:6px"></figure>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#e5e7eb">
    <div id="cap" style="display:inline-block;padding:16px;font-family:-apple-system,system-ui,sans-serif">
      <div style="font:600 14px system-ui;color:#111827;margin:0 2px 10px">
        ${esc(view)} · ${esc(theme)}${hasBefore ? '' : ' · NEW'}
        <span style="color:#6b7280;font-weight:400"> — ${badge}</span>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start">
        ${beforePanel}
        <figure style="margin:0"><figcaption style="font:600 12px system-ui;color:#2563eb;text-align:center;margin-bottom:6px">this PR (after)</figcaption><img src="${afterUri}" style="display:block;width:${PANEL_WIDTH}px;border:1px solid #93c5fd;border-radius:6px"></figure>
      </div>
    </div></body></html>`;
}

// Differing-pixel fraction (%) between two PNG data URIs. The browser decodes on
// a canvas (no native image deps) and returns a compact bit-mask of which pixels
// differ by > PER_PIXEL_DELTA; the cluster denoise + count then run here in node
// against the unit-tested `countDenoisedChanges`, so there is a single tested
// implementation of the metric. A size mismatch or an undecodable image
// short-circuits to 100% (both are themselves a visual change, and must be shown
// rather than silently dropped).
async function diffPct(page, beforeUri, afterUri) {
  const result = await page.evaluate(
    // This arrow runs in the BROWSER (page.evaluate), where Image and document
    // are defined; declare them so eslint's node env doesn't flag no-undef.
    // (btoa is a shared node+browser global, so it needs no declaration here.)
    /* global Image, document */
    async ([a, b, delta]) => {
      const load = (src) =>
        new Promise((res) => {
          const img = new Image();
          img.onload = () => res(img);
          // A truncated/corrupt PNG (a best-effort base render killed
          // mid-write) must still settle, or page.evaluate would hang to the
          // job timeout and take the artifacts with it.
          img.onerror = () => res(null);
          img.src = src;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      // An undecodable image, or a dimension change, IS a visual change: show it
      // (comparing only the overlapping rectangle would hide a size change).
      if (!ia || !ib) return { full: true };
      if (ia.width !== ib.width || ia.height !== ib.height)
        return { full: true };
      const w = ia.width;
      const h = ia.height;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(ia, 0, 0);
      const da = ctx.getImageData(0, 0, w, h).data;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(ib, 0, 0);
      const db = ctx.getImageData(0, 0, w, h).data;
      const n = w * h;
      // Bit-pack the differing-pixel mask (LSB-first) so it transfers to node in
      // ~n/8 bytes rather than a per-pixel object.
      const bytes = new Uint8Array((n + 7) >> 3);
      for (let i = 0; i < n; i++) {
        const j = i * 4;
        if (
          Math.abs(da[j] - db[j]) +
            Math.abs(da[j + 1] - db[j + 1]) +
            Math.abs(da[j + 2] - db[j + 2]) >
          delta
        )
          bytes[i >> 3] |= 1 << (i & 7);
      }
      let bin = '';
      for (let i = 0; i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i]);
      return { w, h, mask: btoa(bin) };
    },
    [beforeUri, afterUri, PER_PIXEL_DELTA],
  );
  if (result.full) return 100;
  const n = result.w * result.h;
  if (!n) return 0;
  const changed = unpackBitMask(result.mask, n);
  return (countDenoisedChanges(changed, result.w, result.h) / n) * 100;
}

async function composeCli(beforeDir, afterDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  const list = (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };
  const work = planWork(list(afterDir), list(beforeDir));

  // Lazy import so the pure exports (parseShot / isChanged / planWork) load
  // WITHOUT @playwright/test — the dependency-free `github_ci_only` test step
  // (no npm ci) imports this module for those helpers and would otherwise die
  // with ERR_MODULE_NOT_FOUND on a top-level Playwright import.
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  const manifest = [];
  // Always close the browser, even if a diff/screenshot rejects mid-loop (an
  // evaluate timeout or CDP disconnect on a corrupt/oversized PNG) — otherwise
  // a ~200 MB Chromium child would leak for the rest of the CI job.
  try {
    // deviceScaleFactor:2 keeps the burned-in labels crisp on retina/GitHub zoom.
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    for (const { name, hasBefore } of work) {
      const { view, theme } = parseShot(name);
      const afterUri = dataUri(join(afterDir, name));
      const beforeUri = hasBefore ? dataUri(join(beforeDir, name)) : null;
      const changedPct = hasBefore
        ? await diffPct(page, beforeUri, afterUri)
        : 100;
      const changed = isChanged({ hasBefore, changedPct });
      manifest.push({
        name,
        view,
        theme,
        hasBefore,
        changedPct: Number(changedPct.toFixed(2)),
        changed,
      });
      if (!changed) continue;
      await page.setContent(
        compositeHtml({
          view,
          theme,
          hasBefore,
          changedPct,
          beforeUri,
          afterUri,
        }),
      );
      await page.locator('#cap').screenshot({ path: join(outDir, name) });
    }
  } finally {
    await browser.close();
  }

  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  const composited = manifest.filter((e) => e.changed).length;
  for (const e of manifest) {
    const tag = e.changed ? (e.hasBefore ? 'CHANGED' : 'NEW    ') : 'skip   ';
    process.stderr.write(`  ${tag} ${e.name} (${e.changedPct}% diff)\n`);
  }
  // stdout = composited count, for logs only. Nothing parses it: the workflow
  // re-counts the written composites via `find`, and the post/no-post decision
  // lives in the publish workflow.
  process.stdout.write(`${composited}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [beforeDir, afterDir, outDir] = process.argv.slice(2);
  if (!beforeDir || !afterDir || !outDir) {
    process.stderr.write(
      'usage: web-shell-visuals-compose.mjs <beforeDir> <afterDir> <outDir>\n',
    );
    process.exit(2);
  }
  composeCli(beforeDir, afterDir, outDir).catch((err) => {
    // Surface a clean diagnostic + non-zero exit instead of an
    // UnhandledPromiseRejectionWarning (e.g. a missing @playwright/test).
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
