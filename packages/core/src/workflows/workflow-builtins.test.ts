/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEEP_RESEARCH_WORKFLOW_SCRIPT,
} from './workflow-builtins.js';
import { parseWorkflowScript } from './workflow-parser.js';
import { runWorkflowScript } from './workflow-runtime.js';
import type {
  WorkflowAgentInvocation,
  WorkflowAgentResult,
} from './workflow-types.js';

type Vote = boolean | 'error';

function completed(structured: unknown): WorkflowAgentResult {
  return {
    content: JSON.stringify(structured),
    structured,
    state: 'done',
  };
}

function enumNodesWithoutType(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      enumNodesWithoutType(item, `${path}[${index}]`),
    );
  }
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const missing = Array.isArray(record['enum']) && record['type'] === undefined;
  return [
    ...(missing ? [path] : []),
    ...Object.entries(record).flatMap(([key, child]) =>
      enumNodesWithoutType(child, `${path}.${key}`),
    ),
  ];
}

async function runDeepResearch(options: {
  votes: Vote[];
  synthesisResult?: unknown | null;
  synthesisApiError?: string;
  angles?: string[];
  searchResults?: Record<
    string,
    Array<{ url: string; title: string; relevance: 'high' | 'medium' | 'low' }>
  >;
  extractClaims?: boolean;
  claimsPerSource?: number;
}) {
  const parsed = parseWorkflowScript(DEEP_RESEARCH_WORKFLOW_SCRIPT);
  const invocations: WorkflowAgentInvocation[] = [];
  let voteIndex = 0;
  let fetchIndex = 0;
  const angles = options.angles ?? ['primary', 'recent', 'skeptical'];
  const result = await runWorkflowScript({
    config: {} as Parameters<typeof runWorkflowScript>[0]['config'],
    args: 'Does the test claim hold?',
    scriptBody: parsed.scriptBody,
    seedPhaseTitles: parsed.meta.phases?.map((phase) => phase.title),
    invokeAgent: async ({ invocation }) => {
      invocations.push(invocation);
      if (invocation.label === 'scope') {
        return completed({
          question: 'Does the test claim hold?',
          summary: 'Cover primary evidence, recent evidence, and objections.',
          angles: angles.map((label) => ({
            label,
            query: `test claim ${label}`,
          })),
        });
      }
      if (invocation.label.startsWith('search:') && options.searchResults) {
        const angle = invocation.label.slice('search:'.length);
        return completed({ results: options.searchResults[angle] ?? [] });
      }
      if (invocation.label === 'search:primary') {
        return completed({
          results: [
            {
              url: 'https://www.example.com/evidence/',
              title: 'Primary evidence',
              relevance: 'high',
            },
          ],
        });
      }
      if (invocation.label === 'search:recent') {
        return completed({
          results: [
            {
              url: 'https://example.com/evidence',
              title: 'Duplicate evidence',
              relevance: 'medium',
            },
          ],
        });
      }
      if (invocation.label === 'search:skeptical') {
        return completed({ results: [] });
      }
      if (invocation.label.startsWith('fetch:')) {
        const sourceIndex = fetchIndex++;
        return completed({
          sourceQuality: 'primary',
          publishDate: '2026-07-17',
          claims:
            options.extractClaims === false
              ? []
              : Array.from(
                  { length: options.claimsPerSource ?? 1 },
                  (_, claimIndex) => ({
                    claim: `The test claim ${sourceIndex}-${claimIndex} is supported.`,
                    quote: 'Direct supporting evidence.',
                    importance: 'central',
                  }),
                ),
        });
      }
      if (/^v\d+:/.test(invocation.label)) {
        const vote = options.votes[voteIndex++] ?? false;
        if (vote === 'error') throw new Error('verifier unavailable');
        return completed({
          refuted: vote,
          evidence: vote ? 'Contradicting evidence.' : 'Supporting evidence.',
          confidence: 'high',
        });
      }
      if (invocation.label === 'synthesize') {
        if (options.synthesisApiError) {
          return {
            content: options.synthesisApiError,
            state: 'error',
            apiError: options.synthesisApiError,
          };
        }
        if (options.synthesisResult === null) return null;
        return completed(
          options.synthesisResult ?? {
            summary: 'The claim is supported.',
            findings: [
              {
                claim: 'The test claim is supported.',
                confidence: 'high',
                sources: ['https://www.example.com/evidence/'],
                evidence: 'Direct supporting evidence.',
              },
            ],
            caveats: 'Synthetic test data.',
            openQuestions: [],
          },
        );
      }
      throw new Error(`Unexpected workflow agent: ${invocation.label}`);
    },
  });

  return { result, invocations };
}

describe('deep-research built-in workflow', () => {
  it('assigns pipeline agents to their declared progress phases', async () => {
    const { result, invocations } = await runDeepResearch({
      votes: [false, false, false],
    });

    expect(result.error).toBeUndefined();
    for (const invocation of invocations) {
      const expectedPhase = invocation.label.startsWith('search:')
        ? 'Search'
        : invocation.label.startsWith('fetch:')
          ? 'Fetch'
          : /^v\d+:/.test(invocation.label)
            ? 'Verify'
            : invocation.label === 'synthesize'
              ? 'Synthesize'
              : 'Scope';
      expect(invocation.phaseTitle).toBe(expectedPhase);
    }
  });

  it('keeps the production research instructions in every phase prompt', async () => {
    const { invocations } = await runDeepResearch({
      votes: [false, false, false],
    });
    const promptFor = (label: string) =>
      invocations.find((invocation) => invocation.label === label)?.prompt;

    expect(promptFor('scope')).toContain(
      'For medical: anatomy · common causes · serious differentials',
    );
    expect(promptFor('scope')).toContain(
      'a 1-2 sentence decomposition strategy',
    );
    expect(promptFor('search:primary')).toContain(
      'Rank by relevance to the ORIGINAL question',
    );
    expect(promptFor('search:primary')).toContain(
      'Include a short snippet capturing why each result is relevant',
    );
    expect(promptFor('fetch:example.com')).toContain(
      '3. Extract 2-5 FALSIFIABLE claims',
    );
    expect(promptFor('fetch:example.com')).toContain(
      '4. Note publish date if available',
    );
    const verify = invocations.find((invocation) =>
      invocation.label.startsWith('v0:'),
    )?.prompt;
    expect(verify).toContain('## Checklist');
    expect(verify).toContain('WebSearch for contradicting evidence');
    expect(verify).toContain('**refuted=false** ONLY if');
    expect(promptFor('synthesize')).toContain(
      'Write a 3-5 sentence executive summary',
    );
    expect(promptFor('synthesize')).toContain('List 2-4 open questions');
  });

  it('uses provider-compatible explicit types for every enum schema', async () => {
    const { result, invocations } = await runDeepResearch({
      votes: [false, false, false],
    });

    expect(result.error).toBeUndefined();
    expect(
      invocations.flatMap((invocation, index) =>
        enumNodesWithoutType(invocation.schema, `agent[${index}].schema`),
      ),
    ).toEqual([]);
  });

  it('classifies a claim as refuted only with two refuting votes', async () => {
    const { result, invocations } = await runDeepResearch({
      votes: [true, true, false],
    });
    const output = result.result as {
      refuted: unknown[];
      unverified: unknown[];
      stats: { urlDupes: number };
    };

    expect(result.error).toBeUndefined();
    expect(output.refuted).toHaveLength(1);
    expect(output.unverified).toEqual([]);
    expect(output.stats.urlDupes).toBe(1);
    expect(
      invocations.filter((invocation) => invocation.label.startsWith('fetch:')),
    ).toHaveLength(1);
    expect(
      invocations.some((invocation) => invocation.label === 'synthesize'),
    ).toBe(false);
  });

  it('keeps a claim with two supporting votes when one verifier errors', async () => {
    const { result } = await runDeepResearch({
      votes: [false, false, 'error'],
    });
    const output = result.result as {
      findings: unknown[];
      refuted: unknown[];
      unverified: unknown[];
      stats: { confirmed: number; unverified: number };
    };

    expect(result.error).toBeUndefined();
    expect(output.findings).toHaveLength(1);
    expect(output.refuted).toEqual([]);
    expect(output.unverified).toEqual([]);
    expect(output.stats).toMatchObject({ confirmed: 1, unverified: 0 });
  });

  it('reports insufficient valid votes as unverified', async () => {
    const { result } = await runDeepResearch({
      votes: [false, 'error', 'error'],
    });
    const output = result.result as {
      summary: string;
      refuted: unknown[];
      unverified: unknown[];
    };

    expect(result.error).toBeUndefined();
    expect(output.refuted).toEqual([]);
    expect(output.unverified).toHaveLength(1);
    expect(output.summary).toContain('infrastructure failure');
    expect(output.summary).not.toContain('All 1 claims were refuted');
  });

  it('reports all verifier failures as infrastructure failure', async () => {
    const { result } = await runDeepResearch({
      votes: ['error', 'error', 'error'],
    });
    const output = result.result as {
      summary: string;
      refuted: unknown[];
      unverified: unknown[];
    };

    expect(result.error).toBeUndefined();
    expect(output.refuted).toEqual([]);
    expect(output.unverified).toHaveLength(1);
    expect(output.summary).toContain('infrastructure failure');
  });

  it('salvages confirmed claims when synthesis returns no result', async () => {
    const { result } = await runDeepResearch({
      votes: [false, false, false],
      synthesisResult: null,
    });
    const output = result.result as {
      findings: unknown[];
      confirmed: unknown[];
      stats: { afterSynthesis: number };
    };

    expect(result.error).toBeUndefined();
    expect(output.findings).toEqual([]);
    expect(output.confirmed).toHaveLength(1);
    expect(output.stats.afterSynthesis).toBe(0);
  });

  it('salvages confirmed claims when synthesis hits an API error', async () => {
    const { result } = await runDeepResearch({
      votes: [false, false, false],
      synthesisApiError: 'provider unavailable',
    });
    const output = result.result as {
      findings: unknown[];
      confirmed: unknown[];
      stats: { afterSynthesis: number };
    };

    expect(result.error).toBeUndefined();
    expect(result.failures).toEqual([
      expect.stringContaining('synthesize failed: provider unavailable'),
    ]);
    expect(output.findings).toEqual([]);
    expect(output.confirmed).toHaveLength(1);
    expect(output.stats.afterSynthesis).toBe(0);
  });

  it.each([
    { relevance: 'high' as const, expectedSources: 18, expectedDropped: 0 },
    { relevance: 'medium' as const, expectedSources: 15, expectedDropped: 3 },
  ])(
    'treats the 15-source fetch budget correctly for $relevance relevance',
    async ({ relevance, expectedSources, expectedDropped }) => {
      const searchResults = Object.fromEntries(
        ['primary', 'recent', 'skeptical'].map((angle) => [
          angle,
          Array.from({ length: 6 }, (_, index) => ({
            url: `https://${angle}-${index}.example.com/evidence`,
            title: `${angle} evidence ${index}`,
            relevance,
          })),
        ]),
      );
      const { result, invocations } = await runDeepResearch({
        votes: [],
        searchResults,
        extractClaims: false,
      });
      const output = result.result as {
        stats: { sources: number; budgetDropped: number };
      };

      expect(result.error).toBeUndefined();
      expect(output.stats).toMatchObject({
        sources: expectedSources,
        budgetDropped: expectedDropped,
      });
      expect(
        invocations.filter((invocation) =>
          invocation.label.startsWith('fetch:'),
        ),
      ).toHaveLength(expectedSources);
    },
  );

  it.each([
    { angleCount: 5, expectedAgentCalls: 97 },
    { angleCount: 6, expectedAgentCalls: 98 },
  ])(
    'reports $expectedAgentCalls agent calls for $angleCount angles, 15 sources, and 25 verified claims',
    async ({ angleCount, expectedAgentCalls }) => {
      const angles = Array.from(
        { length: angleCount },
        (_, index) => `angle-${index}`,
      );
      const searchResults = Object.fromEntries(
        angles.map((angle, angleIndex) => [
          angle,
          angleIndex < 5
            ? Array.from({ length: 3 }, (_, sourceIndex) => ({
                url: `https://${angle}-${sourceIndex}.example.com/evidence`,
                title: `${angle} evidence ${sourceIndex}`,
                relevance: 'high' as const,
              }))
            : [],
        ]),
      );
      const { result, invocations } = await runDeepResearch({
        angles,
        searchResults,
        claimsPerSource: 5,
        votes: Array.from({ length: 75 }, () => false),
      });
      const output = result.result as {
        stats: {
          sourcesFetched: number;
          claimsExtracted: number;
          claimsVerified: number;
          agentCalls: number;
        };
      };

      expect(result.error).toBeUndefined();
      expect(output.stats).toMatchObject({
        sourcesFetched: 15,
        claimsExtracted: 75,
        claimsVerified: 25,
        agentCalls: expectedAgentCalls,
      });
      expect(invocations).toHaveLength(expectedAgentCalls);
    },
  );

  it('sanitizes control and bidi characters in fetch progress labels', async () => {
    const unsafeUrl = 'https://exa\u001b[31m\u202emple.com/evidence';
    const { result, invocations } = await runDeepResearch({
      votes: [],
      extractClaims: false,
      searchResults: {
        primary: [
          {
            url: unsafeUrl,
            title: 'Unsafe source',
            relevance: 'high',
          },
        ],
        recent: [],
        skeptical: [],
      },
    });
    const fetchInvocation = invocations.find((invocation) =>
      invocation.label.startsWith('fetch:'),
    );

    expect(result.error).toBeUndefined();
    expect(fetchInvocation).toBeDefined();
    expect(fetchInvocation?.label).not.toContain('\u001b');
    expect(fetchInvocation?.label).not.toContain('\u202e');
    expect(fetchInvocation?.label).toMatch(/^fetch:"/);
  });

  it('starts fetching completed search branches without waiting for all searches', async () => {
    const parsed = parseWorkflowScript(DEEP_RESEARCH_WORKFLOW_SCRIPT);
    const invocations: string[] = [];
    let releaseSlowSearches!: () => void;
    const slowSearches = new Promise<void>((resolve) => {
      releaseSlowSearches = resolve;
    });

    const run = runWorkflowScript({
      config: {} as Parameters<typeof runWorkflowScript>[0]['config'],
      args: 'Does the test claim hold?',
      scriptBody: parsed.scriptBody,
      seedPhaseTitles: parsed.meta.phases?.map((phase) => phase.title),
      invokeAgent: async ({ invocation }) => {
        invocations.push(invocation.label);
        if (invocation.label === 'scope') {
          return completed({
            question: 'Does the test claim hold?',
            summary: 'Test pipeline ordering.',
            angles: ['fast', 'slow-a', 'slow-b'].map((label) => ({
              label,
              query: label,
            })),
          });
        }
        if (invocation.label === 'search:fast') {
          return completed({
            results: [
              {
                url: 'https://fast.example.com/evidence',
                title: 'Fast source',
                relevance: 'high',
              },
            ],
          });
        }
        if (invocation.label.startsWith('search:')) {
          await slowSearches;
          return completed({ results: [] });
        }
        if (invocation.label.startsWith('fetch:')) {
          return completed({ sourceQuality: 'primary', claims: [] });
        }
        throw new Error(`Unexpected workflow agent: ${invocation.label}`);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(invocations).toContain('fetch:fast.example.com');
    } finally {
      releaseSlowSearches();
    }
    const result = await run;
    expect(result.error).toBeUndefined();
  });
});
