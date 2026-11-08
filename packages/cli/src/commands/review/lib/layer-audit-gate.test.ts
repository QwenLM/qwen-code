/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { layerAuditGate } from './layer-audit-gate.js';
import { appendRunSession, recordResume } from './run-ledger.js';
import { briefPath, promptRecordDir, recordPrompt } from './prompt-record.js';
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
    mkdirSync(promptRecordDir(join(dir, 'plan.json')), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ENV = (): NodeJS.ProcessEnv => ({
    QWEN_CODE_PROJECT_DIR: dir,
    QWEN_CODE_SESSION_ID: 'S1',
  });

  function ledger(...ids: string[]): void {
    // Written by the real writer: it stamps the plan mtime each entry is
    // keyed on, and the resume marker is what authorizes reading prior
    // evidence at all. The current attempt is stamped last, since each
    // attempt's window closes when the next one opened.
    const nowMs = Date.now();
    ids.forEach((id, i) =>
      appendRunSession(
        plan,
        { QWEN_CODE_SESSION_ID: id },
        i === ids.length - 1 ? nowMs + 1500 : nowMs,
      ),
    );
    recordResume(plan, ENV(), nowMs + 1500);
  }

  /** A corroborated reverse auditor in `session`: identity line, a baked
   *  territory read it actually performed, and receipts for `covered`. */
  function auditorTranscript(session: string, covered: string[]): void {
    // The CLI's own record plus the brief it points at: a receipt only
    // counts from an auditor that got THIS prompt and opened that brief.
    const key = 'reverse-audit';
    const brief = briefPath(plan, key);
    const launch =
      'You are review agent `reverse-audit` — hunt the gaps.\n' +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${diff}", offset=0, limit=100)`;
    mkdirSync(promptRecordDir(plan), { recursive: true });
    writeFileSync(brief, 'The reverse-audit brief.');
    recordPrompt(plan, key, launch);
    const base = {
      agentId: `ra-${session}`,
      agentName: 'general-purpose',
      sessionId: session,
    };
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
              functionCall: { name: 'read_file', args: { file_path: brief } },
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
                response: { output: 'brief' },
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
    const f = join(dir, 'subagents', session, `agent-ra-${session}.jsonl`);
    writeFileSync(f, lines.join('\n') + '\n');
    // Backdated below the ledger's prior-window close (nowMs+1500): written
    // AFTER ledger(), a >1.5s CI stall would otherwise fence prior-session
    // fixtures out via the `until` clamp.
    const past = new Date(Date.now() - 10_000);
    utimesSync(f, past, past);
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

  it('refuses a receipt whose auditor only NAMED the brief, never read it', () => {
    // `successfulCallArgs` covers every successful tool, so a grep whose args
    // merely contain the brief path cleared `delivered()` — an auditor that
    // never opened its instructions supplied the receipt. Only a successful
    // `read_file` of the exact brief is opening it.
    ledger('S1');
    auditorTranscript('S1', LAYERS);
    const f = join(dir, 'subagents', 'S1', 'agent-ra-S1.jsonl');
    // Turn the brief READ into a search that names the same path.
    writeFileSync(
      f,
      readFileSync(f, 'utf8').replace(
        '"functionCall":{"name":"read_file","args":{"file_path":' +
          JSON.stringify(briefPath(plan, 'reverse-audit')) +
          '}}',
        '"functionCall":{"name":"search_file_content","args":{"pattern":"x","path":' +
          JSON.stringify(briefPath(plan, 'reverse-audit')) +
          '}}',
      ),
    );
    const out = layerAuditGate(plan, ENV()).unreviewed;
    expect(out).toHaveLength(6);
  });

  it('refuses receipts from an auditor that never RETURNED', () => {
    // A died-mid-flight auditor's narration can carry every receipt form —
    // the harness flushes text before the round's tool calls — and
    // corroborating layers from it is the RELEASE direction, the one the
    // gate's header rules out. Tool traffic after the receipts text is the
    // died shape: `returned: false`.
    ledger('S1');
    auditorTranscript('S1', LAYERS);
    const f = join(dir, 'subagents', 'S1', 'agent-ra-S1.jsonl');
    const base = {
      agentId: 'ra-S1',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    appendFileSync(
      f,
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
      }) + '\n',
    );
    const past = new Date(Date.now() - 9_000);
    utimesSync(f, past, past);
    const out = layerAuditGate(plan, ENV()).unreviewed;
    expect(out).toHaveLength(6);
  });

  it('a transcript matching TWO reverse-audit records delivers neither', () => {
    // `wasDeliveredVerbatim` allows additions, so a launch CONCATENATING
    // two reverse-audit blocks matches both records — and the territory
    // check ranges over the launch-wide UNION of baked ranges, so a walk of
    // one block's territory corroborated everything the other block owed.
    // A transcript matching more than one record names no territory
    // specifically and delivers none (retirement's injectivity rule).
    ledger('S1');
    auditorTranscript('S1', LAYERS);
    // A second reverse-audit record whose lines the SAME launch already
    // verbatim-contains — the minimal concatenation shape.
    recordPrompt(
      plan,
      'reverse-audit--chunk-9',
      `read_file(file_path="${diff}", offset=0, limit=100)`,
    );
    const out = layerAuditGate(plan, ENV()).unreviewed;
    expect(out).toHaveLength(6);
  });

  it('refuses a STALE record a dead attempt left beside the plan', () => {
    // The records read as HISTORY must take the run-epoch fence, like the
    // sibling history reader in retirement: nothing clears the record dir,
    // and an orchestrator that hand-launches a stale record's prompt
    // verbatim otherwise corroborates a run whose builder never emitted an
    // auditor — a fail-open on the gate's own withhold-only invariant.
    ledger('S1');
    auditorTranscript('S1', LAYERS);
    // Backdate the record INSIDE the would-be slack window: one second
    // before the plan's mtime. The strict fence excludes it; a slacked fence
    // (runEpochMs = mtime − 2000) would re-admit it — the consolidation a
    // refactor reaches for, which a year-apart fixture cannot see.
    const past = new Date(new Date(2020, 0, 1).getTime() - 1000);
    const rec = join(
      promptRecordDir(plan),
      `${encodeURIComponent('reverse-audit')}.txt`,
    );
    utimesSync(rec, past, past);
    const out = layerAuditGate(plan, ENV()).unreviewed;
    expect(out).toHaveLength(6);
  });

  it('refuses a delivered auditor whose reads were OFF its territory', () => {
    // The territory clause, discriminated on a fixture that PASSES
    // delivered(): the only off-territory fixture elsewhere fails delivery
    // first, so the clause could be deleted with the suite green.
    ledger('S1');
    auditorTranscript('S1', LAYERS);
    const f = join(dir, 'subagents', 'S1', 'agent-ra-S1.jsonl');
    // Move the diff read far off the baked offset=0..100 territory.
    writeFileSync(
      f,
      readFileSync(f, 'utf8').replaceAll(
        '"args":{"file_path":' +
          JSON.stringify(diff) +
          ',"offset":0,"limit":100}',
        '"args":{"file_path":' +
          JSON.stringify(diff) +
          ',"offset":3300,"limit":100}',
      ),
    );
    const out = layerAuditGate(plan, ENV()).unreviewed;
    expect(out).toHaveLength(6);
  });

  it('ignores receipts from a delivered agent WITHOUT the identity line', () => {
    // The identity filter, discriminated on a fixture that clears every
    // other clause: a verifier-shaped record delivered verbatim, brief
    // opened, diff read on territory, `Layer walked:` lines in its return —
    // and no reverse-audit identity. It must contribute nothing.
    ledger('S1');
    const key = 'verify';
    const brief = briefPath(plan, key);
    const launch =
      'You are review agent `verify` — rule on the findings.\n' +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${diff}", offset=0, limit=100)`;
    mkdirSync(promptRecordDir(plan), { recursive: true });
    writeFileSync(brief, 'The verify brief.');
    recordPrompt(plan, key, launch);
    const base = {
      agentId: 'v-1',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    writeFileSync(
      join(dir, 'subagents', 'S1', 'agent-v-1.jsonl'),
      [
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
                functionCall: { name: 'read_file', args: { file_path: brief } },
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
                  response: { output: 'brief' },
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
                text: LAYERS.map(
                  (id) => `Layer walked: ${id} — examined.`,
                ).join('\n'),
              },
            ],
          },
        }),
      ].join('\n') + '\n',
    );

    // A REAL auditor beside it, covering two layers: with the identity
    // filter the verifier contributes nothing and four layers stay owed;
    // without it the verifier's six receipts release everything. (A
    // verifier-only fixture cannot discriminate — no auditor at all makes
    // the gate defer, which is also `[]`.)
    auditorTranscript('S1', ['lexing', 'expansion']);
    const out = layerAuditGate(plan, ENV()).unreviewed;
    expect(out).toHaveLength(4);
  });

  it('refuses an identity MENTION that is not the identity line', () => {
    // The anchor's strictness: a launch that merely CONTAINS the substring
    // (a verifier told to coordinate with reverse-audit) must not match, or
    // a bare-substring weakening of REVERSE_AUDIT_IDENTITY ships green.
    ledger('S1');
    const key = 'verify';
    const brief = briefPath(plan, key);
    const launch =
      'You are review agent `verify` — after the reverse-audit pass, rule.\n' +
      `read_file(file_path="${brief}")\n` +
      `read_file(file_path="${diff}", offset=0, limit=100)`;
    mkdirSync(promptRecordDir(plan), { recursive: true });
    writeFileSync(brief, 'The verify brief.');
    recordPrompt(plan, key, launch);
    const base = {
      agentId: 'vm',
      agentName: 'general-purpose',
      sessionId: 'S1',
    };
    const f = join(dir, 'subagents', 'S1', 'agent-vm.jsonl');
    writeFileSync(
      f,
      [
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
                text: LAYERS.map((id) => `Layer walked: ${id} — done.`).join(
                  '\n',
                ),
              },
            ],
          },
        }),
      ].join('\n') + '\n',
    );
    auditorTranscript('S1', ['lexing', 'expansion']);
    expect(layerAuditGate(plan, ENV()).unreviewed).toHaveLength(4);
  });

  it('refuses a delivered auditor with ZERO diff reads', () => {
    // The diffToolCalls clause on a fixture that passes delivery: the parrot
    // fails delivered() first, so the clause was deletable with the suite
    // green.
    ledger('S1');
    auditorTranscript('S1', LAYERS);
    const f = join(dir, 'subagents', 'S1', 'agent-ra-S1.jsonl');
    const needle = JSON.stringify(diff).slice(1, -1);
    const lines = readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      // Drop only the diff CALL/RESPONSE pair — the launch line also names
      // the path, and removing it would erase the identity instead.
      .filter(
        (l) =>
          !(
            l.includes(needle) &&
            (l.includes('"functionCall"') || l.includes('"functionResponse"'))
          ),
      );
    writeFileSync(f, lines.join('\n') + '\n');
    const past = new Date(Date.now() - 10_000);
    utimesSync(f, past, past);
    expect(layerAuditGate(plan, ENV()).unreviewed).toHaveLength(6);
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
