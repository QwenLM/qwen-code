/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

// One parser for the identity line `agent-prompt` bakes into every launch —
// shared by cost-ledger (row labels) and coverage (disclosure labels), which
// previously each carried their own copy of this grammar.

import { describe, expect, it } from 'vitest';
import {
  labelFromIdentityLine,
  labelFromLaunchPrompt,
} from './agent-identity.js';

describe('labelFromIdentityLine', () => {
  it('parses the role, keeping round and owned-file suffixes distinct', () => {
    expect(
      labelFromIdentityLine('You are review agent `security` — inspect auth'),
    ).toBe('agent security');
    // Rounds separate pipeline stages that share a role — reverse-audit
    // rounds 1 and 2 must not fold into one indistinguishable label.
    expect(
      labelFromIdentityLine(
        'You are review agent `reverse-audit` — Reverse audit agent (round 2).',
      ),
    ).toBe('agent reverse-audit (round 2)');
    // An invariant role launches once per heavy file; the full path is the
    // distinguisher (same-basename files exist across a monorepo).
    expect(
      labelFromIdentityLine(
        'You are review agent `invariant-a` — Whole-file invariants. Your file: `packages/cli/src/a.ts`.',
      ),
    ).toBe('agent invariant-a (packages/cli/src/a.ts)');
    // A chunk role labels as its chunk id, matching coverage's chunk labels.
    expect(
      labelFromIdentityLine(
        'You are review agent `chunk 3 of 7` — the territory agent for lines 120-260 of the diff.',
      ),
    ).toBe('chunk 3');
    // Both suffixes on one line (agent-prompt emits them independently):
    // round wins — losing it folds two rounds of the same owned file into
    // one cost-ledger row, the exact fold the round suffix prevents.
    expect(
      labelFromIdentityLine(
        'You are review agent `invariant-a` — Whole-file invariants (round 2). Your file: `packages/cli/src/a.ts`.',
      ),
    ).toBe('agent invariant-a (round 2)');
  });

  it('tolerates a trailing carriage return — CRLF prompts must still parse', () => {
    // Callers split on `\n` alone (cost-ledger slices at the first `\n`), so
    // a CRLF-recorded prompt hands this parser a `\r`-terminated line; a
    // parse that fails there falls back to first-line prose for EVERY agent.
    expect(
      labelFromIdentityLine('You are review agent `security` — inspect auth\r'),
    ).toBe('agent security');
    expect(
      labelFromLaunchPrompt(
        'context line\r\nYou are review agent `6c` — Undirected audit.\r\nbody\r\n',
      ),
    ).toBe('agent 6c');
  });

  it('returns null for anything that is not an identity line', () => {
    expect(
      labelFromIdentityLine('PR #9045 modifies getAuthTypeFromEnv().'),
    ).toBeNull();
    expect(labelFromIdentityLine('')).toBeNull();
    // A mid-line mention is a quote, not an identity.
    expect(
      labelFromIdentityLine(
        'as noted, You are review agent `security` was launched earlier',
      ),
    ).toBeNull();
  });
});

describe('labelFromLaunchPrompt', () => {
  it('finds the identity line under a launcher-prepended context line', () => {
    // Twelve live finders shared one PR-summary first line; a first-line-only
    // read labelled every disclosure with the same truncated PR quote.
    expect(
      labelFromLaunchPrompt(
        'PR #9045 (fixes issue #9025) modifies getAuthTypeFromEnv().\n\n' +
          'You are review agent `6c` — Agent 6c: Undirected audit.\n' +
          'Read your brief first.',
      ),
    ).toBe('agent 6c');
  });

  it("takes the agent's OWN line, which precedes anything quoted below it", () => {
    // CLI-built launches put the identity on line one; quoted identity lines
    // (a findings section citing another agent) sit below and must lose.
    expect(
      labelFromLaunchPrompt(
        'You are review agent `verify` — Verification agent (round 2).\n' +
          'Prior findings:\n' +
          'You are review agent `security` — inspect auth\n',
      ),
    ).toBe('agent verify (round 2)');
  });

  it('returns null when no line is an identity line', () => {
    expect(
      labelFromLaunchPrompt('Security review of the whole diff.'),
    ).toBeNull();
  });

  it('differs from the identity-line entry point on a quoted-below prompt', () => {
    // The two entry points are NOT interchangeable, and each caller's choice
    // is load-bearing. A CLI-built launch carries its identity on line one;
    // anything below can QUOTE another agent's. Coverage scans (its launches
    // arrive with orchestrator context prepended); cost-ledger refuses to,
    // because a scan would label its row by the quote and fold two agents'
    // costs into one. Consolidating both callers on either entry point must
    // fail here.
    const quotedBelow =
      'Context: the orchestrator rewrote this launch.\n' +
      'You are review agent `verify` — Verification (round 4).\n';

    // Scanning finds the identity wherever it sits…
    expect(labelFromLaunchPrompt(quotedBelow)).toBe('agent verify (round 4)');
    // …while cost-ledger's feed — line one alone — refuses it, leaving the
    // caller's own fallback (the transcript's file id) in place.
    expect(labelFromIdentityLine(quotedBelow.split('\n')[0])).toBeNull();
  });
});
