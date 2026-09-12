/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FrameLocator, Locator, Page } from 'playwright-core';

import { BrowserRuntimeError } from '../core/errors.js';
import type { DispatchResult, LocatorStep } from '../core/primitives.js';
import type { SupportedCommand } from '../core/schemas.js';
import { serializeJson } from '../core/serialize-json.js';
import {
  chordTokens,
  clickOptions,
  jsonResult,
  matcher,
  releaseChordKeys,
  selectOptions,
  stringArg,
  timeoutArg,
  withTimeout,
} from './runtime-helpers.js';
import type { Args, TabState } from './runtime-state.js';

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_READ_TIMEOUT_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const TYPE_CHAR_BUDGET_MS = 2;
const MAX_TYPE_TIMEOUT_MS = 120_000;

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
    case 'locator.allTextContents': {
      // Playwright's allTextContents takes no options and never waits, so
      // honor the caller's budget with an attach wait on the first match; a
      // locator that never attaches still resolves [].
      await locator
        .first()
        .waitFor({ state: 'attached', timeout })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === 'TimeoutError') return;
          throw error;
        });
      return await locator.allTextContents();
    }
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
      await locator.click({
        ...clickOptions(args, DEFAULT_ACTION_TIMEOUT_MS),
        noWaitAfter: true,
      });
      return null;
    case 'locator.dblclick':
      await locator.dblclick(clickOptions(args, DEFAULT_ACTION_TIMEOUT_MS));
      return null;
    case 'locator.downloadMedia':
      // locator.evaluate's own timeout bounds only element resolution, so
      // race the whole page-side transfer against the caller's deadline and
      // ship the deadline into the page to stop the fetch as well.
      await withTimeout(
        locator.evaluate(
          async (element, budgetMs) => {
            element.scrollIntoView({ block: 'center', inline: 'nearest' });
            // A located wrapper (picture/figure) must resolve to the media it
            // contains: document order puts a wrapping anchor before its
            // image, so try media elements before anchors and keep the first
            // candidate that actually exposes a URL.
            const candidates = [
              element,
              ...element.querySelectorAll('img, video, source'),
              ...element.querySelectorAll('a[href]'),
              element.closest('img, video, source, a[href]'),
            ].filter((node): node is Element => node !== null);
            const readString = (node: Element, name: string): string | null => {
              const value = Reflect.get(node, name);
              // An unloaded element exposes '' for these IDL properties, and
              // '' must fall through to the next source.
              return typeof value === 'string' && value !== '' ? value : null;
            };
            const readSrcset = (node: Element): string | null => {
              const srcset = readString(node, 'srcset');
              // 'hero.webp 1x, hero@2x.webp 2x' — the first candidate URL.
              const first = srcset?.split(',')[0]?.trim().split(/\s+/)[0];
              return first ? first : null;
            };
            let url: string | null = null;
            for (const candidate of candidates) {
              url =
                readString(candidate, 'currentSrc') ??
                readString(candidate, 'src') ??
                readString(candidate, 'href') ??
                readSrcset(candidate);
              if (url !== null) break;
            }
            if (url === null)
              throw new Error(
                'Matched element does not expose a downloadable URL',
              );
            if (!/^(?:https?|blob|data):/.test(url))
              throw new Error(
                `Unsupported media URL scheme: ${url.slice(0, 200)}`,
              );
            // The download attribute is honored only for same-origin URLs, so
            // clicking a cross-origin anchor would navigate the claimed tab
            // away instead; fetch the resource and download a same-origin
            // object URL, failing loudly when the fetch yields no body.
            let response: Response;
            try {
              response = await fetch(url, {
                signal: AbortSignal.timeout(budgetMs),
              });
            } catch (error) {
              // A CORS rejection surfaces as an opaque TypeError; name the
              // actual cause so the model stops retrying the same read.
              if (error instanceof TypeError)
                throw new Error(
                  `Media download requires reading the resource, but the page origin cannot read it (cross-origin without CORS): ${url.slice(0, 200)}`,
                );
              throw error;
            }
            if (!response.ok)
              throw new Error(`Media download failed: HTTP ${response.status}`);
            const objectUrl = URL.createObjectURL(await response.blob());
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = url.split('/').pop()?.split('?')[0] || 'download';
            anchor.rel = 'noopener';
            anchor.style.display = 'none';
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
          },
          timeout,
          options,
        ),
        timeout,
      );
      return null;
    case 'locator.fill':
      await locator.fill(stringArg(args, 'value'), options);
      return null;
    case 'locator.type': {
      const value = stringArg(args, 'value');
      // pressSequentially pays a CDP round trip per character, so the 5s
      // action default cannot deliver a long value; grow the deadline with
      // the input length, capped at the schema's 120s ceiling. An explicit
      // timeoutMs is honored as given.
      const scaled =
        args.timeoutMs === undefined
          ? Math.min(
              Math.max(options.timeout, value.length * TYPE_CHAR_BUDGET_MS),
              MAX_TYPE_TIMEOUT_MS,
            )
          : options.timeout;
      await typeIntoLocator(locator, value, { timeout: scaled });
      return null;
    }
    case 'locator.press': {
      const value = stringArg(args, 'value');
      try {
        await locator.press(value, {
          ...options,
          noWaitAfter: true,
        });
      } catch (error) {
        // An invalid later chord token leaves the earlier tokens held.
        await releaseChordKeys(tab.page, chordTokens(value));
        throw error;
      }
      return null;
    }
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

async function typeIntoLocator(
  locator: Locator,
  value: string,
  options: { timeout: number },
): Promise<void> {
  const unchanged =
    value === ''
      ? undefined
      : await locator.evaluateHandle(
          (element) => {
            const hasValue =
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement ||
              element instanceof HTMLSelectElement;
            const before = hasValue
              ? element.value
              : element instanceof HTMLElement && element.isContentEditable
                ? (element.textContent ?? '')
                : undefined;
            return () =>
              before !== undefined &&
              element.isConnected &&
              element.matches(':focus-within') &&
              (hasValue ? element.value : (element.textContent ?? '')) ===
                before;
          },
          undefined,
          options,
        );
  try {
    await locator.pressSequentially(value, options);
    if (
      unchanged !== undefined &&
      (await withTimeout(
        unchanged.evaluate((check) => check()),
        options.timeout,
      ).catch(() => false))
    )
      throw new BrowserRuntimeError(
        'INPUT_BLOCKED',
        'Typing produced no observable change; inspect the target state before continuing',
      );
  } finally {
    await unchanged?.dispose().catch(() => undefined);
  }
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
  return JSON.parse(
    await withTimeout(
      page.evaluate(async (source) => {
        const AsyncFunction = Object.getPrototypeOf(async () => undefined)
          .constructor as new (body: string) => () => Promise<string>;
        return await new AsyncFunction(source)();
      }, jsonEvaluationScript(script)),
      timeout,
    ),
  );
}

function jsonEvaluationScript(script: string): string {
  return `return (${serializeJson.toString()})((await (async () => {\n${script}\n})()) ?? null);`;
}

async function evaluateLocator(
  locator: Locator,
  script: string,
  all: boolean,
  timeout: number,
): Promise<unknown> {
  if (all) {
    return JSON.parse(
      await withTimeout(
        locator.evaluateAll(async (elements, source) => {
          const AsyncFunction = Object.getPrototypeOf(async () => undefined)
            .constructor as new (
            argument: string,
            body: string,
          ) => (elements: Element[]) => Promise<string>;
          return await new AsyncFunction('elements', source)(elements);
        }, jsonEvaluationScript(script)),
        timeout,
      ),
    );
  }
  return JSON.parse(
    await withTimeout(
      locator.evaluate(
        async (element, source) => {
          const AsyncFunction = Object.getPrototypeOf(async () => undefined)
            .constructor as new (
            argument: string,
            body: string,
          ) => (element: Element) => Promise<string>;
          return await new AsyncFunction('element', source)(element);
        },
        jsonEvaluationScript(script),
        { timeout },
      ),
      timeout,
    ),
  );
}
