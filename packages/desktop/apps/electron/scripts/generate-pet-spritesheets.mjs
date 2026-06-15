/**
 * Generates the built-in pet spritesheet — the Qwen capybara HEAD
 * (clean-room original vector art, modeled on the reference design).
 *
 * Run from the desktop package:  node apps/electron/scripts/generate-pet-spritesheets.mjs
 * Pass --contact to also emit a QA contact sheet next to the webp.
 *
 * Output: apps/electron/src/renderer/assets/pets/qwen-spritesheet.webp
 *
 * The head is drawn in a 1024-unit design space and scaled into each cell.
 * Atlas contract (shared with renderer/pets/pet-animation.ts):
 *   1536x1872, 8 cols x 9 rows, cell 192x208, transparent background.
 *   Rows: 0 idle, 1 running-right, 2 running-left, 3 waving, 4 jumping,
 *         5 failed, 6 waiting, 7 running, 8 review.
 */
import sharp from 'sharp';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CW = 192, CH = 208, COLS = 8, ROWS = 9;
const AW = CW * COLS, AH = CH * ROWS;

const OUTLINE = '#250506', FUR = '#D8B778', EARIN = '#E2C58F', MUZZLE = '#C99768';

// Fit the 1024-space design into the cell, centred.
const S = 0.31, TX = -62.7, TY = -17.2;
const RCX = 96, RCY = 104; // cell-space rotation centre

const HEAD = `
  <circle cx="342" cy="260" r="70" fill="${FUR}"/>
  <circle cx="682" cy="260" r="70" fill="${FUR}"/>
  <circle cx="342" cy="260" r="39" fill="${EARIN}"/>
  <circle cx="682" cy="260" r="39" fill="${EARIN}"/>
  <path d="M480 182 C454 160 468 132 505 143 C498 97 532 79 563 101 C591 122 585 159 560 181" fill="${FUR}"/>
  <path d="M512 162 C344 162 266 255 248 421 C232 565 319 686 512 686 C705 686 792 565 776 421 C758 255 680 162 512 162Z" fill="${FUR}"/>
`;
const MUZ = `<path d="M458 384 C469 349 555 349 566 384 L594 511 C608 585 558 616 512 616 C466 616 416 585 430 511 L458 384Z" fill="${MUZZLE}"/>`;
const WHISKERS = `
  <path d="M249 456 L226 452"/><path d="M248 480 L224 480"/><path d="M249 504 L226 508"/>
  <path d="M775 456 L798 452"/><path d="M776 480 L800 480"/><path d="M775 504 L798 508"/>
`;

function eyes(style) {
  const sw = 18;
  if (style === 'happy') {
    return `<path d="M392 352 Q415 322 438 352" fill="none" stroke-width="${sw}"/>` +
      `<path d="M632 352 Q655 322 678 352" fill="none" stroke-width="${sw}"/>`;
  }
  if (style === 'x') {
    const x = (cx) => `<path d="M${cx - 17} 330 L${cx + 17} 362" stroke-width="16"/><path d="M${cx + 17} 330 L${cx - 17} 362" stroke-width="16"/>`;
    return x(415) + x(655);
  }
  if (style === 'blink') {
    return `<path d="M394 348 L436 348" stroke-width="${sw}"/><path d="M634 348 L676 348" stroke-width="${sw}"/>`;
  }
  const yy = style === 'up' ? -14 : 0;
  return `<path d="M392 ${335 + yy} L438 ${353 + yy}" stroke-width="${sw}"/>` +
    `<path d="M632 ${353 + yy} L678 ${335 + yy}" stroke-width="${sw}"/>`;
}
function noseMouth(style) {
  const nose = `<path d="M486 405 C499 396 525 396 538 405 C533 427 491 427 486 405Z" fill="${OUTLINE}"/>`;
  const phil = `<path d="M512 425 L512 535"/>`;
  let m;
  if (style === 'o') m = `<ellipse cx="512" cy="558" rx="15" ry="18" fill="none"/>`;
  else if (style === 'flat') m = `<path d="M484 556 L540 556"/>`;
  else if (style === 'frown') m = `<path d="M480 568 Q512 546 544 568" fill="none"/>`;
  else m = `<path d="M512 535 L482 570"/><path d="M512 535 L542 570"/>`;
  return nose + phil + m;
}

function spriteSVG(p) {
  const dx = p.dx || 0, dy = p.dy || 0, lean = p.lean || 0;
  const inner =
    `<g stroke="${OUTLINE}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">` +
    HEAD + eyes(p.eyes || 'open') + MUZ + noseMouth(p.mouth || 'smile') + WHISKERS +
    `</g>`;
  const fit = `<g transform="translate(${TX} ${TY}) scale(${S})">${inner}</g>`;
  const anim = `<g transform="translate(${dx} ${dy}) ${lean ? `rotate(${lean} ${RCX} ${RCY})` : ''}">${fit}</g>`;
  const flip = p.facing === -1 ? `<g transform="translate(${CW},0) scale(-1,1)">${anim}</g>` : anim;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">${flip}</svg>`;
}

const sin = (i, n) => Math.sin((i / n) * Math.PI * 2);
function framesFor(state) {
  switch (state) {
    case 'idle': { const e = ['open', 'open', 'blink', 'open', 'open', 'open']; return Array.from({ length: 6 }, (_, i) => ({ eyes: e[i], mouth: 'smile', dy: [0, 0, 1, 2, 1, 0][i] })); }
    case 'running-right': return Array.from({ length: 8 }, (_, i) => ({ eyes: 'open', mouth: 'flat', facing: 1, dy: -Math.abs(Math.round(2 * sin(i, 8))), lean: 5 * sin(i, 8) }));
    case 'running-left': return Array.from({ length: 8 }, () => ({}));
    case 'waving': { const t = [6, 9, 6, 3]; return Array.from({ length: 4 }, (_, i) => ({ eyes: 'happy', mouth: 'smile', lean: t[i] })); }
    case 'jumping': { const dy = [6, -4, -16, -4, 5]; const e = ['open', 'happy', 'happy', 'happy', 'open']; return Array.from({ length: 5 }, (_, i) => ({ eyes: e[i], mouth: 'smile', dy: dy[i] })); }
    case 'failed': { const dx = [0, -2, 2, -2, 2, -1, 1, 0]; return Array.from({ length: 8 }, (_, i) => ({ eyes: 'x', mouth: 'frown', dx: dx[i], dy: 2 })); }
    case 'waiting': { const e = ['up', 'up', 'blink', 'up', 'up', 'up']; return Array.from({ length: 6 }, (_, i) => ({ eyes: e[i], mouth: 'o', dy: [0, 1, 1, 0, 0, 1][i], lean: [4, 4, 0, -4, -4, 0][i] })); }
    case 'running': { const e = ['open', 'open', 'blink', 'open', 'open', 'open']; return Array.from({ length: 6 }, (_, i) => ({ eyes: e[i], mouth: 'flat', dy: i % 2, lean: 2 * sin(i, 6) })); }
    case 'review': { const e = ['blink', 'open', 'open', 'blink', 'open', 'open']; return Array.from({ length: 6 }, (_, i) => ({ eyes: e[i], mouth: 'flat', lean: 4, dx: 2 })); }
    default: return [{}];
  }
}
const ROW_STATE = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];

async function buildAtlas() {
  const composites = [];
  const right = [];
  for (let row = 0; row < ROWS; row++) {
    const state = ROW_STATE[row];
    const frames = framesFor(state);
    for (let col = 0; col < frames.length; col++) {
      let buf;
      if (state === 'running-left') {
        buf = await sharp(right[col]).flop().png().toBuffer();
      } else {
        buf = await sharp(Buffer.from(spriteSVG(frames[col]))).png().toBuffer();
        if (state === 'running-right') right[col] = buf;
      }
      composites.push({ input: buf, left: col * CW, top: row * CH });
    }
  }
  return sharp({ create: { width: AW, height: AH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(composites);
}

async function main() {
  const wantContact = process.argv.includes('--contact');
  const outDir = join(__dirname, '..', 'src', 'renderer', 'assets', 'pets');
  mkdirSync(outDir, { recursive: true });
  const atlas = await buildAtlas();
  const webpPath = join(outDir, 'qwen-spritesheet.webp');
  await atlas.clone().webp({ lossless: true }).toFile(webpPath);
  if (wantContact) {
    const png = await atlas.clone().png().toBuffer();
    await sharp({ create: { width: AW, height: AH, channels: 4, background: { r: 235, g: 235, b: 238, alpha: 1 } } })
      .composite([{ input: png, left: 0, top: 0 }]).png().toFile(join(outDir, 'qwen-contact.png'));
  }
  console.log(`wrote qwen-spritesheet.webp (${statSync(webpPath).size} bytes)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
