/**
 * Figure 3: dwell-response curve for PR #7767.
 * Reads the paired-run summaries and renders a static PNG (PR comment asset).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const D = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2];

const DWELLS = [0, 25, 50, 100, 200];
const rows = DWELLS.map((d) => {
  const o = JSON.parse(fs.readFileSync(path.join(D, `summary-dwell${d}.json`), 'utf8'));
  return {
    dwell: d,
    pairs: o.validPairs,
    arrival: o.stats.promptToProviderRequestArrivalMs,
    create: o.stats.sessionCreateMs,
  };
});
const aa = JSON.parse(fs.readFileSync(path.join(D, 'summary-AA-realtrees.json'), 'utf8'));

// ---- geometry -----------------------------------------------------------
const W = 980, H = 560;
const M = { t: 96, r: 210, b: 74, l: 88 };
const pw = W - M.l - M.r;
const ph = H - M.t - M.b;

const yMin = -18, yMax = 8;
const y = (v) => M.t + ((yMax - v) / (yMax - yMin)) * ph;
const x = (i) => M.l + (pw / (DWELLS.length - 1)) * i;

const S1 = 'var(--series-1)';
const S2 = 'var(--series-2)';

const line = (key, color) =>
  `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"
     points="${rows.map((r, i) => `${x(i)},${y(r[key].pairedMedianDelta)}`).join(' ')}"/>`;

const whiskers = (key, color) =>
  rows
    .map((r, i) => {
      const [lo, hi] = r[key].ci95;
      const cx = x(i);
      return `<line x1="${cx}" y1="${y(lo)}" x2="${cx}" y2="${y(hi)}" stroke="${color}" stroke-width="2" opacity=".45"/>
              <line x1="${cx - 5}" y1="${y(hi)}" x2="${cx + 5}" y2="${y(hi)}" stroke="${color}" stroke-width="2" opacity=".45"/>
              <line x1="${cx - 5}" y1="${y(lo)}" x2="${cx + 5}" y2="${y(lo)}" stroke="${color}" stroke-width="2" opacity=".45"/>`;
    })
    .join('');

const dots = (key, color) =>
  rows
    .map(
      (r, i) =>
        `<circle cx="${x(i)}" cy="${y(r[key].pairedMedianDelta)}" r="5" fill="${color}" stroke="var(--surface-1)" stroke-width="2"/>`,
    )
    .join('');

const aaBand = (() => {
  const [lo, hi] = aa.stats.sessionCreateMs.ci95;
  return `<rect x="${M.l}" y="${y(hi)}" width="${pw}" height="${y(lo) - y(hi)}" fill="var(--text-muted)" opacity=".13"/>`;
})();

const gridVals = [8, 4, 0, -4, -8, -12, -16];
const grid = gridVals
  .map(
    (v) =>
      `<line x1="${M.l}" y1="${y(v)}" x2="${M.l + pw}" y2="${y(v)}" stroke="var(--grid)" stroke-width="${v === 0 ? 1.5 : 1}" ${v === 0 ? '' : 'stroke-dasharray="3 4"'}/>
       <text x="${M.l - 12}" y="${y(v) + 4}" text-anchor="end" class="tick">${v > 0 ? '+' : ''}${v}</text>`,
  )
  .join('');

const xLabels = rows
  .map(
    (r, i) =>
      `<text x="${x(i)}" y="${M.t + ph + 26}" text-anchor="middle" class="tick">${r.dwell} ms</text>
       <text x="${x(i)}" y="${M.t + ph + 45}" text-anchor="middle" class="tick-sm">${r.pairs} pairs</text>`,
  )
  .join('');

const labelArrival = `<text x="${x(4) + 14}" y="${y(rows[4].arrival.pairedMedianDelta) + 4}" class="lab" fill="var(--series-1)">−10.4 ms</text>`;
const labelCreate = `<text x="${x(4) - 12}" y="${y(rows[4].create.pairedMedianDelta) - 16}" text-anchor="end" class="lab" fill="var(--series-2)">+0.6 ms</text>`;
const label0 = `<text x="${x(0) + 12}" y="${y(rows[0].arrival.pairedMedianDelta) - 30}" class="lab" fill="var(--series-1)">−0.4 ms</text>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{ --surface-1:#fcfcfb; --surface-2:#f4f4f1; --text-primary:#0b0b0b; --text-secondary:#52514e;
         --text-muted:#87857e; --grid:#dcdbd5; --series-1:#2a78d6; --series-2:#eb6834; }
  html,body{margin:0;background:var(--surface-2);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;}
  .card{width:${W}px;background:var(--surface-1);border:1px solid var(--grid);border-radius:12px;margin:24px;overflow:hidden;}
  h1{font-size:17px;margin:26px 30px 4px;color:var(--text-primary);letter-spacing:-.01em;}
  p.sub{font-size:13px;margin:0 30px 0;color:var(--text-secondary);line-height:1.5;}
  .tick{font-size:12px;fill:var(--text-secondary);}
  .tick-sm{font-size:10.5px;fill:var(--text-muted);}
  .lab{font-size:12.5px;font-weight:650;}
  .axis-title{font-size:11.5px;fill:var(--text-muted);text-transform:uppercase;letter-spacing:.07em;}
  .lg{font-size:12.5px;fill:var(--text-secondary);}
  .foot{font-size:11.5px;color:var(--text-muted);margin:0 30px 20px;line-height:1.55;}
</style></head><body>
<div class="card">
  <h1>The gain appears only when the session sits idle — and costs nothing when it doesn't</h1>
  <p class="sub">Paired A/B over real ACP children, candidate (4120aa01c) − control (d44030a4c). Negative is faster. Whiskers are seeded bootstrap 95% CIs of the paired median.</p>
  <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${aaBand}
    ${grid}
    <text class="axis-title" x="${M.l}" y="${M.t - 44}">paired median Δ (ms)</text>
    <text class="axis-title" x="${M.l + pw / 2}" y="${H - 12}" text-anchor="middle">post-session dwell before the first prompt</text>
    ${whiskers('arrival', S1)}
    ${whiskers('create', S2)}
    ${line('arrival', S1)}
    ${line('create', S2)}
    ${dots('arrival', S1)}
    ${dots('create', S2)}
    ${labelArrival}${labelCreate}${label0}
    ${xLabels}
    <g transform="translate(${M.l + pw + 26}, ${M.t + 6})">
      <circle cx="6" cy="6" r="5" fill="${S1}"/><text class="lg" x="20" y="10">prompt → provider</text>
      <text class="lg" x="20" y="26" opacity=".8">request arrival</text>
      <circle cx="6" cy="52" r="5" fill="${S2}"/><text class="lg" x="20" y="56">session create</text>
      <text class="lg" x="20" y="72" opacity=".8">(the claimed cost)</text>
      <rect x="1" y="112" width="10" height="10" fill="var(--text-muted)" opacity=".22"/>
      <text class="lg" x="20" y="121" opacity=".85">A/A noise floor</text>
    </g>
  </svg>
  <p class="foot">A/A noise floor = the same metric measured between two independently built clean worktrees at the <b>same</b> commit with a byte-identical <code>cli.js</code>, 15 pairs — a known-zero effect. Session-create Δ stays inside it at every dwell.<br>
  0 → 25 ms is where the preload finishes: past 25 ms the curve is flat, so the work completes inside the first 25 ms of idle time on this host.</p>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setContent(html);
await (await page.$('.card')).screenshot({ path: OUT });
await browser.close();
console.log('wrote', OUT);
