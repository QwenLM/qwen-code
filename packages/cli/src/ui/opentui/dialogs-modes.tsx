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
import {
  getHomeEnvFallbackVars,
  SettingScope,
  type LoadedSettings,
} from '../../config/settings.js';
import {
  getPersistScopeForModelSelection,
  getWritableScopes,
} from '../../config/modelProvidersScope.js';
import { findRawModelProviderEntries } from '../../config/loadedSettingsAdapter.js';
import {
  deleteNestedPropertySafe,
  settingExistsInScope,
} from '../../config/settingsUtils.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { preserveModelProviderPlaceholders } from '@qwen-code/qwen-code-core/providers/model-config-serialization.js';
import { resolveEnvVarsInObject } from '@qwen-code/qwen-code-core/envVarResolver';
import type {
  ModelConfig,
  ModelProvidersConfig,
} from '@qwen-code/qwen-code-core/models/types.js';
import { tryResolveModelProtocol } from '@qwen-code/qwen-code-core/models/modelRegistry.js';
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
  truncateToWidth,
} from '../utils/textUtils.js';
import {
  regionListWindow,
  wrappedRows,
  type DialogListItem,
} from './dialogs-core.js';
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
  // Where the title fills the row on its own it yields half of it instead:
  // the subtitle can be the only place a trust-gate refusal paints, and a
  // rejected Enter whose reason paints nothing reads as a dead key.
  const titleWidth = getCachedStringWidth(titleRun);
  const leftover = contentWidth - titleWidth;
  const subtitleColumns = props.subtitle
    ? leftover > 0
      ? leftover
      : Math.floor(contentWidth / 2)
    : 0;
  // The subtitle is an adjacent text with no gap of its own, so the run's
  // trailing separator space is budgeted outside the clip and re-appended:
  // the fallback branch's budget is always strict, and a clip that reaches
  // the space glues the two runs into one unreadable word.
  const separated = Boolean(props.subtitle) && subtitleColumns > 0;
  const titleBudget = Math.max(
    0,
    contentWidth - subtitleColumns - (separated ? 1 : 0),
  );
  return (
    <box flexDirection="row" marginBottom={props.marginBottom ?? 1}>
      <text fg={C.text} attributes={1}>
        {separated
          ? `${clipToWidth(titleRun, titleBudget)} `
          : clipToWidth(titleRun, titleBudget)}
      </text>
      {separated ? (
        <text fg={C.dim}>
          {truncateToWidth(props.subtitle ?? '', subtitleColumns)}
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

/** One margin row plus the wrapped text rows of a notice below the list. */
function noticeRows(text: string | null, contentWidth: number): number {
  return text ? 1 + wrappedRows(text, contentWidth) : 0;
}

/**
 * The rows a non-truncating DialogTitle paints: the subtitle is an adjacent
 * run that wraps within the columns the title leaves, and the row box is as
 * tall as the taller of the two — so the budget pays the measured maximum,
 * not a flat row. When the two runs overflow the row together the renderer
 * shrinks both, so the split charge is bounded by the runs wrapped as one
 * (plus the partial row each shrunken box can waste): an unbounded remainder
 * charge counts a one-column leftover a dozen rows the box never paints, and
 * the chrome alone can then outgrow the region.
 */
function dialogTitleRows(
  title: string,
  subtitle: string | undefined,
  contentWidth: number,
): number {
  const titleRun = `> ${title} `;
  const titleRowCount = wrappedRows(titleRun, contentWidth);
  if (!subtitle) return titleRowCount;
  const splitRows = wrappedRows(
    subtitle,
    Math.max(1, contentWidth - getCachedStringWidth(titleRun)),
  );
  const ceiling = wrappedRows(`${titleRun}${subtitle}`, contentWidth) + 1;
  return Math.min(Math.max(titleRowCount, splitRows), ceiling);
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
  const listRows =
    constrainedHeight -
    chromeWithoutFooter -
    (showFooterHint ? FOOTER_HINT_ROWS : 0);
  if (listRows < 0) {
    // The chrome alone overfills a region this short: a list row squeezed in
    // anyway overpaints the title, so the step paints its title only and the
    // keys have no painted row to commit (the hook refuses Enter below a
    // one-row window, and the digit guard's window is empty). At exactly zero
    // the row borrows the frame's bottom padding row, which is blank — both
    // ink and the pre-budget code paint it there.
    return {
      showModeSpacer,
      showFooterHint,
      showScrollArrows: false,
      maxItemsToShow: 0,
    };
  }
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
  // refusal is charged first: it is the actionable notice, and a rejected
  // Enter whose explanation paints nothing reads as a dead key, so it keeps
  // one painted text row whenever the region can pay it — but never past the
  // cap: a refusal charged the list floor's own row overcommits the region,
  // and the renderer takes the overdraw out of the mode row, the refusal's
  // glyphs painting over where the row stood. The advisory warning takes
  // only what the refusal leaves; a one-row charge paints its text row with
  // the margin shed, like the refusal's.
  const rowsAfterChrome =
    regionHeight === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(
          0,
          regionHeight -
            MODE_LIST_CHROME_ROWS -
            (regionHeight >= MIN_HEIGHT_WITH_MODE_SPACER ? 1 : 0),
        );
  const noticeCap = Math.max(0, rowsAfterChrome - 1);
  // A one-row charge is the text row with its margin shed — the least a
  // rejected Enter can explain itself with, and a region that cannot pay even
  // that carries the refusal in the title's subtitle instead (below).
  const errorRows = error
    ? Math.max(
        Math.min(noticeRows(error, contentWidth), noticeCap),
        Math.min(2, noticeCap),
      )
    : 0;
  const warningRows = warningText
    ? Math.min(
        Math.max(0, noticeCap - errorRows),
        Math.max(
          WORKSPACE_PRIORITY_WARNING_ROWS,
          noticeRows(warningText, contentWidth),
        ),
      )
    : 0;
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
  // `overflow="hidden"`. This frame does not clip, so the step runs the same
  // budget as the mode step; below a five-row region the budget paints no
  // list row at all — the title and the first row were measured overpainting
  // each other at region heights three and four — and Enter refuses to
  // commit a row nothing painted.
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
            // Where the region cannot pay the refusal a row of its own, the
            // title row — the one row every region paints — carries it.
            subtitle={
              error && errorRows === 0 ? error : otherScopeModifiedMessage
            }
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
            <box
              marginTop={warningRows > 1 ? 1 : 0}
              height={warningRows > 1 ? warningRows - 1 : 1}
              overflow="hidden"
            >
              <text fg={C.yellow}>{warningText}</text>
            </box>
          ) : null}
          {error && errorRows > 0 ? (
            <box
              marginTop={errorRows > 1 ? 1 : 0}
              height={errorRows > 1 ? errorRows - 1 : 1}
              overflow="hidden"
            >
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

/**
 * A static effort in `extra_body`/`samplingParams` outranks the session tier in
 * the provider's request builder (the DeepSeek path merges those raw knobs
 * last). The picker removes those keys from the live config and from the
 * persisted provider entry, leaving `model.reasoningEffort` as the single
 * authority. Both supported shapes are covered: the flat `reasoning_effort`
 * string and the nested `reasoning.effort`; sibling keys are preserved.
 */
function stripEffortBlock(block: Record<string, unknown> | undefined): {
  block: Record<string, unknown> | undefined;
  changed: boolean;
  /** Paths removed relative to this block, for a per-key disk delete. */
  removedPaths: string[];
} {
  if (!block) return { block, changed: false, removedPaths: [] };
  let next = block;
  let changed = false;
  const removedPaths: string[] = [];
  if (typeof block['reasoning_effort'] === 'string') {
    const { reasoning_effort: _drop, ...rest } = next;
    next = rest;
    changed = true;
    removedPaths.push('reasoning_effort');
  }
  const reasoning = block['reasoning'];
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    const nested = reasoning as Record<string, unknown>;
    if (typeof nested['effort'] === 'string') {
      const { effort: _drop, ...rest } = nested;
      changed = true;
      if (Object.keys(rest).length > 0) {
        next = { ...next, reasoning: rest };
        removedPaths.push('reasoning.effort');
      } else {
        const { reasoning: _dropReasoning, ...without } = next;
        next = without;
        removedPaths.push('reasoning');
      }
    }
  }
  return { block: changed ? next : block, changed, removedPaths };
}

function stripLiveEffortOverrides(config: Config): void {
  // `applyReasoningEffort` is a no-op when thinking is explicitly disabled;
  // removing a raw knob there would change a config the picker cannot edit.
  if (config.getContentGeneratorConfig()?.reasoning === false) return;
  const strip = (
    generation:
      | {
          extra_body?: Record<string, unknown>;
          samplingParams?: Record<string, unknown>;
        }
      | undefined,
  ): void => {
    if (!generation) return;
    const extraBody = stripEffortBlock(generation.extra_body);
    if (extraBody.changed) {
      generation.extra_body =
        extraBody.block && Object.keys(extraBody.block).length > 0
          ? extraBody.block
          : undefined;
    }
    const samplingParams = stripEffortBlock(generation.samplingParams);
    if (samplingParams.changed) {
      generation.samplingParams =
        samplingParams.block && Object.keys(samplingParams.block).length > 0
          ? samplingParams.block
          : undefined;
    }
  };
  strip(config.getContentGeneratorConfig());
  const modelsConfig = config.getModelsConfig?.();
  strip(modelsConfig?.getGenerationConfig?.());
  const generation = config.getContentGeneratorConfig?.();
  const authType = generation?.authType;
  const modelId = config.getModel?.();
  if (authType && modelId) {
    // Same-model sub-agents inherit the registry entry's generationConfig.
    const resolved = modelsConfig?.getResolvedModel?.(
      authType,
      modelId,
      generation?.baseUrl,
    );
    strip(resolved?.generationConfig);
  }
}

interface ActiveProviderEntry {
  scope: SettingScope;
  key: string;
  entries: unknown[];
  index: number;
}

/**
 * The one effective provider entry the live config came from. `modelProviders`
 * is merged per provider key, so the owning scope can differ from the entry's
 * protocol key. Matching mirrors `findModelConfig`: id + authType, with the
 * live baseUrl first and the persisted `model.baseUrl` second; an ambiguous set
 * yields no target rather than rewriting a sibling provider. System-owned
 * buckets are visible here so a shadowed writable bucket is never rewritten.
 */
function findActiveProviderEntry(
  config: Config,
  settings: LoadedSettings,
): ActiveProviderEntry | undefined {
  const authType = config.getContentGeneratorConfig?.()?.authType;
  const activeId = config.getModel?.();
  if (!authType || !activeId) return undefined;

  const seenKeys = new Set<string>();
  const effective: Array<{
    scope: SettingScope;
    key: string;
    entries: unknown[];
  }> = [];
  for (const scope of [
    SettingScope.System,
    ...(settings.isTrusted ? [SettingScope.Workspace] : []),
    SettingScope.User,
    SettingScope.SystemDefaults,
  ]) {
    const providers = settings.forScope(scope).settings.modelProviders;
    if (!providers || typeof providers !== 'object') continue;
    for (const [key, entries] of Object.entries(providers)) {
      if (!Array.isArray(entries) || seenKeys.has(key)) continue;
      seenKeys.add(key);
      effective.push({ scope, key, entries });
    }
  }

  const candidates: ActiveProviderEntry[] = [];
  for (const bucket of effective) {
    for (let index = 0; index < bucket.entries.length; index++) {
      const entry = bucket.entries[index];
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (record['id'] !== activeId) continue;
      if (
        tryResolveModelProtocol(
          bucket.key,
          record as { wireApi?: 'chat-completions' | 'responses' },
          settings.merged.providerProtocol,
        ) !== authType
      ) {
        continue;
      }
      candidates.push({ ...bucket, index });
    }
  }
  const entryBaseUrl = ({ entries, index }: ActiveProviderEntry) =>
    (entries[index] as Record<string, unknown>)['baseUrl'];
  const trimUrl = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\/+$/, '') : undefined;
  const liveBaseUrl = trimUrl(config.getContentGeneratorConfig?.()?.baseUrl);
  if (liveBaseUrl) {
    const exact = candidates.filter(
      (candidate) => trimUrl(entryBaseUrl(candidate)) === liveBaseUrl,
    );
    if (exact.length === 1) return exact[0];
  }
  const persistedBaseUrl = trimUrl(settings.merged.model?.baseUrl);
  if (persistedBaseUrl) {
    const exact = candidates.filter(
      (candidate) => trimUrl(entryBaseUrl(candidate)) === persistedBaseUrl,
    );
    if (exact.length === 1) return exact[0];
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Write or clear `model.reasoningEffort` in one scope. */
function writeReasoningSelection(
  settings: LoadedSettings,
  scope: SettingScope,
  value: ReasoningEffort | undefined,
): void {
  settings.setValue(scope, 'model.reasoningEffort', value, undefined, {
    throwOnWriteFailure: true,
  });
  if (value !== undefined) return;
  const file = settings.forScope(scope);
  for (const target of [file.settings, file.originalSettings]) {
    if (target) {
      deleteNestedPropertySafe(
        target as Record<string, unknown>,
        'model.reasoningEffort',
      );
    }
  }
  settings.recomputeMerged();
}

/**
 * `model.generationConfig` is the global fallback for the same raw effort
 * knobs. Strip those from the raw scope objects too: it is written through the
 * original (unexpanded) value so placeholders survive.
 */
function stripModelGenerationConfigEffort(settings: LoadedSettings): void {
  for (const scope of getWritableScopes(settings)) {
    const file = settings.forScope(scope);
    const rawModel = file.originalSettings?.model as
      | Record<string, unknown>
      | undefined;
    const generationConfig = rawModel?.['generationConfig'];
    if (!generationConfig || typeof generationConfig !== 'object') continue;
    const raw = generationConfig as Record<string, unknown>;
    const extraBody = stripEffortBlock(
      raw['extra_body'] as Record<string, unknown> | undefined,
    );
    const samplingParams = stripEffortBlock(
      raw['samplingParams'] as Record<string, unknown> | undefined,
    );
    if (!extraBody.changed && !samplingParams.changed) continue;
    // An object value is deep-merged by the JSONC writer, so a block that kept
    // a sibling (e.g. temperature) would silently retain the removed effort
    // key. Write each removed path as `undefined` instead: that becomes a
    // delete operation. A block emptied completely is deleted as a whole.
    const changes: string[] = [];
    if (extraBody.changed) {
      if (!extraBody.block || Object.keys(extraBody.block).length === 0) {
        changes.push('extra_body');
      } else {
        changes.push(
          ...extraBody.removedPaths.map((path) => `extra_body.${path}`),
        );
      }
    }
    if (samplingParams.changed) {
      if (
        !samplingParams.block ||
        Object.keys(samplingParams.block).length === 0
      ) {
        changes.push('samplingParams');
      } else {
        changes.push(
          ...samplingParams.removedPaths.map(
            (path) => `samplingParams.${path}`,
          ),
        );
      }
    }
    settings.setValues(
      changes.map((path) => ({
        scope,
        key: `model.generationConfig.${path}`,
        value: undefined,
      })),
    );
    for (const path of changes) {
      for (const target of [file.settings.model, file.originalSettings.model]) {
        if (target) {
          deleteNestedPropertySafe(
            target as Record<string, unknown>,
            `generationConfig.${path}`,
          );
        }
      }
    }
    file.settings.model = resolveEnvVarsInObject(
      file.originalSettings.model,
      getHomeEnvFallbackVars(),
    ) as typeof file.settings.model;
    settings.recomputeMerged();
  }
}

/**
 * Persist the picked tier, and remove the static effort keys so the global
 * tier is not shadowed after a restart: the active provider entry (its own
 * per-key merged scope), the registry copy (live session), and
 * `model.generationConfig` (global fallback). A provider id containing a dot
 * cannot be addressed by the settings dot path, so its entry is left untouched
 * rather than corrupting the tree.
 */
function persistEffortSelection(
  config: Config | undefined,
  settings: LoadedSettings,
  effort: ReasoningEffort,
): void {
  const persistScope = getPersistScopeForModelSelection(settings);
  const writableScopes = getWritableScopes(settings);
  const clearScopes = writableScopes.filter(
    (scope) =>
      scope !== persistScope &&
      settingExistsInScope(
        'model.reasoningEffort',
        settings.forScope(scope).settings,
      ),
  );

  // Removing a raw knob while thinking is explicitly disabled would destroy a
  // setting the picker cannot meaningfully edit; only the tier is persisted.
  const reasoningDisabled =
    config?.getContentGeneratorConfig?.()?.reasoning === false;
  const active = config ? findActiveProviderEntry(config, settings) : undefined;
  if (
    !reasoningDisabled &&
    active &&
    writableScopes.includes(active.scope) &&
    !active.key.includes('.')
  ) {
    const record = active.entries[active.index] as Record<string, unknown>;
    const generationConfig = record['generationConfig'];
    if (generationConfig && typeof generationConfig === 'object') {
      const generation = generationConfig as Record<string, unknown>;
      const extraBody = stripEffortBlock(
        generation['extra_body'] as Record<string, unknown> | undefined,
      );
      const samplingParams = stripEffortBlock(
        generation['samplingParams'] as Record<string, unknown> | undefined,
      );
      if (extraBody.changed || samplingParams.changed) {
        const nextGeneration = { ...generation };
        if (extraBody.changed) {
          if (extraBody.block && Object.keys(extraBody.block).length > 0) {
            nextGeneration['extra_body'] = extraBody.block;
          } else {
            delete nextGeneration['extra_body'];
          }
        }
        if (samplingParams.changed) {
          if (
            samplingParams.block &&
            Object.keys(samplingParams.block).length > 0
          ) {
            nextGeneration['samplingParams'] = samplingParams.block;
          } else {
            delete nextGeneration['samplingParams'];
          }
        }
        const nextEntries = [...active.entries];
        nextEntries[active.index] = {
          ...record,
          generationConfig: nextGeneration,
        };
        // The in-memory bucket holds env-expanded values; the raw bucket keeps
        // `${VAR}` placeholders. Restore them before saving so a credential is
        // never written to settings.json in plaintext.
        const file = settings.forScope(active.scope);
        const previous = file.settings.modelProviders?.[active.key] ?? [];
        const resolvedProviders = (
          active.key === AuthType.USE_OPENAI
            ? (settings.merged.modelProviders ?? {})
            : { [active.key]: previous }
        ) as ModelProvidersConfig;
        const rawProviders = (
          active.key === AuthType.USE_OPENAI
            ? Object.fromEntries(
                Object.keys(resolvedProviders).map((id) => [
                  id,
                  findRawModelProviderEntries(settings, id) ?? [],
                ]),
              )
            : {
                [active.key]:
                  findRawModelProviderEntries(settings, active.key) ?? [],
              }
        ) as ModelProvidersConfig;
        const persistedEntries = preserveModelProviderPlaceholders(
          nextEntries as ModelConfig[],
          active.key,
          resolvedProviders,
          rawProviders,
          settings.merged.providerProtocol,
        );
        // The static key is what can shadow the global tier, so write it first:
        // a failed second write must not leave the old shadow in place.
        settings.setValue(
          active.scope,
          `modelProviders.${active.key}`,
          persistedEntries,
          undefined,
          { throwOnWriteFailure: true },
        );
        file.settings.modelProviders = resolveEnvVarsInObject(
          file.originalSettings.modelProviders,
          getHomeEnvFallbackVars(),
        );
        settings.recomputeMerged();
      }
    }
  }

  if (!reasoningDisabled) {
    stripModelGenerationConfigEffort(settings);
  }
  writeReasoningSelection(settings, persistScope, effort);
  for (const scope of clearScopes) {
    writeReasoningSelection(settings, scope, undefined);
  }
}

export function OpenTuiEffortDialog(props: {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  notify?: (text: string, level?: 'info' | 'error') => void;
  /** Footer entry: preselect the tier the footer currently displays. */
  initialEffort?: ReasoningEffort;
  /** The popup region's row budget; the tier list windows from it. */
  availableTerminalHeight?: number;
}) {
  const { config, settings, onClose, notify, initialEffort } = props;
  const tiers = config
    ? [...getReasoningEffortsForConfig(config)]
    : (REASONING_EFFORT_TIERS as ReasoningEffort[]);
  // Pre-select the live tier only when this model exposes it; an unset or
  // out-of-range effort starts at the top (ink EffortDialog parity).
  const currentEffort = initialEffort ?? config?.getReasoningEffort?.();
  const configuredIndex = currentEffort ? tiers.indexOf(currentEffort) : -1;
  const items: Array<LabeledItem<ReasoningEffort>> = tiers.map((tier) => ({
    key: tier,
    value: tier,
    label: `${tier} — ${t(EFFORT_DESCRIPTIONS[tier])}`,
  }));
  // The frame (4) and the margin rows under the title, the note and the
  // footer hint are the rows no run can wrap into; the title — measured
  // through the two-run dialogTitleRows measurement, since the subtitle
  // wraps on narrow terminals — the unconfigured-model note and the footer
  // hint are charged the rows they wrap into at the content width, and the
  // tier list windows from what is left instead of the flat ten-row default.
  const regionHeight = clampDialogHeight(props.availableTerminalHeight);
  const { width } = useTerminalDimensions();
  const effortContentWidth = dialogContentWidth(width);
  const effortTitleRows = dialogTitleRows(
    t('Reasoning Effort'),
    t('(applied across all providers; clamped per model)'),
    effortContentWidth,
  );
  const noteText = currentEffort
    ? t(
        '{{effort}} is not available for this model — using the model/provider default.',
        { effort: currentEffort },
      )
    : t('No effort configured — using the model/provider default.');
  const showEffortNote = configuredIndex === -1;
  const effortFooterText = t('(Use Enter to select, Esc to cancel)');
  const tierWindow = regionListWindow(
    regionHeight,
    {
      fixed: 4 + 1 + (showEffortNote ? 1 : 0) + 1,
      measuredRows: effortTitleRows,
      runs: [
        ...(showEffortNote
          ? [{ text: noteText, width: effortContentWidth }]
          : []),
        { text: effortFooterText, width: effortContentWidth },
      ],
    },
    items.length,
    DEFAULT_MAX_ITEMS_TO_SHOW,
  );
  const list = useDialogSelect<LabeledItem<ReasoningEffort>>({
    items,
    initialIndex: Math.max(0, configuredIndex),
    maxItemsToShow: tierWindow.maxItemsToShow,
    onSelect: (effort) => {
      try {
        // Apply at runtime (next turn); provider adapters clamp the tier per
        // model (ink useEffortCommand parity — the request pipeline reads the
        // live config per request).
        if (config) {
          applyReasoningEffort(config, effort);
          // A saved raw knob outranks the session tier in the request builder;
          // drop it in memory so the wire and the footer follow the picker.
          stripLiveEffortOverrides(config);
        }
        persistEffortSelection(config, settings, effort);
        // Read back after the apply: the message names what the provider
        // actually clamped the tier to, not what the row asked for.
        if (config) notify?.(formatEffortChangeMessage(config, effort));
      } catch (error) {
        // Persisting is the point of this picker; a silent failure would tell
        // the user it survived when a restart will drop it.
        notify?.(
          error instanceof Error ? error.message : String(error),
          'error',
        );
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
      <LabeledRows
        list={list}
        focused
        maxItemsToShow={tierWindow.maxItemsToShow}
        showScrollArrows={tierWindow.showScrollArrows}
      />
      {configuredIndex === -1 ? (
        <box marginTop={1}>
          <text fg={C.dim}>{noteText}</text>
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
  /** The popup region's row budget; the style list windows from it. */
  availableTerminalHeight?: number;
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
  // The frame (4), the title and its margin (measured — the subtitle wraps
  // on narrow terminals) and the footer hint (measured the same way) come
  // off the region first; the catalog windows from what is left instead of
  // the flat ten-row default.
  const { width } = useTerminalDimensions();
  const styleContentWidth = dialogContentWidth(width);
  const styleTitleRows = dialogTitleRows(
    t('Output Style'),
    t('(applies now and persists to settings)'),
    styleContentWidth,
  );
  const styleFooterText = t('(Use Enter to select, Esc to cancel)');
  const styleWindow = regionListWindow(
    clampDialogHeight(props.availableTerminalHeight),
    {
      // The frame (4) and the margin rows under the title and the footer
      // hint; the runs themselves are measured.
      fixed: 4 + 1 + 1,
      measuredRows: styleTitleRows,
      runs: [{ text: styleFooterText, width: styleContentWidth }],
    },
    items.length,
    DEFAULT_MAX_ITEMS_TO_SHOW,
  );
  const list = useDialogSelect<LabeledItem<OutputStyleDefinition | undefined>>({
    items,
    initialIndex: Math.max(
      0,
      items.findIndex((item) => item.key.toLowerCase() === wanted),
    ),
    maxItemsToShow: styleWindow.maxItemsToShow,
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
        <LabeledRows
          list={list}
          focused
          maxItemsToShow={styleWindow.maxItemsToShow}
          showScrollArrows={styleWindow.showScrollArrows}
        />
      ) : (
        <text fg={C.dim}>{t('Loading output styles…')}</text>
      )}
      <FooterHint text={t('(Use Enter to select, Esc to cancel)')} />
    </DialogFrame>
  );
}
