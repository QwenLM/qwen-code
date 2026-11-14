/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createSourceFile,
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
    // getChildren, not forEachChild: punctuation tokens own trivia too (a
    // block comment before a call's closing paren is leading trivia of the
    // CloseParenToken), and forEachChild never visits them.
    for (const child of node.getChildren()) collect(child);
  };
  collect(sourceFile);
  // Comments after the last statement are leading trivia of the EOF token;
  // collect it explicitly in case the child walk ever skips it.
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
// other line verbatim; pin the enabled opening through the callback and the
// first body statement, with the case title quoted verbatim from the gate, so
// an options-object skip, a curried it.skipIf(cond)(, or an early-return first
// statement all break the pin.
const CASE_OPENING_PIN =
  /^\s*it\(\s*'opens, searches, copies, and prints the maximum document with its pinned npm runtime',?\n\s*async \(\) => \{\n {6}const exportDocument = createMaximumDocument\(\);/m;
const DESCRIBE_OPENING_PIN =
  /^\s*describe\('ExportTranscriptDocument browser gate',/m;
// vitest honours a { skip } options object as the second argument and silently
// drops the trailing timeout, so the ceiling pin would keep matching a dead
// literal; no case in the gate may carry such an options key.
const CASE_OPTIONS_PIN = /\{\s*(?:skip|only|todo|skipIf|runIf)\s*:/;
// The budget assertion is anchored to its immediate neighbours at the case
// body's exact indentation, so relocating it, wrapping it in a block, or
// re-indenting the whole block under a dead condition all break the pin.
const BUDGET_ASSERTION_PIN =
  /^ {6}await expectConnectSrcCspEnforced\(page\);\n {6}expect\(durationMs\)\.toBeLessThan\(MAX_DOCUMENT_DURATION_MS\);\n {6}const heapDeltaBytes = Math\.max\(0, heapAfter - heapBefore\);/m;
// The measured window the assertion reads: both ends are anchored to their
// immediate neighbours at the case body's exact indentation, so zeroing the
// measurement, moving either end, or commenting them out all break the pins.
const WINDOW_START_PIN =
  /^ {6}const probe = await installNetworkAndCspProbe\(page\);\n {6}const startedAt = nodePerformance\.now\(\);\n {6}const heapBefore = await page\.evaluate\(/m;
const WINDOW_END_PIN =
  /^ {6}\);\n {6}const durationMs = nodePerformance\.now\(\) - startedAt;$/m;
// No focus/skip/todo modifier anywhere in the gate: it.only( on a sibling
// case silently drops the maximum-document case on local runs (CI unset),
// and the opening pins only see the case's own opening.
const FOCUS_PIN = /^\s*(?:it|describe|test)\s*\.\s*(?:only|skip|todo)\s*\(/m;

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
    // The pool's real CI environment carries both markers.
    expect(
      documentExportBudgetMs({ CI: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }),
    ).toBe(180_000);
    // The per-case timeout (budget + 30s slack) outranks the suite default,
    // so the budget assertion is the one that reports a wedged run. The
    // literal comparison documents that the widened budget still fits under
    // the suite's five-minute default. Literal, not the imported config: the
    // config derives testTimeout from the ambient TB_TIMEOUT_MINUTES, which
    // would make this config-free lane depend on the caller's shell (same
    // shape as ready-prompt-budget.test.ts).
    expect(budget).toBeLessThan(300_000);
    // The literal is only correct while the integration default stays five
    // minutes; pin both halves of the derivation so lowering the '5'
    // fallback or changing the arithmetic reddens here and both ceilings
    // move together.
    expect(integrationConfigCode).toMatch(
      /Number\(process\.env\['TB_TIMEOUT_MINUTES'\] \|\| '5'\)/,
    );
    expect(integrationConfigCode).toMatch(
      /const testTimeoutMs = timeoutMinutes \* 60 \* 1000;/,
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
    // The measured window must stay intact: zeroing durationMs or moving
    // startedAt turns the budget assertion into a tautology without touching
    // any line above.
    expect(gateCode).toMatch(WINDOW_START_PIN);
    expect(gateCode).toMatch(WINDOW_END_PIN);
    // No focus/skip/todo modifier anywhere in the gate, and no options-object
    // skip/only/todo key on any case.
    expect(gateCode).not.toMatch(FOCUS_PIN);
    expect(gateCode).not.toMatch(CASE_OPTIONS_PIN);
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
      '    async () => {',
      '      const exportDocument = createMaximumDocument();',
      '    },',
      '    MAX_DOCUMENT_DURATION_MS + 30_000,',
      '  );',
    ].join('\n');
    expect(skippedCase).not.toMatch(CASE_OPENING_PIN);
    expect(skippedCase.replace('it.skip(', 'it(')).toMatch(CASE_OPENING_PIN);
    const skippedDescribe =
      "describe.skip('ExportTranscriptDocument browser gate', () => {});";
    expect(skippedDescribe).not.toMatch(DESCRIBE_OPENING_PIN);

    // Options-object skip: vitest honours { skip } as the second argument and
    // silently drops the trailing timeout; the negative options pin must see
    // it, and the curried / early-return shapes must break the opening pin.
    const optionsSkip = [
      '  it(',
      "    'opens, searches, copies, and prints the maximum document with its pinned npm runtime',",
      "    { skip: process.env.RUNNER_ENVIRONMENT === 'self-hosted' },",
      '    async () => {',
      '      const exportDocument = createMaximumDocument();',
      '    },',
      '    MAX_DOCUMENT_DURATION_MS + 30_000,',
      '  );',
    ].join('\n');
    expect(optionsSkip).toMatch(CASE_OPTIONS_PIN);
    const curriedSkipIf = skippedCase.replace('it.skip(', 'it.skipIf(false)(');
    expect(curriedSkipIf).not.toMatch(CASE_OPENING_PIN);
    const earlyReturn = skippedCase
      .replace('it.skip(', 'it(')
      .replace(
        '      const exportDocument = createMaximumDocument();',
        '      if (!process.env.CI) return;\n      const exportDocument = createMaximumDocument();',
      );
    expect(earlyReturn).not.toMatch(CASE_OPENING_PIN);

    // Focus-marker shape: the negative gate assertion must see it.only( /
    // it.todo( on any case, not just the maximum-document case's opening.
    const focusedCase = "  it.only('a sibling case', async () => {});";
    expect(focusedCase).toMatch(FOCUS_PIN);
    const todoCase = "  it.todo('a sibling case');";
    expect(todoCase).toMatch(FOCUS_PIN);

    // Commented-out measured window, trailing-opener shape: the block comment
    // opens at the END of the preceding code line, so it is trailing trivia
    // of that statement — the leading scan alone does not collect it. The raw
    // fixture still matches each pin (the pinned lines stay consecutive);
    // only blanking kills the match, so these fixtures witness the trailing
    // half of blankComments, not just adjacency.
    const windowStartTrailing = [
      '      const html = renderExportTranscriptDocumentToHtml(exportDocument); /*',
      '      const probe = await installNetworkAndCspProbe(page);',
      '      const startedAt = nodePerformance.now();',
      '      const heapBefore = await page.evaluate(',
      '*/',
    ].join('\n');
    expect(windowStartTrailing).toMatch(WINDOW_START_PIN);
    expect(blankComments(windowStartTrailing)).not.toMatch(WINDOW_START_PIN);
    const windowEndTrailing = [
      '      const heapAfter = await readHeap(); /*',
      '      );',
      '      const durationMs = nodePerformance.now() - startedAt;',
      '*/',
    ].join('\n');
    expect(windowEndTrailing).toMatch(WINDOW_END_PIN);
    expect(blankComments(windowEndTrailing)).not.toMatch(WINDOW_END_PIN);

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
    const ceilingStringCopy =
      'const note = "MAX_DOCUMENT_DURATION_MS + 30_000, );";';
    expect(ceilingStringCopy).not.toMatch(CASE_CEILING_PIN);

    // Newline preservation is load-bearing: the line anchors correspond to
    // the real file's line structure, so blanking must keep every newline
    // (and the length). A multi-line comment is the shape that distinguishes
    // preserving newlines from collapsing them; the gate's own comments are
    // all single-line, so this fixture must be synthetic.
    const multiLineComment = [
      'const a = 1;',
      '/*',
      ' * comment',
      ' */',
      'const b = 2;',
    ].join('\n');
    const blankedMulti = blankComments(multiLineComment);
    expect(blankedMulti).toHaveLength(multiLineComment.length);
    expect(blankedMulti.split('\n')).toHaveLength(
      multiLineComment.split('\n').length,
    );

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
    const caseOpening =
      '  it(\n' +
      title +
      '\n    async () => {\n      const exportDocument = createMaximumDocument();';
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

    // Parseable ceiling revert: the argument and the original closer are
    // commented out in place and a fresh closer keeps the call valid, so the
    // block comment is leading trivia of the closing paren token — which a
    // forEachChild walk never visits.
    const ceilingRevertWithCloser = replaceOnce(
      gateSource,
      ceiling,
      blockComment(ceiling) + '\n  );',
    );
    expect(ceilingRevertWithCloser).toMatch(CASE_CEILING_PIN);
    expect(blankComments(ceilingRevertWithCloser)).not.toMatch(
      CASE_CEILING_PIN,
    );

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

    // Measured window commented out via trailing openers: each block comment
    // opens at the end of the preceding code line, so the pinned lines stay
    // consecutive in the raw mutant (both pins still match) and only blanking
    // kills the match — the same shape as the synthetic trailing fixtures.
    const windowRevert = replaceOnce(
      replaceOnce(
        replaceOnce(
          replaceOnce(
            gateSource,
            '      const page = await browser.newPage();\n      const probe = await installNetworkAndCspProbe(page);\n      const startedAt = nodePerformance.now();',
            '      const page = await browser.newPage(); /*\n      const probe = await installNetworkAndCspProbe(page);\n      const startedAt = nodePerformance.now();',
          ),
          '      const heapBefore = await page.evaluate(',
          '      const heapBefore = await page.evaluate(\n*/',
        ),
        '          ).memory?.usedJSHeapSize ?? 0,\n      );\n      const durationMs = nodePerformance.now() - startedAt;',
        '          ).memory?.usedJSHeapSize ?? 0, /*\n      );\n      const durationMs = nodePerformance.now() - startedAt;',
      ),
      '      const durationMs = nodePerformance.now() - startedAt;',
      '      const durationMs = nodePerformance.now() - startedAt;\n*/',
    );
    expect(windowRevert).toMatch(WINDOW_START_PIN);
    expect(windowRevert).toMatch(WINDOW_END_PIN);
    expect(blankComments(windowRevert)).not.toMatch(WINDOW_START_PIN);
    expect(blankComments(windowRevert)).not.toMatch(WINDOW_END_PIN);
  });
});
