/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { render as renderRaw } from '../../test-utils/render.js';
import type { ReactElement } from 'react';
import { I18nServiceProvider } from '../i18n/I18nServiceContext.js';
import { createTestI18nService } from '../../test-utils/i18n.js';

async function render(tree: ReactElement, width?: number, height?: number) {
  const wrap = (element: ReactElement) => (
    <I18nServiceProvider
      service={createTestI18nService(
        (element.props as { locale?: UiLocale }).locale,
      )}
    >
      {element}
    </I18nServiceProvider>
  );
  const result = await renderRaw(wrap(tree), width, height);
  return {
    ...result,
    rerender: (next: ReactElement) => result.rerender(wrap(next)),
  };
}
import { Text } from 'ink';
import {
  usePhraseCycler,
  PHRASE_CHANGE_INTERVAL_MS,
} from './usePhraseCycler.js';
import { WITTY_LOADING_PHRASES } from '../constants/wittyPhrases.js';
import type { UiLocale } from '@qwen-code/core';
import {
  getLocalizedInformativeTip,
  hasCompleteInformativeTipCatalog,
  INFORMATIVE_TIP_CATALOG,
} from '../i18n/informativeTips.js';

const EN_INFORMATIVE_TIPS = INFORMATIVE_TIP_CATALOG.map(
  ({ id }) => getLocalizedInformativeTip('en', id) ?? '',
);
import { stringWidth } from '../../ink/stringWidth.js';

const renderPhraseCycler = (tree: React.ReactElement) => render(tree, 1000);

// Test component to consume the hook
const TestComponent = ({
  isActive,
  isWaiting,
  showTips = true,
  showWit = true,
  customPhrases,
  additionalTips,
  locale = 'en',
  maxLength,
}: {
  isActive: boolean;
  isWaiting: boolean;
  showTips?: boolean;
  showWit?: boolean;
  customPhrases?: string[];
  additionalTips?: readonly string[];
  locale?: UiLocale;
  maxLength?: number;
}) => {
  const { currentTip, currentWittyPhrase } = usePhraseCycler(
    isActive,
    isWaiting,
    showTips,
    showWit,
    customPhrases,
    maxLength,
    additionalTips,
    locale,
  );
  // For tests, we'll combine them to verify existence
  return (
    <Text>{[currentTip, currentWittyPhrase].filter(Boolean).join(' | ')}</Text>
  );
};

describe('usePhraseCycler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('has a complete Chinese catalog for every built-in tip', () => {
    expect(hasCompleteInformativeTipCatalog()).toBe(true);
  });

  it('localizes the user-confirmation waiting message', async () => {
    const rendered = await renderPhraseCycler(
      <TestComponent isActive isWaiting locale="zh-CN" />,
    );
    await rendered.waitUntilReady();

    expect(rendered.lastFrame()).toContain('正在等待用户确认……');
    rendered.unmount();
  });

  it('retranslates the selected built-in tip without replacing it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const rendered = await renderPhraseCycler(
      <TestComponent
        isActive
        isWaiting={false}
        showTips
        showWit={false}
        locale="en"
      />,
    );
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain(EN_INFORMATIVE_TIPS[0]);

    rendered.rerender(
      <TestComponent
        isActive
        isWaiting={false}
        showTips
        showWit={false}
        locale="zh-CN"
      />,
    );
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain(
      getLocalizedInformativeTip('zh-CN', INFORMATIVE_TIP_CATALOG[0].id),
    );
    expect(rendered.lastFrame()).toContain('/settings');
    expect(rendered.lastFrame()).not.toContain(EN_INFORMATIVE_TIPS[0]);
    rendered.unmount();
  });

  it('filters Chinese tips by terminal cell width', async () => {
    const firstTip = INFORMATIVE_TIP_CATALOG[0];
    const chineseWidth = stringWidth(firstTip.zhCN);
    expect(chineseWidth).toBeGreaterThan(firstTip.zhCN.length);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const rendered = await renderPhraseCycler(
      <TestComponent
        isActive
        isWaiting={false}
        showTips
        showWit={false}
        additionalTips={['short raw tip']}
        locale="zh-CN"
        maxLength={chineseWidth - 1}
      />,
    );
    await rendered.waitUntilReady();

    expect(rendered.lastFrame()).not.toContain(firstTip.zhCN);
    expect(stringWidth(rendered.lastFrame().trim())).toBeLessThanOrEqual(
      chineseWidth - 1,
    );
    rendered.unmount();
  });

  it('keeps the selected tip within the limit across a locale switch', async () => {
    const maxLength = 35;
    const englishCandidates = INFORMATIVE_TIP_CATALOG.filter(
      ({ en }) => stringWidth(en) <= maxLength,
    );
    const localeMismatch = englishCandidates.find(
      ({ zhCN }) => stringWidth(zhCN) > maxLength,
    );
    expect(localeMismatch).toBeDefined();
    const mismatchIndex = englishCandidates.findIndex(
      ({ id }) => id === localeMismatch?.id,
    );
    vi.spyOn(Math, 'random').mockReturnValue(
      (mismatchIndex + 0.1) / englishCandidates.length,
    );

    const rendered = await renderPhraseCycler(
      <TestComponent
        isActive
        isWaiting={false}
        showTips
        showWit={false}
        locale="en"
        maxLength={maxLength}
      />,
    );
    await rendered.waitUntilReady();
    const englishText = rendered.lastFrame().trim();
    const selectedTip = INFORMATIVE_TIP_CATALOG.find(
      ({ en }) => en === englishText,
    );
    expect(selectedTip).toBeDefined();
    expect(englishText).not.toBe(localeMismatch?.en);

    rendered.rerender(
      <TestComponent
        isActive
        isWaiting={false}
        showTips
        showWit={false}
        locale="zh-CN"
        maxLength={maxLength}
      />,
    );
    await rendered.waitUntilReady();

    expect(rendered.lastFrame().trim()).toBe(selectedTip?.zhCN);
    expect(stringWidth(rendered.lastFrame().trim())).toBeLessThanOrEqual(
      maxLength,
    );
    rendered.unmount();
  });

  it('replaces a cached tip after the terminal width shrinks', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const rendered = await renderPhraseCycler(
      <TestComponent
        isActive
        isWaiting={false}
        showTips
        showWit={false}
        locale="en"
      />,
    );
    await rendered.waitUntilReady();
    expect(rendered.lastFrame()).toContain(INFORMATIVE_TIP_CATALOG[0].en);

    rendered.rerender(
      <TestComponent
        isActive
        isWaiting={false}
        showTips
        showWit={false}
        additionalTips={['short']}
        locale="en"
        maxLength={5}
      />,
    );
    await rendered.waitUntilReady();

    expect(rendered.lastFrame().trim()).toBe('short');
    rendered.unmount();
  });

  it('filters custom witty phrases by terminal cell width', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const rendered = await renderPhraseCycler(
      <TestComponent
        isActive
        isWaiting={false}
        showTips={false}
        showWit
        customPhrases={['中文短语', 'okay']}
        maxLength={5}
      />,
    );
    await rendered.waitUntilReady();

    expect(rendered.lastFrame().trim()).toBe('okay');
    expect(stringWidth(rendered.lastFrame().trim())).toBeLessThanOrEqual(5);
    rendered.unmount();
  });

  it('should initialize with an empty string when not active and not waiting', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0.5); // Always witty
    const { lastFrame, unmount, waitUntilReady } = await renderPhraseCycler(
      <TestComponent isActive={false} isWaiting={false} />,
    );
    await waitUntilReady();
    expect(lastFrame({ allowEmpty: true }).trim()).toBe('');
    unmount();
  });

  it('should show "Waiting for user confirmation..." when isWaiting is true', async () => {
    const { lastFrame, waitUntilReady, unmount } = await renderPhraseCycler(
      <TestComponent isActive={true} isWaiting={true} />,
    );
    await waitUntilReady();

    expect(lastFrame().replaceAll(/\s/g, '')).toBe(
      'Waitingforuserconfirmation...',
    );
    unmount();
  });

  it('should not cycle phrases if isActive is false and not waiting', async () => {
    const { lastFrame, waitUntilReady, unmount } = await renderPhraseCycler(
      <TestComponent isActive={false} isWaiting={false} />,
    );
    await waitUntilReady();
    const initialPhrase = lastFrame({ allowEmpty: true }).trim();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHRASE_CHANGE_INTERVAL_MS * 2);
    });
    await waitUntilReady();

    expect(lastFrame({ allowEmpty: true }).trim()).toBe(initialPhrase);
    unmount();
  });

  it('should show both a tip and a witty phrase when both are enabled', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0.5);
    const { lastFrame, waitUntilReady, unmount } = await renderPhraseCycler(
      <TestComponent
        isActive={true}
        isWaiting={false}
        showTips={true}
        showWit={true}
      />,
    );
    await waitUntilReady();

    // In the new logic, both are selected independently if enabled.
    const frame = lastFrame().trim();
    const parts = frame.split(' | ');
    expect(parts).toHaveLength(2);
    expect(EN_INFORMATIVE_TIPS).toContain(parts[0]);
    expect(WITTY_LOADING_PHRASES).toContain(parts[1]);
    unmount();
  });

  it('should include context-specific tips in the existing tip rotation', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const terminalSetupTip =
      'Run /terminal-setup to enable recommended terminal shortcuts';
    const { lastFrame, waitUntilReady, unmount } = await renderPhraseCycler(
      <TestComponent
        isActive={true}
        isWaiting={false}
        showTips={true}
        showWit={false}
        additionalTips={[terminalSetupTip]}
      />,
    );
    await waitUntilReady();

    expect(lastFrame().trim()).toBe(terminalSetupTip);
    unmount();
  });

  it('should cycle through phrases when isActive is true and not waiting', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0.5);
    const { lastFrame, waitUntilReady, unmount } = await renderPhraseCycler(
      <TestComponent
        isActive={true}
        isWaiting={false}
        showTips={true}
        showWit={true}
      />,
    );
    await waitUntilReady();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHRASE_CHANGE_INTERVAL_MS + 100);
    });
    await waitUntilReady();
    const frame = lastFrame().trim();
    const parts = frame.split(' | ');
    expect(parts).toHaveLength(2);
    expect(EN_INFORMATIVE_TIPS).toContain(parts[0]);
    expect(WITTY_LOADING_PHRASES).toContain(parts[1]);

    unmount();
  });

  it('should reset to phrases when isActive becomes true after being false', async () => {
    const customPhrases = ['Phrase A', 'Phrase B'];
    let callCount = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      const val = callCount % 2 === 0 ? 0 : 0.99;
      callCount++;
      return val;
    });

    const { lastFrame, rerender, waitUntilReady, unmount } =
      await renderPhraseCycler(
        <TestComponent
          isActive={false}
          isWaiting={false}
          customPhrases={customPhrases}
          showWit={true}
          showTips={false}
        />,
      );
    await waitUntilReady();

    // Activate
    await act(async () => {
      rerender(
        <TestComponent
          isActive={true}
          isWaiting={false}
          customPhrases={customPhrases}
          showWit={true}
          showTips={false}
        />,
      );
    });
    await waitUntilReady();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitUntilReady();
    expect(customPhrases).toContain(lastFrame().trim());

    // Deactivate -> resets to undefined (empty string in output)
    await act(async () => {
      rerender(
        <TestComponent
          isActive={false}
          isWaiting={false}
          customPhrases={customPhrases}
          showWit={true}
          showTips={false}
        />,
      );
    });
    await waitUntilReady();

    // The phrase should be empty after reset
    expect(lastFrame({ allowEmpty: true }).trim()).toBe('');
    unmount();
  });

  it('should clear phrase interval on unmount when active', async () => {
    const { unmount, waitUntilReady } = await renderPhraseCycler(
      <TestComponent isActive={true} isWaiting={false} />,
    );
    await waitUntilReady();

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('should use custom phrases when provided', async () => {
    const customPhrases = ['Custom Phrase 1', 'Custom Phrase 2'];
    const randomMock = vi.spyOn(Math, 'random');

    let setStateExternally:
      | React.Dispatch<
          React.SetStateAction<{
            isActive: boolean;
            customPhrases?: string[];
          }>
        >
      | undefined;

    const StatefulWrapper = () => {
      const [config, setConfig] = React.useState<{
        isActive: boolean;
        customPhrases?: string[];
      }>({
        isActive: true,
        customPhrases,
      });
      setStateExternally = setConfig;
      return (
        <TestComponent
          isActive={config.isActive}
          isWaiting={false}
          showTips={false}
          showWit={true}
          customPhrases={config.customPhrases}
        />
      );
    };

    const { lastFrame, unmount, waitUntilReady } = await renderPhraseCycler(
      <StatefulWrapper />,
    );
    await waitUntilReady();

    // After first interval, it should use custom phrases
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitUntilReady();

    randomMock.mockReturnValue(0);
    await act(async () => {
      setStateExternally?.({
        isActive: true,
        customPhrases,
      });
    });
    await waitUntilReady();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PHRASE_CHANGE_INTERVAL_MS + 100);
    });
    await waitUntilReady();
    expect(customPhrases).toContain(lastFrame({ allowEmpty: true }).trim());

    unmount();
  });

  it('should fall back to witty phrases if custom phrases are an empty array', async () => {
    vi.spyOn(Math, 'random').mockImplementation(() => 0.5);
    const { lastFrame, waitUntilReady, unmount } = await renderPhraseCycler(
      <TestComponent
        isActive={true}
        isWaiting={false}
        showTips={false}
        showWit={true}
        customPhrases={[]}
      />,
    );
    await waitUntilReady();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitUntilReady();
    expect(WITTY_LOADING_PHRASES).toContain(lastFrame().trim());
    unmount();
  });
});
