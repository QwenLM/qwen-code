/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderWithProviders } from '../../test-utils/render.js';
import { ModelOptionsSelector } from './ModelSelector.js';
import { figures } from '../utils/figures.js';
import { createMockSettings } from '../../test-utils/settings.js';

// 隔离本机动态文案缓存。
const i18nTexts: Record<string, string> = {};
vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    getI18nService: () => {
      const service = actual.getStaticI18nService();
      return Object.assign(
        Object.create(Object.getPrototypeOf(service)),
        service,
        {
          getText: (key: string) => i18nTexts[key] ?? '',
          getModelDescription: () => '',
        },
      );
    },
  };
});

const RIGHT_ARROW = '\u001B[C';
const LEFT_ARROW = '\u001B[D';

describe('ModelOptionsSelector', () => {
  it('selects Ultracode separately from Extra High and submits xhigh plus the mode', async () => {
    const onSelect = vi.fn();
    const view = await renderWithProviders(
      <ModelOptionsSelector
        model={{
          key: 'ultimate',
          display_name: 'Ultimate',
          efforts: ['high', 'xhigh'],
        }}
        currentReasoningEffort="xhigh"
        ultracodeAvailable
        initialFocusKey="effort"
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
    );
    expect(view.lastFrame()).toContain('Extra High');
    await act(async () => {
      view.stdin.write(RIGHT_ARROW);
    });
    await view.waitUntilReady();
    expect(view.lastFrame()).toContain('Ultracode');
    expect(view.lastFrame()).toContain('Workflow orchestration');
    expect(view.lastFrame()).toContain('this session only');
    expect(view.lastFrame()).toContain(`${figures.thinkingEffort} Ultracode`);
    expect(view.lastFrame()).toMatchSnapshot();
    await act(async () => {
      view.stdin.write('\r');
    });
    await view.waitUntilReady();
    expect(onSelect).toHaveBeenCalledWith('xhigh', undefined, true);
    view.unmount();
  });

  it('initializes active Ultracode and lets the user explicitly return to Extra High', async () => {
    const onSelect = vi.fn();
    const view = await renderWithProviders(
      <ModelOptionsSelector
        model={{
          key: 'ultimate',
          display_name: 'Ultimate',
          efforts: ['high', 'xhigh'],
        }}
        currentReasoningEffort="xhigh"
        currentUltracode
        ultracodeAvailable
        initialFocusKey="effort"
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
    );
    expect(view.lastFrame()).toContain(`${figures.thinkingEffort} Ultracode`);
    await act(async () => {
      view.stdin.write(LEFT_ARROW);
    });
    await view.waitUntilReady();
    expect(view.lastFrame()).not.toContain('Ultracode');
    expect(view.lastFrame()).toContain(`${figures.thinkingEffort} Extra High`);
    await act(async () => {
      view.stdin.write('\r');
    });
    await view.waitUntilReady();
    expect(onSelect).toHaveBeenCalledWith('xhigh', undefined, false);
    view.unmount();
  });

  it.each([
    { efforts: ['high', 'xhigh'], available: false },
    { efforts: ['high'], available: true },
  ])(
    'does not expose Ultracode without both capabilities: %j',
    async ({ efforts, available }) => {
      const onSelect = vi.fn();
      const view = await renderWithProviders(
        <ModelOptionsSelector
          model={{ key: 'ultimate', display_name: 'Ultimate', efforts }}
          currentReasoningEffort="high"
          currentUltracode
          ultracodeAvailable={available}
          initialFocusKey="effort"
          onSelect={onSelect}
          onCancel={vi.fn()}
        />,
      );
      for (let i = 0; i < efforts.length + 2; i++) {
        expect(view.lastFrame()).not.toContain('Ultracode');
        await act(async () => {
          view.stdin.write(RIGHT_ARROW);
        });
        await view.waitUntilReady();
      }
      view.unmount();
    },
  );

  it('cancels a pending Ultracode selection without applying it', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const view = await renderWithProviders(
      <ModelOptionsSelector
        model={{
          key: 'ultimate',
          display_name: 'Ultimate',
          efforts: ['xhigh'],
        }}
        currentReasoningEffort="xhigh"
        ultracodeAvailable
        initialFocusKey="effort"
        onSelect={onSelect}
        onCancel={onCancel}
      />,
    );
    await act(async () => {
      view.stdin.write(RIGHT_ARROW);
    });
    await view.waitUntilReady();
    await act(async () => {
      view.stdin.write('\u001b');
    });
    await view.waitUntilReady();
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    view.unmount();
  });

  it('localizes fixed options while preserving the model name', async () => {
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelOptionsSelector
        model={{
          key: 'ultimate',
          display_name: 'Ultimate-X',
          efforts: ['low', 'max'],
          default_effort: 'max',
          available_context_windows: [200_000, 400_000],
          default_context_window: 200_000,
        }}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
      { settings },
    );

    const output = lastFrame();
    expect(output).toContain('模型选项');
    expect(output).toContain('模型：Ultimate-X');
    expect(output).toContain('上下文窗口');
    expect(output).toContain('思考强度');
    expect(output).toContain('Enter 应用设置');
    unmount();
  });
  it('focuses the requested row when it exists', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelOptionsSelector
        model={{
          key: 'ultimate',
          display_name: 'Ultimate',
          efforts: ['low', 'max'],
          default_effort: 'max',
          available_context_windows: [200_000, 400_000],
          default_context_window: 200_000,
        }}
        initialFocusKey="effort"
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('❯ Thinking Effort');
    expect(output).toContain('  Context Window');
    expect(output.indexOf('Context Window')).toBeLessThan(
      output.indexOf('Thinking Effort'),
    );
    // Summary uses footer-style icons + values (no row labels).
    expect(output).toContain(
      `Selected: ${figures.contextWindow} 200K · ${figures.thinkingEffort} Max (Default)`,
    );
    expect(output).toContain('Enter apply settings');
    unmount();
  });

  it('keeps option value controls aligned across rows', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelOptionsSelector
        model={{
          key: 'glm-5.2',
          display_name: 'GLM-5.2',
          efforts: [],
          supports_disabled: true,
          available_context_windows: [200_000, 400_000],
          default_context_window: 200_000,
        }}
        initialFocusKey="context-window"
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const lines = lastFrame().split('\n');
    // Value lines (below each title) carry the triangle switch controls.
    const valueLines = lines.filter(
      (line) =>
        line.includes(figures.triangleLeft) &&
        line.includes(figures.triangleRight),
    );
    expect(valueLines.length).toBeGreaterThanOrEqual(2);
    const leftIndices = valueLines.map((line) =>
      line.indexOf(figures.triangleLeft),
    );
    const rightIndices = valueLines.map((line) =>
      line.lastIndexOf(figures.triangleRight),
    );
    expect(new Set(leftIndices).size).toBe(1);
    expect(new Set(rightIndices).size).toBe(1);

    const contextValueLine = valueLines.find((line) => line.includes('200K'));
    expect(contextValueLine).toBeDefined();
    const leftGap =
      contextValueLine!.indexOf('200K') -
      contextValueLine!.indexOf(figures.triangleLeft) -
      figures.triangleLeft.length;
    const rightGap =
      contextValueLine!.lastIndexOf(figures.triangleRight) -
      (contextValueLine!.indexOf('200K') + '200K'.length);
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
    unmount();
  });

  it('falls back to the first row when the requested row is missing', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelOptionsSelector
        model={{
          key: 'non-reasoning',
          display_name: 'Non Reasoning',
          available_context_windows: [200_000, 400_000],
          default_context_window: 200_000,
        }}
        initialFocusKey="does-not-exist"
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('❯ Context Window');
    expect(output).not.toContain('❯ Thinking Effort');
    unmount();
  });

  it('always shows Context Window and Thinking Effort rows', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelOptionsSelector
        model={{
          key: 'plain',
          display_name: 'Plain',
          // 无 effort 档位，只有一个窗口。
          available_context_windows: [200_000],
          default_context_window: 200_000,
        }}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Context Window');
    expect(output).toContain('Thinking Effort');
    expect(output).not.toContain('Fast');
    // Non-provided options fall back to defaults.
    expect(output).toContain('Default');
    // Every row shows a short description, regardless of selection.
    expect(output).toContain('Maximum context length the model reads at once.');
    expect(output).toContain('How much the model thinks before replying.');
    // No row is switchable, so no triangle switch controls appear anywhere.
    expect(output).not.toContain(figures.triangleLeft);
    expect(output).not.toContain(figures.triangleRight);
    unmount();
  });

  it('hides arrows for a fixed row but keeps them for switchable rows', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelOptionsSelector
        model={{
          key: 'mixed',
          display_name: 'Mixed',
          // Switchable effort, but a single fixed context window.
          efforts: ['low', 'high'],
          default_effort: 'low',
          available_context_windows: [200_000],
          default_context_window: 200_000,
        }}
        initialFocusKey="effort"
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const lines = lastFrame().split('\n');
    // The value (with triangle controls) sits on the line below each title.
    const valueLineBelow = (label: string) => {
      const titleIndex = lines.findIndex((line) => line.includes(label));
      expect(titleIndex).toBeGreaterThanOrEqual(0);
      return lines[titleIndex + 1];
    };
    const contextValueLine = valueLineBelow('Context Window');
    const effortValueLine = valueLineBelow('Thinking Effort');
    // Fixed context window: no controls. Switchable effort: triangles present.
    expect(contextValueLine).not.toContain(figures.triangleLeft);
    expect(contextValueLine).not.toContain(figures.triangleRight);
    expect(effortValueLine).toContain(figures.triangleLeft);
    expect(effortValueLine).toContain(figures.triangleRight);
    unmount();
  });

  it('marks the default effort option when it matches an explicit level', async () => {
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <ModelOptionsSelector
          model={{
            key: 'ultimate',
            display_name: 'Ultimate',
            efforts: ['high', 'max'],
            default_effort: 'high',
          }}
          initialFocusKey="effort"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

    const valueLineBelow = (label: string) => {
      const lines = lastFrame().split('\n');
      const titleIndex = lines.findIndex((line) => line.includes(label));
      expect(titleIndex).toBeGreaterThanOrEqual(0);
      return lines[titleIndex + 1];
    };

    expect(valueLineBelow('Thinking Effort')).toContain('High (Default)');

    await act(async () => {
      stdin.write(RIGHT_ARROW);
    });
    await waitUntilReady();

    const explicitHighLine = valueLineBelow('Thinking Effort');
    expect(explicitHighLine).toContain('High');
    expect(explicitHighLine).not.toContain('(Default)');

    await act(async () => {
      stdin.write(RIGHT_ARROW);
    });
    await waitUntilReady();

    expect(valueLineBelow('Thinking Effort')).toContain('Max');

    await act(async () => {
      stdin.write(RIGHT_ARROW);
    });
    await waitUntilReady();

    expect(valueLineBelow('Thinking Effort')).toContain('High (Default)');
    unmount();
  });

  it('updates the selected summary when switching context windows', async () => {
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <ModelOptionsSelector
          model={{
            key: 'ultimate',
            display_name: 'Ultimate',
            available_context_windows: [200_000, 400_000, 1_000_000],
            default_context_window: 200_000,
          }}
          initialFocusKey="context-window"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

    expect(lastFrame()).not.toContain(
      'Use the model default context window (200K)',
    );
    expect(lastFrame()).toContain(`Selected: ${figures.contextWindow} 200K`);

    await act(async () => {
      stdin.write(RIGHT_ARROW);
    });
    await waitUntilReady();

    const output = lastFrame();
    expect(output).toContain('❯ Context Window');
    expect(output).toContain(figures.triangleLeft);
    expect(output).toContain('400K');
    expect(output).toContain(figures.triangleRight);
    expect(output).not.toContain('400,000 tokens');
    expect(output).toContain(`Selected: ${figures.contextWindow} 400K`);
    unmount();
  });

  it('uses max_input_tokens as the default option without explicit context config', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ModelOptionsSelector
        model={{
          key: 'auto',
          display_name: 'Auto',
          max_input_tokens: 180_000,
        }}
        initialFocusKey="context-window"
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('❯ Context Window');
    expect(output).toContain('180K');
    expect(output).toContain(`Selected: ${figures.contextWindow} 180K`);
    unmount();
  });

  it('shows enabled and disabled values for disable-only reasoning models', async () => {
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <ModelOptionsSelector
          model={{
            key: 'toggle-reasoning',
            display_name: 'Toggle Reasoning',
            efforts: [],
            supports_disabled: true,
          }}
          currentReasoningEffort="none"
          initialFocusKey="effort"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

    expect(lastFrame()).toContain(figures.triangleLeft);
    expect(lastFrame()).toContain('Disabled');
    expect(lastFrame()).toContain(figures.triangleRight);
    expect(lastFrame()).not.toContain('Disable thinking for this model');
    // On/off toggle models use the "whether" wording, not "how much".
    expect(lastFrame()).toContain('Whether the model thinks before replying.');
    expect(lastFrame()).not.toContain('How much the model thinks');

    await act(async () => {
      stdin.write(LEFT_ARROW);
    });
    await waitUntilReady();

    expect(lastFrame()).toContain(figures.triangleLeft);
    expect(lastFrame()).toContain('Enabled (Default)');
    expect(lastFrame()).toContain(figures.triangleRight);
    expect(lastFrame()).not.toContain('Enable thinking for this model');
    expect(lastFrame()).toContain(
      `${figures.thinkingEffort} Enabled (Default)`,
    );
    unmount();
  });

  it('wraps context window values when switching right past the end', async () => {
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <ModelOptionsSelector
          model={{
            key: 'ultimate',
            display_name: 'Ultimate',
            available_context_windows: [200_000, 400_000, 1_000_000],
            default_context_window: 200_000,
          }}
          initialFocusKey="context-window"
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

    expect(lastFrame()).toContain(figures.triangleLeft);
    expect(lastFrame()).toContain('200K');
    expect(lastFrame()).toContain(figures.triangleRight);

    await act(async () => {
      stdin.write(RIGHT_ARROW);
      stdin.write(RIGHT_ARROW);
    });
    await waitUntilReady();

    expect(lastFrame()).toContain(figures.triangleLeft);
    expect(lastFrame()).toContain('1M');
    expect(lastFrame()).toContain(figures.triangleRight);

    await act(async () => {
      stdin.write(RIGHT_ARROW);
    });
    await waitUntilReady();

    expect(lastFrame()).toContain(figures.triangleLeft);
    expect(lastFrame()).toContain('200K');
    expect(lastFrame()).toContain(figures.triangleRight);
    unmount();
  });
});
