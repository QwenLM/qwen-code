/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildWorkflowSizeGuidelineChangeNotice,
  buildWorkflowSizeGuidelineParagraph,
  DEFAULT_WORKFLOW_SIZE_WARNING_AGENTS,
  DEFAULT_WORKFLOW_SIZE_WARNING_TOKENS,
  evaluateWorkflowSize,
  formatWorkflowSizeWarningLog,
  isWorkflowSizeWarning,
  resolveWorkflowSizeCaps,
  resolveWorkflowSizeGuidelineSetting,
  WORKFLOW_SIZE_GUIDELINE_AGENTS,
  WORKFLOW_SIZE_TOKENS_PER_AGENT_ASSUMPTION,
  WORKFLOW_SIZE_WARNING_AGENTS_ENV,
  WORKFLOW_SIZE_WARNING_TOKENS_ENV,
  type WorkflowSizeCaps,
} from './workflow-size.js';

const DEFAULT = resolveWorkflowSizeGuidelineSetting(undefined);

describe('resolveWorkflowSizeGuidelineSetting', () => {
  it('treats an unset or unrecognised value as the default medium guideline', () => {
    expect(resolveWorkflowSizeGuidelineSetting(undefined)).toEqual({
      size: 'medium',
      isDefault: true,
    });
    // A typo in a settings file must not silently drop the guideline.
    expect(resolveWorkflowSizeGuidelineSetting('huge')).toEqual({
      size: 'medium',
      isDefault: true,
    });
  });

  it('keeps an explicit value, an explicit medium included', () => {
    expect(resolveWorkflowSizeGuidelineSetting('small')).toEqual({
      size: 'small',
      isDefault: false,
    });
    expect(resolveWorkflowSizeGuidelineSetting('medium')).toEqual({
      size: 'medium',
      isDefault: false,
    });
  });
});

describe('buildWorkflowSizeGuidelineParagraph', () => {
  it('states the default and where the user can change it', () => {
    expect(buildWorkflowSizeGuidelineParagraph(DEFAULT)).toBe(
      `This session has the default workflow size guideline: medium — keep workflows under ${WORKFLOW_SIZE_GUIDELINE_AGENTS.medium} agents. ` +
        "This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale. " +
        'The user can raise or remove it with "Dynamic Workflow Size" in /settings.',
    );
  });

  it('states a configured guideline without the settings pointer', () => {
    expect(
      buildWorkflowSizeGuidelineParagraph({ size: 'small', isDefault: false }),
    ).toBe(
      `A workflow size guideline is configured for this session: small — keep workflows under ${WORKFLOW_SIZE_GUIDELINE_AGENTS.small} agents. ` +
        "This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.",
    );
  });

  it('sends nothing for unrestricted', () => {
    expect(
      buildWorkflowSizeGuidelineParagraph({
        size: 'unrestricted',
        isDefault: false,
      }),
    ).toBeNull();
  });
});

describe('buildWorkflowSizeGuidelineChangeNotice', () => {
  // The description was built at startup and still carries the old value, so
  // the reminder has to say which one wins.
  it('says the new guideline replaces the one in the description', () => {
    const notice = buildWorkflowSizeGuidelineChangeNotice({
      size: 'large',
      isDefault: false,
    });
    expect(notice).toContain(
      `changed: large — keep workflows under ${WORKFLOW_SIZE_GUIDELINE_AGENTS.large} agents`,
    );
    expect(notice).toContain('replaces the guideline stated');
  });

  it('says no guideline applies once unrestricted', () => {
    expect(
      buildWorkflowSizeGuidelineChangeNotice({
        size: 'unrestricted',
        isDefault: false,
      }),
    ).toContain(
      'Workflow size is now unrestricted — no size guideline applies',
    );
  });
});

describe('resolveWorkflowSizeCaps', () => {
  it('takes the agent threshold from the guideline', () => {
    expect(resolveWorkflowSizeCaps(DEFAULT, {})).toEqual({
      agentCap: WORKFLOW_SIZE_GUIDELINE_AGENTS.medium,
      tokenCap: DEFAULT_WORKFLOW_SIZE_WARNING_TOKENS,
      capFromGuideline: true,
    });
  });

  it('falls back to the fixed threshold when unrestricted', () => {
    expect(
      resolveWorkflowSizeCaps({ size: 'unrestricted', isDefault: false }, {}),
    ).toEqual({
      agentCap: DEFAULT_WORKFLOW_SIZE_WARNING_AGENTS,
      tokenCap: DEFAULT_WORKFLOW_SIZE_WARNING_TOKENS,
      capFromGuideline: false,
    });
  });

  it('lets the env override the guideline and the token default', () => {
    expect(
      resolveWorkflowSizeCaps(DEFAULT, {
        [WORKFLOW_SIZE_WARNING_AGENTS_ENV]: '100',
        [WORKFLOW_SIZE_WARNING_TOKENS_ENV]: '5000000',
      }),
    ).toEqual({ agentCap: 100, tokenCap: 5_000_000, capFromGuideline: false });
  });

  it.each(['abc', '0', '-3', '1.5', ''])(
    'ignores a malformed env value %j',
    (raw) => {
      expect(
        resolveWorkflowSizeCaps(DEFAULT, {
          [WORKFLOW_SIZE_WARNING_AGENTS_ENV]: raw,
          [WORKFLOW_SIZE_WARNING_TOKENS_ENV]: raw,
        }),
      ).toEqual({
        agentCap: WORKFLOW_SIZE_GUIDELINE_AGENTS.medium,
        tokenCap: DEFAULT_WORKFLOW_SIZE_WARNING_TOKENS,
        capFromGuideline: true,
      });
    },
  );
});

describe('evaluateWorkflowSize', () => {
  const caps: WorkflowSizeCaps = {
    agentCap: 25,
    tokenCap: 1_500_000,
    capFromGuideline: false,
  };

  it('stays quiet within bounds, the cap itself included', () => {
    expect(
      evaluateWorkflowSize(
        { scheduledAgents: 20, settledAgents: 20, tokensSpent: 40_000 },
        caps,
      ),
    ).toBeNull();
  });

  it('flags the agent axis past the agent threshold', () => {
    expect(
      evaluateWorkflowSize(
        { scheduledAgents: 26, settledAgents: 26, tokensSpent: 26_000 },
        caps,
        42,
      ),
    ).toEqual({
      axis: 'agents',
      scheduledAgents: 26,
      totalTokens: 26_000,
      projectedTokens: 26_000,
      agentCap: 25,
      tokenCap: 1_500_000,
      capFromGuideline: false,
      at: 42,
    });
  });

  // A fan-out queues everything before anything settles; the assumption is
  // what lets it be flagged before it has spent the tokens it will spend.
  it('projects with the per-agent assumption before any agent settles', () => {
    const warning = evaluateWorkflowSize(
      { scheduledAgents: 22, settledAgents: 0, tokensSpent: 0 },
      caps,
    );
    expect(warning?.axis).toBe('tokens');
    expect(warning?.projectedTokens).toBe(
      22 * WORKFLOW_SIZE_TOKENS_PER_AGENT_ASSUMPTION,
    );
  });

  it("projects with the run's own average once agents have settled", () => {
    expect(
      evaluateWorkflowSize(
        { scheduledAgents: 22, settledAgents: 2, tokensSpent: 20_000 },
        caps,
      ),
    ).toBeNull();
  });

  it('flags spend that is already past the token threshold', () => {
    const warning = evaluateWorkflowSize(
      { scheduledAgents: 3, settledAgents: 3, tokensSpent: 1_600_000 },
      caps,
    );
    expect(warning?.axis).toBe('tokens');
    expect(warning?.projectedTokens).toBe(1_600_000);
  });
});

describe('formatWorkflowSizeWarningLog', () => {
  it('names the agent count and where the threshold came from', () => {
    expect(
      formatWorkflowSizeWarningLog({
        axis: 'agents',
        scheduledAgents: 16,
        totalTokens: 0,
        projectedTokens: 1_120_000,
        agentCap: 15,
        tokenCap: 1_500_000,
        capFromGuideline: true,
        at: 0,
      }),
    ).toBe(
      '[size] Large workflow: 16 agents scheduled (warning threshold 15, from the size guideline) — /workflows to stop.',
    );
  });

  it('names the projection on the token axis', () => {
    expect(
      formatWorkflowSizeWarningLog({
        axis: 'tokens',
        scheduledAgents: 22,
        totalTokens: 0,
        projectedTokens: 1_540_000,
        agentCap: 25,
        tokenCap: 1_500_000,
        capFromGuideline: false,
        at: 0,
      }),
    ).toBe(
      '[size] Large workflow: ~1,540,000 output tokens projected (warning threshold 1,500,000) — /workflows to stop.',
    );
  });
});

describe('isWorkflowSizeWarning', () => {
  const valid = {
    axis: 'agents',
    scheduledAgents: 16,
    totalTokens: 0,
    projectedTokens: 0,
    agentCap: 15,
    tokenCap: 1_500_000,
    capFromGuideline: true,
    at: 1,
  };

  it('accepts a well-formed warning', () => {
    expect(isWorkflowSizeWarning(valid)).toBe(true);
  });

  it.each([
    ['an unknown axis', { ...valid, axis: 'time' }],
    ['a missing count', { ...valid, scheduledAgents: undefined }],
    ['a non-finite number', { ...valid, tokenCap: Number.NaN }],
    ['a non-boolean source flag', { ...valid, capFromGuideline: 'yes' }],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(isWorkflowSizeWarning(value)).toBe(false);
  });
});
