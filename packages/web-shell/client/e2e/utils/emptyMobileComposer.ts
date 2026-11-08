/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, type Page } from '@playwright/test';

export const emptyMobileComposerSelectors = {
  composerSurface: '[data-web-shell-composer-surface]',
  welcomeFooter: '[data-e2e-mobile-welcome-footer]',
  welcomeHeader: '[data-e2e-mobile-welcome-header]',
} as const;

export interface EmptyMobileComposerLayout {
  chatPaneBottom: number;
  chatViewIsPaneFlexItem: boolean;
  chatViewPosition: string;
  chatViewZIndex: string;
  composerTop: number;
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
  customFooter?: boolean;
  welcomeFooter?: boolean;
}

export async function gotoEmptyMobileWelcomeHarness(
  page: Page,
  options: EmptyMobileWelcomeHarnessOptions = {},
): Promise<void> {
  const params = new URLSearchParams({ emptyMobileWelcome: 'true' });
  if (options.welcomeFooter === false) params.set('welcomeFooter', 'false');
  if (options.customFooter === true) params.set('customFooter', 'true');
  await page.goto(`/e2e/composer-layout-harness.html?${params.toString()}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
}

export async function expectEmptyMobileWelcomeChromeVisible(
  page: Page,
  options: EmptyMobileComposerLayoutOptions = {},
): Promise<void> {
  const composer = page.locator(emptyMobileComposerSelectors.composerSurface);
  const welcomeHeader = page.locator(
    emptyMobileComposerSelectors.welcomeHeader,
  );

  await expect(composer).toBeVisible();
  await expect(welcomeHeader).toBeVisible();
  if (options.requireWelcomeFooter !== false) {
    await expect(
      page.locator(`${emptyMobileComposerSelectors.welcomeFooter}:visible`),
    ).toBeVisible();
  } else {
    await expect(
      page.locator(emptyMobileComposerSelectors.welcomeFooter),
    ).toHaveCount(0);
  }
}

export async function emptyMobileComposerLayout(
  page: Page,
  options: EmptyMobileComposerLayoutOptions = {},
): Promise<EmptyMobileComposerLayout> {
  return page.getByTestId('chat-pane-container').evaluate(
    (chatPane, { selectors, requireWelcomeFooter }) => {
      const composer = chatPane.querySelector(selectors.composerSurface);
      const welcomeHeader = chatPane.querySelector(selectors.welcomeHeader);
      const welcomeFooter = Array.from(
        chatPane.querySelectorAll<HTMLElement>(selectors.welcomeFooter),
      ).find((candidate) => candidate.getClientRects().length > 0);
      if (!composer) {
        throw new Error('Expected the empty mobile composer to be rendered.');
      }
      if (!welcomeHeader) {
        throw new Error('Expected the mobile welcome header to be rendered.');
      }
      if (requireWelcomeFooter && !welcomeFooter) {
        throw new Error('Expected the mobile welcome footer to be rendered.');
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
      if (footer.getClientRects().length === 0) {
        throw new Error(
          'The composer footer has no box in the custom footer welcome variant (it renders display: contents by design), so anchored layout measurements do not apply there.',
        );
      }

      const chatPaneRect = chatPane.getBoundingClientRect();
      const chatPaneStyle = getComputedStyle(chatPane);
      const chatViewStyle = getComputedStyle(chatView);
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
        footerAnchoredToChatPane: footer.offsetParent === chatPane,
        footerBottom: footerRect.bottom,
        footerPosition: getComputedStyle(footer).position,
        welcomeFooterBottom: welcomeFooterRect?.bottom ?? null,
        welcomeFooterTop: welcomeFooterRect?.top ?? null,
        welcomeHeaderBottom: welcomeHeader.getBoundingClientRect().bottom,
      };
    },
    {
      selectors: emptyMobileComposerSelectors,
      requireWelcomeFooter: options.requireWelcomeFooter !== false,
    },
  );
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
  expect(layout.chatViewZIndex).toBe('auto');
  expect(layout.footerAnchoredToChatPane).toBe(true);

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
