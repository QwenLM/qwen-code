/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Native OpenTUI ApprovalMode / Reasoning Effort / Output Style dialogs,
 * ported from ink ApprovalModeDialog / EffortDialog / OutputStyleDialog onto
 * the shared dialog primitives: `> Title` plus a dim subtitle, numbered radio
 * rows carrying ink's own label text, ink's footer hint, and the approval
 * dialog's Tab-reachable scope step.
 */

import { useEffect, useRef, useState } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import {
  APPROVAL_MODES,
  ApprovalMode,
} from '@qwen-code/qwen-code-core/config/approval-mode.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { OutputStyleDefinition } from '@qwen-code/qwen-code-core/core/output-styles.js';
import {
  applyReasoningEffort,
  REASONING_EFFORT_TIERS,
} from '@qwen-code/qwen-code-core/core/reasoning-effort.js';
import type { ReasoningEffort } from '@qwen-code/qwen-code-core/core/reasoning-effort.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import {
  getScopeItems,
  getScopeMessageForSetting,
} from '../../config/dialogScopeUtils.js';
import {
  applyOutputStyleSelection,
  loadSessionOutputStyles,
} from '../commands/output-style-utils.js';
import { formatEffortChangeMessage } from '../commands/effort-utils.js';
import { EFFORT_DESCRIPTIONS } from '../components/EffortDialog.js';
import {
  formatApprovalModeDescription,
  formatApprovalModeName,
} from '../utils/approvalModeDisplay.js';
import { t } from '../../i18n/index.js';
import {
  DEFAULT_MAX_ITEMS_TO_SHOW,
  DialogFrame,
  DialogSelect,
  dialogContentWidth,
  FooterHint,
  useDialogFrameKeys,
  useDialogSelect,
  type UseDialogSelectResult,
} from './dialogs-shared.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import {
  clipToWidth,
  getCachedStringWidth,
  toCodePoints,
  truncateToWidth,
} from '../utils/textUtils.js';
import type { DialogListItem } from './dialogs-core.js';
import { C } from './theme.js';
import { getReasoningEffortsForConfig } from '../../acp-integration/model-configuration.js';

interface LabeledItem<T> extends DialogListItem<T> {
  label: string;
}

/**
 * Columns a list row leaves its label: the dialog's content width minus the
 * row's own `›` indicator box (2) and, when numbered, the `N.` box plus its
 * trailing space. DialogSelect sizes that box from the full list's length
 * (`String(items.length).length` digits), so a ten-row list spends one more
 * column on it than a nine-row one. ink gives every label `wrap="truncate"`,
 * so a label wider than this is clipped rather than wrapped — a wrapped row
 * is two physical rows and the budget below counts it as one.
 */
function rowLabelWidth(
  terminalWidth: number,
  itemCount: number,
  showNumbers: boolean,
): number {
  const numberBox = showNumbers ? String(itemCount).length + 2 : 0;
  return Math.max(0, dialogContentWidth(terminalWidth) - 2 - numberBox);
}

/**
 * The ink dialogs build one `name — description` string per row and let
 * BaseSelectionList colour it as a whole, so the label is a single text run
 * here too rather than a name/description pair.
 */
function LabeledRows<T>(props: {
  list: UseDialogSelectResult<LabeledItem<T>>;
  focused: boolean;
  maxItemsToShow?: number;
  showScrollArrows?: boolean;
}) {
  const { list, focused } = props;
  const { width } = useTerminalDimensions();
  const labelWidth = rowLabelWidth(width, list.items.length, focused);
  return (
    <DialogSelect
      items={list.items}
      activeIndex={list.activeIndex}
      scrollOffset={list.scrollOffset}
      maxItemsToShow={props.maxItemsToShow}
      showScrollArrows={props.showScrollArrows}
      showNumbers={focused}
      focused={focused}
      onHover={list.setActiveIndex}
      onSelectIndex={list.selectIndex}
      onWheel={(direction) =>
        list.setActiveIndex(
          list.activeIndexRef.current + (direction === 'down' ? 1 : -1),
        )
      }
      renderLabel={(item, { titleColor }) => (
        <text fg={titleColor}>{truncateToWidth(item.label, labelWidth)}</text>
      )}
    />
  );
}

/** The `> Title <dim subtitle>` row every ink dialog opens with. The margin
 * below it is the spacer row ink sheds first when the height budget runs out
 * (its `showModeSpacer`), so the approval dialog can pass 0 there. */
function DialogTitle(props: {
  title: string;
  subtitle?: string;
  marginBottom?: number;
  /** ink's ApprovalModeDialog alone gives the run `wrap="truncate"`; the
   * effort and output-style dialogs render a plain Text that wraps, so their
   * subtitles stay whole over as many rows as they need. */
  truncateTitle?: boolean;
}) {
  const { width } = useTerminalDimensions();
  const contentWidth = dialogContentWidth(width);
  const titleRun = `> ${props.title} `;
  if (!props.truncateTitle) {
    return (
      <box flexDirection="row" marginBottom={props.marginBottom ?? 1}>
        <text fg={C.text} attributes={1}>
          {titleRun}
        </text>
        {props.subtitle ? <text fg={C.dim}>{props.subtitle}</text> : null}
      </box>
    );
  }
  // ink puts the whole run — prefix, title and dim subtitle — inside one
  // `wrap="truncate"` Text, so the subtitle only gets the columns the title
  // left and neither wraps onto a second row the budget does not pay for.
  const titleWidth = getCachedStringWidth(titleRun);
  return (
    <box flexDirection="row" marginBottom={props.marginBottom ?? 1}>
      <text fg={C.text} attributes={1}>
        {clipToWidth(titleRun, contentWidth)}
      </text>
      {props.subtitle && titleWidth < contentWidth ? (
        <text fg={C.dim}>
          {truncateToWidth(props.subtitle, contentWidth - titleWidth)}
        </text>
      ) : null}
    </box>
  );
}

// ink ApprovalModeDialog's budget thresholds: as the region gets shorter it
// sheds the spacer row, then the footer hint, then windows the list.
const MIN_HEIGHT_WITH_MODE_SPACER = 9;
const MIN_HEIGHT_WITH_FOOTER_HINT = 10;
const MIN_HEIGHT_WITH_WARNING_FOOTER_HINT = 12;
// ink budgets a flat three rows for the workspace warning. The text only
// fills two of them once the terminal is wide enough, so the flat count
// over-pays there; it stays as the floor because paying fewer rows than ink
// would show a list row ink does not.
const WORKSPACE_PRIORITY_WARNING_ROWS = 3;
// Frame border + padding (4) plus the title row (1); the spacer, warning,
// refusal and footer rows are budgeted separately.
const MODE_LIST_CHROME_ROWS = 5;
const FOOTER_HINT_ROWS = 2;

/**
 * Rows a run paints once the terminal word-wraps it at `width` columns. The
 * warning and the trust-gate refusal both stay wrapped (ink wraps the warning
 * too), so the budget has to pay for the rows they actually occupy: the
 * refusal had no term in it at all, and the warning's flat count only covers a
 * terminal wide enough for the text to fit inside it.
 *
 * Two renderer rules the count has to share: a newline always starts a new
 * row, and a word wider than the row is broken by cell width without splitting
 * a double-width glyph — so a spaceless CJK run packs nine characters into a
 * nineteen-column row, not the ten a whole-width division predicts.
 */
export function wrappedRows(text: string, width: number): number {
  if (width <= 0) {
    return 1;
  }
  let rows = 0;
  for (const line of text.split('\n')) {
    let lineRows = 1;
    let used = 0;
    for (const word of line.split(' ')) {
      const wordWidth = renderWidth(word);
      if (used > 0) {
        if (used + 1 + wordWidth > width) {
          lineRows += 1;
          used = 0;
        } else {
          used += 1;
        }
      }
      if (wordWidth <= width - used) {
        used += wordWidth;
        continue;
      }
      // A word wider than the space left to it is broken across rows, cell by
      // cell; a two-cell glyph that would straddle the boundary moves whole.
      for (const char of toCodePoints(word)) {
        const charWidth = renderWidth(char);
        if (used > 0 && used + charWidth > width) {
          lineRows += 1;
          used = 0;
        }
        used += charWidth;
      }
    }
    rows += lineRows;
  }
  return rows;
}

// The renderer's own width table paints the warning sign in one column where
// string-width counts two, so the row charge is measured with it painted as
// one — otherwise the shipped warning is overcharged a row at narrow widths.
const renderWidth = (text: string): number =>
  getCachedStringWidth(text.replaceAll('\u26A0', ' '));

/** One margin row plus the wrapped text rows of a notice below the list. */
function noticeRows(text: string | null, contentWidth: number): number {
  return text ? 1 + wrappedRows(text, contentWidth) : 0;
}

/**
 * ink ApprovalModeDialog's derivation, ported line for line: which chrome
 * rows the budget still pays for, and how many mode rows fit in what is left.
 * `constrainedHeight` is the popup region's row budget (undefined when the
 * caller has none, which ink treats as "show everything"). `warningRows` and
 * `errorRows` are the notices this port shows below the list. ink only has the
 * warning, and budgets it at a flat three rows; the call site passes the
 * larger of that flat count and the rows the text actually wraps into.
 */
function modeListBudget(
  constrainedHeight: number | undefined,
  warningRows: number,
  errorRows: number,
  itemCount: number,
): {
  showModeSpacer: boolean;
  showFooterHint: boolean;
  showScrollArrows: boolean;
  maxItemsToShow: number;
} {
  if (constrainedHeight === undefined) {
    return {
      showModeSpacer: true,
      showFooterHint: true,
      showScrollArrows: false,
      maxItemsToShow: DEFAULT_MAX_ITEMS_TO_SHOW,
    };
  }
  const showModeSpacer = constrainedHeight >= MIN_HEIGHT_WITH_MODE_SPACER;
  const preferredShowFooterHint =
    constrainedHeight >=
    (warningRows > 0
      ? MIN_HEIGHT_WITH_WARNING_FOOTER_HINT
      : MIN_HEIGHT_WITH_FOOTER_HINT);
  const chromeWithoutFooter =
    MODE_LIST_CHROME_ROWS + (showModeSpacer ? 1 : 0) + warningRows + errorRows;
  const rowsWithPreferredFooter = Math.max(
    1,
    constrainedHeight -
      chromeWithoutFooter -
      (preferredShowFooterHint ? FOOTER_HINT_ROWS : 0),
  );
  const rowsWithoutFooter = Math.max(
    1,
    constrainedHeight - chromeWithoutFooter,
  );
  // What a row count leaves the list once the arrows that count would raise
  // are paid for — the comparison the footer decision is made with.
  const itemsFor = (rows: number): number => {
    const arrows = rows > 2 && rows < itemCount;
    return Math.max(
      1,
      Math.min(DEFAULT_MAX_ITEMS_TO_SHOW, itemCount, rows - (arrows ? 2 : 0)),
    );
  };
  // Deliberate divergence: ink gates the hint-shedding guard on
  // `!showWorkspacePriorityWarning`, which its flat three-row warning made
  // safe. This port's notices are variable, so with the warning up the hint
  // stays only while dropping it could not buy another mode row — at region
  // fourteen the warning's way keeps one mode between two arrows beside the
  // hint, while dropping the hint shows all five. Either way the hint goes
  // whenever the chrome alone leaves no room for it beside a single list
  // row: ink's fixed chrome never let that happen, so its thresholds never
  // had to check.
  const showFooterHint =
    preferredShowFooterHint &&
    constrainedHeight - chromeWithoutFooter - FOOTER_HINT_ROWS >= 1 &&
    (warningRows > 0
      ? itemsFor(rowsWithoutFooter) <= itemsFor(rowsWithPreferredFooter)
      : !(
          rowsWithPreferredFooter <= 2 &&
          rowsWithoutFooter > 2 &&
          rowsWithoutFooter < itemCount
        ));
  const listRows = Math.max(
    1,
    constrainedHeight -
      chromeWithoutFooter -
      (showFooterHint ? FOOTER_HINT_ROWS : 0),
  );
  const showScrollArrows = listRows > 2 && listRows < itemCount;
  const maxItemsToShow = Math.max(
    1,
    Math.min(
      DEFAULT_MAX_ITEMS_TO_SHOW,
      itemCount,
      listRows - (showScrollArrows ? 2 : 0),
    ),
  );
  return { showModeSpacer, showFooterHint, showScrollArrows, maxItemsToShow };
}

export function OpenTuiApprovalModeDialog(props: {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  onApprovalModeChanged: (m: ApprovalMode) => void;
  /** The popup region's row budget, as ink's DialogManager hands it over. */
  availableTerminalHeight?: number;
}) {
  const { config, settings, onClose, onApprovalModeChanged } = props;
  const [view, setView] = useState<'mode' | 'scope'>('mode');
  const [selectedScope, setSelectedScope] = useState<SettingScope>(
    SettingScope.User,
  );
  const [error, setError] = useState<string | null>(null);
  const current = config?.getApprovalMode?.() ?? ApprovalMode.DEFAULT;
  // ink keeps its own highlighted-mode state and seeds the list index from it,
  // so the remount that follows a scope trip restores the row the arrows last
  // landed on rather than the mode the config happens to hold.
  const [highlightedMode, setHighlightedMode] = useState<ApprovalMode>(current);

  const modeItems: Array<LabeledItem<ApprovalMode>> = APPROVAL_MODES.map(
    (mode) => ({
      key: mode,
      value: mode,
      label: `${formatApprovalModeName(mode)} - ${formatApprovalModeDescription(
        mode,
      )}`,
    }),
  );
  const otherScopeModifiedMessage = getScopeMessageForSetting(
    'tools.approvalMode',
    selectedScope,
    settings,
  );
  const showWorkspacePriorityWarning =
    selectedScope === SettingScope.User &&
    otherScopeModifiedMessage.toLowerCase().includes('workspace');
  const { width } = useTerminalDimensions();
  const contentWidth = dialogContentWidth(width);
  const warningText = showWorkspacePriorityWarning
    ? `⚠ ${t(
        'Workspace approval mode exists and takes priority. User-level change will have no effect.',
      )}`
    : null;

  // ink derives the window from the height its dialog manager hands over;
  // without it the list never windows (the default is 10 rows for 5 items)
  // and on a short terminal the unsized rows shrink to zero and overpaint
  // each other while the keys still commit a mode the user cannot read.
  const regionHeight = clampDialogHeight(props.availableTerminalHeight);
  // The notices are paid out of the same region the list windows into, so
  // their charge is capped at what the region can give it after the
  // mandatory chrome and the one-row list floor — and the boxes below are
  // clipped to the same figure, since a capped charge beside an unclipped
  // notice would still overpaint the rows the budget just took back. The
  // warning is charged first: its three-row floor is the ink parity a wide
  // enough region keeps.
  const noticeCap =
    regionHeight === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(
          0,
          regionHeight -
            MODE_LIST_CHROME_ROWS -
            (regionHeight >= MIN_HEIGHT_WITH_MODE_SPACER ? 1 : 0) -
            1,
        );
  const warningRows = warningText
    ? Math.min(
        noticeCap,
        Math.max(
          WORKSPACE_PRIORITY_WARNING_ROWS,
          noticeRows(warningText, contentWidth),
        ),
      )
    : 0;
  const errorRows = Math.min(
    noticeRows(error, contentWidth),
    Math.max(0, noticeCap - warningRows),
  );
  const budget = modeListBudget(
    regionHeight,
    warningRows,
    errorRows,
    modeItems.length,
  );
  const modeList = useDialogSelect<LabeledItem<ApprovalMode>>({
    items: modeItems,
    initialIndex: Math.max(
      0,
      modeItems.findIndex((item) => item.value === highlightedMode),
    ),
    focused: view === 'mode',
    numbers: view === 'mode',
    maxItemsToShow: budget.maxItemsToShow,
    // The scope step's close remounts this list; the highlighted mode is what
    // survives that trip, and the scope is what changes on it.
    resyncKey: selectedScope,
    onHighlight: (mode) => {
      setHighlightedMode(mode);
      // A highlight move is what invalidates the trust-gate refusal — the
      // gate reads the mode, never the scope — so the message (whose rows are
      // charged to the list window) is cleared here, not only on a scope
      // move that cannot invalidate it.
      setError(null);
    },
    onSelect: (mode) => {
      try {
        // Do not persist a privileged mode that this workspace cannot use;
        // User scope would make it active in other trusted workspaces.
        if (
          config?.isTrustedFolder() === false &&
          mode !== ApprovalMode.DEFAULT &&
          mode !== ApprovalMode.PLAN
        ) {
          throw new Error(
            'Cannot enable privileged approval modes in an untrusted folder.',
          );
        }
        settings.setValue(selectedScope, 'tools.approvalMode', mode);
        const effectiveMode = settings.merged.tools?.approvalMode ?? mode;
        config?.setApprovalMode?.(effectiveMode);
        onApprovalModeChanged(effectiveMode);
      } catch (e) {
        // Keep the dialog open and show the refusal: an empty catch here made a
        // gate rejection indistinguishable from an accepted choice.
        setError((e as Error).message);
        return;
      }
      onClose();
    },
  });

  const scopeItems: Array<LabeledItem<SettingScope>> = getScopeItems().map(
    (item) => ({
      key: item.value,
      value: item.value,
      label: t(item.label),
    }),
  );
  // Deliberate divergence: ink's ScopeSelector keeps an unconditional spacer
  // and an unwindowed list, and its frame absorbs the overrun with
  // `overflow="hidden"`. Here the same rows overpaint each other at region
  // heights 4 to 6 (measured), and Enter commits a scope the user cannot read.
  const scopeBudget = modeListBudget(regionHeight, 0, 0, scopeItems.length);
  // The trust-gate refusal is charged to the list window, so it must not
  // outlive the state it describes: a scope move clears it, and a successful
  // write closes the dialog.
  const adoptScope = (scope: SettingScope) => {
    setSelectedScope(scope);
    setError(null);
  };
  // The footer hint lives outside both branches, in the frame whose rows the
  // step on screen paid for.
  const activeBudget = view === 'mode' ? budget : scopeBudget;
  const scopeList = useDialogSelect<LabeledItem<SettingScope>>({
    items: scopeItems,
    initialIndex: Math.max(
      0,
      scopeItems.findIndex((item) => item.value === selectedScope),
    ),
    focused: view === 'scope',
    numbers: view === 'scope',
    maxItemsToShow: scopeBudget.maxItemsToShow,
    // ink's handleScopeSelect only records the scope and steps back: the mode
    // row's Enter is what persists.
    onSelect: (scope) => {
      adoptScope(scope);
      setView('mode');
    },
    onHighlight: adoptScope,
  });

  useDialogFrameKeys({
    onTab: () => setView((prev) => (prev === 'mode' ? 'scope' : 'mode')),
    onEscape: onClose,
  });

  return (
    <DialogFrame fill>
      {view === 'mode' ? (
        <box flexDirection="column" flexGrow={1}>
          <DialogTitle
            title={t('Approval Mode')}
            subtitle={otherScopeModifiedMessage}
            marginBottom={budget.showModeSpacer ? 1 : 0}
            truncateTitle
          />
          <LabeledRows
            list={modeList}
            focused={view === 'mode'}
            maxItemsToShow={budget.maxItemsToShow}
            showScrollArrows={budget.showScrollArrows}
          />
          {warningText && warningRows > 0 ? (
            <box marginTop={1} height={warningRows - 1} overflow="hidden">
              <text fg={C.yellow}>{warningText}</text>
            </box>
          ) : null}
          {error && errorRows > 0 ? (
            <box marginTop={1} height={errorRows - 1} overflow="hidden">
              <text fg={C.red}>{error}</text>
            </box>
          ) : null}
        </box>
      ) : (
        <box flexDirection="column">
          <DialogTitle
            title={t('Apply To')}
            marginBottom={scopeBudget.showModeSpacer ? 1 : 0}
            truncateTitle
          />
          <LabeledRows
            list={scopeList}
            focused={view === 'scope'}
            maxItemsToShow={scopeBudget.maxItemsToShow}
            showScrollArrows={scopeBudget.showScrollArrows}
          />
        </box>
      )}
      {activeBudget.showFooterHint ? (
        <FooterHint
          text={truncateToWidth(
            view === 'mode'
              ? t('(Use Enter to select, Tab to configure scope)')
              : t('(Use Enter to apply scope, Tab to go back)'),
            contentWidth,
          )}
        />
      ) : null}
    </DialogFrame>
  );
}

export function OpenTuiEffortDialog(props: {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  notify?: (text: string, level?: 'info' | 'error') => void;
}) {
  const { config, settings, onClose, notify } = props;
  const tiers = config
    ? [...getReasoningEffortsForConfig(config)]
    : (REASONING_EFFORT_TIERS as ReasoningEffort[]);
  // Pre-select the live tier only when this model exposes it; an unset or
  // out-of-range effort starts at the top (ink EffortDialog parity).
  const currentEffort = config?.getReasoningEffort?.();
  const configuredIndex = currentEffort ? tiers.indexOf(currentEffort) : -1;
  const items: Array<LabeledItem<ReasoningEffort>> = tiers.map((tier) => ({
    key: tier,
    value: tier,
    label: `${tier} — ${t(EFFORT_DESCRIPTIONS[tier])}`,
  }));
  const list = useDialogSelect<LabeledItem<ReasoningEffort>>({
    items,
    initialIndex: Math.max(0, configuredIndex),
    onSelect: (effort) => {
      try {
        // Apply at runtime (next turn) and persist for future sessions;
        // provider adapters clamp the tier per model (ink useEffortCommand
        // parity — the request pipeline reads the live config per request).
        if (config) {
          applyReasoningEffort(config, effort);
        }
        settings.setValue(
          getPersistScopeForModelSelection(settings),
          'model.reasoningEffort',
          effort,
        );
        // Read back after the apply: the message names what the provider
        // actually clamped the tier to, not what the row asked for.
        if (config) notify?.(formatEffortChangeMessage(config, effort));
      } catch {
        /* ignore */
      }
      onClose();
    },
  });
  useDialogFrameKeys({ onEscape: onClose });

  return (
    <DialogFrame>
      <DialogTitle
        title={t('Reasoning Effort')}
        subtitle={t('(applied across all providers; clamped per model)')}
      />
      <LabeledRows list={list} focused />
      {configuredIndex === -1 ? (
        <box marginTop={1}>
          <text fg={C.dim}>
            {currentEffort
              ? t(
                  '{{effort}} is not available for this model — using the model/provider default.',
                  { effort: currentEffort },
                )
              : t('No effort configured — using the model/provider default.')}
          </text>
        </box>
      ) : null}
      <FooterHint text={t('(Use Enter to select, Esc to cancel)')} />
    </DialogFrame>
  );
}

/** Case-insensitive membership, the way the catalog dedupes and looks up. */
function containsStyle(
  styles: readonly OutputStyleDefinition[],
  name: string,
): boolean {
  const wanted = name.toLowerCase();
  return styles.some((style) => style.name.toLowerCase() === wanted);
}

/** ink OutputStyleDialog's `describe`: built-ins translate, customs cite the source. */
function describeStyle(style: OutputStyleDefinition): string {
  if (style.source === 'built-in') {
    return t(style.description);
  }
  return `${style.description} (${style.source})`;
}

export function OpenTuiOutputStyleDialog(props: {
  config: Config;
  settings: LoadedSettings;
  onClose: () => void;
  notify: (text: string, level?: 'info' | 'error') => void;
}) {
  const { config, settings, onClose, notify } = props;
  // The catalog, not just the built-ins: a custom style can be active under
  // this renderer too (`--output-style`, `general.outputStyle`, or the
  // renderer-agnostic `/output-style <name>`), and a list of built-ins alone
  // would leave it unlisted -- pre-selecting `default` and persisting that
  // over the user's setting on the first Enter.
  const [styles, setStyles] = useState<
    readonly OutputStyleDefinition[] | undefined
  >();
  // The mount site passes fresh inline closures on every render, and the shell
  // re-renders on every host version bump, so depending on these props would
  // re-read both style directories mid-dialog: the reload would re-derive the
  // selection and discard the user's arrow-key navigation. Only `config`
  // invalidates the catalog.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    let cancelled = false;
    void loadSessionOutputStyles(config).then(
      (loaded) => {
        if (!cancelled) setStyles(loaded);
      },
      (error: unknown) => {
        if (!cancelled) {
          notifyRef.current(
            `Failed to load output styles: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
          onCloseRef.current();
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [config]);

  const currentStyle = config.getOutputStyle();
  // The catalog is re-read on every open and skips a file it cannot parse, so
  // the active style can be absent from it (edited into an invalid state,
  // renamed, grown past the size cap, a dangling dotfiles symlink) while the
  // session still runs it. Listing the live definition keeps the `›` marker
  // truthful; falling back to index 0 would mark `default` as active and one
  // Enter would persist it over the user's setting.
  const catalog =
    styles && currentStyle && !containsStyle(styles, currentStyle.name)
      ? [...styles, currentStyle]
      : styles;

  const items: Array<LabeledItem<OutputStyleDefinition | undefined>> = catalog
    ? [
        {
          key: 'default',
          value: undefined,
          label: `default — ${t('The standard prompt, with no extra style')}`,
        },
        ...catalog.map((style) => ({
          key: style.name,
          value: style as OutputStyleDefinition | undefined,
          label: `${style.name} — ${describeStyle(style)}`,
        })),
      ]
    : [];
  // Unlike /effort, "no style configured" genuinely is the first entry
  // (default), so pre-selecting index 0 in that case tells the truth. The name
  // is matched case-insensitively, like every other style lookup.
  const wanted = currentStyle?.name.toLowerCase();
  const list = useDialogSelect<LabeledItem<OutputStyleDefinition | undefined>>({
    items,
    initialIndex: Math.max(
      0,
      items.findIndex((item) => item.key.toLowerCase() === wanted),
    ),
    onSelect: (style) => {
      // Close first, like ink's handleOutputStyleSelect: the apply rebuilds
      // the system instruction, and the dialog should not sit open for it.
      onClose();
      void applyOutputStyleSelection(config, settings, style).then(
        (message) => notify(message),
        (error: unknown) =>
          notify(
            t('Failed to set "{{key}}": {{error}}', {
              key: 'general.outputStyle',
              error: error instanceof Error ? error.message : String(error),
            }),
            'error',
          ),
      );
    },
  });
  useDialogFrameKeys({ onEscape: onClose });

  return (
    <DialogFrame>
      <DialogTitle
        title={t('Output Style')}
        subtitle={t('(applies now and persists to settings)')}
      />
      {catalog ? (
        <LabeledRows list={list} focused />
      ) : (
        <text fg={C.dim}>{t('Loading output styles…')}</text>
      )}
      <FooterHint text={t('(Use Enter to select, Esc to cancel)')} />
    </DialogFrame>
  );
}
