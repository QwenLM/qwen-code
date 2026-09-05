/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { platform } from 'node:os';

import { BrowserRuntimeError } from '../core/errors.js';
import type { DispatchResult } from '../core/primitives.js';
import type { SupportedCommand } from '../core/schemas.js';
import {
  clickOptions,
  keyChord,
  mouseButton,
  modifiers,
  numberArg,
  stringArg,
  withModifiers,
} from './runtime-helpers.js';
import type { Args, TabState } from './runtime-state.js';
import { snapshotRefLocator, snapshotTab } from './snapshot.js';

export async function executeDomCuaOperation(
  method: SupportedCommand,
  args: Args,
  tab: TabState,
): Promise<DispatchResult> {
  if (method === 'dom_cua.get_visible_dom')
    return await snapshotTab(tab, { interactiveOnly: true });
  switch (method) {
    case 'dom_cua.click': {
      const locator = await domCuaLocator(tab, args);
      await locator.click({ ...clickOptions(args), noWaitAfter: true });
      return null;
    }
    case 'dom_cua.double_click': {
      const locator = await domCuaLocator(tab, args);
      await locator.dblclick(clickOptions(args));
      return null;
    }
    case 'dom_cua.type':
      await tab.page.keyboard.insertText(stringArg(args, 'text'));
      return null;
    case 'dom_cua.keypress':
      await tab.page.keyboard.press(keyChord(args.keys));
      return null;
    case 'dom_cua.scroll': {
      if (typeof args.node_id === 'string') {
        const locator = await domCuaLocator(tab, args);
        await locator.hover();
      }
      await tab.page.mouse.wheel(numberArg(args, 'x'), numberArg(args, 'y'));
      return null;
    }
    default:
      throw new BrowserRuntimeError(
        'UNKNOWN_METHOD',
        `Unknown DOM CUA method: ${method}`,
      );
  }
}

export async function executeCuaOperation(
  method: SupportedCommand,
  args: Args,
  tab: TabState,
): Promise<null> {
  const page = tab.page;
  switch (method) {
    case 'cua.click': {
      const button = args.button === undefined ? 1 : numberArg(args, 'button');
      if (button <= 3) {
        await withModifiers(page, args.keypress, async () => {
          await page.mouse.click(numberArg(args, 'x'), numberArg(args, 'y'), {
            button: mouseButton(button),
          });
        });
      } else {
        await dispatchAuxiliaryClick(page, args, button);
      }
      return null;
    }
    case 'cua.double_click':
      await withModifiers(page, args.keypress, async () => {
        await page.mouse.dblclick(numberArg(args, 'x'), numberArg(args, 'y'));
      });
      return null;
    case 'cua.drag': {
      const path = args.path as Array<{ x: number; y: number }>;
      await withModifiers(page, args.keys, async () => {
        await page.mouse.move(path[0]?.x ?? 0, path[0]?.y ?? 0);
        await page.mouse.down();
        for (const point of path.slice(1))
          await page.mouse.move(point.x, point.y);
        await page.mouse.up();
      });
      return null;
    }
    case 'cua.keypress':
      await page.keyboard.press(keyChord(args.keys));
      return null;
    case 'cua.move':
      await withModifiers(page, args.keys, async () => {
        await page.mouse.move(numberArg(args, 'x'), numberArg(args, 'y'));
      });
      return null;
    case 'cua.scroll':
      await withModifiers(page, args.keypress, async () => {
        await page.mouse.move(numberArg(args, 'x'), numberArg(args, 'y'));
        await page.mouse.wheel(
          numberArg(args, 'scrollX'),
          numberArg(args, 'scrollY'),
        );
      });
      return null;
    case 'cua.type':
      await page.keyboard.insertText(stringArg(args, 'text'));
      return null;
    default:
      throw new BrowserRuntimeError(
        'UNKNOWN_METHOD',
        `Unknown CUA method: ${method}`,
      );
  }
}

async function domCuaLocator(tab: TabState, args: Args) {
  return await snapshotRefLocator(tab.page, stringArg(args, 'node_id'));
}

async function dispatchAuxiliaryClick(
  page: TabState['page'],
  args: Args,
  buttonNumber: number,
): Promise<void> {
  const button = buttonNumber === 4 ? 'back' : 'forward';
  const buttons = buttonNumber === 4 ? 8 : 16;
  const x = numberArg(args, 'x');
  const y = numberArg(args, 'y');
  const held = modifiers(args.keypress);
  const modifierMask = held.reduce((mask, key) => {
    switch (key) {
      case 'Alt':
        return mask | 1;
      case 'Control':
        return mask | 2;
      case 'Meta':
        return mask | 4;
      case 'ControlOrMeta':
        return mask | (platform() === 'darwin' ? 4 : 2);
      case 'Shift':
        return mask | 8;
      default:
        return mask;
    }
  }, 0);
  const session = await page.context().newCDPSession(page);
  try {
    for (const key of held) await page.keyboard.down(key);
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons,
      clickCount: 1,
      modifiers: modifierMask,
    });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1,
      modifiers: modifierMask,
    });
  } finally {
    for (const key of [...held].reverse())
      await page.keyboard.up(key).catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}
