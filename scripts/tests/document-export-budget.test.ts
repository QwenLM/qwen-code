/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createSourceFile,
  forEachChild,
  getLeadingCommentRanges,
  getTrailingCommentRanges,
  type Node,
  ScriptTarget,
} from 'typescript';
import { describe, expect, it } from 'vitest';
import { documentExportBudgetMs } from '../../integration-tests/document-export-budget.js';

// The browser gate that consumes these budgets runs on both runner classes:
// ci.yml's PR-gated web_shell_e2e_smoke shard 1 selects the shared self-hosted
// ARM64 pool or ubuntu-latest, and e2e.yml's nightly leg runs on ubuntu-latest.
// Only the self-hosted pool measured the overruns, so the tier decision is
// pinned here, where test:scripts collects it on every PR.
const repoRoot = resolve(import.meta.dirname, '../..');
const gateSource = readFileSync(
  join(repoRoot, 'integration-tests/chat-transcript-document.test.ts'),
  'utf8',
);
const integrationConfigSource = readFileSync(
  join(repoRoot, 'integration-tests/vitest.config.ts'),
  'utf8',
);

// Blank comments using the parser's own trivia ranges so a commented-out
// copy of a pinned line cannot satisfy the pin. A raw createScanner walk is
// not safe here: it does not rescan the `}` of a `${...}` substitution as a
// template token (the parser calls reScanTemplateToken), so on the gate's
// interpolated RENDERER_URL / RENDERER_CSS_URL templates it desyncs and
// blanks none of the comments after them. A /\*[\s\S]*?\*\// regex is not
// safe either: the gate's page.route('**/*') glob contains "/*", which a
// blanket regex reads as a comment opener, blanking the rest of the file and
// swallowing the real assertion. Newlines survive so line anchors keep their
// line structure.
function blankComments(source: string): string {
  const sourceFile = createSourceFile(
    'pinned-source.ts',
    source,
    ScriptTarget.Latest,
    true,
  );
  const ranges: { pos: number; end: number }[] = [];
  const collect = (node: Node) => {
    ranges.push(...(getLeadingCommentRanges(source, node.pos) ?? []));
    ranges.push(...(getTrailingCommentRanges(source, node.end) ?? []));
    forEachChild(node, collect);
  };
  collect(sourceFile);
  // Comments after the last statement are leading trivia of the EOF token,
  // which no node visits.
  const eof = sourceFile.getChildAt(sourceFile.getChildCount() - 1);
  ranges.push(...(getLeadingCommentRanges(source, eof.pos) ?? []));
  ranges.sort((a, b) => a.pos - b.pos);
  let out = '';
  let last = 0;
  for (const { pos, end } of ranges) {
    if (pos < last) continue;
    out +=
      source.slice(last, pos) + source.slice(pos, end).replace(/[^\n]/g, ' ');
    last = end;
  }
  return out + source.slice(last);
}

const gateCode = blankComments(gateSource);
const integrationConfigCode = blankComments(integrationConfigSource);

// Source-shape tripwires for the obvious reverts, not proof that the gate
// executes the budget: a sufficiently creative rewrite can still slip past,
// and the browser gate itself remains the end-to-end check. Line-start
// anchored on comment-blanked source so a commented-out copy cannot satisfy
// a pin; the \s* / ,? tolerance still absorbs the reflow and trailing comma
// Prettier emits for a long call or argument. Shared with the acceptance
// fixtures below so those cases witness these exact patterns.
const WIRING_PIN =
  /^const MAX_DOCUMENT_DURATION_MS = documentExportBudgetMs\(\s*process\.env,?\s*\);/m;
const CASE_CEILING_PIN = /^\s*MAX_DOCUMENT_DURATION_MS \+ 30_000,?\s*\);/m;
// it.skip( / describe.skip( is the cheapest deflake rollback and leaves every
// other line verbatim; pin the enabled openings, with the case title quoted
// verbatim from the gate.
const CASE_OPENING_PIN =
  /^\s*it\(\s*'opens, searches, copies, and prints the maximum document with its pinned npm runtime',?$/m;
const DESCRIBE_OPENING_PIN =
  /^\s*describe\('ExportTranscriptDocument browser gate',/m;
// The budget assertion is anchored to its immediate neighbours at the case
// body's exact indentation, so relocating it, wrapping it in a block, or
// re-indenting the whole block under a dead condition all break the pin.
const BUDGET_ASSERTION_PIN =
  /^ {6}await expectConnectSrcCspEnforced\(page\);\n {6}expect\(durationMs\)\.toBeLessThan\(MAX_DOCUMENT_DURATION_MS\);\n {6}const heapDeltaBytes = Math\.max\(0, heapAfter - heapBefore\);/m;

describe('document export budgets', () => {
  it('keeps the tight 60s ceiling off the shared self-hosted pool', () => {
    expect(documentExportBudgetMs({})).toBe(60_000);
    expect(documentExportBudgetMs({ CI: 'true' })).toBe(60_000);
    expect(
      documentExportBudgetMs({
        CI: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
      }),
    ).toBe(60_000);
  });

  it('widens the ceiling on the self-hosted pool that measured the overruns', () => {
    const budget = documentExportBudgetMs({
      RUNNER_ENVIRONMENT: 'self-hosted',
    });
    expect(budget).toBe(180_000);
    // The gate derives its per-case ceiling from this budget, and a per-case
    // timeout outranks the suite's, so the budget has to stay under the suite
    // ceiling for the budget assertion to be the one that reports a wedged run.
    // Literal, not the imported config: the config derives testTimeout from
    // the ambient TB_TIMEOUT_MINUTES, which would make this config-free lane
    // depend on the caller's shell (same shape as ready-prompt-budget.test.ts).
    expect(budget).toBeLessThan(300_000);
    // The literal is only correct while the integration default stays five
    // minutes; pin the derivation so lowering the '5' fallback reddens here
    // and both ceilings move together.
    expect(integrationConfigCode).toMatch(
      /Number\(process\.env\['TB_TIMEOUT_MINUTES'\] \|\| '5'\)/,
    );
  });

  it('wires the resolved budget into the browser gate and its case ceiling', () => {
    // These lines are invisible to every PR-gated lane when reverted: the
    // gate itself only runs in web_shell_e2e_smoke shard 1 and the
    // schedule-only nightly leg, where a healthy render sits well under either
    // ceiling. These tripwires give the obvious reverts a ~0ms witness through
    // test:scripts, which runs on every PR.
    expect(gateCode).toMatch(WIRING_PIN);
    expect(gateCode).toMatch(CASE_CEILING_PIN);
    // The case and its describe must stay enabled: skipping them leaves every
    // other pin matching while the gate stops running at all.
    expect(gateCode).toMatch(CASE_OPENING_PIN);
    expect(gateCode).toMatch(DESCRIBE_OPENING_PIN);
    // The assertion that consumes the budget: a deflake round that deletes it
    // (with the now-unused startedAt/durationMs/nodePerformance locals) would
    // leave the gate enforcing only the case timeout, reporting a bare
    // "Test timed out" instead of the budget.
    expect(gateCode).toMatch(BUDGET_ASSERTION_PIN);
  });

  it('does not witness a commented-out revert of the wiring', () => {
    // Acceptance fixtures for the pin mechanism: each revert shape below must
    // match no pin on comment-blanked source. Removing an anchor, the comment
    // blanking, or a neighbouring line turns the matching assertion red.
    const commentedOut = [
      '// const MAX_DOCUMENT_DURATION_MS = documentExportBudgetMs(process.env);',
      'const MAX_DOCUMENT_DURATION_MS = 60_000;',
      '    // MAX_DOCUMENT_DURATION_MS + 30_000,',
      '  );',
      '      // expect(durationMs).toBeLessThan(MAX_DOCUMENT_DURATION_MS);',
    ].join('\n');
    expect(blankComments(commentedOut)).not.toMatch(WIRING_PIN);
    expect(blankComments(commentedOut)).not.toMatch(CASE_CEILING_PIN);
    expect(blankComments(commentedOut)).not.toMatch(BUDGET_ASSERTION_PIN);

    // /* */ shape: the pinned lines travel inside a block comment. The raw
    // text still satisfies the line anchors (the hole the blanking closes);
    // the blanked copy must not.
    const blockCommented = [
      '/*',
      'const MAX_DOCUMENT_DURATION_MS = documentExportBudgetMs(process.env);',
      '*/',
      'const MAX_DOCUMENT_DURATION_MS = 60_000;',
      '/*',
      '    MAX_DOCUMENT_DURATION_MS + 30_000,',
      '  );',
      '*/',
    ].join('\n');
    expect(blockCommented).toMatch(WIRING_PIN);
    expect(blockCommented).toMatch(CASE_CEILING_PIN);
    expect(blankComments(blockCommented)).not.toMatch(WIRING_PIN);
    expect(blankComments(blockCommented)).not.toMatch(CASE_CEILING_PIN);

    // Interpolated-template shape: a blanking mechanism that desyncs on the
    // `}` of a `${...}` substitution (as a raw scanner walk does) passes the
    // fixtures above but fails here. The gate's RENDERER_URL templates are
    // the real-world instance of this shape.
    const templateThenComment = [
      'const t = `x${y}z`;',
      '/*',
      'const MAX_DOCUMENT_DURATION_MS = documentExportBudgetMs(process.env);',
      '*/',
      'const MAX_DOCUMENT_DURATION_MS = 60_000;',
    ].join('\n');
    expect(templateThenComment).toMatch(WIRING_PIN);
    expect(blankComments(templateThenComment)).not.toMatch(WIRING_PIN);

    // it.skip( / describe.skip( shape: only the opening pins can see it.
    const skippedCase = [
      '  it.skip(',
      "    'opens, searches, copies, and prints the maximum document with its pinned npm runtime',",
      '    async () => {},',
      '    MAX_DOCUMENT_DURATION_MS + 30_000,',
      '  );',
    ].join('\n');
    expect(skippedCase).not.toMatch(CASE_OPENING_PIN);
    expect(skippedCase.replace('it.skip(', 'it(')).toMatch(CASE_OPENING_PIN);
    const skippedDescribe =
      "describe.skip('ExportTranscriptDocument browser gate', () => {});";
    expect(skippedDescribe).not.toMatch(DESCRIBE_OPENING_PIN);

    // Brace-wrapped / relocated assertion shapes: the neighbourhood anchor
    // must see the assertion only between its two neighbours at the case
    // body's indentation.
    const neighbours = [
      '      await expectConnectSrcCspEnforced(page);',
      '      expect(durationMs).toBeLessThan(MAX_DOCUMENT_DURATION_MS);',
      '      const heapDeltaBytes = Math.max(0, heapAfter - heapBefore);',
    ].join('\n');
    expect(neighbours).toMatch(BUDGET_ASSERTION_PIN);
    const braceWrapped = [
      '      await expectConnectSrcCspEnforced(page);',
      '      {',
      '        expect(durationMs).toBeLessThan(MAX_DOCUMENT_DURATION_MS);',
      '      }',
      '      const heapDeltaBytes = Math.max(0, heapAfter - heapBefore);',
    ].join('\n');
    expect(braceWrapped).not.toMatch(BUDGET_ASSERTION_PIN);
    const blockWrapped = [
      '      if (false) {',
      '        await expectConnectSrcCspEnforced(page);',
      '        expect(durationMs).toBeLessThan(MAX_DOCUMENT_DURATION_MS);',
      '        const heapDeltaBytes = Math.max(0, heapAfter - heapBefore);',
      '      }',
    ].join('\n');
    expect(blockWrapped).not.toMatch(BUDGET_ASSERTION_PIN);
    const relocated =
      'expect(durationMs).toBeLessThan(MAX_DOCUMENT_DURATION_MS);';
    expect(relocated).not.toMatch(BUDGET_ASSERTION_PIN);

    // The line-start anchor still matters after blanking: a copy inside a
    // string literal is not a comment, and only the anchor rejects it.
    const stringCopy =
      'const note = "const MAX_DOCUMENT_DURATION_MS = documentExportBudgetMs(process.env);";';
    expect(stringCopy).not.toMatch(WIRING_PIN);

    // The \s* / ,? tolerance must keep absorbing Prettier reflow.
    const reflowedWiring =
      'const MAX_DOCUMENT_DURATION_MS = documentExportBudgetMs(\n  process.env,\n);';
    expect(reflowedWiring).toMatch(WIRING_PIN);
  });

  it('does not witness comment-shaped reverts of the real gate source', () => {
    // Synthetic fixtures cannot see a blanking mechanism that desyncs on the
    // gate's interpolated template literals: drive the real source through
    // each comment-shaped rollback instead. For the single-line pins the raw
    // mutant must still match — the blanked copy is what the pin sees, so
    // blanking is the only defense.
    const replaceOnce = (src: string, from: string, to: string): string => {
      const i = src.indexOf(from);
      expect(i, `anchor present: ${from.slice(0, 40)}`).toBeGreaterThanOrEqual(
        0,
      );
      expect(src.indexOf(from, i + 1), 'anchor unique').toBe(-1);
      return src.slice(0, i) + to + src.slice(i + from.length);
    };
    const blockComment = (s: string) => '/*\n' + s + '\n*/';

    const wiring =
      'const MAX_DOCUMENT_DURATION_MS = documentExportBudgetMs(process.env);';
    const ceiling = '    MAX_DOCUMENT_DURATION_MS + 30_000,\n  );';
    const assertion =
      '      expect(durationMs).toBeLessThan(MAX_DOCUMENT_DURATION_MS);';
    const title =
      "    'opens, searches, copies, and prints the maximum document with its pinned npm runtime',";
    const caseOpening = '  it(\n' + title;
    const describeOpening =
      "describe('ExportTranscriptDocument browser gate', () => {";

    // Wiring commented out, literal restored.
    const wiringRevert = replaceOnce(
      gateSource,
      wiring,
      blockComment(wiring) + '\nconst MAX_DOCUMENT_DURATION_MS = 60_000;',
    );
    expect(wiringRevert).toMatch(WIRING_PIN);
    expect(blankComments(wiringRevert)).not.toMatch(WIRING_PIN);

    // Derived ceiling commented out.
    const ceilingRevert = replaceOnce(
      gateSource,
      ceiling,
      blockComment(ceiling),
    );
    expect(ceilingRevert).toMatch(CASE_CEILING_PIN);
    expect(blankComments(ceilingRevert)).not.toMatch(CASE_CEILING_PIN);

    // Budget assertion commented out.
    const assertionRevert = replaceOnce(
      gateSource,
      assertion,
      blockComment(assertion),
    );
    expect(blankComments(assertionRevert)).not.toMatch(BUDGET_ASSERTION_PIN);

    // Partial rollback: assertion and ceiling commented out, wiring intact.
    const partialRevert = replaceOnce(
      assertionRevert,
      ceiling,
      blockComment(ceiling),
    );
    expect(blankComments(partialRevert)).not.toMatch(BUDGET_ASSERTION_PIN);
    expect(blankComments(partialRevert)).not.toMatch(CASE_CEILING_PIN);

    // Case really skipped, with a commented-out copy of the enabled opening
    // left behind to tempt the opening pin.
    const skippedCaseRevert = replaceOnce(
      gateSource,
      caseOpening,
      blockComment(caseOpening) + '\n  it.skip(\n' + title,
    );
    expect(skippedCaseRevert).toMatch(CASE_OPENING_PIN);
    expect(blankComments(skippedCaseRevert)).not.toMatch(CASE_OPENING_PIN);

    // Same shape for the describe opening.
    const skippedDescribeRevert = replaceOnce(
      gateSource,
      describeOpening,
      blockComment(describeOpening) +
        "\ndescribe.skip('ExportTranscriptDocument browser gate', () => {",
    );
    expect(skippedDescribeRevert).toMatch(DESCRIBE_OPENING_PIN);
    expect(blankComments(skippedDescribeRevert)).not.toMatch(
      DESCRIBE_OPENING_PIN,
    );
  });
});
