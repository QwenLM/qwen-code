/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Text-projection parity tests for the special ink history items (audit 01
 * G-1/2/3/12/14/17): each builder must print what the ink component prints.
 */

import { describe, it, expect } from 'vitest';
import type { SessionMetrics } from '@qwen-code/qwen-code-core';
import {
  extractPromptText,
  projectContextUsage,
  projectDoctor,
  projectMcpStatus,
  projectModelStats,
  projectQuit,
  projectSkillStats,
  projectSummary,
  projectToolStats,
} from './item-projection.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';

function makeMetrics(): SessionMetrics {
  return {
    models: {
      'qwen3-max': {
        api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 4000 },
        tokens: {
          prompt: 1000,
          candidates: 500,
          total: 1600,
          cached: 100,
          thoughts: 100,
        },
        bySource: Object.create(null),
      },
    },
    tools: {
      totalCalls: 3,
      totalSuccess: 2,
      totalFail: 1,
      totalDurationMs: 3000,
      totalDecisions: { accept: 1, reject: 1, modify: 0, auto_accept: 0 },
      byName: {
        read_file: {
          count: 2,
          success: 2,
          fail: 0,
          durationMs: 2000,
          decisions: { accept: 1, reject: 0, modify: 0, auto_accept: 0 },
        },
        write_file: {
          count: 1,
          success: 0,
          fail: 1,
          durationMs: 1000,
          decisions: { accept: 0, reject: 1, modify: 0, auto_accept: 0 },
        },
      },
    },
    files: { totalLinesAdded: 10, totalLinesRemoved: 2 },
    skills: {
      totalCalls: 1,
      totalSuccess: 1,
      totalFail: 0,
      byName: {
        review: { count: 1, success: 1, fail: 0 },
      },
    },
  } as unknown as SessionMetrics;
}

describe('projectModelStats', () => {
  it('reports no calls when the session is empty', () => {
    const metrics = makeMetrics();
    metrics.models = {};
    expect(projectModelStats(metrics)).toBe(
      'No API calls have been made in this session.',
    );
  });

  it('prints requests/errors/tokens for active models', () => {
    const text = projectModelStats(makeMetrics());
    expect(text).toContain('Model Stats For Nerds');
    expect(text).toContain('Requests 2');
    expect(text).toContain('Errors 0 (0.0%)');
    expect(text).toContain('Total 1,600');
    expect(text).toContain(' ↳ Prompt 1,000');
    expect(text).toContain(' ↳ Cached 100 (10.0%)');
    expect(text).toContain('qwen3-max');
  });
});

describe('projectToolStats', () => {
  it('reports no calls when nothing ran', () => {
    const metrics = makeMetrics();
    metrics.tools.byName = {};
    expect(projectToolStats(metrics)).toBe(
      'No tool calls have been made in this session.',
    );
  });

  it('prints per-tool rows and the decision summary', () => {
    const text = projectToolStats(makeMetrics());
    expect(text).toContain('Tool Stats For Nerds');
    expect(text).toContain('read_file 2 100.0% 1.0s');
    expect(text).toContain('write_file 1 0.0% 1.0s');
    expect(text).toContain('Total Reviewed Suggestions: 2');
    expect(text).toContain(' » Accepted: 1');
    expect(text).toContain(' » Rejected: 1');
    expect(text).toContain(' Overall Agreement Rate: 50.0%');
  });
});

describe('projectSkillStats', () => {
  it('prints skill rows sorted by count', () => {
    const text = projectSkillStats(makeMetrics());
    expect(text).toContain('Skill Stats For Nerds');
    expect(text).toContain('review 1 1 0 100.0%');
  });
});

describe('projectSummary', () => {
  it('shows stage-specific pending lines and the saved path', () => {
    expect(projectSummary({ isPending: true, stage: 'generating' })).toBe(
      'Generating project summary...',
    );
    expect(projectSummary({ isPending: true, stage: 'saving' })).toBe(
      'Saving project summary...',
    );
    expect(projectSummary({ isPending: false, stage: 'completed' })).toContain(
      'Project summary generated and saved successfully!',
    );
    expect(
      projectSummary({
        isPending: false,
        stage: 'completed',
        filePath: '/tmp/QWEN.md',
      }),
    ).toContain('Saved to: /tmp/QWEN.md');
  });
});

describe('projectContextUsage', () => {
  it('prints the usage table with categories', () => {
    const text = projectContextUsage({
      modelName: 'qwen3-max',
      totalTokens: 5000,
      contextWindowSize: 100000,
      breakdown: {
        systemPrompt: 1000,
        builtinTools: 800,
        mcpTools: 0,
        memoryFiles: 200,
        skills: 0,
        messages: 3000,
        freeSpace: 94000,
        autocompactBuffer: 1000,
      },
      isEstimated: false,
      showDetails: false,
    });
    expect(text).toContain('Context Usage');
    expect(text).toContain('Model: qwen3-max Context window: 100.0k tokens');
    expect(text).toContain('█ Used 5.0k tokens (5.0%)');
    expect(text).toContain('█ Messages 3.0k tokens (3.0%)');
    expect(text).toContain('Run /context detail for per-item breakdown.');
    // MCP tools row is skipped at zero.
    expect(text).not.toContain('MCP tools');
  });

  it('shows the no-API-response notice before the first turn', () => {
    const text = projectContextUsage({
      modelName: 'qwen3-max',
      totalTokens: 0,
      contextWindowSize: 100000,
      breakdown: {},
    });
    expect(text).toContain('No API response yet.');
  });
});

describe('projectDoctor', () => {
  it('groups checks by category and prints the summary', () => {
    const text = projectDoctor(
      [
        {
          category: 'Auth',
          name: 'credentials',
          status: 'pass',
          message: 'ok',
        },
        {
          category: 'Auth',
          name: 'expiry',
          status: 'warn',
          message: 'soon',
          detail: 'renew it',
        },
      ],
      { pass: 1, warn: 1, fail: 0 },
    );
    expect(text).toContain('Doctor Report');
    expect(text).toContain('Auth');
    expect(text).toContain('✓ credentials: ok');
    expect(text).toContain('⚠ expiry: soon');
    expect(text).toContain('-> renew it');
    expect(text).toContain('-- 1 passed, 1 warnings, 0 failures');
  });
});

describe('projectMcpStatus', () => {
  it('reports no servers when none are configured', () => {
    expect(projectMcpStatus({ servers: {}, tools: [], prompts: [] })).toBe(
      'No MCP servers configured.',
    );
  });

  it('lists servers with cached tools as connected', () => {
    const text = projectMcpStatus({
      servers: { docs: {} },
      tools: [{ serverName: 'docs', name: 'search' }],
      prompts: [],
      authStatus: {},
      blockedServers: [],
      discoveryInProgress: false,
      connectingServers: [],
      showDescriptions: false,
    });
    expect(text).toContain('Configured MCP servers:');
    expect(text).toContain('● docs - Ready (1 tool)');
    expect(text).toContain('Tools:');
    expect(text).toContain('- search');
  });
});

describe('projectQuit', () => {
  it('prints the session summary with the resume hint', () => {
    const stats = {
      sessionId: 'abc-123',
      sessionStartTime: new Date(),
      metrics: makeMetrics(),
      lastPromptTokenCount: 0,
      promptCount: 2,
    } as unknown as SessionStatsState;
    const config = {
      getChatRecordingService: () => ({}),
    } as never;
    const text = projectQuit('5m 0s', stats, config);
    expect(text).toContain('Agent powering down. Goodbye!');
    expect(text).toContain('Session ID: abc-123');
    expect(text).toContain('Wall Time: 5m 0s');
    expect(text).toContain('qwen --resume abc-123');
  });

  it('falls back to the bare duration without stats', () => {
    expect(projectQuit('1m', undefined, null)).toContain(
      'Session duration: 1m',
    );
  });
});

describe('extractPromptText', () => {
  it('passes strings through and walks React element children', () => {
    expect(extractPromptText('plain')).toBe('plain');
    // React.createElement(Text, null, '...') shape.
    const element = {
      $$typeof: Symbol.for('react.element'),
      props: { children: 'Overwrite QWEN.md?' },
    };
    expect(extractPromptText(element)).toBe('Overwrite QWEN.md?');
    const nested = {
      props: { children: ['A ', { props: { children: 'B' } }] },
    };
    expect(extractPromptText(nested)).toBe('A B');
    expect(extractPromptText(42)).toBe('42');
  });
});
