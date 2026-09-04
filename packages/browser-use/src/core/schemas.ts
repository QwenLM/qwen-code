/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

import { SNAPSHOT_REF_PATTERN, type LocatorStep } from './primitives.js';
import {
  MAX_SCREENSHOT_EDGE,
  MAX_SCREENSHOT_PIXELS,
} from './screenshot-budget.js';

const id = z.string().min(1).max(200);
const timeoutMs = z.number().int().nonnegative().max(120_000);
const waitUntil = z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']);
const loadState = z.enum(['domcontentloaded', 'load', 'networkidle']);
const matcher = z.union([
  z.string().max(20_000),
  z
    .object({
      regex: z.string().max(20_000),
      flags: z
        .string()
        .regex(/^[dgimsuvy]*$/)
        .optional(),
    })
    .strict(),
]);

const locatorStepSchema: z.ZodType<LocatorStep> = z.lazy(() =>
  z.union([
    z
      .object({
        kind: z.literal('locator'),
        selector: z.string().min(1).max(20_000),
      })
      .strict(),
    z
      .object({
        kind: z.literal('frame'),
        selector: z.string().min(1).max(20_000),
      })
      .strict(),
    z
      .object({
        kind: z.literal('getByRole'),
        role: z.string().min(1).max(100),
        name: matcher.optional(),
        exact: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('getByText'),
        text: matcher,
        exact: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('getByLabel'),
        text: matcher,
        exact: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('getByPlaceholder'),
        text: matcher,
        exact: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('getByTestId'),
        testId: z.string().max(20_000),
      })
      .strict(),
    z
      .object({
        kind: z.literal('filter'),
        hasText: matcher.optional(),
        hasNotText: matcher.optional(),
        has: z.array(locatorStepSchema).min(1).max(32).optional(),
        hasNot: z.array(locatorStepSchema).min(1).max(32).optional(),
        visible: z.boolean().optional(),
      })
      .strict(),
    z.object({ kind: z.literal('first') }).strict(),
    z.object({ kind: z.literal('last') }).strict(),
    z
      .object({
        kind: z.literal('nth'),
        index: z.number().int().min(-10_000).max(10_000),
      })
      .strict(),
    z
      .object({
        kind: z.literal('and'),
        steps: z.array(locatorStepSchema).min(1).max(32),
      })
      .strict(),
    z
      .object({
        kind: z.literal('or'),
        steps: z.array(locatorStepSchema).min(1).max(32),
      })
      .strict(),
  ]),
);

export const locatorStepsSchema = z.array(locatorStepSchema).min(1).max(32);

const browserArgs = z.object({ browserId: id }).strict();
const userTabInfo = z
  .object({
    id,
    title: z.string().max(20_000).nullable().optional(),
    url: z.string().max(20_000).nullable().optional(),
    lastOpened: z.string().max(200).optional(),
    tabGroup: z.string().max(1_000).optional(),
  })
  .strict();
const historyQuery = z
  .string()
  .max(1_000)
  .refine(
    (value) => value.trim() !== '',
    'History query terms must not be empty',
  );
const historyTimestamp = z
  .union([z.string().max(200), z.date()])
  .refine((value) => {
    const timestamp =
      value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(timestamp);
  }, 'History timestamps must be valid dates');
const historyOptions = z
  .object({
    limit: z.number().int().positive().max(500).optional(),
    queries: z.array(historyQuery).min(1).max(20).optional(),
    from: historyTimestamp.optional(),
    to: historyTimestamp.optional(),
  })
  .strict();
const tabArgs = z.object({ tabId: id }).strict();
const locatorFields = {
  tabId: id,
  steps: locatorStepsSchema,
} as const;
const locatorArgs = z.object(locatorFields).strict();
const locatorTimeoutArgs = z
  .object({ ...locatorFields, timeoutMs: timeoutMs.optional() })
  .strict();

const navigationOptions = {
  waitUntil: waitUntil.optional(),
  timeoutMs: timeoutMs.optional(),
};

const locatorActionOptions = {
  timeoutMs: timeoutMs.optional(),
};

const screenshotClip = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive().max(MAX_SCREENSHOT_EDGE),
    height: z.number().finite().positive().max(MAX_SCREENSHOT_EDGE),
  })
  .strict()
  .refine((value) => value.width * value.height <= MAX_SCREENSHOT_PIXELS, {
    message: `Screenshot clip must not exceed ${MAX_SCREENSHOT_PIXELS} pixels`,
  });

const selectOptionDescriptor = z
  .object({
    index: z.number().int().nonnegative().max(100_000).optional(),
    label: z.string().max(20_000).optional(),
    value: z.string().max(20_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.index !== undefined ||
      value.label !== undefined ||
      value.value !== undefined,
    {
      message: 'A select option descriptor must include index, label, or value',
    },
  );
const selectOption = z.union([z.string().max(20_000), selectOptionDescriptor]);
const mouseButtonName = z.enum(['left', 'middle', 'right']);
const modifierNames = z
  .array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift']))
  .max(4);
const scrollDelta = z.number().finite().min(-100_000).max(100_000);
const coordinate = z.number().finite().nonnegative().max(100_000);
const coordinatePoint = z.object({ x: coordinate, y: coordinate }).strict();
const keyNames = z.array(z.string().min(1).max(100)).min(1).max(32);
const optionalKeyNames = z.array(z.string().min(1).max(100)).max(8).optional();
const domNodeId = z.string().regex(SNAPSHOT_REF_PATTERN);
const evaluateScript = z.string().min(1).max(512_000);
const pageEvaluateArgs = z
  .object({
    tabId: id,
    script: evaluateScript,
    timeoutMs: timeoutMs.optional(),
  })
  .strict();
const locatorEvaluateArgs = z
  .object({
    ...locatorFields,
    script: evaluateScript,
    timeoutMs: timeoutMs.optional(),
  })
  .strict();

export const commandSchemas = {
  'browsers.list': z.object({}).strict(),
  'browsers.get': z.object({ id }).strict(),
  'browser.documentation': browserArgs,
  'browser.nameSession': z
    .object({ browserId: id, name: z.string().min(1).max(200) })
    .strict(),
  'browser.user.openTabs': browserArgs,
  'browser.user.claimTab': z
    .object({ browserId: id, tab: z.union([id, userTabInfo]) })
    .strict(),
  'browser.user.history': z
    .object({ browserId: id, options: historyOptions.optional() })
    .strict(),

  'tabs.new': browserArgs,
  'tabs.list': browserArgs,
  'tabs.get': z.object({ browserId: id, tabId: id }).strict(),
  'tabs.selected': browserArgs,

  'tab.goto': z
    .object({
      tabId: id,
      url: z.string().min(1).max(20_000),
    })
    .strict(),
  'tab.url': tabArgs,
  'tab.title': tabArgs,
  'tab.back': tabArgs,
  'tab.forward': tabArgs,
  'tab.reload': tabArgs,
  'tab.close': tabArgs,
  'tab.screenshot': z
    .object({
      tabId: id,
      clip: screenshotClip.optional(),
      fullPage: z.boolean().optional(),
    })
    .strict()
    .refine((value) => value.clip === undefined || value.fullPage !== true, {
      message: 'Screenshot clip and fullPage cannot be used together',
    }),

  'cua.click': z
    .object({
      tabId: id,
      x: coordinate,
      y: coordinate,
      button: z.number().int().min(1).max(5).optional(),
      keypress: optionalKeyNames,
    })
    .strict(),
  'cua.double_click': z
    .object({
      tabId: id,
      x: coordinate,
      y: coordinate,
      keypress: optionalKeyNames,
    })
    .strict(),
  'cua.drag': z
    .object({
      tabId: id,
      path: z.array(coordinatePoint).min(2).max(512),
      keys: optionalKeyNames,
    })
    .strict(),
  'cua.keypress': z.object({ tabId: id, keys: keyNames }).strict(),
  'cua.move': z
    .object({ tabId: id, x: coordinate, y: coordinate, keys: optionalKeyNames })
    .strict(),
  'cua.scroll': z
    .object({
      tabId: id,
      x: coordinate,
      y: coordinate,
      scrollX: scrollDelta,
      scrollY: scrollDelta,
      keypress: optionalKeyNames,
    })
    .strict(),
  'cua.type': z.object({ tabId: id, text: z.string().max(1_000_000) }).strict(),
  'dom_cua.get_visible_dom': tabArgs,
  'dom_cua.click': z
    .object({
      tabId: id,
      node_id: domNodeId,
    })
    .strict(),
  'dom_cua.double_click': z
    .object({
      tabId: id,
      node_id: domNodeId,
    })
    .strict(),
  'dom_cua.type': z
    .object({
      tabId: id,
      text: z.string().max(1_000_000),
    })
    .strict(),
  'dom_cua.keypress': z
    .object({
      tabId: id,
      keys: keyNames,
    })
    .strict(),
  'dom_cua.scroll': z
    .object({
      tabId: id,
      node_id: domNodeId.optional(),
      x: scrollDelta,
      y: scrollDelta,
    })
    .strict(),

  'tab.getJsDialog': tabArgs,
  'tab.dialog.accept': z
    .object({ tabId: id, promptText: z.string().max(20_000).optional() })
    .strict(),
  'tab.dialog.dismiss': tabArgs,
  'dev.logs': z
    .object({
      tabId: id,
      filter: z.string().max(1_000).optional(),
      levels: z
        .array(z.enum(['debug', 'info', 'log', 'warn', 'warning', 'error']))
        .max(6)
        .optional(),
      limit: z.number().int().min(1).max(1_000).optional(),
    })
    .strict(),
  'playwright.domSnapshot': tabArgs,
  'playwright.evaluate': pageEvaluateArgs,
  'playwright.waitForEvent': z
    .object({
      tabId: id,
      event: z.enum(['download', 'filechooser']),
      timeoutMs: timeoutMs.optional(),
    })
    .strict(),
  'fileChooser.setFiles': z
    .object({
      tabId: id,
      chooserId: id,
      files: z.array(z.string().min(1).max(4_096)).min(1).max(50),
      timeoutMs: timeoutMs.optional(),
    })
    .strict(),
  'playwright.waitForURL': z
    .object({
      tabId: id,
      url: z.string().min(1).max(20_000),
      ...navigationOptions,
    })
    .strict(),
  'playwright.expectNavigation.begin': z
    .object({
      tabId: id,
      url: z.string().min(1).max(20_000).optional(),
      waitUntil: loadState.optional(),
      timeoutMs: timeoutMs.optional(),
    })
    .strict(),
  'playwright.expectNavigation.wait': z
    .object({ tabId: id, waiterId: id })
    .strict(),
  'playwright.expectNavigation.cancel': z
    .object({ tabId: id, waiterId: id })
    .strict(),
  'playwright.waitForLoadState': z
    .object({
      tabId: id,
      state: loadState.optional(),
      timeoutMs: timeoutMs.optional(),
    })
    .strict(),
  'playwright.waitForTimeout': z.object({ tabId: id, timeoutMs }).strict(),

  'locator.count': locatorArgs,
  'locator.evaluate': locatorEvaluateArgs,
  'locator.evaluateAll': locatorEvaluateArgs,
  'locator.allTextContents': locatorTimeoutArgs,
  'locator.innerText': locatorTimeoutArgs,
  'locator.textContent': locatorTimeoutArgs,
  'locator.getAttribute': z
    .object({
      ...locatorFields,
      name: z.string().min(1).max(1_000),
      timeoutMs: timeoutMs.optional(),
    })
    .strict(),
  'locator.isEnabled': locatorArgs,
  'locator.isVisible': locatorArgs,
  'locator.click': z
    .object({
      ...locatorFields,
      button: mouseButtonName.optional(),
      modifiers: modifierNames.optional(),
      force: z.boolean().optional(),
      ...locatorActionOptions,
    })
    .strict(),
  'locator.dblclick': z
    .object({
      ...locatorFields,
      button: mouseButtonName.optional(),
      modifiers: modifierNames.optional(),
      force: z.boolean().optional(),
      ...locatorActionOptions,
    })
    .strict(),
  'locator.downloadMedia': locatorTimeoutArgs,
  'locator.fill': z
    .object({
      ...locatorFields,
      value: z.string().max(1_000_000),
      timeoutMs: timeoutMs.optional(),
    })
    .strict(),
  'locator.type': z
    .object({
      ...locatorFields,
      value: z.string().max(1_000_000),
      timeoutMs: timeoutMs.optional(),
    })
    .strict(),
  'locator.press': z
    .object({
      ...locatorFields,
      value: z.string().min(1).max(200),
      timeoutMs: timeoutMs.optional(),
    })
    .strict(),
  'locator.selectOption': z
    .object({
      ...locatorFields,
      value: z.union([selectOption, z.array(selectOption).min(1).max(1_000)]),
      timeoutMs: timeoutMs.optional(),
    })
    .strict(),
  'locator.check': z
    .object({
      ...locatorFields,
      force: z.boolean().optional(),
      ...locatorActionOptions,
    })
    .strict(),
  'locator.uncheck': z
    .object({
      ...locatorFields,
      force: z.boolean().optional(),
      ...locatorActionOptions,
    })
    .strict(),
  'locator.setChecked': z
    .object({
      ...locatorFields,
      checked: z.boolean(),
      force: z.boolean().optional(),
      ...locatorActionOptions,
    })
    .strict(),
  'locator.waitFor': z
    .object({
      ...locatorFields,
      state: z.enum(['attached', 'detached', 'visible', 'hidden']),
      timeoutMs: timeoutMs.optional(),
    })
    .strict(),
} as const satisfies Record<string, z.ZodTypeAny>;

export type SupportedCommand = keyof typeof commandSchemas;
