/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI /hooks: a read-only browser over the hooks this session can run,
 * moving from events to matchers to hooks to one hook's details, like the
 * ink HooksManagementDialog. The rows come from core `buildHooksListing`, so
 * they carry the registry's real enabled state and include the hooks skills,
 * `/goal` and the SDK registered for this session.
 */

import { useMemo, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  HookType,
  type HookEventName,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import {
  buildHooksListing,
  type HooksListing,
  type HooksListingDisabledReason,
  type HooksListingRow,
} from '@qwen-code/qwen-code-core/hooks/hooks-listing.js';
import { isLegacyMillisecondHookTimeout } from '@qwen-code/qwen-code-core/hooks/hook-timeout.js';
import type { LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import {
  DISPLAY_HOOK_EVENTS,
  getHookShortDescription,
  supportsMatchers,
} from '../components/hooks/constants.js';
import { normalizeMatcher } from '../components/hooks/matcherGrouping.js';
import { formatSourceLabel } from '../components/hooks/sourceLabels.js';
import { toOriginalKey } from './key-map.js';
import {
  DialogFrame,
  DialogSelect,
  FooterHint,
  dialogContentWidth,
  useDialogSelect,
  type DialogListItem,
} from './dialogs-shared.js';
import { regionListWindow, wrappedRows } from './dialogs-core.js';

import { clampDialogHeight } from '../utils/layoutUtils.js';
import {
  clipToWidth,
  getCachedStringWidth,
  sanitizeTerminalLine,
  truncateToWidth,
} from '../utils/textUtils.js';
import { readHooksEnabled } from './dialogs-misc.js';
import { C } from './theme.js';

const MAX_ROWS = 12;
const DETAIL_LABEL_WIDTH = 18;

export type HooksDialogView =
  | { step: 'events' }
  | { step: 'matchers'; event: HookEventName }
  | { step: 'handlers'; event: HookEventName; matcher?: string }
  | { step: 'detail'; event: HookEventName; matcher?: string; index: number };

export interface HookEventSummary {
  event: HookEventName;
  count: number;
  description: string;
}

export interface HookMatcherSummary {
  matcher: string;
  count: number;
}

export function summarizeHookEvents(
  rows: readonly HooksListingRow[],
): HookEventSummary[] {
  return DISPLAY_HOOK_EVENTS.map((event) => ({
    event,
    count: rows.filter((row) => row.eventName === event).length,
    description: getHookShortDescription(event),
  }));
}

/** Matcher groups of one event, in the order they first appear. */
export function summarizeHookMatchers(
  rows: readonly HooksListingRow[],
  event: HookEventName,
): HookMatcherSummary[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.eventName !== event) continue;
    const matcher = normalizeMatcher(row.matcher);
    counts.set(matcher, (counts.get(matcher) ?? 0) + 1);
  }
  return [...counts].map(([matcher, count]) => ({ matcher, count }));
}

/** The hooks under an event, narrowed to one matcher group when given. */
export function selectHookRows(
  rows: readonly HooksListingRow[],
  event: HookEventName,
  matcher?: string,
): HooksListingRow[] {
  return rows.filter(
    (row) =>
      row.eventName === event &&
      (matcher === undefined || normalizeMatcher(row.matcher) === matcher),
  );
}

/** Enter on an event: events without matcher support skip the matcher step. */
export function openHookEvent(event: HookEventName): HooksDialogView {
  return supportsMatchers(event)
    ? { step: 'matchers', event }
    : { step: 'handlers', event };
}

/** Esc walks back one step; undefined means close the dialog. */
export function previousHooksDialogView(
  view: HooksDialogView,
): HooksDialogView | undefined {
  switch (view.step) {
    case 'events':
      return undefined;
    case 'matchers':
      return { step: 'events' };
    case 'handlers':
      return view.matcher === undefined
        ? { step: 'events' }
        : { step: 'matchers', event: view.event };
    case 'detail':
      return { step: 'handlers', event: view.event, matcher: view.matcher };
    default: {
      const exhaustive: never = view;
      void exhaustive;
      return undefined;
    }
  }
}

export function hooksBannerText(listing: HooksListing): string | undefined {
  if (listing.safeMode) {
    return t('Safe mode is on, so no hooks run in this session.');
  }
  if (listing.bareMode) {
    return t('Bare mode is on, so no hooks run in this session.');
  }
  if (listing.allDisabled) {
    return t('All hooks are disabled by the disableAllHooks setting.');
  }
  return undefined;
}

/**
 * Timeout with its unit: function hooks count milliseconds, command hooks
 * still read 1000 or more as legacy milliseconds, everything else seconds.
 */
export function formatHookTimeout(row: HooksListingRow): string {
  const timeout = row.timeout;
  if (typeof timeout !== 'number') return String(timeout);
  if (row.hookType === HookType.Function) return `${timeout} ms`;
  if (
    row.hookType === HookType.Command &&
    isLegacyMillisecondHookTimeout(timeout)
  ) {
    return `${timeout} ms`;
  }
  return `${timeout} s`;
}

function literalLabel(hookType: HookType): string {
  switch (hookType) {
    case HookType.Http:
      return t('URL:');
    case HookType.Prompt:
      return t('Prompt:');
    default:
      return t('Command:');
  }
}

/** The Status value for a row: enabled, or disabled with the reason. */
export function hookStatusText(row: HooksListingRow): string {
  if (row.enabled) return t('enabled');
  return row.disabledReason
    ? disabledReasonText(row.disabledReason)
    : t('disabled');
}

function disabledReasonText(reason: HooksListingDisabledReason): string {
  switch (reason) {
    case 'bareMode':
      return t('disabled (bare mode)');
    case 'safeMode':
      return t('disabled (safe mode)');
    case 'allHooksDisabled':
      return t('disabled (disableAllHooks)');
    case 'untrusted':
      return t('disabled (folder not trusted)');
    case 'registryDisabled':
      return t('disabled (turned off for this session)');
    default: {
      const exhaustive: never = reason;
      void exhaustive;
      return t('disabled');
    }
  }
}

export function hookDetailFields(
  row: HooksListingRow,
): Array<[label: string, value: string]> {
  const fields: Array<[string, string]> = [[t('Event:'), row.eventName]];
  if (supportsMatchers(row.eventName)) {
    fields.push([t('Matcher:'), normalizeMatcher(row.matcher)]);
  }
  fields.push([t('Type:'), row.hookType]);
  fields.push([t('Source:'), formatSourceLabel(row.source)]);
  fields.push([t('Status:'), hookStatusText(row)]);
  if (row.name) fields.push([t('Name:'), row.name]);
  if (row.description) fields.push([t('Desc:'), row.description]);
  if (row.commandText !== undefined) {
    fields.push([literalLabel(row.hookType), row.commandText]);
  }
  if (row.timeout !== undefined) {
    fields.push([t('Timeout:'), formatHookTimeout(row)]);
  }
  if (row.statusMessage) {
    fields.push([t('Status message:'), row.statusMessage]);
  }
  if (row.condition) fields.push([t('Condition:'), row.condition]);
  const options = [
    row.runsInBackground ? t('runs in background') : undefined,
    row.runsOnce ? t('runs once') : undefined,
    row.sequential ? t('sequential') : undefined,
  ].filter((option): option is string => option !== undefined);
  if (options.length > 0) fields.push([t('Options:'), options.join(', ')]);
  if (row.skillRoot) fields.push([t('Skill:'), row.skillRoot]);
  return fields;
}

function hookCountLabel(count: number): string {
  return count === 1
    ? t('{{count}} hook', { count: String(count) })
    : t('{{count}} hooks', { count: String(count) });
}

function emptyListing(settings: LoadedSettings): HooksListing {
  return {
    rows: [],
    allDisabled: !readHooksEnabled(undefined, settings),
    safeMode: false,
    bareMode: false,
  };
}

export interface OpenTuiHooksDialogProps {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  /** Optional line under the title, for a status such as a reload. */
  notice?: string;
  /** The popup region's row budget; every list step windows from it. */
  availableTerminalHeight?: number;
}

export function OpenTuiHooksDialog({
  config,
  settings,
  onClose,
  notice,
  availableTerminalHeight,
}: OpenTuiHooksDialogProps) {
  // A snapshot for the life of the dialog: it remounts on every open.
  const listing = useMemo(
    () => (config ? buildHooksListing(config) : emptyListing(settings)),
    [config, settings],
  );
  const [view, setView] = useState<HooksDialogView>({ step: 'events' });

  const events = useMemo(
    () => summarizeHookEvents(listing.rows),
    [listing.rows],
  );
  const eventItems = useMemo<Array<DialogListItem<HookEventName>>>(
    () =>
      events.map((summary) => ({ key: summary.event, value: summary.event })),
    [events],
  );

  const matcherEvent = view.step === 'matchers' ? view.event : undefined;
  const matchers = useMemo(
    () =>
      matcherEvent === undefined
        ? []
        : summarizeHookMatchers(listing.rows, matcherEvent),
    [listing.rows, matcherEvent],
  );
  const matcherItems = useMemo<Array<DialogListItem<string>>>(
    () =>
      matchers.map((group) => ({ key: group.matcher, value: group.matcher })),
    [matchers],
  );

  const handlerEvent =
    view.step === 'handlers' || view.step === 'detail' ? view.event : undefined;
  const handlerMatcher =
    view.step === 'handlers' || view.step === 'detail'
      ? view.matcher
      : undefined;
  const handlerRows = useMemo(
    () =>
      handlerEvent === undefined
        ? []
        : selectHookRows(listing.rows, handlerEvent, handlerMatcher),
    [listing.rows, handlerEvent, handlerMatcher],
  );
  const handlerItems = useMemo<Array<DialogListItem<number>>>(
    () => handlerRows.map((_, index) => ({ key: String(index), value: index })),
    [handlerRows],
  );

  const regionHeight = clampDialogHeight(availableTerminalHeight);
  const { width } = useTerminalDimensions();
  const contentWidth = dialogContentWidth(width);
  const noticeRows = notice
    ? notice
        .split('\n')
        .reduce((rows, line) => rows + wrappedRows(line, contentWidth), 0)
    : 0;
  const banner = hooksBannerText(listing);
  const bannerRows = banner ? 1 + wrappedRows(banner, contentWidth) : 0;
  // The events step's read-only note wraps (95 columns at full width), so it
  // is charged by the row, like the notice and the banner.
  const eventsNoteRows = wrappedRows(
    t(
      'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.',
    ),
    contentWidth,
  );
  // Every chrome text run is measured at the content width instead of
  // charged a flat row: the header's count, the step titles and — in the
  // handlers step — the user-supplied matcher all wrap on narrow terminals,
  // and a flat constant pays for one row where two paint.
  const total = listing.rows.length;
  const countText =
    total === 1
      ? t('{{count}} hook configured', { count: String(total) })
      : t('{{count}} hooks configured', { count: String(total) });
  const headerRows = wrappedRows(`${t('Hooks')} · ${countText}`, contentWidth);
  const matchersHeaderRows =
    matcherEvent === undefined
      ? 1
      : wrappedRows(`${matcherEvent} - ${t('Matchers')}`, contentWidth);
  const handlersHeaderRows =
    handlerEvent === undefined
      ? 2
      : wrappedRows(
          handlerMatcher === undefined
            ? handlerEvent
            : `${handlerEvent} - ${t('Matcher:')} ${sanitizeTerminalLine(handlerMatcher)}`,
          contentWidth,
        ) + wrappedRows(getHookShortDescription(handlerEvent), contentWidth);
  // The rows no run can wrap into: the frame (4), the body's margin row (1),
  // the list's margin row (1) and the footer hint's margin (1). The footer
  // hint is charged the rows it wraps into at the content width, like the
  // header, the notice and the banner.
  const footerText =
    view.step === 'events'
      ? t('Enter to select · Esc to cancel')
      : view.step === 'detail'
        ? t('Esc to go back')
        : t('Enter to select · Esc to go back');
  const eventsWindow = regionListWindow(
    regionHeight,
    {
      fixed: 7,
      runs: [{ text: footerText, width: contentWidth }],
      measuredRows: headerRows + noticeRows + bannerRows + eventsNoteRows,
    },
    eventItems.length,
    MAX_ROWS,
  );
  const matchersWindow = regionListWindow(
    regionHeight,
    {
      fixed: 7,
      runs: [{ text: footerText, width: contentWidth }],
      measuredRows: headerRows + matchersHeaderRows + noticeRows + bannerRows,
    },
    matcherItems.length,
    MAX_ROWS,
  );
  const handlersWindow = regionListWindow(
    regionHeight,
    {
      fixed: 7,
      runs: [{ text: footerText, width: contentWidth }],
      measuredRows: headerRows + handlersHeaderRows + noticeRows + bannerRows,
    },
    handlerItems.length,
    MAX_ROWS,
  );
  // Every list row is charged one physical row in the windows above, so each
  // label's runs clip to the columns the row actually owns: the content width
  // minus DialogSelect's indicator and number columns.
  const labelBudget = (itemCount: number) =>
    Math.max(0, contentWidth - 4 - String(itemCount).length);
  const eventSelect = useDialogSelect({
    items: eventItems,
    focused: view.step === 'events',
    maxItemsToShow: eventsWindow.maxItemsToShow,
    onSelect: (event) => setView(openHookEvent(event)),
  });
  const matcherSelect = useDialogSelect({
    items: matcherItems,
    focused: view.step === 'matchers',
    resyncKey: `matchers:${matcherEvent ?? ''}`,
    maxItemsToShow: matchersWindow.maxItemsToShow,
    onSelect: (matcher) => {
      if (matcherEvent !== undefined) {
        setView({ step: 'handlers', event: matcherEvent, matcher });
      }
    },
  });
  const handlerSelect = useDialogSelect({
    items: handlerItems,
    focused: view.step === 'handlers',
    resyncKey: `handlers:${handlerEvent ?? ''}:${handlerMatcher ?? ''}`,
    maxItemsToShow: handlersWindow.maxItemsToShow,
    onSelect: (index) => {
      if (handlerEvent !== undefined) {
        setView({
          step: 'detail',
          event: handlerEvent,
          matcher: handlerMatcher,
          index,
        });
      }
    },
  });

  useKeyboard((key) => {
    if (toOriginalKey(key).name !== 'escape') return;
    const previous = previousHooksDialogView(view);
    if (previous) {
      setView(previous);
    } else {
      onClose();
    }
  });

  const wheel =
    (
      select: {
        activeIndexRef: Readonly<{ current: number }>;
        highlightIndex: (index: number) => void;
      },
      length: number,
    ) =>
    (direction: 'up' | 'down') =>
      select.highlightIndex(
        Math.max(
          0,
          Math.min(
            length - 1,
            select.activeIndexRef.current + (direction === 'down' ? 1 : -1),
          ),
        ),
      );

  const renderEvents = () => (
    <box flexDirection="column">
      <text fg={C.dim}>
        {t(
          'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Qwen Code.',
        )}
      </text>
      <box marginTop={1} flexDirection="column">
        <DialogSelect
          items={eventItems}
          activeIndex={eventSelect.activeIndex}
          scrollOffset={eventSelect.scrollOffset}
          maxItemsToShow={eventsWindow.maxItemsToShow}
          showScrollArrows={eventsWindow.showScrollArrows}
          focused={view.step === 'events'}
          onHover={eventSelect.highlightIndex}
          onWheel={wheel(eventSelect, eventItems.length)}
          onSelectIndex={eventSelect.selectIndex}
          renderLabel={(item, context) => {
            const summary = events.find((entry) => entry.event === item.value);
            const budget = labelBudget(eventItems.length);
            const nameRun = clipToWidth(item.value, budget);
            const countRun =
              summary && summary.count > 0
                ? clipToWidth(
                    ` (${summary.count})`,
                    Math.max(0, budget - getCachedStringWidth(nameRun)),
                  )
                : '';
            const descriptionRun = truncateToWidth(
              `  ${summary?.description ?? ''}`,
              Math.max(
                0,
                budget -
                  getCachedStringWidth(nameRun) -
                  getCachedStringWidth(countRun),
              ),
            );
            return (
              <box flexDirection="row">
                <text fg={context.titleColor}>{nameRun}</text>
                {countRun ? <text fg={C.green}>{countRun}</text> : null}
                {descriptionRun ? (
                  <text fg={C.dim}>{descriptionRun}</text>
                ) : null}
              </box>
            );
          }}
        />
      </box>
    </box>
  );

  const renderEmpty = (message: string) => (
    <box flexDirection="column">
      <text fg={C.dim}>{message}</text>
      <text fg={C.dim}>
        {t('To add hooks, edit settings.json directly or ask Qwen.')}
      </text>
    </box>
  );

  const renderMatchers = (event: HookEventName) => (
    <box flexDirection="column">
      <text fg={C.text}>{`${event} - ${t('Matchers')}`}</text>
      <box marginTop={1} flexDirection="column">
        {matcherItems.length === 0 ? (
          renderEmpty(t('No hooks configured for this event.'))
        ) : (
          <DialogSelect
            items={matcherItems}
            activeIndex={matcherSelect.activeIndex}
            scrollOffset={matcherSelect.scrollOffset}
            maxItemsToShow={matchersWindow.maxItemsToShow}
            showScrollArrows={matchersWindow.showScrollArrows}
            focused={view.step === 'matchers'}
            onHover={matcherSelect.highlightIndex}
            onWheel={wheel(matcherSelect, matcherItems.length)}
            onSelectIndex={matcherSelect.selectIndex}
            renderLabel={(item, context) => {
              const group = matchers.find(
                (entry) => entry.matcher === item.value,
              );
              const budget = labelBudget(matcherItems.length);
              const nameRun = clipToWidth(
                sanitizeTerminalLine(item.value),
                budget,
              );
              const countRun = truncateToWidth(
                `  · ${hookCountLabel(group?.count ?? 0)}`,
                Math.max(0, budget - getCachedStringWidth(nameRun)),
              );
              return (
                <box flexDirection="row">
                  <text fg={context.titleColor}>{nameRun}</text>
                  {countRun ? <text fg={C.dim}>{countRun}</text> : null}
                </box>
              );
            }}
          />
        )}
      </box>
    </box>
  );

  const renderHandlers = (event: HookEventName, matcher?: string) => (
    <box flexDirection="column">
      <text fg={C.text}>
        {matcher === undefined
          ? event
          : `${event} - ${t('Matcher:')} ${sanitizeTerminalLine(matcher)}`}
      </text>
      <text fg={C.dim}>{getHookShortDescription(event)}</text>
      <box marginTop={1} flexDirection="column">
        {handlerItems.length === 0 ? (
          renderEmpty(
            matcher === undefined
              ? t('No hooks configured for this event.')
              : t('No hooks configured for this matcher.'),
          )
        ) : (
          <DialogSelect
            items={handlerItems}
            activeIndex={handlerSelect.activeIndex}
            scrollOffset={handlerSelect.scrollOffset}
            maxItemsToShow={handlersWindow.maxItemsToShow}
            showScrollArrows={handlersWindow.showScrollArrows}
            focused={view.step === 'handlers'}
            onHover={handlerSelect.highlightIndex}
            onWheel={wheel(handlerSelect, handlerItems.length)}
            onSelectIndex={handlerSelect.selectIndex}
            renderLabel={(item, context) => {
              const row = handlerRows[item.value];
              if (!row) return <text fg={context.titleColor}>{''}</text>;
              const type = row.runsInBackground
                ? `${row.hookType} async`
                : row.hookType;
              const budget = labelBudget(handlerItems.length);
              const mainRun = clipToWidth(
                sanitizeTerminalLine(`[${type}] ${row.displayText}`),
                budget,
              );
              const sourceRun = clipToWidth(
                `  · ${formatSourceLabel(row.source)}`,
                Math.max(0, budget - getCachedStringWidth(mainRun)),
              );
              const disabledRun = row.enabled
                ? ''
                : truncateToWidth(
                    `  ${t('disabled')}`,
                    Math.max(
                      0,
                      budget -
                        getCachedStringWidth(mainRun) -
                        getCachedStringWidth(sourceRun),
                    ),
                  );
              return (
                <box flexDirection="row">
                  <text fg={context.titleColor}>{mainRun}</text>
                  {sourceRun ? <text fg={C.dim}>{sourceRun}</text> : null}
                  {disabledRun ? (
                    <text fg={C.yellow}>{disabledRun}</text>
                  ) : null}
                </box>
              );
            }}
          />
        )}
      </box>
    </box>
  );

  const renderDetail = (row: HooksListingRow) => (
    <box flexDirection="column">
      <text fg={C.text} attributes={1}>
        {t('Hook details')}
      </text>
      <box marginTop={1} flexDirection="column">
        {hookDetailFields(row).map(([label, value]) => (
          <box key={label} flexDirection="row">
            <box width={DETAIL_LABEL_WIDTH} flexShrink={0}>
              <text fg={C.dim}>{label}</text>
            </box>
            <box flexGrow={1}>
              <text fg={C.text}>{value}</text>
            </box>
          </box>
        ))}
      </box>
      <box marginTop={1}>
        <text fg={C.dim}>
          {t(
            'To modify or remove this hook, edit settings.json directly or ask Qwen to help.',
          )}
        </text>
      </box>
    </box>
  );

  let body;
  let footer: string;
  switch (view.step) {
    case 'events':
      body = renderEvents();
      footer = footerText;
      break;
    case 'matchers':
      body = renderMatchers(view.event);
      footer = footerText;
      break;
    case 'handlers':
      body = renderHandlers(view.event, view.matcher);
      footer = footerText;
      break;
    case 'detail': {
      const row = handlerRows[view.index];
      body = row ? renderDetail(row) : renderHandlers(view.event, view.matcher);
      footer = footerText;
      break;
    }
    default: {
      const exhaustive: never = view;
      void exhaustive;
      body = null;
      footer = '';
    }
  }

  return (
    <DialogFrame>
      <box flexDirection="row">
        <text fg={C.accent} attributes={1}>
          {t('Hooks')}
        </text>
        <text fg={C.dim}>{` · ${countText}`}</text>
      </box>
      {notice
        ? notice.split('\n').map((line, index) => (
            <text key={`notice-${index}`} fg={C.dim}>
              {line}
            </text>
          ))
        : null}
      {banner ? (
        <box marginTop={1}>
          <text fg={C.yellow}>{banner}</text>
        </box>
      ) : null}
      <box marginTop={1} flexDirection="column">
        {body}
      </box>
      <FooterHint text={footer} />
    </DialogFrame>
  );
}
