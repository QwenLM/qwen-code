/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, type Page } from '@playwright/test';

export interface EmptyMobileComposerLayout {
  chatPaneBottom: number;
  chatPaneTop: number;
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
  footerDisplay: string;
  footerPosition: string;
  footerTop: number;
  messageListClientHeight: number;
  messageListScrollHeight: number;
  messageListTop: number;
  welcomeFooterBottom: number | null;
  welcomeFooterTop: number | null;
  welcomeGroupClientHeight: number | null;
  welcomeGroupOverflowY: string | null;
  welcomeGroupScrollHeight: number | null;
  welcomeGroupScrollTop: number | null;
  welcomeGroupTop: number | null;
  welcomeHeaderBottom: number;
  welcomeHeaderTop: number;
}

export interface EmptyChatViewState {
  ariaHidden: string | null;
  className: string;
  display: string;
}

export interface EmptyMobileComposerLayoutOptions {
  expectCenteredWelcome?: boolean;
  requireWelcomeFooter?: boolean;
}

export interface EmptyMobileWelcomeHarnessOptions {
  customFooter?: boolean;
  tallWelcome?: boolean;
  welcomeFooter?: boolean;
}

export async function gotoEmptyMobileWelcomeHarness(
  page: Page,
  options: EmptyMobileWelcomeHarnessOptions = {},
): Promise<void> {
  const params = new URLSearchParams({ emptyMobileWelcome: 'true' });
  if (options.welcomeFooter === false) params.set('welcomeFooter', 'false');
  if (options.customFooter === true) params.set('customFooter', 'true');
  if (options.tallWelcome === true) params.set('tallWelcome', 'true');
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
      const messageList = chatPane.querySelector<HTMLElement>(
        '[data-web-shell-message-list]',
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
      if (!composer) throw new Error('Expected the composer surface.');
      if (!messageList) throw new Error('Expected the message list.');
      if (!welcomeHeader) throw new Error('Expected the welcome header.');
      if (!dotField) throw new Error('Expected the new-session dot field.');
      if (requireWelcomeFooter && !welcomeFooter) {
        throw new Error('Expected a visible welcome footer.');
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
      const footerStyle = getComputedStyle(footer);
      const messageListRect = messageList.getBoundingClientRect();
      const welcomeFooterRect = welcomeFooter?.getBoundingClientRect();
      let welcomeGroup: HTMLElement | null = null;
      for (
        let ancestor = welcomeFooter?.parentElement;
        ancestor && ancestor !== chatView;
        ancestor = ancestor.parentElement
      ) {
        if (ancestor.contains(welcomeHeader)) {
          welcomeGroup = ancestor;
          break;
        }
      }
      const welcomeGroupRect = welcomeGroup?.getBoundingClientRect();

      return {
        chatPaneBottom: chatPaneRect.bottom,
        chatPaneTop: chatPaneRect.top,
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
        footerDisplay: footerStyle.display,
        footerPosition: footerStyle.position,
        footerTop: footerRect.top,
        messageListClientHeight: messageList.clientHeight,
        messageListScrollHeight: messageList.scrollHeight,
        messageListTop: messageListRect.top,
        welcomeFooterBottom: welcomeFooterRect?.bottom ?? null,
        welcomeFooterTop: welcomeFooterRect?.top ?? null,
        welcomeGroupClientHeight: welcomeGroup?.clientHeight ?? null,
        welcomeGroupOverflowY: welcomeGroup
          ? getComputedStyle(welcomeGroup).overflowY
          : null,
        welcomeGroupScrollHeight: welcomeGroup?.scrollHeight ?? null,
        welcomeGroupScrollTop: welcomeGroup?.scrollTop ?? null,
        welcomeGroupTop: welcomeGroupRect?.top ?? null,
        welcomeHeaderBottom: welcomeHeader.getBoundingClientRect().bottom,
        welcomeHeaderTop: welcomeHeader.getBoundingClientRect().top,
      };
    }, options.requireWelcomeFooter !== false);
}

export async function emptyChatViewState(
  page: Page,
): Promise<EmptyChatViewState> {
  return page.getByTestId('chat-pane-container').evaluate((chatPane) => {
    const composer = chatPane.querySelector(
      '[data-web-shell-composer-surface]',
    );
    if (!composer) throw new Error('Expected the composer surface.');
    const chatView = Array.from(chatPane.children).find((child) =>
      child.contains(composer),
    );
    if (!chatView) throw new Error('Expected the composer chat view.');
    return {
      ariaHidden: chatView.getAttribute('aria-hidden'),
      className: chatView.className,
      display: getComputedStyle(chatView).display,
    };
  });
}

export async function scrollEmptyMobileWelcomeGroup(
  page: Page,
  scrollTop: number,
): Promise<void> {
  await page
    .locator('[data-e2e-mobile-welcome-footer]:visible')
    .evaluate((welcomeFooter, nextScrollTop) => {
      const welcomeHeader = document.querySelector(
        '[data-e2e-mobile-welcome-header]',
      );
      if (!welcomeHeader) throw new Error('Expected the welcome header.');

      let welcomeGroup: HTMLElement | null = null;
      for (
        let ancestor = welcomeFooter.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        if (ancestor.contains(welcomeHeader)) {
          welcomeGroup = ancestor;
          break;
        }
      }
      if (!welcomeGroup) throw new Error('Expected the mobile welcome group.');
      welcomeGroup.scrollTop = nextScrollTop;
    }, scrollTop);
}

export function expectEmptyMobileComposerAnchored(
  layout: EmptyMobileComposerLayout,
  options: EmptyMobileComposerLayoutOptions = {},
): void {
  expect(layout.footerPosition).toBe('relative');
  expect(layout.footerDisplay).not.toBe('contents');
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
    expect(layout.welcomeFooterBottom).toBeLessThanOrEqual(layout.footerTop);
  } else if (options.expectCenteredWelcome !== false) {
    const welcomeHeaderMiddle =
      (layout.welcomeHeaderTop + layout.welcomeHeaderBottom) / 2;
    const welcomeRowMiddle = (layout.chatPaneTop + layout.footerTop) / 2;
    expect(
      Math.abs(welcomeHeaderMiddle - welcomeRowMiddle),
    ).toBeLessThanOrEqual(3);
  }
}
