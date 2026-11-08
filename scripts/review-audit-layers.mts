/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Measure defect-LAYER coverage of a reverse-audit run — the A/B instrument for
// the layer-aware convergence change.
//
// The reverse audit converges on "two dry rounds": no auditor found a new gap.
// This script answers the question that stop rule cannot — *which defect layers
// did the auditors actually walk* — so you can compare a run before the auditor
// brief asked for `Layer walked:` receipts against one after, and see the deep
// layers (scope-propagation, resolution-order, inheritance) go from uncovered to
// covered. On PR #8687 the token layer filled every round while the state layer
// went untouched; this is what makes that visible instead of hidden behind a
// green "converged".
//
// Usage:
//   tsx scripts/review-audit-layers.mts <file-or-glob> [<file> ...] [--infer]
//
//   Each argument is a text file (or a glob) holding one auditor's final return
//   — dump the reverse-audit agents' returns to files, one per agent, named so
//   the round is recoverable (e.g. round-1-chunk-3.txt). One JSON file whose
//   top level is an array of {round?, chunk?, text} objects also works.
//
//   --infer  turn on the keyword estimate for MARKER-LESS baseline transcripts
//            (a run recorded before the brief change emits no `Layer walked:`
//            lines, so structured-only coverage reads as zero — the estimate is
//            the best baseline signal, approximate by construction).
//
// Reads nothing but the files you pass; it never touches a PR or the network.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { glob } from 'glob';
import {
  SHELL_MODEL_LAYERS,
  layerCoverage,
} from '../packages/cli/src/commands/review/lib/audit-layers.ts';

interface Return {
  round: number | null;
  label: string;
  text: string;
}

function roundOf(name: string): number | null {
  const m = /round[-_ ]?(\d+)/i.exec(name);
  return m ? Number(m[1]) : null;
}

async function collectPaths(args: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const arg of args) {
    if (/[*?[\]]/.test(arg)) {
      out.push(...(await glob(arg)));
    } else {
      out.push(arg);
    }
  }
  return out;
}

function loadReturns(paths: string[]): Return[] {
  const returns: Return[] = [];
  for (const path of paths) {
    const raw = readFileSync(path, 'utf8');
    if (path.endsWith('.json')) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        parsed.forEach((e, i) => {
          const o = (e ?? {}) as Record<string, unknown>;
          returns.push({
            round: typeof o.round === 'number' ? o.round : null,
            label:
              typeof o.chunk === 'number'
                ? `${basename(path)}#${o.chunk}`
                : `${basename(path)}#${i}`,
            text: typeof o.text === 'string' ? o.text : '',
          });
        });
        continue;
      }
    }
    returns.push({
      round: roundOf(basename(path)),
      label: basename(path),
      text: raw,
    });
  }
  return returns;
}

function report(returns: Return[], keywordFallback: boolean): void {
  const texts = returns.map((r) => r.text);
  const overall = layerCoverage(texts, { keywordFallback });

  // Group by round so you can watch a layer stay uncovered across the loop.
  const rounds = [...new Set(returns.map((r) => r.round))].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });

  process.stdout.write(
    `\nDefect-layer coverage — ${returns.length} auditor return(s), ` +
      `${keywordFallback ? 'keyword estimate ON' : 'structured receipts only'}\n\n`,
  );
  for (const round of rounds) {
    const inRound = returns.filter((r) => r.round === round);
    const cov = layerCoverage(
      inRound.map((r) => r.text),
      { keywordFallback },
    );
    const label = round === null ? 'unlabelled' : `round ${round}`;
    const covered = SHELL_MODEL_LAYERS.filter((l) => cov.covered[l.id]).map(
      (l) => l.id,
    );
    process.stdout.write(
      `  ${label.padEnd(12)} covered: ${covered.join(', ') || '(none)'}\n`,
    );
  }

  process.stdout.write('\n  Whole run:\n');
  for (const layer of SHELL_MODEL_LAYERS) {
    const mark = overall.covered[layer.id] ? '✓' : '✗ OWED';
    process.stdout.write(`    [${mark}] ${layer.id} — ${layer.label}\n`);
  }
  if (overall.uncovered.length > 0) {
    process.stdout.write(
      `\n  ${overall.uncovered.length} layer(s) never walked: ` +
        `${overall.uncovered.join(', ')}\n` +
        `  A "two dry rounds" stop would certify the diff with these unreviewed.\n`,
    );
  } else {
    process.stdout.write('\n  Every layer was walked.\n');
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const keywordFallback = argv.includes('--infer');
  const paths = await collectPaths(argv.filter((a) => a !== '--infer'));
  if (paths.length === 0) {
    process.stderr.write(
      'usage: tsx scripts/review-audit-layers.mts <file-or-glob> [...] [--infer]\n',
    );
    process.exit(2);
  }
  report(loadReturns(paths), keywordFallback);
}

await main();
