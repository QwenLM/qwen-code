/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRuntimeError } from './errors.js';
import type {
  BrowserMouseButton,
  BrowserPrimitive,
  BrowserPrimitiveArgs,
} from './primitives.js';
import type { SupportedCommand } from './schemas.js';

export const primitiveLegacyCommands = {
  'browser.list': 'browsers.list',
  'browser.get': 'browsers.get',
  'session.setName': 'browser.nameSession',
  'tab.discover': 'browser.user.openTabs',
  'tab.claim': 'browser.user.claimTab',
  'history.list': 'browser.user.history',
  'tab.create': 'tabs.new',
  'tab.list': 'tabs.list',
  'tab.get': 'tabs.get',
  'tab.getSelected': 'tabs.selected',
  'tab.activate': 'tab.activate',
  'navigation.goto': 'tab.goto',
  'navigation.getUrl': 'tab.url',
  'navigation.getTitle': 'tab.title',
  'navigation.back': 'tab.back',
  'navigation.forward': 'tab.forward',
  'navigation.reload': 'tab.reload',
  'tab.close': 'tab.close',
  'capture.screenshot': 'tab.screenshot',
  'pointer.click': 'cua.click',
  'pointer.doubleClick': 'cua.double_click',
  'pointer.drag': 'cua.drag',
  'pointer.move': 'cua.move',
  'pointer.scroll': 'cua.scroll',
  'pointer.down': 'cua.mouse_down',
  'pointer.up': 'cua.mouse_up',
  'keyboard.press': 'cua.keypress',
  'keyboard.type': 'cua.type',
  'keyboard.down': 'cua.key_down',
  'keyboard.up': 'cua.key_up',
  'keyboard.hold': 'cua.hold_key',
  'snapshot.capture': 'playwright.domSnapshot',
  'snapshot.captureWithMetadata': 'playwright.domSnapshotWithMetadata',
  'snapshot.captureByRef': 'dom_cua.get_visible_dom',
  'element.clickByRef': 'dom_cua.click',
  'element.doubleClickByRef': 'dom_cua.double_click',
  'element.hoverByRef': 'dom_cua.hover',
  'element.typeByRef': 'dom_cua.type',
  'element.pressByRef': 'dom_cua.keypress',
  'element.scrollByRef': 'dom_cua.scroll',
  'element.screenshotByRef': 'dom_cua.screenshot',
  'dialog.get': 'tab.getJsDialog',
  'dialog.accept': 'tab.dialog.accept',
  'dialog.dismiss': 'tab.dialog.dismiss',
  'diagnostics.readConsole': 'dev.logs',
  'diagnostics.readNetwork': 'dev.network',
  'page.evaluate': 'playwright.evaluate',
  'event.wait': 'playwright.waitForEvent',
  'fileChooser.setFiles': 'fileChooser.setFiles',
  'download.readEvents': 'download.events',
  'download.getPath': 'download.path',
  'navigation.waitForUrl': 'playwright.waitForURL',
  'navigation.watch.begin': 'playwright.expectNavigation.begin',
  'navigation.watch.wait': 'playwright.expectNavigation.wait',
  'navigation.watch.cancel': 'playwright.expectNavigation.cancel',
  'navigation.waitForLoadState': 'playwright.waitForLoadState',
  'time.wait': 'playwright.waitForTimeout',
  'element.count': 'locator.count',
  'element.evaluate': 'locator.evaluate',
  'element.evaluateAll': 'locator.evaluateAll',
  'element.getAllText': 'locator.allTextContents',
  'element.getInnerText': 'locator.innerText',
  'element.getTextContent': 'locator.textContent',
  'element.getAttribute': 'locator.getAttribute',
  'element.isEnabled': 'locator.isEnabled',
  'element.isVisible': 'locator.isVisible',
  'element.isChecked': 'locator.isChecked',
  'element.getInputValue': 'locator.inputValue',
  'element.getBoundingBox': 'locator.boundingBox',
  'element.scrollIntoView': 'locator.scrollIntoViewIfNeeded',
  'element.click': 'locator.click',
  'element.doubleClick': 'locator.dblclick',
  'element.hover': 'locator.hover',
  'element.scroll': 'locator.scroll',
  'element.setFiles': 'locator.setInputFiles',
  'element.screenshot': 'locator.screenshot',
  'element.fill': 'locator.fill',
  'element.type': 'locator.type',
  'element.press': 'locator.press',
  'element.select': 'locator.selectOption',
  'element.check': 'locator.check',
  'element.uncheck': 'locator.uncheck',
  'element.setChecked': 'locator.setChecked',
  'element.waitFor': 'locator.waitFor',
} as const satisfies Record<BrowserPrimitive, SupportedCommand>;

export const browserPrimitiveNames = Object.freeze(
  Object.keys(primitiveLegacyCommands) as BrowserPrimitive[],
);

const legacyPrimitives = new Map<SupportedCommand, BrowserPrimitive>(
  browserPrimitiveNames.map((primitive) => [
    primitiveLegacyCommands[primitive],
    primitive,
  ]),
);

const observationPrimitives: ReadonlySet<BrowserPrimitive> = new Set([
  'browser.list',
  'browser.get',
  'tab.discover',
  'history.list',
  'tab.list',
  'tab.get',
  'tab.getSelected',
  'navigation.getUrl',
  'navigation.getTitle',
  'snapshot.capture',
  'snapshot.captureWithMetadata',
  'snapshot.captureByRef',
  'dialog.get',
  'diagnostics.readConsole',
  'diagnostics.readNetwork',
  'event.wait',
  'download.readEvents',
  'download.getPath',
  'navigation.waitForUrl',
  'navigation.watch.begin',
  'navigation.watch.wait',
  'navigation.watch.cancel',
  'navigation.waitForLoadState',
  'time.wait',
  'element.count',
  'element.getAllText',
  'element.getInnerText',
  'element.getTextContent',
  'element.getAttribute',
  'element.isEnabled',
  'element.isVisible',
  'element.isChecked',
  'element.getInputValue',
  'element.getBoundingBox',
  'element.waitFor',
]);

const afterCodeMutationPrimitives: ReadonlySet<BrowserPrimitive> = new Set([
  'navigation.goto',
  'navigation.back',
  'navigation.forward',
  'navigation.reload',
  'tab.close',
  'dialog.accept',
  'dialog.dismiss',
  'pointer.click',
  'pointer.doubleClick',
  'pointer.drag',
  'pointer.move',
  'pointer.scroll',
  'keyboard.press',
  'keyboard.type',
  'element.clickByRef',
  'element.doubleClickByRef',
  'element.hoverByRef',
  'element.typeByRef',
  'element.pressByRef',
  'element.scrollByRef',
  'element.click',
  'element.doubleClick',
  'element.hover',
  'element.scroll',
  'element.scrollIntoView',
  'element.setFiles',
  'fileChooser.setFiles',
  'element.fill',
  'element.type',
  'element.press',
  'element.select',
  'element.check',
  'element.uncheck',
  'element.setChecked',
]);

const auditedResultPrimitives: ReadonlySet<BrowserPrimitive> = new Set([
  'navigation.getUrl',
  'navigation.getTitle',
  'element.count',
  'element.getAllText',
  'element.getInnerText',
  'element.getTextContent',
  'element.getAttribute',
  'element.isEnabled',
  'element.isVisible',
]);

const backendLegacyCommands: Partial<
  Record<SupportedCommand, SupportedCommand>
> = {
  'dom_cua.get_visible_dom': 'playwright.domSnapshot',
  'dom_cua.click': 'locator.click',
  'dom_cua.double_click': 'locator.dblclick',
  'dom_cua.hover': 'locator.hover',
  'dom_cua.type': 'locator.type',
  'dom_cua.keypress': 'locator.press',
  'dom_cua.scroll': 'locator.scroll',
  'dom_cua.screenshot': 'locator.screenshot',
};

export function primitiveForLegacyCommand(
  method: SupportedCommand,
): BrowserPrimitive | undefined {
  return legacyPrimitives.get(method);
}

export function isLegacyObservationCommand(method: SupportedCommand): boolean {
  const primitive = primitiveForLegacyCommand(method);
  return primitive !== undefined && observationPrimitives.has(primitive);
}

export function isAfterCodeMutationCommand(method: string): boolean {
  const primitive = legacyPrimitives.get(method as SupportedCommand);
  return primitive !== undefined && afterCodeMutationPrimitives.has(primitive);
}

export function hasAuditedResult(method: string): boolean {
  const primitive = legacyPrimitives.get(method as SupportedCommand);
  return primitive !== undefined && auditedResultPrimitives.has(primitive);
}

export function backendLegacyCommandFor(
  method: string,
): SupportedCommand | undefined {
  return backendLegacyCommands[method as SupportedCommand];
}

export interface CompatibilityInvocation {
  method: SupportedCommand;
  args: Record<string, unknown>;
}

export function compatibilityInvocation<P extends BrowserPrimitive>(
  primitive: P,
  input: BrowserPrimitiveArgs<P>,
): CompatibilityInvocation {
  const method = primitiveLegacyCommands[primitive];
  if (method === undefined)
    throw new BrowserRuntimeError(
      'UNKNOWN_METHOD',
      `Unknown browser primitive: ${primitive}`,
    );
  const args = { ...input } as Record<string, unknown>;
  const modifiers = args.modifiers;

  switch (primitive) {
    case 'pointer.click':
    case 'pointer.doubleClick':
      delete args.modifiers;
      args.keypress = modifiers;
      if (primitive === 'pointer.click' && args.button !== undefined)
        args.button = legacyMouseButton(args.button);
      break;
    case 'pointer.drag':
    case 'pointer.move':
      delete args.modifiers;
      args.keys = modifiers;
      break;
    case 'pointer.scroll':
      delete args.modifiers;
      args.scrollX = args.deltaX;
      args.scrollY = args.deltaY;
      delete args.deltaX;
      delete args.deltaY;
      args.keypress = modifiers;
      break;
    case 'snapshot.captureByRef':
      args.root = args.rootRef;
      delete args.rootRef;
      break;
    case 'element.clickByRef':
    case 'element.doubleClickByRef':
    case 'element.hoverByRef':
    case 'element.typeByRef':
    case 'element.pressByRef':
    case 'element.scrollByRef':
    case 'element.screenshotByRef':
      args.nodeId = args.ref;
      delete args.ref;
      if (primitive === 'element.scrollByRef') {
        args.scrollX = args.deltaX;
        args.scrollY = args.deltaY;
        delete args.deltaX;
        delete args.deltaY;
      }
      break;
    case 'element.scroll':
      args.scrollX = args.deltaX;
      args.scrollY = args.deltaY;
      delete args.deltaX;
      delete args.deltaY;
      break;
    default:
      break;
  }
  return { method, args };
}

function legacyMouseButton(value: unknown): 1 | 2 | 3 | 4 | 5 {
  return (
    (
      { left: 1, middle: 2, right: 3, back: 4, forward: 5 } as Partial<
        Record<BrowserMouseButton, 1 | 2 | 3 | 4 | 5>
      >
    )[value as BrowserMouseButton] ??
    (() => {
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        'Unsupported mouse button',
      );
    })()
  );
}
