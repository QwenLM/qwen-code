/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Before/after compositor for the web-shell visuals preview.
 *
 * Given a `before/` (rendered from the PR's merge-base, i.e. `main`) and an
 * `after/` (rendered from the PR head) set of `<view>-<theme>.png` screenshots,
 * pixel-diff each pair and, for the views that actually CHANGED, stitch a
 * single labelled "main (before) | this PR (after)" composite into `outDir`
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

import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// % of pixels that must differ for a view to count as "changed". Small but
// non-zero so sub-pixel/AA jitter between two identical renders is ignored.
export const CHANGED_PCT_THRESHOLD = 0.1;
// A pixel "differs" when |ΔR|+|ΔG|+|ΔB| exceeds this (ignores imperceptible AA).
export const PER_PIXEL_DELTA = 30;
// Display width of each panel in the stitched composite.
export const PANEL_WIDTH = 560;

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
    ? `<figure style="margin:0"><figcaption style="font:600 12px system-ui;color:#6b7280;text-align:center;margin-bottom:6px">main (before)</figcaption><img src="${beforeUri}" style="display:block;width:${PANEL_WIDTH}px;border:1px solid #cbd5e1;border-radius:6px"></figure>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#e5e7eb">
    <div id="cap" style="display:inline-block;padding:16px;font-family:-apple-system,system-ui,sans-serif">
      <div style="font:600 14px system-ui;color:#111827;margin:0 2px 10px">
        ${view} · ${theme}${hasBefore ? '' : ' · NEW'}
        <span style="color:#6b7280;font-weight:400"> — ${badge}</span>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start">
        ${beforePanel}
        <figure style="margin:0"><figcaption style="font:600 12px system-ui;color:#2563eb;text-align:center;margin-bottom:6px">this PR (after)</figcaption><img src="${afterUri}" style="display:block;width:${PANEL_WIDTH}px;border:1px solid #93c5fd;border-radius:6px"></figure>
      </div>
    </div></body></html>`;
}

// Differing-pixel fraction (%) between two same-size PNG data URIs, measured on
// a canvas (no native image deps). Compares over the overlapping region so a
// height change between before/after still yields a sane number.
async function diffPct(page, beforeUri, afterUri) {
  return page.evaluate(
    // This arrow runs in the BROWSER (page.evaluate), where Image/document are
    // defined; declare them so eslint's node env doesn't flag no-undef.
    /* global Image, document */
    async ([a, b, delta]) => {
      const load = (src) =>
        new Promise((res) => {
          const img = new Image();
          img.onload = () => res(img);
          img.src = src;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(ia, 0, 0);
      const da = ctx.getImageData(0, 0, w, h).data;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(ib, 0, 0);
      const db = ctx.getImageData(0, 0, w, h).data;
      let diff = 0;
      const n = w * h;
      for (let i = 0; i < n; i++) {
        const j = i * 4;
        if (
          Math.abs(da[j] - db[j]) +
            Math.abs(da[j + 1] - db[j + 1]) +
            Math.abs(da[j + 2] - db[j + 2]) >
          delta
        )
          diff++;
      }
      return n ? (diff / n) * 100 : 0;
    },
    [beforeUri, afterUri, PER_PIXEL_DELTA],
  );
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

  const browser = await chromium.launch();
  // deviceScaleFactor:2 keeps the burned-in labels crisp on retina/GitHub zoom.
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  const manifest = [];
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
  await browser.close();

  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  const composited = manifest.filter((e) => e.changed).length;
  for (const e of manifest) {
    const tag = e.changed ? (e.hasBefore ? 'CHANGED' : 'NEW    ') : 'skip   ';
    process.stderr.write(`  ${tag} ${e.name} (${e.changedPct}% diff)\n`);
  }
  // stdout = composited count (the workflow reads it to decide whether to post).
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
  composeCli(beforeDir, afterDir, outDir);
}
