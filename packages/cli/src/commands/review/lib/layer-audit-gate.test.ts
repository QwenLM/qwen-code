/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layerAuditGate } from './layer-audit-gate.js';
import { MODELED_SYSTEM_DOMAIN } from './audit-layers.js';

/** A valid RepositoryContext (strict schema) with the given domains. */
function context(domains: string[]) {
  return {
    version: 1,
    provider: 'test',
    label: 'guard',
    domains,
    relatedPaths: [],
    recommendedTests: [],
    requiredConfigurations: [],
    requiredAgents: [],
    unverifiedDimensions: [],
    verificationNotes: [],
  };
}

describe('layerAuditGate', () => {
  let dir: string;
  const planPath = () => join(dir, 'plan.json');
  const writePlan = (plan: unknown) =>
    writeFileSync(planPath(), JSON.stringify(plan));
  const env = {} as NodeJS.ProcessEnv;

  // Receipts covering exactly the named layers, one return each.
  const returns = (...covered: string[]) =>
    covered.map((id) => `Layer walked: ${id} — examined.`);

  // Wrap a reader result: the corroborated returns plus how many identity-matched
  // reverse auditors ran at all (defaults to one per corroborated return).
  const reader =
    (corroborated: string[], identityMatched = corroborated.length) =>
    () => ({ corroborated, identityMatched });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'layer-gate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is inert with no plan path', () => {
    expect(
      layerAuditGate(undefined, env, reader(returns())).unreviewed,
    ).toEqual([]);
  });

  it('is inert on a plan with no repository context', () => {
    writePlan({ srcDiffLines: 10 });
    expect(
      layerAuditGate(planPath(), env, reader(returns('lexing'))).unreviewed,
    ).toEqual([]);
  });

  it('is inert when the manifest does not mark the diff a modeled system', () => {
    writePlan({ repositoryContext: context(['some-other-domain']) });
    // Even with token-only coverage, no sentinel domain → no cap at all.
    expect(
      layerAuditGate(planPath(), env, reader(returns('lexing'))).unreviewed,
    ).toEqual([]);
  });

  it('owes an entry per unwalked layer once the diff is marked a modeled system', () => {
    writePlan({ repositoryContext: context([MODELED_SYSTEM_DOMAIN]) });
    // Token layers walked; the state layers were not — the #8687 shape.
    const out = layerAuditGate(
      planPath(),
      env,
      reader(returns('lexing', 'expansion')),
    ).unreviewed;
    expect(out.some((e) => e.includes('scope-propagation'))).toBe(true);
    expect(out.some((e) => e.includes('resolution-order'))).toBe(true);
    expect(out.some((e) => e.includes('inheritance'))).toBe(true);
    expect(out.some((e) => e.includes('toctou'))).toBe(true);
    // Walked layers are not owed.
    expect(out.some((e) => e.includes('lexing'))).toBe(false);
    // Every entry is a self-explained cap line, prefixed so compose-review's
    // caller-echo dedup cannot shadow it behind a `reverse audit` coverage entry.
    for (const e of out)
      expect(e).toMatch(
        /^reverse-audit layer coverage — the .+ was never walked$/,
      );
  });

  it('fails open (default reader) when the transcript dir is missing — finding 1', () => {
    // Every other test injects readReturns; this one exercises the REAL reader, so
    // a regression that lets readTranscripts throw out of the gate — taking compose
    // down on a manifest-marked diff in a transcript-less environment — fails here.
    // An empty env makes transcriptPaths throw TranscriptsUnavailableError.
    writePlan({ repositoryContext: context([MODELED_SYSTEM_DOMAIN]) });
    expect(() =>
      layerAuditGate(planPath(), {} as NodeJS.ProcessEnv),
    ).not.toThrow();
    expect(
      layerAuditGate(planPath(), {} as NodeJS.ProcessEnv).unreviewed,
    ).toEqual([]);
  });

  it('owes nothing when every layer was walked', () => {
    writePlan({ repositoryContext: context([MODELED_SYSTEM_DOMAIN]) });
    const out = layerAuditGate(
      planPath(),
      env,
      reader(
        returns(
          'lexing',
          'expansion',
          'scope-propagation',
          'resolution-order',
          'inheritance',
          'toctou',
        ),
      ),
    ).unreviewed;
    expect(out).toEqual([]);
  });

  it('does NOT cap when no reverse auditor ran — the reverse-audit-ran floor owns that', () => {
    writePlan({ repositoryContext: context([MODELED_SYSTEM_DOMAIN]) });
    // Zero identity-matched auditors: the floor caps "the auditor never ran".
    expect(layerAuditGate(planPath(), env, reader([], 0)).unreviewed).toEqual(
      [],
    );
  });

  it('owes every layer when auditors ran but none read their territory', () => {
    writePlan({ repositoryContext: context([MODELED_SYSTEM_DOMAIN]) });
    // Identity-matched auditors ran, but none was corroborated by a territory
    // read (a diff-read failure, a budget stop, universal parroting). The floor
    // has no diff-read requirement, so it will not cap this — the gate must,
    // owing all six layers rather than deferring.
    const out = layerAuditGate(planPath(), env, reader([], 2)).unreviewed;
    expect(out).toHaveLength(6);
    expect(out.some((e) => e.includes('scope-propagation'))).toBe(true);
  });

  it('fails open on an invalid repository context', () => {
    // version 2 makes validateRepositoryContext throw; the gate must not.
    writePlan({
      repositoryContext: { ...context([MODELED_SYSTEM_DOMAIN]), version: 2 },
    });
    expect(
      layerAuditGate(planPath(), env, reader(returns('lexing'))).unreviewed,
    ).toEqual([]);
  });

  it('fails open on an unreadable plan', () => {
    expect(
      layerAuditGate(join(dir, 'nope.json'), env, reader(returns('lexing')))
        .unreviewed,
    ).toEqual([]);
  });
});

describe('the real reader on a resumed run — prior-session auditors count', () => {
  // Every other suite injects readReturns; these exercise the DEFAULT reader
  // against real transcript files, because this caller filters on the
  // reverse-audit identity line and corroborates with territory reads — a
  // path the shared readRunTranscripts tests cannot cover.
  let dir: string;
  let plan: string;
  let diff: string;

  const LAYERS = [
    'lexing',
    'expansion',
    'scope-propagation',
    'resolution-order',
    'inheritance',
    'toctou',
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'layer-gate-resume-'));
    plan = join(dir, 'plan.json');
    diff = join(dir, 'diff.txt');
    writeFileSync(
      plan,
      JSON.stringify({
        repositoryContext: context([MODELED_SYSTEM_DOMAIN]),
        diffPathAbsolute: diff,
      }),
    );
    const old = new Date(2020, 0, 1);
    utimesSync(plan, old, old);
    mkdirSync(join(dir, 'subagents', 'S1'), { recursive: true });
    mkdirSync(join(dir, 'subagents', 'S0'), { recursive: true });
    mkdirSync(join(dir, 'plan-prompts'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ENV = (): NodeJS.ProcessEnv => ({
    QWEN_CODE_PROJECT_DIR: dir,
    QWEN_CODE_SESSION_ID: 'S1',
  });

  function ledger(...ids: string[]): void {
    writeFileSync(
      join(dir, 'plan-prompts', 'run-sessions.json'),
      JSON.stringify(ids.map((id) => ({ sessionId: id, atMs: Date.now() }))),
    );
  }

  /** A corroborated reverse auditor in `session`: identity line, a baked
   *  territory read it actually performed, and receipts for `covered`. */
  function auditorTranscript(session: string, covered: string[]): void {
    const launch =
      'You are review agent `reverse-audit` — hunt the gaps.\n' +
      `read_file(file_path="${diff}", offset=0, limit=100)`;
    const base = { agentId: `ra-${session}`, agentName: 'general-purpose' };
    const lines = [
      JSON.stringify({
        ...base,
        type: 'user',
        message: { role: 'user', parts: [{ text: launch }] },
      }),
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { file_path: diff, offset: 0, limit: 100 },
              },
            },
          ],
        },
      }),
      JSON.stringify({
        ...base,
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read_file',
                response: { output: 'diff bytes' },
              },
            },
          ],
        },
      }),
      JSON.stringify({
        ...base,
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              text: covered
                .map((id) => `Layer walked: ${id} — examined.`)
                .join('\n'),
            },
          ],
        },
      }),
    ];
    writeFileSync(
      join(dir, 'subagents', session, `agent-ra-${session}.jsonl`),
      lines.join('\n') + '\n',
    );
  }

  it('credits the prior attempt before this session has launched anything', () => {
    // Without `currentDirOptional` the reader throws, the catch reports
    // `identityMatched: 0`, and the gate DEFERS — failing open on exactly
    // the layers the prior attempt never walked.
    ledger('S0', 'S1');
    auditorTranscript('S0', ['lexing', 'expansion']);
    rmSync(join(dir, 'subagents', 'S1'), { recursive: true, force: true });
    const out = layerAuditGate(plan, ENV()).unreviewed;
    expect(out).toHaveLength(4);
  });

  it("credits the interrupted attempt's walked layers through the ledger", () => {
    ledger('S0', 'S1');
    auditorTranscript('S0', LAYERS);
    expect(layerAuditGate(plan, ENV()).unreviewed).toEqual([]);
  });

  it('still owes the layers the prior auditor did not walk', () => {
    ledger('S0', 'S1');
    auditorTranscript('S0', ['lexing', 'expansion']);
    const out = layerAuditGate(plan, ENV()).unreviewed;
    expect(out).toHaveLength(4);
    expect(out.some((e) => e.includes('scope-propagation'))).toBe(true);
    expect(out.some((e) => e.includes('lexing'))).toBe(false);
  });

  it('sees nothing from a prior session the ledger never recorded', () => {
    // A PARTIAL walk is the discriminating shape: were the un-ledgered
    // transcript visible, one identity-matched auditor covering two layers
    // would owe the other four; invisible, identityMatched is 0 and the
    // reverse-audit-ran floor owns it — the gate defers entirely.
    auditorTranscript('S0', ['lexing', 'expansion']);
    expect(layerAuditGate(plan, ENV()).unreviewed).toEqual([]);
  });
});
