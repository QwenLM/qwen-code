/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionMode,
  type PermissionRules,
  type ToolCheckContext,
} from '../../permissions/manager/decision/index.js';
import { DONT_ASK_REJECT_MESSAGE } from '../../tools/tool-checkers/mode-layer.js';
import { checkInPermissionMode } from '../../test-utils/permission-mode.js';
import type { ToolPermissionReason } from '../../tools/tool-checkers/checker-reasons.js';
import type {
  HostToolChecker,
  ToolPermissionResult,
} from '../../tools/tool-checkers/rule-precedence.js';

function contextIn(
  mode: PermissionMode,
): ToolCheckContext<ToolPermissionReason> {
  const rules: PermissionRules = { allow: {}, deny: {}, ask: {} };
  return {
    mode,
    rules,
    cwd: '/repo',
    additionalDirectories: [],
    rulesForTool: rulesForToolName(rules, 'T'),
    toolUseId: 'tu-1',
  };
}

function returning(result: ToolPermissionResult): HostToolChecker {
  return { check: () => result };
}

const plainAsk: ToolPermissionResult = {
  kind: 'ask',
  reason: {
    message: 'Allow?',
    attribution: { type: 'other', reason: 'no rule' },
    decisionPoint: 'tool.no_rule.ask',
  },
};

const safetyAsk: ToolPermissionResult = {
  kind: 'ask',
  reason: {
    message: 'Dangerous.',
    attribution: {
      type: 'safetyCheck',
      reason: 'dangerous path',
      classifierApprovable: false,
    },
  },
};

const interactionAsk: ToolPermissionResult = {
  kind: 'ask',
  reason: {
    message: 'The agent has a question for you.',
    attribution: { type: 'interaction', reason: 'the prompt is the tool' },
  },
};

const boundaryAsk: ToolPermissionResult = {
  kind: 'ask',
  reason: {
    message: 'Outside the workspace.',
    attribution: { type: 'other', reason: 'boundary' },
    blockedPath: '/etc/hosts',
  },
};

const askRuleAsk: ToolPermissionResult = {
  kind: 'ask',
  reason: {
    message: 'A rule says ask.',
    attribution: {
      type: 'rule',
      rule: {
        source: 'userSettings',
        ruleBehavior: 'ask',
        ruleValue: { toolName: 'T' },
      },
    },
  },
};

const hookAsk: ToolPermissionResult = {
  kind: 'ask',
  reason: {
    message: 'A hook says ask.',
    attribution: { type: 'hook', hookName: 'PreToolUse' },
  },
};

const denied: ToolPermissionResult = {
  kind: 'deny',
  extra: { decisionPoint: 'tool.rule.deny' },
};

describe('Yolo', () => {
  it('turns an ask into an allow', async () => {
    const result = await checkInPermissionMode(returning(plainAsk)).check(
      {},
      contextIn(PermissionModes.Yolo),
    );
    expect(result.kind).toBe('allow');
    expect(result.extra?.decisionPoint).toBe('mode.yolo.allow');
  });

  it('leaves a deny denied — a mode only resolves asks', async () => {
    const result = await checkInPermissionMode(returning(denied)).check(
      {},
      contextIn(PermissionModes.Yolo),
    );
    expect(result.kind).toBe('deny');
  });

  it('cannot skip a tool whose prompt is its purpose', async () => {
    const result = await checkInPermissionMode(returning(interactionAsk)).check(
      {},
      contextIn(PermissionModes.Yolo),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.decisionPoint).toBe('mode.needs_user.keep_ask');
    }
  });
});

describe('AcceptEdits', () => {
  it('allows a plain ask from a tool it covers', async () => {
    const result = await checkInPermissionMode(returning(plainAsk), {
      coveredByAcceptEdits: true,
    }).check({}, contextIn(PermissionModes.AcceptEdits));
    expect(result.kind).toBe('allow');
    expect(result.extra?.decisionPoint).toBe('mode.accept_edits.allow');
  });

  it('keeps the prompt for a tool the mode does not cover', async () => {
    // acceptEdits is a narrow capability: an ask from a tool it does not
    // cover (MCP passthrough, Bash, Agent) stays visible to the user.
    const result = await checkInPermissionMode(returning(plainAsk)).check(
      {},
      contextIn(PermissionModes.AcceptEdits),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.decisionPoint).toBe(
        'mode.accept_edits.ineligible.keep_ask',
      );
    }
  });

  it('keeps the prompt for a hook ask, even on a tool it covers', async () => {
    const result = await checkInPermissionMode(returning(hookAsk), {
      coveredByAcceptEdits: true,
    }).check({}, contextIn(PermissionModes.AcceptEdits));
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.decisionPoint).toBe(
        'mode.accept_edits.ineligible.keep_ask',
      );
    }
  });

  it('does not overrule a safety objection, a boundary, or an ask rule', async () => {
    for (const ask of [safetyAsk, boundaryAsk, askRuleAsk]) {
      const result = await checkInPermissionMode(returning(ask), {
        coveredByAcceptEdits: true,
      }).check({}, contextIn(PermissionModes.AcceptEdits));
      expect(result.kind).toBe('ask');
      if (result.kind === 'ask') {
        expect(result.reason.decisionPoint).toBe(
          'mode.safety_objection.keep_ask',
        );
      }
    }
  });

  it('leaves a deny denied', async () => {
    const result = await checkInPermissionMode(returning(denied)).check(
      {},
      contextIn(PermissionModes.AcceptEdits),
    );
    expect(result.kind).toBe('deny');
  });
});

describe('DontAsk', () => {
  it('refuses instead of prompting', async () => {
    const result = await checkInPermissionMode(returning(plainAsk)).check(
      {},
      contextIn(PermissionModes.DontAsk),
    );
    expect(result.kind).toBe('deny');
    expect(result.extra?.denialReason?.message).toBe(DONT_ASK_REJECT_MESSAGE);
    expect(result.extra?.denialReason?.attribution).toEqual({
      type: 'mode',
      mode: PermissionModes.DontAsk,
    });
  });

  it('refuses even a tool whose prompt is its purpose — dontAsk never prompts', async () => {
    const result = await checkInPermissionMode(returning(interactionAsk)).check(
      {},
      contextIn(PermissionModes.DontAsk),
    );
    expect(result.kind).toBe('deny');
  });
});

describe('Auto', () => {
  it('hands the ask to the classifier', async () => {
    const classify = vi.fn(async () => ({ kind: 'allow' }) as const);
    const result = await checkInPermissionMode(returning(plainAsk), {
      autoClassifier: { classify },
    }).check({}, contextIn(PermissionModes.Auto));
    expect(classify).toHaveBeenCalledOnce();
    expect(result.kind).toBe('allow');
  });

  it('refuses rather than prompting when no classifier is available', async () => {
    const result = await checkInPermissionMode(returning(plainAsk)).check(
      {},
      contextIn(PermissionModes.Auto),
    );
    expect(result.kind).toBe('deny');
    expect(result.extra?.decisionPoint).toBe('mode.auto_unavailable.deny');
  });
});

describe('Default', () => {
  it('leaves the prompt alone', async () => {
    const result = await checkInPermissionMode(returning(plainAsk)).check(
      {},
      contextIn(PermissionModes.Default),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.decisionPoint).toBe('tool.no_rule.ask');
      expect(result.suggestions).toBeUndefined();
    }
  });

  it('offers the AcceptEdits shortcut only for tools it covers', async () => {
    const covered = await checkInPermissionMode(returning(plainAsk), {
      coveredByAcceptEdits: true,
    }).check({}, contextIn(PermissionModes.Default));
    expect(covered.kind).toBe('ask');
    if (covered.kind === 'ask') {
      expect(covered.suggestions).toEqual([
        {
          type: 'setMode',
          destination: 'session',
          mode: PermissionModes.AcceptEdits,
        },
      ]);
    }
  });

  it('lets AcceptEdits allow an edit marked only for auto-mode review', async () => {
    const result = await checkInPermissionMode(
      returning({ ...plainAsk, extra: { autoModeReview: true } }),
      { coveredByAcceptEdits: true },
    ).check({}, contextIn(PermissionModes.AcceptEdits));
    expect(result.kind).toBe('allow');
  });

  it('passes an allow through untouched', async () => {
    const result = await checkInPermissionMode(
      returning({ kind: 'allow' }),
    ).check({}, contextIn(PermissionModes.Default));
    expect(result.kind).toBe('allow');
  });
});

const bypassImmuneAsk: ToolPermissionResult = {
  kind: 'ask',
  reason: {
    message: "Dangerous rm operation detected: '~'",
    attribution: {
      type: 'safetyCheck',
      reason: 'Dangerous rm operation on critical path: ~',
      safetyCheckKind: 'dangerousRemoval',
      classifierApprovable: true,
      bypassImmune: true,
    },
    decisionPoint: 'shell.dangerous_removal.ask',
  },
  suggestions: [],
};

describe('Yolo and a bypass-immune ask', () => {
  it('keeps a catastrophic-removal ask as a prompt', async () => {
    const result = await checkInPermissionMode(
      returning(bypassImmuneAsk),
    ).check({}, contextIn(PermissionModes.Yolo));
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.decisionPoint).toBe('mode.bypass_immune.keep_ask');
      expect(result.suggestions).toEqual([]);
    }
  });

  it('still waves an ordinary safety check through', async () => {
    const result = await checkInPermissionMode(returning(safetyAsk)).check(
      {},
      contextIn(PermissionModes.Yolo),
    );
    expect(result.kind).toBe('allow');
    expect(result.extra?.decisionPoint).toBe('mode.yolo.allow');
  });

  it('routes the same ask to the classifier under Auto, as any safety check', async () => {
    const classify = vi.fn(async () => ({
      kind: 'allow' as const,
      extra: { decisionPoint: 'mode.auto_classifier.allow' },
    }));
    const result = await checkInPermissionMode(returning(bypassImmuneAsk), {
      autoClassifier: { classify },
    }).check({}, contextIn(PermissionModes.Auto));
    expect(classify).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('allow');
  });
});

describe('per-invocation edit eligibility', () => {
  it('consumes only checker eligibility, not an input flag', async () => {
    const eligible = checkInPermissionMode(
      returning({ ...plainAsk, extra: { acceptEditsEligible: true } }),
    );
    expect(
      (await eligible.check({}, contextIn(PermissionModes.AcceptEdits))).kind,
    ).toBe('allow');
    expect(
      (await eligible.check({}, contextIn(PermissionModes.Default))).kind,
    ).toBe('ask');
    const normal = checkInPermissionMode(returning(plainAsk));
    expect(
      (
        await normal.check(
          { acceptEditsEligible: true },
          contextIn(PermissionModes.AcceptEdits),
        )
      ).kind,
    ).toBe('ask');
  });
  it.each([safetyAsk, boundaryAsk, askRuleAsk, hookAsk])(
    'cannot suppress a safety, rule, boundary or Hook objection',
    async (objection) => {
      const checker = checkInPermissionMode(
        returning({ ...objection, extra: { acceptEditsEligible: true } }),
      );
      expect(
        (await checker.check({}, contextIn(PermissionModes.AcceptEdits))).kind,
      ).toBe('ask');
    },
  );
});
