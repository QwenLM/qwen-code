/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Text-projection parity tests for the special ink history items (audit 01
 * G-1/2/3/12/14/17): each builder must print what the ink component prints.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config, SessionMetrics } from '@qwen-code/qwen-code-core';
import {
  extractPromptText,
  projectContextUsage,
  projectDoctor,
  projectMcpStatus,
  projectModelStats,
  projectQuit,
  projectSkillStats,
  projectSpecialItemText,
  projectSummary,
  projectToolStats,
  projectToolsList,
} from './item-projection.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { LoadedSettings } from '../../config/settings.js';

// R1-93 tests the cached-items upgrade from the DISCONNECTED base state;
// the real registry reports unknown servers as disconnected anyway, but the
// mock makes that independent of core's global state.
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    getMCPServerStatus: () => actual.MCPServerStatus.DISCONNECTED,
  };
});

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

describe('projectToolsList (R1-90: tool descriptions)', () => {
  it('renders each tool description under its name when showDescriptions', () => {
    const text = projectToolsList(
      [
        {
          name: 'read_file',
          displayName: 'ReadFile',
          description: 'Reads a file. ',
        },
        { name: 'run_shell', description: '  Runs a shell command.' },
      ],
      true,
    );
    expect(text).toContain('- ReadFile (read_file)');
    expect(text).toContain('   Reads a file.');
    expect(text).toContain('- run_shell (run_shell)');
    expect(text).toContain('   Runs a shell command.');
  });

  it('omits descriptions when showDescriptions is off', () => {
    const text = projectToolsList(
      [{ name: 'read_file', description: 'Reads a file.' }],
      false,
    );
    expect(text).toContain('- read_file');
    expect(text).not.toContain('Reads a file.');
  });
});

describe('model pricing (R1-91/R1-92)', () => {
  const pricingMetrics = (): SessionMetrics =>
    ({
      models: {
        'qwen3-max-001': {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 1000,
            candidates: 500,
            total: 1500,
            cached: 0,
            thoughts: 0,
          },
          bySource: Object.create(null),
        },
      },
    }) as unknown as SessionMetrics;

  it('looks pricing up under the raw model name, not the normalized label', () => {
    // The display label renders as "qwen3-max" (normalizeModelName strips
    // -001) but the pricing table is keyed by the raw name, exactly like
    // ink's getModelName(key) — a label-based lookup would miss.
    const text = projectModelStats(pricingMetrics(), {
      'qwen3-max-001': {
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
      },
    });
    expect(text).toContain('Cost');
    expect(text).toContain('Estimated $0.0020');
  });

  it('resolves pricing from settings.merged.modelPricing (R1-92)', () => {
    const settings = {
      merged: {
        modelPricing: {
          'qwen3-max-001': {
            inputPerMillionTokens: 1,
            outputPerMillionTokens: 2,
          },
        },
      },
    } as unknown as LoadedSettings;
    const stats = {
      sessionId: 's',
      sessionStartTime: new Date(),
      metrics: pricingMetrics(),
      lastPromptTokenCount: 0,
      promptCount: 1,
    } as unknown as SessionStatsState;
    const text = projectSpecialItemText(
      { type: 'model_stats' },
      {
        stats,
        settings,
        // Decoy: the old code probed this nonexistent config method; the
        // pricing entry only exists in settings, so a Cost row proves the
        // settings channel is the one being read.
        config: {
          getModelPricing: () => ({ decoy: {} }),
        } as unknown as Config,
      },
    );
    expect(text).toContain('Cost');
    expect(text).toContain('Estimated $0.0020');
  });
});

describe('projectMcpStatus cached-items upgrade (R1-93)', () => {
  it('upgrades DISCONNECTED servers with cached prompts, not just tools', () => {
    const text = projectMcpStatus({
      servers: { ghost: {}, 'tools-only': {}, 'prompts-only': {} },
      tools: [{ serverName: 'tools-only', name: 't1' }],
      prompts: [{ serverName: 'prompts-only', name: 'p1' }],
    });
    // cached tools OR cached prompts upgrade the row to Ready (ink
    // hasCachedItems); a server with neither stays Disconnected.
    expect(text).toMatch(/tools-only[^\n]*Ready/);
    expect(text).toMatch(/prompts-only[^\n]*Ready/);
    expect(text).toMatch(/ghost[^\n]*Disconnected/);
  });
});
