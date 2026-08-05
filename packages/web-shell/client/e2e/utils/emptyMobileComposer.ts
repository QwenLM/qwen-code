/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, type Page } from '@playwright/test';

export interface EmptyMobileComposerLayout {
  chatPaneBottom: number;
  chatViewPosition: string;
  chatViewZIndex: string;
  composerTop: number;
  dotFieldCoversChatPane: boolean;
  dotFieldPointerEvents: string;
  footerBottom: number;
  footerPosition: string;
  welcomeFooterBottom: number;
  welcomeFooterTop: number;
  welcomeHeaderBottom: number;
}

export async function gotoEmptyMobileWelcomeHarness(page: Page): Promise<void> {
  await page.goto('/e2e/composer-layout-harness.html?emptyMobileWelcome=true');
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
}

export async function emptyMobileComposerLayout(
  page: Page,
): Promise<EmptyMobileComposerLayout> {
  return page.getByTestId('chat-pane-container').evaluate((chatPane) => {
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
    const dotField = chatPane.querySelector(
      '[data-web-shell-new-session-dot-field]',
    );
    if (!composer || !welcomeHeader || !welcomeFooter || !dotField) {
      throw new Error(
        'Expected the empty mobile welcome layout with a visible footer to be rendered.',
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
    const chatViewStyle = getComputedStyle(chatView);
    const dotFieldRect = dotField.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();

    return {
      chatPaneBottom: chatPaneRect.bottom,
      chatViewPosition: chatViewStyle.position,
      chatViewZIndex: chatViewStyle.zIndex,
      composerTop: composer.getBoundingClientRect().top,
      dotFieldCoversChatPane:
        Math.abs(dotFieldRect.top - chatPaneRect.top) <= 1 &&
        Math.abs(dotFieldRect.right - chatPaneRect.right) <= 1 &&
        Math.abs(dotFieldRect.bottom - chatPaneRect.bottom) <= 1 &&
        Math.abs(dotFieldRect.left - chatPaneRect.left) <= 1,
      dotFieldPointerEvents: getComputedStyle(dotField).pointerEvents,
      footerBottom: footerRect.bottom,
      footerPosition: getComputedStyle(footer).position,
      welcomeFooterBottom: welcomeFooter.getBoundingClientRect().bottom,
      welcomeFooterTop: welcomeFooter.getBoundingClientRect().top,
      welcomeHeaderBottom: welcomeHeader.getBoundingClientRect().bottom,
    };
  });
}
