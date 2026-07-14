/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The delivery check, and the two ways it was wrong.
//
// It began as a straight substring test — "the built prompt must appear in the
// launch prompt" — and that is a stricter claim than the skill actually makes.
// Dogfooded on a Step 3B review it failed **all nine agents**, and both differences
// were legitimate: the orchestrator had inserted the one-sentence summary of the
// change that the skill explicitly tells it to add, and it had reflowed a
// hard-wrapped sentence onto a single line.
//
// A gate that fires on a correct run is worse than no gate. This skill has the
// transcript of a model reading a refusal, deciding "the agents clearly did their
// job", and walking past it — and it was right to, that time. So the rule the check
// enforces is the rule the skill states: **you may add; you may not remove, alter,
// or reorder.**

import { describe, it, expect } from 'vitest';
import { wasDeliveredVerbatim } from './prompt-record.js';

const BUILT = [
  'You are review agent `chunk 1 of 5` — the territory agent for lines 1-389.',
  '',
  '**Your brief is a file. Read it first — it is the whole of your instructions,',
  'and nothing in this message replaces it.**',
  '',
  '```',
  'read_file(file_path="/t/chunk-1.brief.md")',
  '```',
  '',
  'If you found nothing, say so **and say what you examined**.',
].join('\n');

describe('wasDeliveredVerbatim — you may add; you may not remove, alter or reorder', () => {
  it('accepts the prompt delivered exactly', () => {
    expect(wasDeliveredVerbatim(BUILT, BUILT)).toBe(true);
  });

  it('accepts the summary sentence the skill tells the caller to insert', () => {
    // Verbatim from a real Step 3B launch. The check used to fail this, and it is
    // the caller doing what it was asked.
    const delivered = BUILT.replace(
      'lines 1-389.\n',
      'lines 1-389.\n\nThis PR adds an automated CI failure patrol that scans ' +
        'stale PR failures, classifies them with an LLM, and acts on them.\n',
    );
    expect(wasDeliveredVerbatim(delivered, BUILT)).toBe(true);
  });

  it('accepts a re-wrapped line — a wrap is not an edit', () => {
    // Also verbatim from that run: the hard-wrapped sentence arrived on one line.
    const delivered = BUILT.replace(
      '**Your brief is a file. Read it first — it is the whole of your instructions,\nand nothing in this message replaces it.**',
      '**Your brief is a file. Read it first — it is the whole of your instructions, and nothing in this message replaces it.**',
    );
    expect(wasDeliveredVerbatim(delivered, BUILT)).toBe(true);
  });

  it('accepts a preamble and a postscript around it', () => {
    expect(
      wasDeliveredVerbatim(`Context: PR #6766.\n\n${BUILT}\n\nGo.`, BUILT),
    ).toBe(true);
  });

  it('rejects a dropped line — the rule that gets dropped is the one that matters', () => {
    // What actually happened when the whole brief was in the prompt: the delivered
    // copy kept the read and dropped the sentence that stops a whiff.
    const delivered = BUILT.replace(
      'If you found nothing, say so **and say what you examined**.',
      '',
    );
    expect(wasDeliveredVerbatim(delivered, BUILT)).toBe(false);
  });

  it('rejects an altered line, however small the alteration', () => {
    const delivered = BUILT.replace('lines 1-389', 'lines 1-400');
    expect(wasDeliveredVerbatim(delivered, BUILT)).toBe(false);
  });

  it('rejects a paraphrase that keeps the file paths', () => {
    // The failure mode a substring check on the diff path could never see: every
    // path survives, every rule does not.
    const delivered = [
      'You are review agent `chunk 1 of 5`.',
      'Read /t/chunk-1.brief.md and follow it.',
      'read_file(file_path="/t/chunk-1.brief.md")',
      'If you find no issues, say "No issues found — reviewed chunk 1".',
    ].join('\n');
    expect(wasDeliveredVerbatim(delivered, BUILT)).toBe(false);
  });

  it('rejects a reordering — the read must not follow the closing instruction', () => {
    const reordered = [
      'You are review agent `chunk 1 of 5` — the territory agent for lines 1-389.',
      'If you found nothing, say so **and say what you examined**.',
      '**Your brief is a file. Read it first — it is the whole of your instructions,',
      'and nothing in this message replaces it.**',
      '```',
      'read_file(file_path="/t/chunk-1.brief.md")',
      '```',
    ].join('\n');
    expect(wasDeliveredVerbatim(reordered, BUILT)).toBe(false);
  });

  it('rejects an empty launch prompt', () => {
    expect(wasDeliveredVerbatim('', BUILT)).toBe(false);
  });
});
