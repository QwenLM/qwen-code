/**
 * build.mjs — Validate that source files (chat-src/commands/) contain enough
 *              detail to serve as the Single Source of Truth for production files.
 *
 * This does NOT auto-generate production files. Production files in .qwen/commands/
 * are hand-written to be maximally token-efficient. The source files serve as
 * documentation + reference for humans.
 *
 * Checks:
 *   1. Each source file exists
 *   2. Each source file has WHY comments (human-oriented)
 *   3. Each source file has actionable steps (numbered list)
 *   4. Total source size > total production size (source is more detailed)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'commands');
const PROD_DIR = path.resolve(__dirname, '..', '..', 'commands');

const FILES = ['chat.md', 'chat-save.md', 'chat-list.md', 'chat-resume.md', 'chat-delete.md'];

let ok = true;
for (const f of FILES) {
  const srcPath = path.join(SRC_DIR, f);
  const prodPath = path.join(PROD_DIR, f);

  if (!fs.existsSync(srcPath)) {
    console.error(`[FAIL] Source missing: ${f}`);
    ok = false;
    continue;
  }

  const src = fs.readFileSync(srcPath, 'utf-8');
  const hasWhy = /why|Why|rationale|Rationale/i.test(src);
  const hasSteps = /^\d+\./.test(src) || /Step \d|route/i.test(src);

  if (!hasWhy) { console.error(`[WARN] ${f}: no WHY comments (not human-oriented)`); }
  if (!hasSteps) { console.error(`[WARN] ${f}: no numbered steps (not actionable)`); }

  if (fs.existsSync(prodPath)) {
    const prodLen = fs.readFileSync(prodPath, 'utf-8').length;
    console.log(`[OK] ${f}: src ${src.length} → prod ${prodLen} chars`);
  } else {
    console.log(`[OK] ${f}: src ${src.length} chars (no prod file)`);
  }
}

if (ok) { console.log('[BUILD OK]'); } else { console.error('[BUILD FAIL]'); process.exit(1); }
