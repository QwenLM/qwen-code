/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FrameLocator, Locator, Page } from 'playwright-core';

import { BrowserRuntimeError } from '../core/errors.js';
import type { DispatchResult, LocatorStep } from '../core/primitives.js';
import type { SupportedCommand } from '../core/schemas.js';
import {
  clickOptions,
  jsonResult,
  matcher,
  selectOptions,
  stringArg,
  timeoutArg,
  withTimeout,
} from './runtime-helpers.js';
import type { Args, TabState } from './runtime-state.js';

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_READ_TIMEOUT_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export async function executeLocatorOperation(
  method: SupportedCommand,
  args: Args,
  tab: TabState,
): Promise<DispatchResult> {
  const locator = buildLocator(tab.page, args.steps as LocatorStep[]);
  const timeout = timeoutArg(args, defaultLocatorTimeout(method));
  const options = { timeout };
  switch (method) {
    case 'locator.count':
      return await locator.count();
    case 'locator.evaluate':
      return jsonResult(
        await evaluateLocator(
          locator,
          stringArg(args, 'script'),
          false,
          timeout,
        ),
      );
    case 'locator.evaluateAll':
      return jsonResult(
        await evaluateLocator(
          locator,
          stringArg(args, 'script'),
          true,
          timeout,
        ),
      );
    case 'locator.allTextContents':
      return await locator.allTextContents();
    case 'locator.innerText':
      return await locator.innerText(options);
    case 'locator.textContent':
      return await locator.textContent(options);
    case 'locator.getAttribute':
      return await locator.getAttribute(stringArg(args, 'name'), options);
    case 'locator.isEnabled':
      return await locator.isEnabled(options);
    case 'locator.isVisible':
      return await locator.isVisible(options);
    case 'locator.click':
      await locator.click(clickOptions(args, DEFAULT_ACTION_TIMEOUT_MS));
      return null;
    case 'locator.dblclick':
      await locator.dblclick(clickOptions(args, DEFAULT_ACTION_TIMEOUT_MS));
      return null;
    case 'locator.downloadMedia':
      await locator.evaluate(
        (element) => {
          element.scrollIntoView({ block: 'center', inline: 'nearest' });
          const media =
            element.closest('img, video, source, a[href]') ??
            element.querySelector('img, video, source, a[href]') ??
            element;
          const readString = (name: string): string | null => {
            const value = Reflect.get(media, name);
            return typeof value === 'string' ? value : null;
          };
          const url =
            readString('currentSrc') ??
            readString('src') ??
            readString('href') ??
            '';
          if (url === '')
            throw new Error(
              'Matched element does not expose a downloadable URL',
            );
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = url.split('/').pop()?.split('?')[0] || 'download';
          anchor.rel = 'noopener';
          anchor.style.display = 'none';
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
        },
        undefined,
        options,
      );
      return null;
    case 'locator.fill':
      await fillLocator(locator, stringArg(args, 'value'), options);
      return null;
    case 'locator.type':
      await typeIntoLocator(locator, stringArg(args, 'value'), options);
      return null;
    case 'locator.press':
      await locator.press(stringArg(args, 'value'), options);
      return null;
    case 'locator.selectOption':
      await locator.selectOption(selectOptions(args.value), options);
      return null;
    case 'locator.check':
      await locator.check({
        ...options,
        ...(args.force === true ? { force: true } : {}),
      });
      return null;
    case 'locator.uncheck':
      await locator.uncheck({
        ...options,
        ...(args.force === true ? { force: true } : {}),
      });
      return null;
    case 'locator.setChecked':
      await locator.setChecked(args.checked === true, {
        ...options,
        ...(args.force === true ? { force: true } : {}),
      });
      return null;
    case 'locator.waitFor':
      await locator.waitFor({
        state: args.state as 'attached' | 'detached' | 'visible' | 'hidden',
        timeout,
      });
      return null;
    default:
      throw new BrowserRuntimeError(
        'UNKNOWN_METHOD',
        `Unknown locator method: ${method}`,
      );
  }
}

function defaultLocatorTimeout(method: SupportedCommand): number {
  switch (method) {
    case 'locator.evaluate':
    case 'locator.evaluateAll':
    case 'locator.waitFor':
      return DEFAULT_WAIT_TIMEOUT_MS;
    case 'locator.count':
    case 'locator.allTextContents':
    case 'locator.innerText':
    case 'locator.textContent':
    case 'locator.getAttribute':
    case 'locator.isEnabled':
    case 'locator.isVisible':
      return DEFAULT_READ_TIMEOUT_MS;
    default:
      return DEFAULT_ACTION_TIMEOUT_MS;
  }
}

async function fillLocator(
  locator: Locator,
  value: string,
  options: { timeout: number },
): Promise<void> {
  await locator.fill(value, options);
  await locator.dispatchEvent('change', { bubbles: true }, options);
}

async function typeIntoLocator(
  locator: Locator,
  value: string,
  options: { timeout: number },
): Promise<void> {
  const before =
    value === '' ? undefined : await editableValue(locator, options);
  await locator.pressSequentially(value, options);
  if (value === '') return;
  const after = await editableValue(locator, options);
  if (after === before)
    throw new BrowserRuntimeError(
      'INPUT_BLOCKED',
      'Typing produced no observable change; inspect the target state before continuing',
    );
}

async function editableValue(
  locator: Locator,
  options: { timeout: number },
): Promise<string> {
  return await locator.evaluate(
    (element) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
        return element.value;
      if (element instanceof HTMLElement && element.isContentEditable)
        return element.textContent ?? '';
      throw new Error(
        'type requires an input, textarea, select, or contenteditable element',
      );
    },
    undefined,
    options,
  );
}

type LocatorScope = Page | Locator | FrameLocator;

function buildLocator(page: Page, steps: readonly LocatorStep[]): Locator {
  let scope: LocatorScope = page;
  let locator: Locator | undefined;
  for (const step of steps) {
    switch (step.kind) {
      case 'locator':
        locator = scope.locator(step.selector);
        scope = locator;
        break;
      case 'frame':
        scope = scope.locator(step.selector).contentFrame();
        locator = undefined;
        break;
      case 'getByRole':
        locator = scope.getByRole(step.role as never, {
          ...(step.name === undefined ? {} : { name: matcher(step.name) }),
          ...(step.exact === undefined ? {} : { exact: step.exact }),
        });
        scope = locator;
        break;
      case 'getByText':
        locator = scope.getByText(matcher(step.text), {
          ...(step.exact === undefined ? {} : { exact: step.exact }),
        });
        scope = locator;
        break;
      case 'getByLabel':
        locator = scope.getByLabel(matcher(step.text), {
          ...(step.exact === undefined ? {} : { exact: step.exact }),
        });
        scope = locator;
        break;
      case 'getByPlaceholder':
        locator = scope.getByPlaceholder(matcher(step.text), {
          ...(step.exact === undefined ? {} : { exact: step.exact }),
        });
        scope = locator;
        break;
      case 'getByTestId':
        locator = scope.getByTestId(step.testId);
        scope = locator;
        break;
      case 'filter':
        locator = requireLocator(locator).filter({
          ...(step.hasText === undefined
            ? {}
            : { hasText: matcher(step.hasText) }),
          ...(step.hasNotText === undefined
            ? {}
            : { hasNotText: matcher(step.hasNotText) }),
          ...(step.has === undefined
            ? {}
            : { has: buildLocator(page, step.has) }),
          ...(step.hasNot === undefined
            ? {}
            : { hasNot: buildLocator(page, step.hasNot) }),
          ...(step.visible === undefined ? {} : { visible: step.visible }),
        });
        scope = locator;
        break;
      case 'first':
        locator = requireLocator(locator).first();
        scope = locator;
        break;
      case 'last':
        locator = requireLocator(locator).last();
        scope = locator;
        break;
      case 'nth':
        locator = requireLocator(locator).nth(step.index);
        scope = locator;
        break;
      case 'and':
        locator = requireLocator(locator).and(buildLocator(page, step.steps));
        scope = locator;
        break;
      case 'or':
        locator = requireLocator(locator).or(buildLocator(page, step.steps));
        scope = locator;
        break;
      default:
        throw new BrowserRuntimeError(
          'INVALID_LOCATOR',
          'The locator plan contains an unsupported step',
        );
    }
  }
  return requireLocator(locator);
}

function requireLocator(locator: Locator | undefined): Locator {
  if (locator !== undefined) return locator;
  throw new BrowserRuntimeError(
    'INVALID_LOCATOR',
    'The locator plan must end with an element selector',
  );
}

export async function evaluateScript(
  page: Page,
  script: string,
  timeout: number,
): Promise<unknown> {
  return await withTimeout(
    page.evaluate(async (source) => {
      const AsyncFunction = Object.getPrototypeOf(async () => undefined)
        .constructor as new (body: string) => () => Promise<unknown>;
      return await new AsyncFunction(source)();
    }, script),
    timeout,
  );
}

async function evaluateLocator(
  locator: Locator,
  script: string,
  all: boolean,
  timeout: number,
): Promise<unknown> {
  if (all) {
    return await withTimeout(
      locator.evaluateAll(async (elements, source) => {
        const AsyncFunction = Object.getPrototypeOf(async () => undefined)
          .constructor as new (
          argument: string,
          body: string,
        ) => (elements: Element[]) => Promise<unknown>;
        return await new AsyncFunction('elements', source)(elements);
      }, script),
      timeout,
    );
  }
  return await locator.evaluate(
    async (element, source) => {
      const AsyncFunction = Object.getPrototypeOf(async () => undefined)
        .constructor as new (
        argument: string,
        body: string,
      ) => (element: Element) => Promise<unknown>;
      return await new AsyncFunction('element', source)(element);
    },
    script,
    { timeout },
  );
}
