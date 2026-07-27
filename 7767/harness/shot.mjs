/**
 * ANSI terminal capture -> PNG, via a minimal xterm-style HTML page.
 * usage: node shot.mjs <in.ansi> <out.png> [titleText]
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const [, , inFile, outFile, title = ''] = process.argv;
const raw = fs.readFileSync(inFile, 'utf8').replace(/^\^D/, '').replace(/\r/g, '');

const FG = {
  30: '#3b3b3b', 31: '#ff6b6b', 32: '#4ec9a0', 33: '#e3b341', 34: '#6aa8f0',
  35: '#d778c8', 36: '#4dc4d6', 37: '#d4d4d4', 90: '#8b8b8b', 91: '#ff8787',
  92: '#73d69f', 93: '#ecc94b', 94: '#8ab4f8', 95: '#e39ddb', 96: '#66d9e8', 97: '#ffffff',
};

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ansiToHtml(text) {
  let out = '';
  let open = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1].split(';').filter(Boolean).map(Number);
    if (!codes.length || codes.includes(0)) {
      while (open > 0) { out += '</span>'; open--; }
      continue;
    }
    const style = [];
    for (const code of codes) {
      if (code === 1) style.push('font-weight:700');
      else if (code === 2) style.push('opacity:.72');
      else if (FG[code]) style.push(`color:${FG[code]}`);
    }
    out += `<span style="${style.join(';')}">`;
    open++;
  }
  out += esc(text.slice(last));
  while (open > 0) { out += '</span>'; open--; }
  return out;
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#12141a;}
  .win{display:inline-block;min-width:1180px;padding:0;background:#1b1e26;border-radius:10px;
       box-shadow:0 18px 60px rgba(0,0,0,.55);overflow:hidden;margin:22px;}
  .bar{height:34px;background:#252932;display:flex;align-items:center;padding:0 14px;gap:8px;
       font:600 12px/1 ui-sans-serif,system-ui;color:#9aa0ac;}
  .dot{width:11px;height:11px;border-radius:50%;}
  pre{margin:0;padding:18px 22px 22px;color:#d4d4d4;background:#1b1e26;
      font:13px/1.62 "SFMono-Regular",Menlo,Consolas,monospace;white-space:pre;}
</style></head><body><div class="win">
<div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
<span style="margin-left:10px">${esc(title)}</span></div>
<pre>${ansiToHtml(raw)}</pre></div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setContent(html);
const el = await page.$('.win');
await el.screenshot({ path: outFile });
await browser.close();
console.log('wrote', outFile);
