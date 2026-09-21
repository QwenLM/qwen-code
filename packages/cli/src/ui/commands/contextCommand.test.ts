/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Content } from '@google/genai';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  buildSkillLlmContent,
  DiscoveredMCPTool,
  estimateContextTextTokens,
  getBuiltInOutputStyle,
  getCoreSystemPrompt,
  resolveInteractionMode,
  ToolNames,
  resolveSlimmingConfig,
  wrapSystemReminder,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import type { ContextCategoryBreakdown } from '../types.js';
import {
  collectContextData,
  formatContextUsageText,
} from './contextCommand.js';

// uiTelemetryService is consumed inside collectContextData via the
// re-export from core; mock it here so the function returns deterministic
// numbers without needing a real session. The mock fns live inside
// vi.hoisted so they are available when vi.mock's factory runs (vi.mock
// is hoisted above module-level const declarations).
const { mockGetLastPromptTokenCount, mockGetLastCachedContentTokenCount } =
  vi.hoisted(() => ({
    mockGetLastPromptTokenCount: vi.fn().mockReturnValue(0),
    mockGetLastCachedContentTokenCount: vi.fn().mockReturnValue(0),
  }));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    uiTelemetryService: {
      getLastPromptTokenCount: mockGetLastPromptTokenCount,
      getLastCachedContentTokenCount: mockGetLastCachedContentTokenCount,
    },
  };
});

function makeMockConfig(contextWindowSize = 32_000): Config {
  return {
    getModel: vi.fn().mockReturnValue('test-model'),
    getContentGeneratorConfig: vi.fn().mockReturnValue({
      contextWindowSize,
    }),
    getToolRegistry: vi.fn().mockReturnValue({
      getAllTools: vi.fn().mockReturnValue([]),
      getFunctionDeclarations: vi.fn().mockReturnValue([]),
      isDeferredAndHidden: vi.fn().mockReturnValue(false),
    }),
    getVisibleTools: vi.fn().mockReturnValue(new Set()),
    getUserMemory: vi.fn().mockReturnValue(''),
    getSystemPrompt: vi.fn().mockReturnValue(undefined),
    getOutputStyle: vi.fn().mockReturnValue(undefined),
    getCodeModeOnly: vi.fn().mockReturnValue(false),
    isTodoWriteEnabled: vi.fn().mockReturnValue(false),
    getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
    getSkillManager: vi.fn().mockReturnValue({
      listSkills: vi.fn().mockResolvedValue([]),
    }),
    getDisabledSkillNames: vi.fn().mockReturnValue(new Set()),
    isSkillEnabled(this: Config, skill: { name: string }) {
      return !this.getDisabledSkillNames().has(skill.name.toLowerCase());
    },
    getChatCompression: vi.fn().mockReturnValue(undefined),
    getAutoCompactThreshold: vi.fn(),
    getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
    isInteractive: vi.fn().mockReturnValue(true),
    getWorkingDir: vi.fn().mockReturnValue(process.cwd()),
  } as unknown as Config;
}

describe('collectContextData (contextCommand)', () => {
  let getFunctionDeclarationsSpy: ReturnType<typeof vi.fn>;
  let mockConfig: Config;

  beforeEach(() => {
    mockGetLastPromptTokenCount.mockReturnValue(0);
    mockGetLastCachedContentTokenCount.mockReturnValue(0);
    getFunctionDeclarationsSpy = vi.fn().mockReturnValue([]);
    mockConfig = {
      getModel: vi.fn().mockReturnValue('test-model'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        contextWindowSize: 32_000,
      }),
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: vi.fn().mockReturnValue([]),
        getFunctionDeclarations: getFunctionDeclarationsSpy,
        isDeferredAndHidden: vi.fn().mockReturnValue(false),
      }),
      getVisibleTools: vi.fn().mockReturnValue(new Set()),
      getUserMemory: vi.fn().mockReturnValue(''),
      getSystemPrompt: vi.fn().mockReturnValue(undefined),
      getOutputStyle: vi.fn().mockReturnValue(undefined),
      getCodeModeOnly: vi.fn().mockReturnValue(false),
      isTodoWriteEnabled: vi.fn().mockReturnValue(false),
      getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
      getSkillManager: vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
      }),
      getDisabledSkillNames: vi.fn().mockReturnValue(new Set()),
      isSkillEnabled(this: Config, skill: { name: string }) {
        return !this.getDisabledSkillNames().has(skill.name.toLowerCase());
      },
      getChatCompression: vi.fn().mockReturnValue(undefined),
      getAutoCompactThreshold: vi.fn(),
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(true),
      getWorkingDir: vi.fn().mockReturnValue(process.cwd()),
    } as unknown as Config;
  });

  it('queries getFunctionDeclarations with no args, matching the actual API request', async () => {
    // /context should reflect what's actually sent to the model. Deferred
    // tools (MCP tools default to shouldDefer=true) are excluded from the
    // prompt unless session setup has revealed them — see
    // client.ts which calls getFunctionDeclarations() with no options.
    // Pinning the call here keeps the /context token estimate aligned with
    // the real request, instead of overcounting by the full MCP tool pool.
    await collectContextData(mockConfig, false);

    expect(getFunctionDeclarationsSpy).toHaveBeenCalledTimes(1);
    expect(getFunctionDeclarationsSpy).toHaveBeenCalledWith();
  });

  it('reads the per-session chat token count, not the process-global singleton (#5763)', async () => {
    // uiTelemetryService is a module-level singleton shared by every session
    // in a `serve` daemon. Reading it here would report whichever session most
    // recently completed a turn. The active chat carries the correct
    // per-session value and must win.
    mockGetLastPromptTokenCount.mockReturnValue(999_000); // wrong session's global value
    const getLastPromptTokenCount = vi.fn().mockReturnValue(50_000);
    const isLastPromptTokenCountEstimated = vi.fn().mockReturnValue(false);
    const config = {
      ...makeMockConfig(200_000),
      getLlmClient: vi.fn().mockReturnValue({
        isInitialized: vi.fn().mockReturnValue(true),
        getChat: vi.fn().mockReturnValue({
          getLastPromptTokenCount,
          isLastPromptTokenCountEstimated,
        }),
      }),
    } as unknown as Config;

    const data = await collectContextData(config, false);

    expect(getLastPromptTokenCount).toHaveBeenCalled();
    expect(data.totalTokens).toBe(50_000);
    // 50K < warn(150K); if the 999K global had leaked through it would be `hard`.
    expect(data.breakdown.currentTier).toBe('safe');
  });

  it('reads the per-session cached-content count, not the process-global singleton (#12047)', async () => {
    // Same daemon cross-talk as #5763, but for the cached-prefix annotation.
    mockGetLastPromptTokenCount.mockReturnValue(999_000);
    mockGetLastCachedContentTokenCount.mockReturnValue(64_653); // foreign session
    const getLastPromptTokenCount = vi.fn().mockReturnValue(65_267);
    const getLastCachedContentTokenCount = vi.fn().mockReturnValue(1_000);
    const isLastPromptTokenCountEstimated = vi.fn().mockReturnValue(false);
    const config = {
      ...makeMockConfig(200_000),
      getLlmClient: vi.fn().mockReturnValue({
        isInitialized: vi.fn().mockReturnValue(true),
        getChat: vi.fn().mockReturnValue({
          getLastPromptTokenCount,
          getLastCachedContentTokenCount,
          isLastPromptTokenCountEstimated,
        }),
      }),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(getLastCachedContentTokenCount).toHaveBeenCalled();
    expect(data.totalTokens).toBe(65_267);
    expect(data.breakdown.cachedTokens).toBe(1_000);
  });

  it('keeps a zero per-session cached count instead of the foreign global (#12047)', async () => {
    // Pins ?? vs || on the per-session preference: a chat that reports 0 must
    // not fall through to the process-global singleton.
    mockGetLastPromptTokenCount.mockReturnValue(999_000);
    mockGetLastCachedContentTokenCount.mockReturnValue(64_653); // foreign
    const getLastPromptTokenCount = vi.fn().mockReturnValue(65_267);
    const getLastCachedContentTokenCount = vi.fn().mockReturnValue(0);
    const isLastPromptTokenCountEstimated = vi.fn().mockReturnValue(false);
    const config = {
      ...makeMockConfig(200_000),
      getLlmClient: vi.fn().mockReturnValue({
        isInitialized: vi.fn().mockReturnValue(true),
        getChat: vi.fn().mockReturnValue({
          getLastPromptTokenCount,
          getLastCachedContentTokenCount,
          isLastPromptTokenCountEstimated,
        }),
      }),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(getLastCachedContentTokenCount).toHaveBeenCalled();
    expect(data.totalTokens).toBe(65_267);
    expect(data.breakdown.cachedTokens).toBe(0);
    // A session with no cache hit must not grow a `Cached prefix 0 tokens`
    // row under `Used` in the text renderer (forwarded to ACP clients as
    // `formattedText`). `totalTokens` is nonzero here, which is what makes
    // this witness the `> 0` guard rather than the `hasTokenCount` gate.
    expect(formatContextUsageText(data)).not.toContain('Cached prefix');
  });

  it('reads the history through the shallow reader, not a deep clone', async () => {
    const history: Content[] = [{ role: 'user', parts: [{ text: 'hi' }] }];
    const getHistoryShallow = vi.fn().mockReturnValue(history);
    const getHistory = vi.fn().mockReturnValue(history);
    const config = {
      ...makeMockConfig(200_000),
      getLlmClient: vi.fn().mockReturnValue({
        isInitialized: vi.fn().mockReturnValue(true),
        getChat: vi.fn().mockReturnValue({
          getLastPromptTokenCount: vi.fn().mockReturnValue(0),
          isLastPromptTokenCountEstimated: vi.fn().mockReturnValue(false),
          getHistoryShallow,
          getHistory,
        }),
      }),
    } as unknown as Config;

    await collectContextData(config, false);

    // `getHistory()` is `structuredClone(this.history)` — a full deep copy of
    // every base64 payload for a caller that only reads. The shallow reader
    // shares leaves, and must be called with no `curated` flag: curation merges
    // the prelude into the first user prompt and would defeat
    // `getStartupContextLength`.
    expect(getHistoryShallow).toHaveBeenCalledWith();
    expect(getHistory).not.toHaveBeenCalled();
  });

  describe('category identity (#12033)', () => {
    const skillEntry =
      '<skill>\n<name>\nreport-builder\n</name>\n<description>\nBuild reports (project)\n</description>\n<location>\nproject\n</location>\n</skill>';
    const listingReminder = wrapSystemReminder(
      `The following skills are available for use with the Skill tool.\n\n<available_skills>\n${skillEntry}\n</available_skills>`,
    );
    const environmentReminder = wrapSystemReminder(
      'Working directory: /work. Today is 2026-09-18.',
    );
    const prelude: Content = {
      role: 'user',
      parts: [{ text: listingReminder }, { text: environmentReminder }],
    };
    // 400 + 800 ASCII chars → 100 + 200 tokens.
    const conversation: Content[] = [
      { role: 'user', parts: [{ text: 'a'.repeat(400) }] },
      { role: 'model', parts: [{ text: 'b'.repeat(800) }] },
    ];

    const skillResponse = (output: string): Content =>
      ({
        role: 'user',
        parts: [{ functionResponse: { name: 'skill', response: { output } } }],
      }) as unknown as Content;

    // A `skill` tool whose tracking is intact, i.e. the shape the live registry
    // has once a body has been loaded. Names use the same exact spelling as
    // `listSkills()`, while bodies retain the bytes injected into the history.
    const skillToolSchema = {
      name: 'skill',
      description: 'Load a skill by name',
      parameters: {
        type: 'OBJECT',
        properties: { skill: { type: 'STRING' } },
      },
    };
    const skillToolDouble = {
      name: 'skill',
      schema: skillToolSchema,
      getLoadedSkillContentNames: () =>
        new Map([[trackedBody, 'report-builder']]),
    };
    const skillBody = 'Report builder instructions.\n'.repeat(140);
    const trackedBody = buildSkillLlmContent(
      '/skills/report-builder',
      skillBody,
    );
    const trackedSkillList = [
      {
        name: 'report-builder',
        description: 'Build reports',
        level: 'project',
        filePath: '/skills/report-builder/SKILL.md',
        body: skillBody,
      },
    ];

    function makeChatConfig(options: {
      total: number;
      cached?: number;
      history: Content[];
      /** True when the count came from core's estimator, not the provider. */
      estimated?: boolean;
      /** Registry contents; a `skill` double turns on loaded-body tracking. */
      tools?: unknown[];
      /**
       * What getFunctionDeclarations() returns; defaults to [] so existing
       * fixtures keep their shape. Production declares the non-deferred
       * tools, so a fixture that cares about declaration totals should pass
       * the matching schemas here.
       */
      declared?: unknown[];
      /** Overrides the default one-skill list. */
      skillList?: unknown[];
    }): Config {
      const skillList = options.skillList ?? [
        {
          name: 'report-builder',
          description: 'Build reports',
          level: 'project',
          filePath: '/skills/report-builder/SKILL.md',
        },
      ];
      return {
        ...makeMockConfig(200_000),
        ...(options.tools
          ? {
              getToolRegistry: vi.fn().mockReturnValue({
                getAllTools: vi.fn().mockReturnValue(options.tools),
                getFunctionDeclarations: vi
                  .fn()
                  .mockReturnValue(options.declared ?? []),
                isDeferredAndHidden: vi.fn().mockReturnValue(false),
              }),
            }
          : {}),
        getSkillManager: vi.fn().mockReturnValue({
          listSkills: vi.fn().mockResolvedValue(skillList),
        }),
        getLlmClient: vi.fn().mockReturnValue({
          isInitialized: vi.fn().mockReturnValue(true),
          getChat: vi.fn().mockReturnValue({
            getLastPromptTokenCount: vi.fn().mockReturnValue(options.total),
            getLastCachedContentTokenCount: vi
              .fn()
              .mockReturnValue(options.cached ?? 0),
            isLastPromptTokenCountEstimated: vi
              .fn()
              .mockReturnValue(options.estimated ?? false),
            getHistory: vi.fn().mockReturnValue(options.history),
          }),
        }),
      } as unknown as Config;
    }

    function sumRows(breakdown: ContextCategoryBreakdown): number {
      return (
        breakdown.systemPrompt +
        breakdown.builtinTools +
        breakdown.mcpTools +
        breakdown.memoryFiles +
        breakdown.skills +
        (breakdown.startupContext ?? 0) +
        breakdown.messages +
        (breakdown.unattributed ?? 0)
      );
    }

    it('bills the skill listing as sent under skills and the rest of the prelude as startup context', async () => {
      const data = await collectContextData(
        makeChatConfig({
          total: 100_000,
          history: [prelude, ...conversation],
        }),
        true,
      );

      expect(data.breakdown.skills).toBe(
        estimateContextTextTokens(listingReminder),
      );
      expect(data.breakdown.startupContext).toBe(
        estimateContextTextTokens(environmentReminder),
      );
      expect(data.skills).toEqual([
        expect.objectContaining({
          name: 'report-builder',
          tokens: estimateContextTextTokens(skillEntry),
        }),
      ]);
      expect(data.breakdown.messages).toBe(300);
    });

    it('closes the rows against the provider total, reporting the gap as unattributed', async () => {
      const data = await collectContextData(
        makeChatConfig({
          total: 100_000,
          history: [prelude, ...conversation],
        }),
        false,
      );

      expect(data.breakdown.unattributed).toBeGreaterThan(0);
      expect(sumRows(data.breakdown)).toBe(100_000);
    });

    it('scales every row down when the estimates exceed the provider total', async () => {
      const data = await collectContextData(
        makeChatConfig({
          total: 5_000,
          cached: 4_000,
          history: [
            prelude,
            { role: 'user', parts: [{ text: 'c'.repeat(40_000) }] },
          ],
        }),
        true,
      );

      expect(data.breakdown.unattributed).toBe(0);
      expect(sumRows(data.breakdown)).toBe(5_000);
      // The `scale < 1` branch forces `unattributed` to 0, so the row must be
      // suppressed in the text renderer rather than printed as `0 tokens`.
      // `totalTokens` is nonzero, so this witnesses the `> 0` guard and not
      // the `hasTokenCount` gate.
      expect(formatContextUsageText(data)).not.toContain('Unattributed');
      // The cached count is an annotation, never a term of the row sum, and
      // never subtracted when deriving `messages` (this is the only branch that
      // still derives it by subtraction).
      expect(data.breakdown.cachedTokens).toBe(4_000);
      // Each row pinned against its own unscaled value: dropping `* scale` from
      // a row this PR added leaves the two identities above intact, because
      // `messages` absorbs the difference.
      expect(data.breakdown.skills).toBeLessThan(
        estimateContextTextTokens(listingReminder),
      );
      expect(data.breakdown.startupContext).toBeLessThan(
        estimateContextTextTokens(environmentReminder),
      );
      expect(data.skills[0]!.tokens).toBeLessThan(
        estimateContextTextTokens(skillEntry),
      );
    });

    it('charges nested tool media at the flat image budget, not as base64 text', async () => {
      // Tool media rides on `functionResponse.parts[k].inlineData.data` — the
      // carrier core's tools actually use. Serializing the whole part bills
      // 400,000 ASCII chars (~100,000 tokens) against a 40,000 provider total,
      // which collapses `scale` and deflates every row, including this
      // ASCII-only one.
      const withScreenshot = [
        prelude,
        {
          role: 'model',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'read_file',
                response: { output: 'ok' },
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: 'A'.repeat(400_000),
                    },
                  },
                ],
              },
            },
          ],
        } as unknown as Content,
      ];

      const billed = await collectContextData(
        makeChatConfig({ total: 40_000, history: withScreenshot }),
        false,
      );
      const control = await collectContextData(
        makeChatConfig({ total: 40_000, history: [prelude] }),
        false,
      );

      // The screenshot must never reach `scale`, so no overhead row moves.
      expect(control.breakdown.systemPrompt).toBeGreaterThan(1_000);
      expect(billed.breakdown.systemPrompt).toBe(
        control.breakdown.systemPrompt,
      );
      expect(billed.breakdown.skills).toBe(control.breakdown.skills);
      // Charged at the flat per-image budget rather than at chars/4.
      expect(billed.breakdown.messages).toBeLessThan(5_000);
      expect(sumRows(billed.breakdown)).toBe(40_000);
    });

    it('charges a top-level media part at the flat image budget', async () => {
      // Pasted screenshots and the images core re-embeds after compaction ride
      // as top-level `inlineData` parts, not nested in a tool response. With no
      // arm for that shape the image contributed zero — in the API branch its
      // cost leaked to `unattributed`, and in the estimated branch it vanished
      // from `rawContent`, which `freeSpace` and `tierTokens` read.
      const imageTokens = resolveSlimmingConfig(undefined).imageTokenEstimate;
      const data = await collectContextData(
        makeChatConfig({
          total: 100_000,
          history: [
            prelude,
            {
              role: 'user',
              parts: [
                { text: 'a'.repeat(400) },
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: 'A'.repeat(400_000),
                  },
                },
              ],
            } as unknown as Content,
          ],
        }),
        false,
      );

      // An exact delta, not an upper bound: the text part is 400 ASCII chars
      // (100 tokens) and the image is billed at the flat per-image budget.
      expect(data.breakdown.messages).toBe(100 + imageTokens);
      expect(sumRows(data.breakdown)).toBe(100_000);
    });

    it('does not deflate rows when the total is itself a char/4 estimate', async () => {
      // `compressFast()` and resume seeding stamp a total measured by core's
      // char/4 estimator. These categories use the CJK-aware one, up to ~6x
      // larger on CJK text, so dividing the two deflated every row.
      const cjk = '中'.repeat(100_000);
      const history = [prelude, { role: 'user', parts: [{ text: cjk }] }];
      const estimatedTotal = Math.ceil(cjk.length / 4);

      // Reference: the same config with no provider count renders the raw,
      // unscaled estimates.
      const unscaled = await collectContextData(
        makeChatConfig({ total: 0, history }),
        false,
      );
      const data = await collectContextData(
        makeChatConfig({ total: estimatedTotal, history, estimated: true }),
        false,
      );

      expect(unscaled.breakdown.systemPrompt).toBeGreaterThan(1_000);
      expect(unscaled.breakdown.startupContext).toBeGreaterThan(0);
      expect(data.breakdown.systemPrompt).toBe(unscaled.breakdown.systemPrompt);
      expect(data.breakdown.startupContext).toBe(
        unscaled.breakdown.startupContext,
      );
      expect(data.breakdown.skills).toBe(unscaled.breakdown.skills);
      // The rows still close against the estimated total.
      expect(sumRows(data.breakdown)).toBe(estimatedTotal);
    });

    it('does not deflate overhead rows against a provider total when only the conversation overshoots', async () => {
      // Two ordinary triggers push `rawContent` past a provider-reported total
      // without any overhead row being wrong: the CJK-aware estimator runs
      // several times higher than the provider's count on zh-heavy text, and
      // `totalTokens` is the last request's prompt count, which excludes the
      // answer added since. Scaling the rows by total/rawContent deflated every
      // exactly-measured row; only an overhead-side overshoot may scale them.
      // A conversation-side overshoot is absorbed by the `messages` cap.
      const cjkHistory: Content[] = [
        prelude,
        { role: 'user', parts: [{ text: '中'.repeat(100_000) }] },
      ];
      const cjkUnscaled = await collectContextData(
        makeChatConfig({ total: 0, history: cjkHistory }),
        false,
      );
      const cjkData = await collectContextData(
        makeChatConfig({ total: 57_000, history: cjkHistory }),
        false,
      );

      expect(cjkUnscaled.breakdown.systemPrompt).toBeGreaterThan(1_000);
      expect(cjkData.breakdown.systemPrompt).toBe(
        cjkUnscaled.breakdown.systemPrompt,
      );
      expect(sumRows(cjkData.breakdown)).toBe(57_000);

      // Pure ASCII with an exact estimator: the stale-by-one-response gap
      // alone overshoots the provider total on every completed turn.
      const asciiHistory: Content[] = [
        prelude,
        conversation[0]!,
        { role: 'model', parts: [{ text: 'b'.repeat(40_000) }] },
      ];
      const asciiUnscaled = await collectContextData(
        makeChatConfig({ total: 0, history: asciiHistory }),
        false,
      );
      const asciiData = await collectContextData(
        makeChatConfig({ total: 15_000, history: asciiHistory }),
        false,
      );

      expect(asciiData.breakdown.systemPrompt).toBe(
        asciiUnscaled.breakdown.systemPrompt,
      );
      expect(sumRows(asciiData.breakdown)).toBe(15_000);
    });

    it('closes the rows against an estimated total that sits below the measured overhead', async () => {
      // The total core stamps after a compression or resume covers the
      // compressed history alone, so a session carrying heavy declarations can
      // stamp a total smaller than the measured overhead. The rows must still
      // close against `Used` — scaling against `rawOverhead` is unconditional,
      // so this state scales the overhead rows down to the stamped total
      // instead of letting the category rows sum above it.
      const data = await collectContextData(
        makeChatConfig({
          total: 500,
          history: [prelude, ...conversation],
          estimated: true,
        }),
        false,
      );

      expect(data.totalTokens).toBe(500);
      expect(sumRows(data.breakdown)).toBeLessThanOrEqual(data.totalTokens);
      // The rendered category rows must not exceed the printed `Used` either.
      const text = formatContextUsageText(data);
      const usedMatch = text.match(/^ {2}Used +([\d.]+)(k?) tokens \(/m);
      expect(usedMatch).not.toBeNull();
      const used = Number(usedMatch![1]) * (usedMatch![2] === 'k' ? 1000 : 1);
      expect(used).toBe(500);
      const rowPattern = /^ {2}([A-Za-z][^\n]*?) +([\d.]+)(k?) tokens \(/gm;
      let rowCount = 0;
      for (const match of text.matchAll(rowPattern)) {
        const label = match[1]!;
        if (label === 'Used' || label === 'Free') continue;
        const value = Number(match[2]) * (match[3] === 'k' ? 1000 : 1);
        expect(value).toBeLessThanOrEqual(used);
        rowCount += 1;
      }
      // The assertion above is vacuous unless the category rows were found.
      expect(rowCount).toBeGreaterThanOrEqual(6);
    });

    it('never derives messages from the cached count', async () => {
      const data = await collectContextData(
        makeChatConfig({
          total: 100_000,
          cached: 90_000,
          history: [prelude, ...conversation],
        }),
        false,
      );

      // The old `total − cached` derivation would print 10_000 here.
      expect(data.breakdown.messages).toBe(300);
      expect(data.breakdown.cachedTokens).toBe(90_000);
      expect(sumRows(data.breakdown)).toBe(100_000);
    });

    it('bills a tracked skill body under skills and keeps it out of messages', async () => {
      const data = await collectContextData(
        makeChatConfig({
          total: 100_000,
          tools: [skillToolDouble],
          // Production declares the skill tool, so `allToolsTokens` already
          // carries its definition and no clamp deficit spills into skills.
          declared: [skillToolSchema],
          skillList: trackedSkillList,
          history: [prelude, conversation[0]!, skillResponse(trackedBody)],
        }),
        true,
      );

      expect(data.breakdown.messages).toBe(100);
      expect(data.skills[0]).toEqual({
        name: 'report-builder',
        tokens: estimateContextTextTokens(skillEntry),
        loaded: true,
        bodyTokens: estimateContextTextTokens(trackedBody),
      });
      // The three terms `skillsTokens` adds — tool definition, the listing as
      // sent, and the loaded body, which no fixture made nonzero before.
      expect(data.breakdown.skills).toBe(
        estimateContextTextTokens(JSON.stringify(skillToolSchema)) +
          estimateContextTextTokens(listingReminder) +
          estimateContextTextTokens(trackedBody),
      );
      expect(sumRows(data.breakdown)).toBe(100_000);
    });

    it.each([0, 100_000])(
      'bills repeated copies of a tracked skill body as messages (API total %i)',
      async (total) => {
        const options = {
          total,
          tools: [skillToolDouble],
          declared: [skillToolSchema],
          skillList: trackedSkillList,
          history: [prelude, conversation[0]!, skillResponse(trackedBody)],
        };
        const once = await collectContextData(makeChatConfig(options), true);
        const repeatedConfig = makeChatConfig({
          ...options,
          history: [...options.history, skillResponse(trackedBody)],
        });
        const repeated = await collectContextData(repeatedConfig, true);
        const responseTokens = estimateContextTextTokens(
          JSON.stringify({ name: 'skill', response: { output: trackedBody } }),
        );

        expect(once.breakdown.messages).toBe(total ? 100 : 0);
        expect(repeated.breakdown.messages).toBe(
          total ? 100 + responseTokens : 0,
        );
        expect(repeated.breakdown.skills).toBe(once.breakdown.skills);
        expect(repeated.skills).toEqual(once.skills);
        expect(repeated.totalTokens).toBe(total);
        if (!total) {
          expect(repeated.breakdown.freeSpace).toBe(
            once.breakdown.freeSpace - responseTokens,
          );
        }
        // Accounting must not consume the live tool's history tracking.
        expect(await collectContextData(repeatedConfig, true)).toEqual(
          repeated,
        );
      },
    );

    it('attributes the emitted body with a backslash skill filePath', async () => {
      // Attribution uses the body actually emitted by core, without rebuilding
      // it from the current file path or content.
      const windowsFilePath = 'C:\\skills\\report-builder\\SKILL.md';
      const windowsBody = buildSkillLlmContent(
        path.dirname(windowsFilePath),
        skillBody,
      );
      const data = await collectContextData(
        makeChatConfig({
          total: 100_000,
          tools: [
            {
              ...skillToolDouble,
              getLoadedSkillContentNames: () =>
                new Map([[windowsBody, 'report-builder']]),
            },
          ],
          skillList: [
            {
              name: 'report-builder',
              description: 'Build reports',
              level: 'project',
              filePath: windowsFilePath,
              body: skillBody,
            },
          ],
          history: [prelude, conversation[0]!, skillResponse(windowsBody)],
        }),
        true,
      );

      expect(data.breakdown.messages).toBe(100);
      expect(data.skills[0]).toEqual({
        name: 'report-builder',
        tokens: estimateContextTextTokens(skillEntry),
        loaded: true,
        bodyTokens: estimateContextTextTokens(windowsBody),
      });
      expect(sumRows(data.breakdown)).toBe(100_000);
    });

    it('bills a skill response whose body was never tracked as messages', async () => {
      // Two production shapes reach this line: the Skill tool returns a
      // same-named command's expanded prompt without calling `onSkillLoaded`,
      // and `/restore` / compression clear the tracking while the body stays in
      // history. Neither is billed under `skills`, so neither may be skipped
      // here — a name-keyed skip dropped those tokens into `unattributed`,
      // which owns nothing.
      const commandOutput = 'Expanded command prompt.\n'.repeat(160);
      const expected =
        100 +
        estimateContextTextTokens(
          JSON.stringify({
            name: 'skill',
            response: { output: commandOutput },
          }),
        );

      const untracked = await collectContextData(
        makeChatConfig({
          total: 100_000,
          history: [prelude, conversation[0]!, skillResponse(commandOutput)],
        }),
        false,
      );
      // A skill tool that tracks a *different* body must not change the answer.
      const trackingOtherBody = await collectContextData(
        makeChatConfig({
          total: 100_000,
          tools: [skillToolDouble],
          skillList: trackedSkillList,
          history: [prelude, conversation[0]!, skillResponse(commandOutput)],
        }),
        false,
      );

      expect(untracked.breakdown.messages).toBe(expected);
      expect(trackingOtherBody.breakdown.messages).toBe(expected);
      expect(sumRows(untracked.breakdown)).toBe(100_000);
    });

    it('gives a detail row to a listing entry listSkills does not return', async () => {
      // `collectAvailableSkillEntries` merges model-invocable commands (a user's
      // `.qwen/commands/*.toml`, extension saved workflows) into the listing, so
      // their tokens are inside the measured block `skills` bills while
      // `listSkills()` never returns them: billed with no row.
      const commandEntry =
        '<skill>\n<name>\ndeploy-check\n</name>\n<description>\nRun the deploy checks\n</description>\n</skill>';
      const commandListing = wrapSystemReminder(
        `The following skills are available for use with the Skill tool.\n\n<available_skills>\n${[
          skillEntry,
          commandEntry,
        ].join('\n')}\n</available_skills>`,
      );

      const data = await collectContextData(
        makeChatConfig({
          total: 100_000,
          history: [
            {
              role: 'user',
              parts: [{ text: commandListing }, { text: environmentReminder }],
            },
            ...conversation,
          ],
        }),
        true,
      );

      expect(data.breakdown.skills).toBe(
        estimateContextTextTokens(commandListing),
      );
      expect(data.skills).toContainEqual({
        name: 'deploy-check',
        tokens: estimateContextTextTokens(commandEntry),
      });
    });

    it('bills a mid-session skill listing under skills, not under messages', async () => {
      // A skill enabled after startup is announced by a tail `<system-reminder>`
      // (`buildChangedSkillsReminder`) that `getStartupContextLength` never
      // inspects. Without measuring it here the entry's row printed `0 tokens`
      // while its text was billed to `messages`.
      const lateEntry =
        '<skill>\n<name>\nlate-skill\n</name>\n<description>\nArrived after startup\n</description>\n<location>\nproject\n</location>\n</skill>';
      const delta = wrapSystemReminder(
        `The following skills/commands became available after startup and can now be invoked via the Skill tool by name.\n\n<available_skills>\n${lateEntry}\n</available_skills>`,
      );
      const lateSkill = {
        name: 'late-skill',
        description: 'Arrived after startup',
        level: 'project',
        filePath: '/skills/late-skill/SKILL.md',
      };

      const data = await collectContextData(
        makeChatConfig({
          total: 100_000,
          skillList: [
            {
              name: 'report-builder',
              description: 'Build reports',
              level: 'project',
              filePath: '/skills/report-builder/SKILL.md',
            },
            lateSkill,
          ],
          history: [
            prelude,
            { role: 'user', parts: [{ text: delta }] },
            ...conversation,
          ],
        }),
        true,
      );

      expect(data.skills.find((skill) => skill.name === 'late-skill')).toEqual({
        name: 'late-skill',
        tokens: estimateContextTextTokens(lateEntry),
        loaded: false,
        bodyTokens: undefined,
      });
      // Both listings, and only the two conversation turns.
      expect(data.breakdown.skills).toBe(
        estimateContextTextTokens(listingReminder) +
          estimateContextTextTokens(delta),
      );
      expect(data.breakdown.messages).toBe(300);
      expect(sumRows(data.breakdown)).toBe(100_000);
    });

    it('prints the startup context, unattributed and cached rows in text output', async () => {
      const data = await collectContextData(
        makeChatConfig({
          total: 100_000,
          cached: 40_000,
          history: [prelude, ...conversation],
        }),
        false,
      );
      const text = formatContextUsageText(data);

      expect(text).toContain('Startup context');
      expect(text).toContain('Unattributed');
      expect(text).toContain('Cached prefix');
    });

    it('bills tool calls and ordinary tool output as messages (#12033)', async () => {
      // The two arms of `estimateConversationTokens` that dominate a real
      // tool-using session's history: a `functionCall` part and a
      // `functionResponse` from an ordinary (non-skill) tool. Unbilled, their
      // whole cost migrates into `unattributed` — the mis-attribution #12033
      // exists to remove — while `messages` reads near-zero.
      // No media part here on purpose: nested `inlineData` is billed at the
      // flat image budget, which 'charges nested tool media at the flat image
      // budget, not as base64 text' pins. The skill-response arms stay pinned
      // by their own two cases above; this one uses a different tool name so
      // it cannot mask a regression in the `ToolNames.SKILL` condition.
      const toolCall = {
        id: 'call-1',
        name: 'run_shell_command',
        args: { command: 'npm test' },
      };
      const toolResponse = {
        id: 'call-1',
        name: 'run_shell_command',
        response: { output: 'x'.repeat(8_000) },
      };

      const data = await collectContextData(
        makeChatConfig({
          total: 100_000,
          history: [
            prelude,
            conversation[0]!,
            { role: 'model', parts: [{ functionCall: toolCall }] },
            {
              role: 'user',
              parts: [{ functionResponse: toolResponse }],
            } as unknown as Content,
          ],
        }),
        false,
      );

      // `estimateFunctionResponseTokens` serializes exactly these three keys.
      expect(data.breakdown.messages).toBe(
        100 +
          estimateContextTextTokens(JSON.stringify(toolCall)) +
          estimateContextTextTokens(JSON.stringify(toolResponse)),
      );
      expect(sumRows(data.breakdown)).toBe(100_000);
    });

    it('charges the builtin-clamp deficit to the mcp row, not to messages', async () => {
      // Under `tools.codeModeOnly` the declarations collapse to a few control
      // tools while an `alwaysLoadTools` MCP server still bills every schema
      // the detail loop sees, so the billed tools exceed the declared ones and
      // `displayBuiltinTools` clamps at 0. The clamp deficit must come out of
      // the mcp row — the row whose billing overshoots the declarations;
      // otherwise `attributedOverhead` silently takes it out of `messages`.
      // Own value properties shadow the prototype's getters (Object.assign
      // would trip the setter-less `schema` accessor on DeclarativeTool).
      const mcpToolDouble = Object.defineProperties(
        Object.create(DiscoveredMCPTool.prototype),
        {
          name: { value: 'mcp__server__big_tool' },
          serverName: { value: 'server' },
          serverToolName: { value: 'big_tool' },
          schema: {
            value: {
              name: 'mcp__server__big_tool',
              description: `Big MCP tool ${'x'.repeat(400)}`,
              parameters: { type: 'OBJECT', properties: {} },
            },
          },
        },
      ) as DiscoveredMCPTool;
      const tools = [
        { ...skillToolDouble, getLoadedSkillContentNames: () => new Map() },
        mcpToolDouble,
      ];
      const declared = [skillToolSchema];
      const history = [prelude, ...conversation];

      const unscaled = await collectContextData(
        makeChatConfig({ total: 0, tools, declared, history }),
        false,
      );
      // The provider-side total: the measured overhead plus the 300-token
      // conversation, so exactly 300 tokens are left for `messages`.
      const total =
        unscaled.breakdown.systemPrompt +
        (unscaled.breakdown.startupContext ?? 0) +
        estimateContextTextTokens(listingReminder) +
        estimateContextTextTokens(JSON.stringify(declared)) +
        300;
      const data = await collectContextData(
        makeChatConfig({ total, tools, declared, history }),
        false,
      );

      // The fixture does put the clamp in force: billed skill definition plus
      // mcp schemas exceed the declared tools.
      expect(
        estimateContextTextTokens(JSON.stringify(skillToolSchema)) +
          estimateContextTextTokens(JSON.stringify(mcpToolDouble.schema)),
      ).toBeGreaterThan(estimateContextTextTokens(JSON.stringify(declared)));
      expect(data.breakdown.messages).toBe(300);
      expect(sumRows(data.breakdown)).toBe(total);
    });
  });

  it('reports a nonzero compression-derived count as estimated', async () => {
    const config = {
      ...makeMockConfig(200_000),
      getLlmClient: vi.fn().mockReturnValue({
        isInitialized: vi.fn().mockReturnValue(true),
        getChat: vi.fn().mockReturnValue({
          getLastPromptTokenCount: vi.fn().mockReturnValue(50_000),
          isLastPromptTokenCountEstimated: vi.fn().mockReturnValue(true),
        }),
      }),
    } as unknown as Config;

    const data = await collectContextData(config, false);

    expect(data.isEstimated).toBe(true);
    expect(data.totalTokens).toBe(50_000);
    expect(data.breakdown.freeSpace).toBeLessThan(150_000);
    const text = formatContextUsageText(data);
    expect(text).toContain('Token usage is estimated');
    expect(text).not.toContain('No API response yet');
  });

  it('falls back to the global singleton when the session chat is not initialized', async () => {
    // First /context or --continue resume before any send: getChat() would
    // throw, so collectContextData must use the global value instead.
    mockGetLastPromptTokenCount.mockReturnValue(60_000);
    const config = {
      ...makeMockConfig(200_000),
      getLlmClient: vi.fn().mockReturnValue({
        isInitialized: vi.fn().mockReturnValue(false),
        getChat: vi.fn(() => {
          throw new Error('Chat not initialized');
        }),
      }),
    } as unknown as Config;

    const data = await collectContextData(config, false);

    expect(data.totalTokens).toBe(60_000);
  });

  it('excludes deferred-but-not-revealed tools from the per-tool breakdown (#4508)', async () => {
    const isDeferredAndHidden = vi
      .fn()
      .mockImplementation(
        (name: string) => name === 'web_fetch' || name === 'mcp__server__tool',
      );
    const hiddenBuiltin = {
      name: 'web_fetch',
      schema: { name: 'web_fetch', description: 'large schema' },
      shouldDefer: true,
      alwaysLoad: false,
    };
    const hiddenMcp = {
      name: 'mcp__server__tool',
      schema: { name: 'mcp__server__tool', description: 'large schema' },
      shouldDefer: true,
      alwaysLoad: false,
    };
    const config = {
      getModel: vi.fn().mockReturnValue('test-model'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        contextWindowSize: 32_000,
      }),
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: vi.fn().mockReturnValue([hiddenBuiltin, hiddenMcp]),
        getFunctionDeclarations: vi.fn().mockReturnValue([]),
        isDeferredAndHidden,
      }),
      getVisibleTools: vi.fn().mockReturnValue(new Set()),
      getUserMemory: vi.fn().mockReturnValue(''),
      getSystemPrompt: vi.fn().mockReturnValue(undefined),
      getOutputStyle: vi.fn().mockReturnValue(undefined),
      getCodeModeOnly: vi.fn().mockReturnValue(false),
      isTodoWriteEnabled: vi.fn().mockReturnValue(false),
      getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
      getSkillManager: vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
      }),
      getDisabledSkillNames: vi.fn().mockReturnValue(new Set()),
      getChatCompression: vi.fn().mockReturnValue(undefined),
      getAutoCompactThreshold: vi.fn(),
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(true),
      getWorkingDir: vi.fn().mockReturnValue(process.cwd()),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(data.builtinTools).toHaveLength(0);
    expect(data.mcpTools).toHaveLength(0);
    expect(isDeferredAndHidden).toHaveBeenCalledWith('web_fetch');
    expect(isDeferredAndHidden).toHaveBeenCalledWith('mcp__server__tool');
  });

  it('includes visibleTools in per-tool breakdown when deferred and not revealed (#6372)', async () => {
    const visibleTool = {
      name: 'web_fetch',
      schema: { name: 'web_fetch', description: 'visible tool schema' },
      shouldDefer: true,
      alwaysLoad: false,
    };
    const hiddenDeferred = {
      name: 'monitor',
      schema: { name: 'monitor', description: 'hidden tool schema' },
      shouldDefer: true,
      alwaysLoad: false,
    };
    const config = {
      getModel: vi.fn().mockReturnValue('test-model'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        contextWindowSize: 32_000,
      }),
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: vi.fn().mockReturnValue([visibleTool, hiddenDeferred]),
        getFunctionDeclarations: vi.fn().mockReturnValue([visibleTool.schema]),
        isDeferredAndHidden: vi
          .fn()
          .mockImplementation((name: string) => name === 'monitor'),
      }),
      getVisibleTools: vi.fn().mockReturnValue(new Set(['web_fetch'])),
      getUserMemory: vi.fn().mockReturnValue(''),
      getSystemPrompt: vi.fn().mockReturnValue(undefined),
      getOutputStyle: vi.fn().mockReturnValue(undefined),
      getCodeModeOnly: vi.fn().mockReturnValue(false),
      isTodoWriteEnabled: vi.fn().mockReturnValue(false),
      getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
      getSkillManager: vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
      }),
      getDisabledSkillNames: vi.fn().mockReturnValue(new Set()),
      getChatCompression: vi.fn().mockReturnValue(undefined),
      getAutoCompactThreshold: vi.fn(),
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(true),
      getWorkingDir: vi.fn().mockReturnValue(process.cwd()),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(data.builtinTools).toHaveLength(1);
    expect(data.builtinTools[0].name).toBe('web_fetch');
  });

  it('excludes fixed-only media-policy tools from the per-tool breakdown (D6)', async () => {
    // A media-policy tool without modelAccess.enabled is stripped from
    // getFunctionDeclarations() (zero prompt tokens), so listing it in the
    // breakdown would make the per-tool sum exceed allToolsTokens. One with
    // modelAccess.enabled IS declared to the model and must stay listed.
    const descriptor = {
      kind: 'media_policy',
      inputMediaTypes: ['image'],
      outputs: [],
    };
    const hiddenPolicyTool = {
      name: 'omni_downsample_image',
      schema: { name: 'omni_downsample_image', description: 'policy schema' },
      mediaPolicyDescriptor: descriptor,
    };
    const exposedPolicyTool = {
      name: 'omni_probe_media',
      schema: { name: 'omni_probe_media', description: 'probe schema' },
      mediaPolicyDescriptor: descriptor,
    };
    const config = {
      ...mockConfig,
      getModel: vi.fn().mockReturnValue('test-model'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        contextWindowSize: 32_000,
      }),
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: vi
          .fn()
          .mockReturnValue([hiddenPolicyTool, exposedPolicyTool]),
        getFunctionDeclarations: vi
          .fn()
          .mockReturnValue([exposedPolicyTool.schema]),
        isDeferredAndHidden: vi.fn().mockReturnValue(false),
      }),
      getOmniPolicyToolsSettings: vi.fn().mockReturnValue({
        omni_probe_media: { modelAccess: { enabled: true } },
      }),
      getVisibleTools: vi.fn().mockReturnValue(new Set()),
      getUserMemory: vi.fn().mockReturnValue(''),
      getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
      getSkillManager: vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
      }),
      getChatCompression: vi.fn().mockReturnValue(undefined),
      getAutoCompactThreshold: vi.fn(),
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(true),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(data.builtinTools).toHaveLength(1);
    expect(data.builtinTools[0].name).toBe('omni_probe_media');
  });

  it('lists the auto-memory section as a separate memory entry (#7651)', async () => {
    // The managed auto-memory section is no longer part of getUserMemory(); its
    // tokens are surfaced via getAutoMemoryPrompt(). Exercise the non-empty
    // branch so a regression that drops the "auto memory" row from /context
    // fails here instead of silently under-counting the memory breakdown.
    const config = {
      ...makeMockConfig(),
      getUserMemory: vi.fn().mockReturnValue(''),
      getOutputStyle: vi.fn().mockReturnValue(undefined),
      getAutoMemoryPrompt: vi
        .fn()
        .mockReturnValue('# auto memory\nMEMORY_INDEX_MARKER'),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(data.memoryFiles).toHaveLength(1);
    expect(data.memoryFiles[0].path).toBe(t('auto memory'));
    expect(data.memoryFiles[0].tokens).toBeGreaterThan(0);
  });

  it('shortens home-dir memory marker paths to ~ in the breakdown', async () => {
    // Memory markers store paths relative to the session working directory,
    // which in ACP/daemon-served sessions differs from process.cwd(); global
    // files must render as `~/...` instead of `../../..` chains.
    const workingDir = path.join(os.tmpdir(), 'context-session-dir');
    const globalFile = path.join(os.homedir(), '.qwen', 'QWEN.md');
    const markerPath = path.relative(workingDir, globalFile);
    const memory =
      `--- Context from: ${markerPath} ---\n` +
      `global rules\n` +
      `--- End of Context from: ${markerPath} ---`;
    const config = {
      ...makeMockConfig(),
      getUserMemory: vi.fn().mockReturnValue(memory),
      getOutputStyle: vi.fn().mockReturnValue(undefined),
      getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
      getWorkingDir: vi.fn().mockReturnValue(workingDir),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(data.memoryFiles).toHaveLength(1);
    expect(data.memoryFiles[0].path).toBe(path.join('~', '.qwen', 'QWEN.md'));
  });

  it('renders project-local markers as relative paths when workingDir != cwd', async () => {
    // The resolve+format round-trip must anchor on the session working dir,
    // not process.cwd(); a mutation that passes process.cwd() as the display
    // anchor renders every project-local file as a ../.. chain.
    const workingDir = path.join(os.tmpdir(), 'context-session-dir');
    const memory =
      `--- Context from: QWEN.md ---\n` +
      `project rules\n` +
      `--- End of Context from: QWEN.md ---\n` +
      `--- Context from: docs/QWEN.md ---\n` +
      `docs rules\n` +
      `--- End of Context from: docs/QWEN.md ---`;
    const config = {
      ...makeMockConfig(),
      getUserMemory: vi.fn().mockReturnValue(memory),
      getOutputStyle: vi.fn().mockReturnValue(undefined),
      getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
      getWorkingDir: vi.fn().mockReturnValue(workingDir),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(data.memoryFiles).toHaveLength(2);
    expect(data.memoryFiles[0].path).toBe('QWEN.md');
    expect(data.memoryFiles[1].path).toBe(path.join('docs', 'QWEN.md'));
  });

  it('attributes all injected skill bodies after refresh, removal and disable', async () => {
    const listingEntries = new Map(
      ['edited', 'removed', 'disabled'].map((name) => [
        name,
        `<skill>\n<name>\n${name}\n</name>\n<description>\nSkill\n</description>\n</skill>`,
      ]),
    );
    const listing = wrapSystemReminder(
      `The following skills are available for use with the Skill tool.\n\n<available_skills>\n${[...listingEntries.values()].join('\n')}\n</available_skills>`,
    );
    const history = new Map([
      ['Earlier body retained in conversation.', 'edited'],
      ['New body injected after refresh.', 'edited'],
      ['Removed skill body retained in conversation.', 'removed'],
      ['Disabled skill body retained in conversation.', 'disabled'],
    ]);
    const tool = {
      name: ToolNames.SKILL,
      schema: { name: ToolNames.SKILL, description: 'Static skill definition' },
      getLoadedSkillNames: () => new Set(['edited']),
      getLoadedSkillContents: () => new Set(history.keys()),
      getLoadedSkillContentNames: () => history,
    };
    const config = {
      ...makeMockConfig(),
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: () => [tool],
        getFunctionDeclarations: () => [tool.schema],
        isDeferredAndHidden: () => false,
      }),
      getSkillManager: vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue(
          ['edited', 'disabled'].map((name) => ({
            name,
            description: 'Skill',
            level: 'user',
            filePath: `/skills/${name}/SKILL.md`,
            body: 'Unloaded replacement content on disk.'.repeat(100),
          })),
        ),
      }),
      getDisabledSkillNames: () => new Set(['disabled']),
      getLlmClient: () => ({
        isInitialized: () => true,
        getChat: () => ({
          getLastPromptTokenCount: () => 100_000,
          isLastPromptTokenCountEstimated: () => false,
          getHistory: () => [
            { role: 'user', parts: [{ text: listing }] },
            { role: 'user', parts: [{ text: 'Current conversation.' }] },
            ...[...history.keys()].map((output) => ({
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: ToolNames.SKILL,
                    response: { output },
                  },
                },
              ],
            })),
          ],
        }),
      }),
    } as unknown as Config;
    const data = await collectContextData(config, true);
    const bodyTokens = [...history.keys()].reduce(
      (sum, content) => sum + estimateContextTextTokens(content),
      0,
    );
    expect(data.breakdown.skills).toBe(
      estimateContextTextTokens(JSON.stringify(tool.schema)) +
        estimateContextTextTokens(listing) +
        bodyTokens,
    );
    expect(data.breakdown.messages).toBe(
      estimateContextTextTokens('Current conversation.'),
    );
    expect(data.skills.find((skill) => skill.name === 'edited')).toMatchObject({
      loaded: true,
      bodyTokens:
        estimateContextTextTokens('Earlier body retained in conversation.') +
        estimateContextTextTokens('New body injected after refresh.'),
    });
    for (const name of ['removed', 'disabled']) {
      expect(data.skills.filter((skill) => skill.name === name)).toEqual([
        {
          name,
          loaded: true,
          tokens: estimateContextTextTokens(listingEntries.get(name)!),
          bodyTokens: estimateContextTextTokens(
            [...history].find(([, skillName]) => skillName === name)![0],
          ),
        },
      ]);
    }
  });

  it('names the extension that contributes a context file (#12030)', async () => {
    // An extension's context file is resident in every request of every session
    // it is active in, and the marker path alone does not say who is paying for
    // it — the row has to name the extension to be actionable.
    const workingDir = path.join(os.tmpdir(), 'context-extension-dir');
    const extensionFile = path.join(
      workingDir,
      'extensions',
      'report-tools',
      'QWEN.md',
    );
    const memory =
      `--- Context from: QWEN.md ---\n` +
      `project rules\n` +
      `--- End of Context from: QWEN.md ---\n` +
      `--- Context from: ${extensionFile} ---\n` +
      `extension rules\n` +
      `--- End of Context from: ${extensionFile} ---`;
    const config = {
      ...makeMockConfig(),
      getUserMemory: vi.fn().mockReturnValue(memory),
      getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
      getWorkingDir: vi.fn().mockReturnValue(workingDir),
      getActiveExtensions: vi.fn().mockReturnValue([
        {
          name: 'report-tools',
          displayName: 'Report Tools',
          path: path.dirname(extensionFile),
          contextFiles: [extensionFile],
        },
      ]),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(data.memoryFiles).toHaveLength(2);
    // The project file keeps its path; only the extension's file is renamed.
    expect(data.memoryFiles[0].path).toBe('QWEN.md');
    expect(data.memoryFiles[1].path).toBe(
      `${t('Extension')}: Report Tools · QWEN.md`,
    );
  });

  it('keeps extension file labels distinct and safe without changing token counts', async () => {
    const workingDir = path.join(os.tmpdir(), 'context-extension-dir');
    const extensionRoot = path.join(workingDir, 'extensions', 'report-tools');
    const files = ['docs', 'prompts'].map((dir) =>
      path.join(extensionRoot, dir, 'QWEN.md'),
    );
    const memory = files
      .map((file) => {
        const marker = path.relative(workingDir, file);
        return `--- Context from: ${marker} ---\nextension rules\n--- End of Context from: ${marker} ---`;
      })
      .join('\n');
    const config = {
      ...makeMockConfig(),
      getUserMemory: vi.fn().mockReturnValue(memory),
      getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
      getWorkingDir: vi.fn().mockReturnValue(workingDir),
      getActiveExtensions: vi.fn().mockReturnValue([]),
    } as unknown as Config;
    const before = await collectContextData(config, true);
    vi.mocked(config.getActiveExtensions).mockReturnValue([
      {
        name: 'report-tools',
        displayName: '\u001b[31mReport\u001b[0m\nTools\u202e',
        path: extensionRoot,
        contextFiles: files,
      } as ReturnType<Config['getActiveExtensions']>[number],
    ]);

    const after = await collectContextData(config, true);

    expect(after.memoryFiles.map((file) => file.path)).toEqual(
      ['docs', 'prompts'].map(
        (dir) =>
          `${t('Extension')}: Report Tools · ${path.join(dir, 'QWEN.md')}`,
      ),
    );
    expect(after.memoryFiles.map((file) => file.tokens)).toEqual(
      before.memoryFiles.map((file) => file.tokens),
    );
  });

  it('leaves memory rows alone when no extension owns them (#12030)', async () => {
    const workingDir = path.join(os.tmpdir(), 'context-extension-dir');
    const memory =
      `--- Context from: QWEN.md ---\nproject rules\n` +
      `--- End of Context from: QWEN.md ---`;
    const config = {
      ...makeMockConfig(),
      getUserMemory: vi.fn().mockReturnValue(memory),
      getAutoMemoryPrompt: vi.fn().mockReturnValue(''),
      getWorkingDir: vi.fn().mockReturnValue(workingDir),
      // A Config without the accessor at all: partial stubs and older shapes
      // must not break the breakdown.
      getActiveExtensions: undefined,
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(data.memoryFiles).toHaveLength(1);
    expect(data.memoryFiles[0].path).toBe('QWEN.md');
  });

  it('excludes disabled skills from the detail breakdown', async () => {
    const config = {
      ...makeMockConfig(),
      getSkillManager: vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([
          {
            name: 'enabled-skill',
            description: 'Enabled skill',
            level: 'user',
            filePath: '/skills/enabled-skill/SKILL.md',
            body: 'Enabled body',
          },
          {
            name: 'Disabled-Skill',
            description: 'Disabled skill',
            level: 'user',
            filePath: '/skills/disabled-skill/SKILL.md',
            body: 'Disabled body',
          },
        ]),
      }),
      getDisabledSkillNames: vi
        .fn()
        .mockReturnValue(new Set(['disabled-skill'])),
    } as unknown as Config;

    const data = await collectContextData(config, true);

    expect(data.skills.map((skill) => skill.name)).toEqual(['enabled-skill']);
  });
});

describe('/context shows three-tier thresholds', () => {
  beforeEach(() => {
    mockGetLastPromptTokenCount.mockReturnValue(0);
    mockGetLastCachedContentTokenCount.mockReturnValue(0);
  });

  it('renders warn/auto/hard with the warn-tier marker when usage sits between warn and auto', async () => {
    // 200K window. computeThresholds(200K) = {
    //   warn: 147,000, auto: 167,000, hard: 177,000, effectiveWindow: 180,000
    // }
    // lastPromptTokenCount = 160K → between warn and auto → tier = warn.
    mockGetLastPromptTokenCount.mockReturnValue(160_000);
    const data = await collectContextData(makeMockConfig(200_000), false);
    const text = formatContextUsageText(data);

    expect(text).toMatch(/Effective window:\s+180,000/);
    expect(text).toMatch(/Warn threshold:\s+147,000/);
    expect(text).toMatch(/Auto threshold:\s+167,000/);
    expect(text).toMatch(/Hard threshold:\s+177,000/);
    expect(text).toMatch(/Current tier:\s+warn/);
    expect(data.breakdown.currentTier).toBe('warn');
    expect(data.breakdown.thresholds).toEqual({
      effectiveWindow: 180_000,
      warn: 147_000,
      auto: 167_000,
      hard: 177_000,
    });
  });

  it('classifies usage below the warn threshold as the safe tier', async () => {
    mockGetLastPromptTokenCount.mockReturnValue(50_000);
    const data = await collectContextData(makeMockConfig(200_000), false);
    const text = formatContextUsageText(data);

    expect(text).toMatch(/Current tier:\s+safe/);
    expect(data.breakdown.currentTier).toBe('safe');
    // No chat → no prelude → `startupContext` is 0, and this row is pushed
    // *outside* the `hasTokenCount` block, so it is the one guard a zero-total
    // fixture cannot witness. Suppressing it is what keeps a pre-first-send
    // `/context` free of a `Startup context 0 tokens (0.0%)` row.
    expect(text).not.toContain('Startup context');
  });

  it('classifies usage at or above the hard threshold as the hard tier', async () => {
    mockGetLastPromptTokenCount.mockReturnValue(180_000);
    const data = await collectContextData(makeMockConfig(200_000), false);
    expect(data.breakdown.currentTier).toBe('hard');
  });

  it('classifies usage between auto and hard as the auto tier', async () => {
    // 200K window — between 167K (auto) and 177K (hard) → tier = auto.
    mockGetLastPromptTokenCount.mockReturnValue(173_000);
    const data = await collectContextData(makeMockConfig(200_000), false);
    expect(data.breakdown.currentTier).toBe('auto');
    const text = formatContextUsageText(data);
    expect(text).toMatch(/Current tier:\s+auto/);
  });

  it('classifies a history-heavy no-API-data session by its conversation too', async () => {
    // A `/model` switch (`adoptTokenCountsForRoute`), `/restore` or a resume
    // zeroes lastPromptTokenCount while leaving the history intact. 200K window
    // → warn at 147,000; 600,000 ASCII chars ≈ 150,000 tokens of conversation,
    // so the session sits past `warn` even though its overhead alone is tiny —
    // which is the render right before the cheap gate compacts on the next send.
    const config = {
      ...makeMockConfig(200_000),
      getLlmClient: vi.fn().mockReturnValue({
        isInitialized: vi.fn().mockReturnValue(true),
        getChat: vi.fn().mockReturnValue({
          getLastPromptTokenCount: vi.fn().mockReturnValue(0),
          isLastPromptTokenCountEstimated: vi.fn().mockReturnValue(false),
          getHistory: vi
            .fn()
            .mockReturnValue([
              { role: 'user', parts: [{ text: 'a'.repeat(600_000) }] },
            ]),
        }),
      }),
    } as unknown as Config;

    const data = await collectContextData(config, false);

    expect(data.totalTokens).toBe(0);
    expect(data.breakdown.currentTier).not.toBe('safe');
    // Free space has to account for the conversation as well.
    expect(data.breakdown.freeSpace).toBeLessThan(50_000);

    // A top-level media part must count against the free window exactly like
    // text: the same fixture plus one pasted image lowers `freeSpace` by the
    // flat per-image budget. Before `estimateConversationTokens` had an arm
    // for top-level `inlineData`, the image vanished from `rawContent` and
    // this delta was 0.
    const withImage = await collectContextData(
      {
        ...makeMockConfig(200_000),
        getLlmClient: vi.fn().mockReturnValue({
          isInitialized: vi.fn().mockReturnValue(true),
          getChat: vi.fn().mockReturnValue({
            getLastPromptTokenCount: vi.fn().mockReturnValue(0),
            isLastPromptTokenCountEstimated: vi.fn().mockReturnValue(false),
            getHistory: vi.fn().mockReturnValue([
              {
                role: 'user',
                parts: [
                  { text: 'a'.repeat(600_000) },
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: 'A'.repeat(400_000),
                    },
                  },
                ],
              },
            ]),
          }),
        }),
      } as unknown as Config,
      false,
    );
    expect(data.breakdown.freeSpace - withImage.breakdown.freeSpace).toBe(
      resolveSlimmingConfig(undefined).imageTokenEstimate,
    );
  });

  it('treats no-API-data sessions as safe and omits the threshold section from text', async () => {
    // lastPromptTokenCount = 0 → collectContextData uses the estimated branch
    // (classifies against `rawContent` — overhead plus conversation — not
    // apiTotalTokens). With these default fixtures there is no chat and no
    // history, so rawContent lands well below `warn` and currentTier resolves
    // to `safe`. On heavy system-prompt / skill / MCP loads the
    // estimated branch can return warn/auto/hard — this test only covers
    // the default-fixture safe case. formatContextUsageText must NOT emit
    // the "Compaction thresholds" section because the estimated path
    // renders a different layout.
    mockGetLastPromptTokenCount.mockReturnValue(0);
    const data = await collectContextData(makeMockConfig(200_000), false);
    expect(data.breakdown.currentTier).toBe('safe');
    // Thresholds are still computed and exposed on the breakdown for downstream
    // consumers, even though the text layout suppresses them.
    expect(data.breakdown.thresholds.auto).toBe(167_000);
    const text = formatContextUsageText(data);
    expect(text).not.toMatch(/Compaction thresholds/);
  });

  it('bills the active output style into the system-prompt estimate', async () => {
    const concise = getBuiltInOutputStyle('Concise')!;
    const plainConfig = makeMockConfig(200_000);
    const styledConfig = {
      ...makeMockConfig(200_000),
      getOutputStyle: vi.fn().mockReturnValue(concise),
    } as unknown as Config;

    // No API token count, so breakdown.systemPrompt is the raw estimate
    // rather than a scaled share — the style section shows up undiluted.
    const plain = await collectContextData(plainConfig, false);
    const styled = await collectContextData(styledConfig, false);

    const tokenDelta =
      styled.breakdown.systemPrompt - plain.breakdown.systemPrompt;
    expect(tokenDelta).toBeGreaterThan(0);

    // ...and the delta has to be the style layer itself, not incidental
    // drift: estimateTokens bills ASCII at ~4 chars/token.
    const mode = resolveInteractionMode(styledConfig);
    const charDelta =
      getCoreSystemPrompt(undefined, 'test-model', undefined, mode, concise)
        .length -
      getCoreSystemPrompt(undefined, 'test-model', undefined, mode, undefined)
        .length;
    expect(tokenDelta).toBeGreaterThan(charDelta / 4 - 5);
    expect(tokenDelta).toBeLessThan(charDelta / 4 + 5);
  });

  it('estimates the custom system prompt used by the live client', async () => {
    const config = {
      ...makeMockConfig(200_000),
      getSystemPrompt: vi.fn().mockReturnValue('CUSTOM'),
      getOutputStyle: vi.fn().mockReturnValue(getBuiltInOutputStyle('Concise')),
    } as unknown as Config;

    const data = await collectContextData(config, false);

    expect(data.breakdown.systemPrompt).toBe(2);
  });

  it('propagates custom autoCompactThreshold through to /context thresholds', async () => {
    // config.getAutoCompactThreshold() returns 0.5 → computeThresholds(32000, 0.5)
    // = { warn: 0, auto: 16,000, hard: 19,000, effectiveWindow: 12,000 }
    // (32K ceiling degenerates, so auto = proportional floor = 0.5 * 32K)
    const config = makeMockConfig(32_000);
    vi.mocked(config.getAutoCompactThreshold).mockReturnValue(0.5);
    const data = await collectContextData(config, false);

    expect(data.breakdown.thresholds).toBeDefined();
    expect(data.breakdown.thresholds!.auto).toBe(16_000);
  });
});
