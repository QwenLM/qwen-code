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

import { describe, it, expect, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  wasDeliveredVerbatim,
  findingsPointerOf,
  writeFindingsFile,
} from './prompt-record.js';
import { writeStderrLineSafe } from '../../../utils/stdioHelpers.js';

vi.mock('../../../utils/stdioHelpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/stdioHelpers.js')>()),
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
  writeStderrLineSafe: vi.fn(),
}));

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

  it('fails closed on an EMPTY built prompt — the loop would be vacuously true', () => {
    // The one input that must not pass. `recordPrompt` swallows its write errors by
    // design, so a partial write leaves a zero-byte record — and `readRecordedPrompts`
    // stores that as `''`, not `undefined`, so the "no prompt was built" guard does
    // not catch it. A vacuously-true check would then credit the role to whichever
    // transcript the roster looked at first.
    expect(wasDeliveredVerbatim('anything at all', '')).toBe(false);
    expect(wasDeliveredVerbatim('anything at all', '   \n  \n ')).toBe(false);
  });
});

describe('findingsPointerOf — the list file a recorded launch points at', () => {
  it('extracts the pointer from a findings-role block', () => {
    const prompt = [
      'You are review agent `verify`.',
      '',
      '```',
      'read_file(file_path="/t/verify--round-1--abc123.findings.md")',
      '```',
      '',
      '**Your brief is a file. Read it first.**',
      'read_file(file_path="/t/verify--abc123.brief.md")',
    ].join('\n');
    expect(findingsPointerOf(prompt)).toBe(
      '/t/verify--round-1--abc123.findings.md',
    );
  });

  it('returns null for a prompt with no findings pointer', () => {
    // A chunk agent's block: brief and diff only — and a `.brief.md` path can
    // never match the `.findings.md` suffix the pointer carries.
    expect(findingsPointerOf(BUILT)).toBeNull();
  });

  it('ignores a pointer-shaped line quoted inside an inlined findings list', () => {
    // The write-failure fallback inlines the list where the pointer would sit.
    // A finding entry there can quote a read_file pointer of ITS own (a finding
    // about this pipeline); the anchor must not mistake that quotation for the
    // pointer, or retirement would confine-and-read an earlier round's file and
    // flip a just-filed finding to an echo. A quoted pointer is indented or
    // embedded in prose, so a standalone-line anchor skips it.
    const prompt = [
      'You are review agent `reverse-audit` (round 2).',
      '',
      '## Already confirmed — do not re-report these',
      '',
      '- **File:** src/review/prompt-record.ts:85 — a finding quoting the',
      '  pointer shape: `read_file(file_path="/t/old.findings.md")`',
      '- **Severity:** Suggestion',
      '',
      '**Your brief is a file. Read it first.**',
      'read_file(file_path="/t/reverse-audit--abc123.brief.md")',
    ].join('\n');
    expect(findingsPointerOf(prompt)).toBeNull();
  });
});

describe('writeFindingsFile — a failed write must not be silent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('reports the failure on stderr and returns null so the caller inlines', () => {
    // The build must not die on an unwritable record dir — and it must not
    // point the round at a file that does not exist either: null is what
    // makes findingsSection fall back to inlining the list (the pre-#8597
    // shape), instead of 12-14 agents burning a round against a dead path.
    // A FILE where the record directory must sit makes mkdir fail. The
    // diagnostic goes through writeStderrLineSafe: this catch exists to keep
    // the build alive, so it must not throw out of it on EPIPE.
    const dir = mkdtempSync(join(tmpdir(), 'pr-ff-'));
    try {
      const blocker = join(dir, 'blocker');
      writeFileSync(blocker, 'a file where a directory would go');
      const planPath = join(blocker, 'plan.json');
      const p = writeFindingsFile(planPath, 'verify--abc', 'the list');
      expect(p).toBeNull();
      const calls = (writeStderrLineSafe as unknown as Mock).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(
        calls.some((m) => m.includes('failed to write findings file')),
      ).toBe(true);
      expect(calls.some((m) => m.includes('inlining the list instead'))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
