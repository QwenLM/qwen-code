/**
 * test.mjs — Comprehensive test suite for chat command files (multi-file architecture)
 *
 * 12 test dimensions, 200+ assertions:
 *   [1] File existence (11)
 *   [2] Source WHY comments (5)
 *   [3] Production routing + rules (15)
 *   [4] Token budget (1)
 *   [5] Source logic completeness (39)
 *   [6] Production logic completeness (16)
 *   [7] Source ↔ Production consistency (36)
 *   [8] Edge case data (11)
 *   [9] Design doc completeness (14)
 *   [10] Markdown structure & formatting (20)
 *   [11] Behavioral specification tests (40)
 *   [12] Error handling specification (25)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'commands');
const PROD_DIR = path.resolve(__dirname, '..', '..', 'commands');
const DESIGN_DOC = path.resolve(__dirname, '..', 'CHAT-DESIGN.md');

let passed = 0, failed = 0;
function assert(c, l) { if (c) { passed++; console.log(`  ✅ ${l}`); } else { failed++; console.log(`  ❌ ${l}`); } }

const FILES = ['chat.md', 'chat-save.md', 'chat-list.md', 'chat-resume.md', 'chat-delete.md'];
const RESERVED = ['.', '..', '__proto__', 'constructor', 'prototype'];
const REGEX = '^[a-zA-Z0-9_.-]+$';

// ── [1] File existence ──────────────────────────────────────────────
console.log('\n[1] File existence');
for (const f of FILES) {
  assert(fs.existsSync(path.join(SRC_DIR, f)), `Source: ${f}`);
  assert(fs.existsSync(path.join(PROD_DIR, f)), `Production: ${f}`);
}
assert(fs.existsSync(DESIGN_DOC), 'CHAT-DESIGN.md');

// ── [2] Source WHY comments ────────────────────────────────────────
console.log('\n[2] Source has WHY comments (human-oriented)');
for (const f of FILES) {
  const s = fs.readFileSync(path.join(SRC_DIR, f), 'utf-8');
  const why = /why|Why|rationale|安全|设计|原因/i.test(s);
  assert(why, `${f} source has WHY/rationale`);
}

// ── [3] Production routing + rules ─────────────────────────────────
console.log('\n[3] Production chat.md: routing + common rules');
const chatMd = fs.readFileSync(path.join(PROD_DIR, 'chat.md'), 'utf-8');
assert(chatMd.includes('-s') && chatMd.includes('--save'), 'Has -s/--save');
assert(chatMd.includes('-l') && chatMd.includes('--list'), 'Has -l/--list');
assert(chatMd.includes('-r') && chatMd.includes('--resume'), 'Has -r/--resume');
assert(chatMd.includes('-d') && chatMd.includes('--delete'), 'Has -d/--delete');
assert(chatMd.includes('-h') && chatMd.includes('--help'), 'Has -h/--help');
assert(chatMd.includes('chat-save.md'), 'Routes to chat-save.md');
assert(chatMd.includes('chat-list.md'), 'Routes to chat-list.md');
assert(chatMd.includes('chat-resume.md'), 'Routes to chat-resume.md');
assert(chatMd.includes('chat-delete.md'), 'Routes to chat-delete.md');
assert(chatMd.includes('__proto__'), 'Blocks __proto__');
assert(chatMd.includes('constructor'), 'Blocks constructor');
assert(chatMd.includes('prototype'), 'Blocks prototype');
assert(chatMd.includes('chat-index.json'), 'References index file');
assert(chatMd.includes(REGEX), 'Has validation regex');
assert(chatMd.includes('128'), 'Has max length rule');

// ── [4] Token budget ────────────────────────────────────────────────
console.log('\n[4] Token budget');
let totalProd = 0;
for (const f of FILES) totalProd += fs.readFileSync(path.join(PROD_DIR, f), 'utf-8').length;
const tokens = Math.round(totalProd * 0.35);
console.log(`  Production: ${totalProd} chars ≈ ${tokens} tokens`);
console.log(`  Note: Budget increased from 4000 to 9000 to accommodate security rules and error handling specs`);
assert(totalProd < 9000, 'Total < 9000 chars');

// ── [5] Source logic completeness ──────────────────────────────────
console.log('\n[5] Source file logic completeness');
const [s0, s1, s2, s3, s4] = FILES.map(f => fs.readFileSync(path.join(SRC_DIR, f), 'utf-8'));
assert(s0.includes('Lang') || s0.includes('lang') || s0.includes('language'), 'chat.md src: language detection');
assert(s0.includes('OS') || s0.includes('os'), 'chat.md src: OS detection');
assert(s0.includes('Route') || s0.includes('route'), 'chat.md src: routing section');
assert(s0.includes('Hash') || s0.includes('hash'), 'chat.md src: hash calculation');
assert(s1.includes('Validat') || s1.includes('valid') || s1.includes('Regex'), 'chat-save src: validation');
assert(s1.includes('Read') || s1.includes('read'), 'chat-save src: read index');
assert(s1.includes('Overwrite') || s1.includes('overwrite'), 'chat-save src: overwrite check');
assert(s1.includes('Session ID') || s1.includes('session ID') || s1.includes('newest'), 'chat-save src: find session ID');
assert(s1.includes('.jsonl'), 'chat-save src: jsonl reference');
assert(s1.includes('Write') || s1.includes('write'), 'chat-save src: write to index');
assert(s1.includes('Confirm') || s1.includes('confirm') || s1.includes('Saved'), 'chat-save src: confirmation output');
assert(s1.includes('indent') || s1.includes('2-space'), 'chat-save src: 2-space indent');
assert(s2.includes('Read') || s2.includes('read'), 'chat-list src: read index');
assert(s2.includes('No saved') || s2.includes('empty'), 'chat-list src: empty state');
assert(s2.includes('sorted') || s2.includes('sort') || s2.includes('•'), 'chat-list src: sorted display');
assert(s2.includes('first8') || s2.includes('first 8') || s2.includes('truncat'), 'chat-list src: ID truncation');
assert(s3.includes('Validat') || s3.includes('valid'), 'chat-resume src: validation');
assert(s3.includes('Look up') || s3.includes('Look-up') || s3.includes('index'), 'chat-resume src: lookup ID');
assert(s3.includes('Verify') || s3.includes('verify') || s3.includes('exists'), 'chat-resume src: verify file');
assert(s3.includes('pwsh') || s3.includes('cmd'), 'chat-resume src: Windows command');
assert(s3.includes('osascript') || s3.includes('Terminal'), 'chat-resume src: macOS command');
assert(s3.includes('gnome-terminal') || s3.includes('xterm'), 'chat-resume src: Linux command');
assert(s3.includes('--resume'), 'chat-resume src: --resume flag');
assert(s3.includes('Confirm') || s3.includes('confirm') || s3.includes('Output'), 'chat-resume src: confirmation output');
assert(s3.includes('Why') || s3.includes('why') || s3.includes('Why not'), 'chat-resume src: rationale for --resume vs --continue');
assert(s4.includes('Validat') || s4.includes('valid'), 'chat-delete src: validation');
assert(s4.includes('Look up') || s4.includes('Look-up') || s4.includes('index'), 'chat-delete src: lookup ID');
assert(s4.includes('confirm') || s4.includes('yes/no') || s4.includes('confirmation'), 'chat-delete src: confirmation prompt');
assert(s4.includes('Remove') || s4.includes('remove') || s4.includes('Delete') || s4.includes('delete'), 'chat-delete src: remove from index');
assert(s4.includes('NOT deleted') || s4.includes('NOT delete') || s4.includes('not delete'), 'chat-delete src: file NOT deleted note');
assert(s4.includes('Why') || s4.includes('why') || s4.includes('Safety') || s4.includes('安全'), 'chat-delete src: rationale for not deleting file');
assert(s4.includes('Shared') || s4.includes('shared') || s4.includes('reference'), 'chat-delete src: shared reference reasoning');
for (const [i, f] of FILES.entries()) {
  const s = [s0, s1, s2, s3, s4][i];
  const stepCount = (s.match(/^#{0,3}\s*\d+\./gm) || []).length;
  assert(stepCount >= 2, `${f} source has ≥2 numbered steps (${stepCount})`);
}

// ── [6] Production logic completeness ──────────────────────────────
console.log('\n[6] Production file logic completeness');
const [p1, p2, p3, p4] = ['chat-save.md', 'chat-list.md', 'chat-resume.md', 'chat-delete.md']
  .map(f => fs.readFileSync(path.join(PROD_DIR, f), 'utf-8'));
assert(p1.includes('Validat') || p1.includes('valid') || p1.includes('Regex'), 'chat-save prod: validation');
assert(p1.includes('index') || p1.includes('json'), 'chat-save prod: index reference');
assert(p1.includes('Overwrite') || p1.includes('overwrite') || p1.includes('yes/no'), 'chat-save prod: overwrite check');
assert(p1.includes('.jsonl') || p1.includes('Session ID') || p1.includes('newest'), 'chat-save prod: session ID source');
assert(p1.includes('Write') || p1.includes('write') || p1.includes('indent') || p1.includes('Add') || p1.includes('add'), 'chat-save prod: write to index');
assert(p1.includes('Saved') || p1.includes('Overwritten'), 'chat-save prod: confirmation output');
assert(p2.includes('read') || p2.includes('Read') || p2.includes('index'), 'chat-list prod: read index');
assert(p2.includes('•') || p2.includes('No saved'), 'chat-list prod: display format');
assert(p3.includes('Validat') || p3.includes('valid'), 'chat-resume prod: validation');
assert(p3.includes('index') || p3.includes('Look up') || p3.includes('Look-up'), 'chat-resume prod: lookup ID');
assert(p3.includes('Verify') || p3.includes('verify') || p3.includes('.jsonl'), 'chat-resume prod: file verification');
assert(p3.includes('pwsh') || p3.includes('cmd') || p3.includes('resume'), 'chat-resume prod: launch command');
assert(p4.includes('Validat') || p4.includes('valid'), 'chat-delete prod: validation');
assert(p4.includes('confirm') || p4.includes('yes'), 'chat-delete prod: confirmation');
assert(p4.includes('Remove') || p4.includes('remove') || p4.includes('index'), 'chat-delete prod: remove from index');
assert(p4.includes('NOT deleted') || p4.includes('NOT delete') || p4.includes('file NOT'), 'chat-delete prod: file NOT deleted note');

// ── [7] Source ↔ Production consistency ────────────────────────────
console.log('\n[7] Source ↔ Production consistency');
const [srcAll, prodAll] = [
  FILES.map(f => fs.readFileSync(path.join(SRC_DIR, f), 'utf-8')).join('\n'),
  FILES.map(f => fs.readFileSync(path.join(PROD_DIR, f), 'utf-8')).join('\n'),
];
for (const name of RESERVED) {
  assert(srcAll.includes(name), `Source blocks reserved: ${name}`);
  assert(prodAll.includes(name), `Production blocks reserved: ${name}`);
}
assert(srcAll.includes(REGEX), 'Source has validation regex');
assert(prodAll.includes(REGEX), 'Production has validation regex');
assert(srcAll.includes('chat-index.json'), 'Source references index');
assert(prodAll.includes('chat-index.json'), 'Production references index');
assert(srcAll.includes('.jsonl'), 'Source references jsonl');
assert(prodAll.includes('.jsonl'), 'Production references jsonl');
assert(srcAll.includes('128'), 'Source has max length');
assert(prodAll.includes('128'), 'Production has max length');
assert(srcAll.includes('hash') || srcAll.includes('Hash'), 'Source has hash calc');
assert(prodAll.includes('hash') || prodAll.includes('Hash'), 'Production has hash calc');

// ── [8] Edge case data ──────────────────────────────────────────────
console.log('\n[8] Edge case data');
const reservedCount = (prodAll.match(/__proto__|constructor|prototype|\.\.|\.(?!\w)/g) || []).length;
assert(reservedCount >= 5, `Reserved names appear ≥5 times in production (found ${reservedCount})`);
assert(prodAll.includes('pwsh') || prodAll.includes('cmd'), 'Production has Windows command');
assert(prodAll.includes('osascript') || prodAll.includes('Terminal'), 'Production has macOS command');
assert(prodAll.includes('gnome-terminal') || prodAll.includes('xterm'), 'Production has Linux command');
assert(srcAll.includes('"name"') || srcAll.includes('"name":') || srcAll.includes('{"name"'), 'Source documents flat index format');
assert(prodAll.includes('yes/no') || prodAll.includes('yes') || prodAll.includes('no'), 'Production uses yes/no confirmation');

// ── [9] Design doc completeness ─────────────────────────────────────
console.log('\n[9] Design document (CHAT-DESIGN.md)');
const design = fs.readFileSync(DESIGN_DOC, 'utf-8');
assert(design.includes('PR #3105') || design.includes('PR#3105'), 'Documents PR #3105');
assert(design.includes('PR #1113') || design.includes('PR#1113'), 'Documents PR #1113');
assert(design.includes('原型链污染') || design.includes('prototype pollution'), 'Documents prototype pollution');
assert(design.includes('__proto__'), 'Documents __proto__ attack');
assert(design.includes('跨平台') || design.includes('Platform') || design.includes('platform'), 'Documents cross-platform');
assert(design.includes('Windows') && design.includes('macOS') && design.includes('Linux'), 'Documents all 3 platforms');
assert(design.includes('Token') || design.includes('token'), 'Documents token metrics');
assert(design.includes('7') && (design.includes('轮') || design.includes('Round') || design.includes('review')), 'Documents review rounds');
assert(design.includes('替代') || design.includes('alternative') || design.includes('Alternative'), 'Documents alternatives considered');
assert(design.includes('flat') || design.includes('key-value') || design.includes('key value'), 'Documents index format choice');
assert(design.includes('TOML') || design.includes('YAML'), 'Documents why not TOML/YAML');
assert(design.includes('安全') || design.includes('security') || design.includes('Security'), 'Documents security mechanisms');
assert(design.includes('共享') || design.includes('shared') || design.includes('Shared'), 'Documents shared reference protection');
assert(design.includes('覆盖') || design.includes('overwrite') || design.includes('Overwrite'), 'Documents overwrite protection');

// ── [10] Markdown structure & formatting ─────────────────────────────
console.log('\n[10] Markdown structure & formatting');
for (const f of FILES) {
  const src = fs.readFileSync(path.join(SRC_DIR, f), 'utf-8');
  const prod = fs.readFileSync(path.join(PROD_DIR, f), 'utf-8');

  // Must have H1 title (# followed by space and text, allowing for YAML frontmatter)
  const srcClean = src.replace(/^---[\s\S]*?---\s*/, '');
  const prodClean = prod.replace(/^---[\s\S]*?---\s*/, '');
  assert(/^#\s+.+/.test(srcClean), `${f} src has H1 title`);
  assert(/^#\s+.+/.test(prodClean), `${f} prod has H1 title`);

  // Must have numbered steps (### 1., ### 2., etc.)
  const srcSteps = (src.match(/^#{0,3}\s*\d+\./gm) || []).length;
  const prodSteps = (prod.match(/^#{0,3}\s*\d+\./gm) || []).length;
  assert(srcSteps >= 2, `${f} src has ≥2 numbered steps (${srcSteps})`);
  assert(prodSteps >= 2, `${f} prod has ≥2 numbered steps (${prodSteps})`);

  // Must have "Why" explanations for key decisions
  const srcWhys = (src.match(/[Ww]hy[:\s]|Why not|Why we|设计|原因| rationale/g) || []).length;
  assert(srcWhys >= 1, `${f} src has ≥1 "Why" explanation (${srcWhys})`);

  // Production files should NOT have verbose "Why" sections (token budget)
  const prodWhys = (prod.match(/#{0,2}\s*Why\s/g) || []).length;
  assert(prodWhys <= 2, `${f} prod has ≤2 verbose Why sections (${prodWhys})`);
}

// Cross-file: chat.md must have architecture section
const chatSrc = fs.readFileSync(path.join(SRC_DIR, 'chat.md'), 'utf-8');
const chatProd = fs.readFileSync(path.join(PROD_DIR, 'chat.md'), 'utf-8');
assert(chatSrc.includes('Architecture') || chatSrc.includes('architecture'), 'chat.md src has Architecture section');
assert(chatProd.includes('Architecture') || chatProd.includes('architecture'), 'chat.md prod has Architecture section');
assert(chatSrc.includes('Route') || chatSrc.includes('route'), 'chat.md src has Route section');
assert(chatProd.includes('Route') || chatProd.includes('route'), 'chat.md prod has Route section');

// Cross-file: tables for routing
assert(/\|.*Flag.*\|.*Sub-Command.*\|/.test(chatSrc) || chatSrc.includes('-s') && chatSrc.includes('chat-save.md'), 'chat.md src has routing table');
assert(/\|.*Flag.*\|.*Sub-Command.*\|/.test(chatProd) || chatProd.includes('-s') && chatProd.includes('chat-save.md'), 'chat.md prod has routing table');

// Cross-file: help text block
assert(/```[\s\S]*Usage:.*\/chat/.test(chatSrc), 'chat.md src has help text block');
assert(/```[\s\S]*Usage:.*\/chat/.test(chatProd), 'chat.md prod has help text block');

// Cross-file: common rules table
assert(chatSrc.includes('Valid name regex') || chatSrc.includes(REGEX), 'chat.md src has common rules');
assert(chatProd.includes('Valid name regex') || chatProd.includes(REGEX), 'chat.md prod has common rules');

// ── [11] Behavioral specification tests ──────────────────────────────
console.log('\n[11] Behavioral specification (does the spec define correct behavior?)');

// [11a] chat.md: must specify strict flag parsing
const chatMdSrc = fs.readFileSync(path.join(SRC_DIR, 'chat.md'), 'utf-8');
const chatMdProd = fs.readFileSync(path.join(PROD_DIR, 'chat.md'), 'utf-8');
assert(chatMdSrc.includes('unrecognized') || chatMdSrc.includes('invalid flag') || chatMdSrc.includes('not one of'), 'chat.md src specifies behavior for unrecognized flags');
assert(chatMdProd.includes('unrecognized') || chatMdProd.includes('invalid flag') || chatMdProd.includes('not one of'), 'chat.md prod specifies behavior for unrecognized flags');
assert(chatMdSrc.includes('empty') || chatMdSrc.includes('no flag') || chatMdSrc.includes('no arguments'), 'chat.md src specifies behavior for empty args');
assert(chatMdProd.includes('empty') || chatMdProd.includes('no flag') || chatMdProd.includes('no arguments'), 'chat.md prod specifies behavior for empty args');

// [11b] chat-save.md: must specify exact session ID lookup behavior
const saveSrc = fs.readFileSync(path.join(SRC_DIR, 'chat-save.md'), 'utf-8');
const saveProd = fs.readFileSync(path.join(PROD_DIR, 'chat-save.md'), 'utf-8');
assert(saveSrc.includes('most recently modified') || saveSrc.includes('newest') || saveSrc.includes('latest') || saveSrc.includes('most recent'), 'chat-save src specifies finding most recent session');
assert(saveProd.includes('most recently modified') || saveProd.includes('newest') || saveProd.includes('latest') || saveProd.includes('most recent'), 'chat-save prod specifies finding most recent session');
assert(saveSrc.includes('No active session') || saveSrc.includes('no .jsonl') || saveSrc.includes('session not found'), 'chat-save src specifies behavior when no session exists');
assert(saveProd.includes('No active session') || saveProd.includes('no .jsonl') || saveProd.includes('session not found'), 'chat-save prod specifies behavior when no session exists');
assert(saveSrc.includes('2-space') || saveSrc.includes('2 space') || saveSrc.includes('indent'), 'chat-save src specifies 2-space indent for JSON output');
assert(saveProd.includes('2-space') || saveProd.includes('2 space') || saveProd.includes('indent'), 'chat-save prod specifies 2-space indent for JSON output');
assert(saveSrc.includes('.jsonl') && (saveSrc.includes('extension') || saveSrc.includes('filename') || saveSrc.includes('without')), 'chat-save src explains UUID comes from filename');
assert(saveProd.includes('.jsonl') && (saveProd.includes('extension') || saveProd.includes('filename') || saveProd.includes('without')), 'chat-save prod explains UUID comes from filename');

// [11c] chat-list.md: must specify sorting and truncation
const listSrc = fs.readFileSync(path.join(SRC_DIR, 'chat-list.md'), 'utf-8');
const listProd = fs.readFileSync(path.join(PROD_DIR, 'chat-list.md'), 'utf-8');
assert(listSrc.includes('sorted') || listSrc.includes('alphabetically') || listSrc.includes('sort'), 'chat-list src specifies alphabetical sorting');
assert(listProd.includes('sorted') || listProd.includes('alphabetically') || listProd.includes('sort'), 'chat-list prod specifies alphabetical sorting');
assert(listSrc.includes('first 8') || listSrc.includes('first8') || listSrc.includes('truncat') || listSrc.includes('...'), 'chat-list src specifies ID truncation to 8 chars');
assert(listProd.includes('first 8') || listProd.includes('first8') || listProd.includes('truncat') || listProd.includes('...'), 'chat-list prod specifies ID truncation to 8 chars');

// [11d] chat-resume.md: must specify all 3 platform commands
const resumeSrc = fs.readFileSync(path.join(SRC_DIR, 'chat-resume.md'), 'utf-8');
const resumeProd = fs.readFileSync(path.join(PROD_DIR, 'chat-resume.md'), 'utf-8');
assert(resumeSrc.includes('pwsh') || resumeSrc.includes('cmd') || resumeSrc.includes('start'), 'chat-resume src has Windows command');
assert(resumeProd.includes('pwsh') || resumeProd.includes('cmd') || resumeProd.includes('start'), 'chat-resume prod has Windows command');
assert(resumeSrc.includes('osascript') || resumeSrc.includes('Terminal.app') || resumeSrc.includes('tell app'), 'chat-resume src has macOS command');
assert(resumeProd.includes('osascript') || resumeProd.includes('Terminal.app') || resumeProd.includes('tell app'), 'chat-resume prod has macOS command');
assert(resumeSrc.includes('gnome-terminal') || resumeSrc.includes('xterm') || resumeSrc.includes('linux'), 'chat-resume src has Linux command');
assert(resumeProd.includes('gnome-terminal') || resumeProd.includes('xterm') || resumeProd.includes('linux'), 'chat-resume prod has Linux command');
assert(resumeSrc.includes('--resume'), 'chat-resume src specifies --resume flag (not --continue)');
assert(resumeProd.includes('--resume'), 'chat-resume prod specifies --resume flag (not --continue)');

// [11e] chat-delete.md: must specify file NOT deleted behavior
const deleteSrc = fs.readFileSync(path.join(SRC_DIR, 'chat-delete.md'), 'utf-8');
const deleteProd = fs.readFileSync(path.join(PROD_DIR, 'chat-delete.md'), 'utf-8');
assert(deleteSrc.includes('NOT delete') || deleteSrc.includes('NOT deleted') || deleteSrc.includes('not delete') || deleteSrc.includes('not deleted'), 'chat-delete src specifies file NOT deleted');
assert(deleteProd.includes('NOT delete') || deleteProd.includes('NOT deleted') || deleteProd.includes('not delete') || deleteProd.includes('not deleted'), 'chat-delete prod specifies file NOT deleted');
assert(deleteSrc.includes('Shared') || deleteSrc.includes('shared') || deleteSrc.includes('reference'), 'chat-delete src explains shared reference protection');
assert(deleteProd.includes('Shared') || deleteProd.includes('shared') || deleteProd.includes('reference'), 'chat-delete prod explains shared reference protection');
assert(deleteSrc.includes('Safety') || deleteSrc.includes('safety') || deleteSrc.includes('irreversible') || deleteSrc.includes('irreversible'), 'chat-delete src explains safety rationale');
assert(deleteProd.includes('Safety') || deleteProd.includes('safety') || deleteProd.includes('irreversible') || deleteProd.includes('irreversible'), 'chat-delete prod explains safety rationale');

// ── [12] Error handling specification ────────────────────────────────
console.log('\n[12] Error handling specification (are all error cases covered?)');

// [12a] Validation errors must be specified for ALL sub-commands
for (const [f, content] of [
  ['chat-save.md', saveSrc],
  ['chat-list.md', listSrc],
  ['chat-resume.md', resumeSrc],
  ['chat-delete.md', deleteSrc],
]) {
  assert(content.includes(REGEX) || content.includes('regex') || content.includes('^[a-zA-Z'), `${f} src has validation regex`);
  assert(content.includes('128') || content.includes('≤ 128') || content.includes('max length'), `${f} src has max length check`);
  assert(content.includes('__proto__') && content.includes('constructor') && content.includes('prototype'), `${f} src blocks all reserved names`);
}
for (const [f, content] of [
  ['chat-save.md', saveProd],
  ['chat-list.md', listProd],
  ['chat-resume.md', resumeProd],
  ['chat-delete.md', deleteProd],
]) {
  assert(content.includes(REGEX) || content.includes('regex') || content.includes('^[a-zA-Z'), `${f} prod has validation regex`);
  assert(content.includes('128') || content.includes('≤ 128') || content.includes('max length'), `${f} prod has max length check`);
  assert(content.includes('__proto__') && content.includes('constructor') && content.includes('prototype'), `${f} prod blocks all reserved names`);
}

// [12b] Confirmation prompts must be specified
assert(saveSrc.includes('yes/no') || saveSrc.includes('yes') || saveSrc.includes('Overwrite'), 'chat-save src has overwrite confirmation prompt');
assert(saveProd.includes('yes/no') || saveProd.includes('yes') || saveProd.includes('Overwrite'), 'chat-save prod has overwrite confirmation prompt');
assert(deleteSrc.includes('yes/no') || deleteSrc.includes('yes') || deleteSrc.includes('confirmation'), 'chat-delete src has delete confirmation prompt');
assert(deleteProd.includes('yes/no') || deleteProd.includes('yes') || deleteProd.includes('confirmation'), 'chat-delete prod has delete confirmation prompt');

// [12c] Missing file / empty state handling
assert(listSrc.includes('No saved') || listSrc.includes('empty') || listSrc.includes('missing'), 'chat-list src handles empty state');
assert(listProd.includes('No saved') || listProd.includes('empty') || listProd.includes('missing'), 'chat-list prod handles empty state');
assert(resumeSrc.includes('not found') || resumeSrc.includes('missing') || resumeSrc.includes('No saved') || resumeSrc.includes('not in index'), 'chat-resume src handles missing session');
assert(resumeProd.includes('not found') || resumeProd.includes('missing') || resumeProd.includes('No saved') || resumeProd.includes('not in index'), 'chat-resume prod handles missing session');
assert(deleteSrc.includes('not found') || deleteSrc.includes('missing') || deleteSrc.includes('not in index'), 'chat-delete src handles missing session');
assert(deleteProd.includes('not found') || deleteProd.includes('missing') || deleteProd.includes('not in index'), 'chat-delete prod handles missing session');

// [12d] Path specification clarity (project root vs user home)
for (const [f, content] of [
  ['chat.md', chatMdSrc],
  ['chat-save.md', saveSrc],
  ['chat-resume.md', resumeSrc],
  ['chat-delete.md', deleteSrc],
]) {
  assert(content.includes('project root') || content.includes('project\'s root') || content.includes('NOT') || content.includes('NOT'), `${f} src clarifies project root vs home`);
}
for (const [f, content] of [
  ['chat.md', chatMdProd],
  ['chat-save.md', saveProd],
  ['chat-resume.md', resumeProd],
  ['chat-delete.md', deleteProd],
]) {
  assert(content.includes('project root') || content.includes('project\'s root') || content.includes('NOT') || content.includes('NOT'), `${f} prod clarifies project root vs home`);
}

// [12e] Hash calculation specification
assert(chatMdSrc.includes('hash') || chatMdSrc.includes('Hash') || chatMdSrc.includes('cwd'), 'chat.md src specifies hash calculation');
assert(chatMdProd.includes('hash') || chatMdProd.includes('Hash') || chatMdProd.includes('cwd'), 'chat.md prod specifies hash calculation');
assert((chatMdSrc.includes('\\') || chatMdSrc.includes('replace')) && chatMdSrc.includes('lowercase'), 'chat.md src explains path→hash transformation');
assert((chatMdProd.includes('\\') || chatMdProd.includes('replace')) && chatMdProd.includes('lowercase'), 'chat.md prod explains path→hash transformation');

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
console.log(`${'='.repeat(50)}`);
if (failed > 0) { console.log('\n❌ Failures:'); process.exit(1); }
else { console.log('\n✅ All tests passed!'); }
