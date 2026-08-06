/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, type Page } from '@playwright/test';

export interface EmptyMobileComposerLayout {
  chatPaneBottom: number;
  chatViewIsPaneFlexItem: boolean;
  chatViewPosition: string;
  chatViewZIndex: string;
  composerTop: number;
  dotFieldAnchoredToChatPane: boolean;
  dotFieldCoversChatPane: boolean;
  dotFieldPointerEvents: string;
  dotFieldZIndex: string;
  footerAnchoredToChatPane: boolean;
  footerBottom: number;
  footerPosition: string;
  welcomeFooterBottom: number | null;
  welcomeFooterTop: number | null;
  welcomeHeaderBottom: number;
}

export interface EmptyMobileComposerLayoutOptions {
  requireWelcomeFooter?: boolean;
}

export interface EmptyMobileWelcomeHarnessOptions {
  welcomeFooter?: boolean;
}

export async function gotoEmptyMobileWelcomeHarness(
  page: Page,
  options: EmptyMobileWelcomeHarnessOptions = {},
): Promise<void> {
  const params = new URLSearchParams({ emptyMobileWelcome: 'true' });
  if (options.welcomeFooter === false) params.set('welcomeFooter', 'false');
  await page.goto(`/e2e/composer-layout-harness.html?${params.toString()}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
}

export async function emptyMobileComposerLayout(
  page: Page,
  options: EmptyMobileComposerLayoutOptions = {},
): Promise<EmptyMobileComposerLayout> {
  return page
    .getByTestId('chat-pane-container')
    .evaluate((chatPane, requireWelcomeFooter) => {
      const composer = chatPane.querySelector(
        '[data-web-shell-composer-surface]',
      );
      const welcomeHeader = chatPane.querySelector(
        '[data-e2e-mobile-welcome-header]',
      );
      const welcomeFooter = Array.from(
        chatPane.querySelectorAll<HTMLElement>(
          '[data-e2e-mobile-welcome-footer]',
        ),
      ).find((candidate) => candidate.getClientRects().length > 0);
      const dotField = chatPane.querySelector<HTMLElement>(
        '[data-web-shell-new-session-dot-field]',
      );
      if (
        !composer ||
        !welcomeHeader ||
        !dotField ||
        (requireWelcomeFooter && !welcomeFooter)
      ) {
        throw new Error(
          'Expected the empty mobile welcome layout to be rendered.',
        );
      }

      const chatView = Array.from(chatPane.children).find((child) =>
        child.contains(composer),
      );
      if (!chatView) throw new Error('Expected the composer chat view.');

      const composerShell = composer.closest('[data-web-shell-composer]');
      if (!composerShell) throw new Error('Expected the composer shell.');

      let footer: HTMLElement | undefined;
      for (
        let ancestor = composerShell.parentElement;
        ancestor && ancestor !== chatPane;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        if (style.position === 'absolute' || style.position === 'relative') {
          footer = ancestor;
          break;
        }
      }
      if (!footer) throw new Error('Expected the composer footer.');

      const chatPaneRect = chatPane.getBoundingClientRect();
      const chatPaneStyle = getComputedStyle(chatPane);
      const chatViewStyle = getComputedStyle(chatView);
      const dotFieldRect = dotField.getBoundingClientRect();
      const dotFieldStyle = getComputedStyle(dotField);
      const footerRect = footer.getBoundingClientRect();
      const welcomeFooterRect = welcomeFooter?.getBoundingClientRect();

      return {
        chatPaneBottom: chatPaneRect.bottom,
        chatViewIsPaneFlexItem:
          chatView.parentElement === chatPane &&
          chatPaneStyle.display === 'flex',
        chatViewPosition: chatViewStyle.position,
        chatViewZIndex: chatViewStyle.zIndex,
        composerTop: composer.getBoundingClientRect().top,
        dotFieldAnchoredToChatPane: dotField.offsetParent === chatPane,
        dotFieldCoversChatPane:
          Math.abs(dotFieldRect.top - chatPaneRect.top) <= 1 &&
          Math.abs(dotFieldRect.right - chatPaneRect.right) <= 1 &&
          Math.abs(dotFieldRect.bottom - chatPaneRect.bottom) <= 1 &&
          Math.abs(dotFieldRect.left - chatPaneRect.left) <= 1,
        dotFieldPointerEvents: dotFieldStyle.pointerEvents,
        dotFieldZIndex: dotFieldStyle.zIndex,
        footerAnchoredToChatPane: footer.offsetParent === chatPane,
        footerBottom: footerRect.bottom,
        footerPosition: getComputedStyle(footer).position,
        welcomeFooterBottom: welcomeFooterRect?.bottom ?? null,
        welcomeFooterTop: welcomeFooterRect?.top ?? null,
        welcomeHeaderBottom: welcomeHeader.getBoundingClientRect().bottom,
      };
    }, options.requireWelcomeFooter !== false);
}

export function expectEmptyMobileComposerAnchored(
  layout: EmptyMobileComposerLayout,
  options: EmptyMobileComposerLayoutOptions = {},
): void {
  expect(layout.footerPosition).toBe('absolute');
  expect(
    Math.abs(layout.footerBottom - layout.chatPaneBottom),
  ).toBeLessThanOrEqual(1);
  expect(layout.chatViewPosition).toBe('static');
  expect(layout.chatViewIsPaneFlexItem).toBe(true);
  expect(layout.chatViewZIndex).toBe('1');
  expect(layout.footerAnchoredToChatPane).toBe(true);
  expect(layout.dotFieldAnchoredToChatPane).toBe(true);
  expect(layout.dotFieldCoversChatPane).toBe(true);
  expect(layout.dotFieldPointerEvents).toBe('none');
  expect(Number(layout.chatViewZIndex)).toBeGreaterThan(
    Number(layout.dotFieldZIndex),
  );

  if (options.requireWelcomeFooter !== false) {
    if (
      layout.welcomeFooterTop === null ||
      layout.welcomeFooterBottom === null
    ) {
      throw new Error('Expected a visible welcome footer.');
    }
    expect(layout.welcomeHeaderBottom).toBeLessThanOrEqual(
      layout.welcomeFooterTop,
    );
    expect(layout.welcomeFooterBottom).toBeLessThanOrEqual(layout.composerTop);
  }
}
