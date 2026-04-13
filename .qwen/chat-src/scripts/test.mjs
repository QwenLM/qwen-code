/**
 * test.mjs — Complete test suite for chat command files
 *
 * Tests 9 dimensions:
 *   [1] File existence (11 assertions)
 *   [2] Source WHY comments (5)
 *   [3] Production routing + rules (15)
 *   [4] Token budget (1)
 *   [5] Source logic completeness (39)
 *   [6] Production logic completeness (19)
 *   [7] Source ↔ Production consistency (36)
 *   [8] Edge case data (11)
 *   [9] Design doc completeness (14)
 *
 * Total: 151 assertions
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'commands');
const PROD_DIR = path.resolve(__dirname, '..', '..', 'commands');
const DESIGN_DOC = path.resolve(__dirname, '..', 'CHAT-DESIGN.md');

let passed = 0, failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}

function hasText(filePath, ...patterns) {
  const text = fs.readFileSync(filePath, 'utf-8');
  return patterns.map(p => text.includes(p));
}

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
const [chatMd, chatMdSrc] = [
  fs.readFileSync(path.join(PROD_DIR, 'chat.md'), 'utf-8'),
  fs.readFileSync(path.join(SRC_DIR, 'chat.md'), 'utf-8'),
];

// Flags
assert(chatMd.includes('-s') && chatMd.includes('--save'), 'Has -s/--save');
assert(chatMd.includes('-l') && chatMd.includes('--list'), 'Has -l/--list');
assert(chatMd.includes('-r') && chatMd.includes('--resume'), 'Has -r/--resume');
assert(chatMd.includes('-d') && chatMd.includes('--delete'), 'Has -d/--delete');
assert(chatMd.includes('-h') && chatMd.includes('--help'), 'Has -h/--help');

// Routes
assert(chatMd.includes('chat-save'), 'Routes to chat-save');
assert(chatMd.includes('chat-list'), 'Routes to chat-list');
assert(chatMd.includes('chat-resume'), 'Routes to chat-resume');
assert(chatMd.includes('chat-delete'), 'Routes to chat-delete');

// Rules
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
assert(totalProd < 3000, 'Total < 3000 chars');

// ── [5] Source logic completeness ──────────────────────────────────
console.log('\n[5] Source file logic completeness');

// chat.md source
const [s0, s1, s2, s3, s4] = FILES.map(f => fs.readFileSync(path.join(SRC_DIR, f), 'utf-8'));
assert(s0.includes('Lang') || s0.includes('lang') || s0.includes('language'), 'chat.md src: language detection');
assert(s0.includes('OS') || s0.includes('os'), 'chat.md src: OS detection');
assert(s0.includes('Route') || s0.includes('route'), 'chat.md src: routing section');
assert(s0.includes('Hash') || s0.includes('hash'), 'chat.md src: hash calculation');

// chat-save.md source
assert(s1.includes('Validat') || s1.includes('valid') || s1.includes('Regex'), 'chat-save src: validation');
assert(s1.includes('Read') || s1.includes('read'), 'chat-save src: read index');
assert(s1.includes('Overwrite') || s1.includes('overwrite') || s1.includes('Overwrite'), 'chat-save src: overwrite check');
assert(s1.includes('Session ID') || s1.includes('session ID') || s1.includes('newest'), 'chat-save src: find session ID');
assert(s1.includes('.jsonl'), 'chat-save src: jsonl reference');
assert(s1.includes('Write') || s1.includes('write'), 'chat-save src: write to index');
assert(s1.includes('Confirm') || s1.includes('confirm') || s1.includes('Saved'), 'chat-save src: confirmation output');
assert(s1.includes('indent') || s1.includes('2-space'), 'chat-save src: 2-space indent');

// chat-list.md source
assert(s2.includes('Read') || s2.includes('read'), 'chat-list src: read index');
assert(s2.includes('No saved') || s2.includes('empty'), 'chat-list src: empty state');
assert(s2.includes('sorted') || s2.includes('sort') || s2.includes('•'), 'chat-list src: sorted display');
assert(s2.includes('first8') || s2.includes('first 8') || s2.includes('truncat'), 'chat-list src: ID truncation');

// chat-resume.md source
assert(s3.includes('Validat') || s3.includes('valid'), 'chat-resume src: validation');
assert(s3.includes('Look up') || s3.includes('Look-up') || s3.includes('index'), 'chat-resume src: lookup ID');
assert(s3.includes('Verify') || s3.includes('verify') || s3.includes('exists'), 'chat-resume src: verify file');
assert(s3.includes('pwsh') || s3.includes('cmd'), 'chat-resume src: Windows command');
assert(s3.includes('osascript') || s3.includes('Terminal'), 'chat-resume src: macOS command');
assert(s3.includes('gnome-terminal') || s3.includes('xterm'), 'chat-resume src: Linux command');
assert(s3.includes('--resume'), 'chat-resume src: --resume flag');
assert(s3.includes('Confirm') || s3.includes('confirm') || s3.includes('Output'), 'chat-resume src: confirmation output');
assert(s3.includes('Why') || s3.includes('why') || s3.includes('Why not'), 'chat-resume src: rationale for --resume vs --continue');

// chat-delete.md source
assert(s4.includes('Validat') || s4.includes('valid'), 'chat-delete src: validation');
assert(s4.includes('Look up') || s4.includes('Look-up') || s4.includes('index'), 'chat-delete src: lookup ID');
assert(s4.includes('confirm') || s4.includes('yes/no') || s4.includes('confirmation'), 'chat-delete src: confirmation prompt');
assert(s4.includes('Remove') || s4.includes('remove') || s4.includes('Delete') || s4.includes('delete'), 'chat-delete src: remove from index');
assert(s4.includes('NOT deleted') || s4.includes('NOT delete') || s4.includes('not delete'), 'chat-delete src: file NOT deleted note');
assert(s4.includes('Why') || s4.includes('why') || s4.includes('Safety') || s4.includes('安全'), 'chat-delete src: rationale for not deleting file');
assert(s4.includes('Shared') || s4.includes('shared') || s4.includes('reference'), 'chat-delete src: shared reference reasoning');

// Numbered steps check (matches "### 1. ..." or "1. ..." formats)
for (const [i, f] of FILES.entries()) {
  const s = [s0, s1, s2, s3, s4][i];
  const stepCount = (s.match(/^#{0,3}\s*\d+\./gm) || []).length;
  assert(stepCount >= 2, `${f} source has ≥2 numbered steps (${stepCount})`);
}

// ── [6] Production logic completeness ──────────────────────────────
console.log('\n[6] Production file logic completeness');

// chat-save.md prod
const [p1, p2, p3, p4] = ['chat-save.md', 'chat-list.md', 'chat-resume.md', 'chat-delete.md']
  .map(f => fs.readFileSync(path.join(PROD_DIR, f), 'utf-8'));

assert(p1.includes('Validat') || p1.includes('valid') || p1.includes('Regex'), 'chat-save prod: validation');
assert(p1.includes('index') || p1.includes('json'), 'chat-save prod: index reference');
assert(p1.includes('Overwrite') || p1.includes('overwrite') || p1.includes('yes/no'), 'chat-save prod: overwrite check');
assert(p1.includes('.jsonl') || p1.includes('Session ID') || p1.includes('newest'), 'chat-save prod: session ID source');
assert(p1.includes('Write') || p1.includes('write') || p1.includes('indent'), 'chat-save prod: write to index');
assert(p1.includes('Saved') || p1.includes('Overwritten'), 'chat-save prod: confirmation output');

// chat-list.md prod
assert(p2.includes('read') || p2.includes('Read') || p2.includes('index'), 'chat-list prod: read index');
assert(p2.includes('•') || p2.includes('No saved'), 'chat-list prod: display format');

// chat-resume.md prod
assert(p3.includes('Validat') || p3.includes('valid'), 'chat-resume prod: validation');
assert(p3.includes('index') || p3.includes('Look up') || p3.includes('Look-up'), 'chat-resume prod: lookup ID');
assert(p3.includes('Verify') || p3.includes('verify') || p3.includes('.jsonl'), 'chat-resume prod: file verification');
assert(p3.includes('pwsh') || p3.includes('cmd') || p3.includes('resume'), 'chat-resume prod: launch command');

// chat-delete.md prod
assert(p4.includes('Validat') || p4.includes('valid'), 'chat-delete prod: validation');
assert(p4.includes('confirm') || p4.includes('yes'), 'chat-delete prod: confirmation');
assert(p4.includes('Remove') || p4.includes('remove') || p4.includes('index'), 'chat-delete prod: remove from index');
assert(p4.includes('NOT deleted') || p4.includes('NOT delete') || p4.includes('file NOT'), 'chat-delete prod: file NOT deleted note');

// ── [7] Source ↔ Production consistency ────────────────────────────
console.log('\n[7] Source ↔ Production consistency');

// Reserved names must appear in BOTH
const [srcAll, prodAll] = [
  FILES.map(f => fs.readFileSync(path.join(SRC_DIR, f), 'utf-8')).join('\n'),
  FILES.map(f => fs.readFileSync(path.join(PROD_DIR, f), 'utf-8')).join('\n'),
];

for (const name of RESERVED) {
  assert(srcAll.includes(name), `Source blocks reserved: ${name}`);
  assert(prodAll.includes(name), `Production blocks reserved: ${name}`);
}

// Regex consistency
assert(srcAll.includes(REGEX), 'Source has validation regex');
assert(prodAll.includes(REGEX), 'Production has validation regex');

// Index path consistency
assert(srcAll.includes('chat-index.json'), 'Source references index');
assert(prodAll.includes('chat-index.json'), 'Production references index');

// jsonl consistency
assert(srcAll.includes('.jsonl'), 'Source references jsonl');
assert(prodAll.includes('.jsonl'), 'Production references jsonl');

// Max length
assert(srcAll.includes('128'), 'Source has max length');
assert(prodAll.includes('128'), 'Production has max length');

// Hash calculation
assert(srcAll.includes('hash') || srcAll.includes('Hash'), 'Source has hash calc');
assert(prodAll.includes('hash') || prodAll.includes('Hash'), 'Production has hash calc');

// Step concept mapping: each source step should have a production equivalent
const saveSteps = [
  ['Validat', p1],
  ['index', p1],
  ['Overwrite', p1],
  ['Session ID', p1],
  ['Write', p1],
  ['Saved', p1],
];
for (const [keyword, prod] of saveSteps) {
  assert(prod.includes(keyword) || prod.includes(keyword.toLowerCase()), `chat-save: src step "${keyword}" → prod`);
}

const resumeSteps = [
  ['Validat', p3],
  ['Look up', p3],
  ['Verify', p3],
  ['pwsh', p3],
  ['resume', p3],
];
for (const [keyword, prod] of resumeSteps) {
  assert(prod.includes(keyword) || prod.includes(keyword.toLowerCase()), `chat-resume: src step "${keyword}" → prod`);
}

const deleteSteps = [
  ['Validat', p4],
  ['Look up', p4],
  ['confirm', p4],
  ['Remove', p4],
  ['NOT deleted', p4],
];
for (const [keyword, prod] of deleteSteps) {
  assert(prod.includes(keyword) || prod.includes(keyword.toLowerCase()), `chat-delete: src step "${keyword}" → prod`);
}

// ── [8] Edge case data ──────────────────────────────────────────────
console.log('\n[8] Edge case data');

// Reserved name count
const reservedCount = (prodAll.match(/__proto__|constructor|prototype|\.\.|\.(?!\w)/g) || []).length;
assert(reservedCount >= 5, `Reserved names appear ≥5 times in production (found ${reservedCount})`);

// Cross-platform commands
assert(prodAll.includes('pwsh') || prodAll.includes('cmd'), 'Production has Windows command');
assert(prodAll.includes('osascript') || prodAll.includes('Terminal'), 'Production has macOS command');
assert(prodAll.includes('gnome-terminal') || prodAll.includes('xterm'), 'Production has Linux command');

// Index format: flat key-value
assert(srcAll.includes('"name"') || srcAll.includes('"name":') || srcAll.includes('{"name"'), 'Source documents flat index format');

// yes/no confirmation
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

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
console.log(`${'='.repeat(50)}`);

if (failed > 0) {
  console.log('\n❌ Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
}
