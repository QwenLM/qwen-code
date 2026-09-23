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
  FooterHint,
  useDialogFrameKeys,
  useDialogSelect,
  type UseDialogSelectResult,
} from './dialogs-shared.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';
import type { DialogListItem } from './dialogs-core.js';
import { C } from './theme.js';
import { getReasoningEffortsForConfig } from '../../acp-integration/model-configuration.js';

interface LabeledItem<T> extends DialogListItem<T> {
  label: string;
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
        <text fg={titleColor}>{item.label}</text>
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
}) {
  return (
    <box flexDirection="row" marginBottom={props.marginBottom ?? 1}>
      <text fg={C.text} attributes={1}>
        {'> '}
        {props.title}{' '}
      </text>
      {props.subtitle ? <text fg={C.dim}>{props.subtitle}</text> : null}
    </box>
  );
}

// ink ApprovalModeDialog's budget thresholds: as the region gets shorter it
// sheds the spacer row, then the footer hint, then windows the list.
const MIN_HEIGHT_WITH_MODE_SPACER = 9;
const MIN_HEIGHT_WITH_FOOTER_HINT = 10;
const MIN_HEIGHT_WITH_WARNING_FOOTER_HINT = 12;
// Frame border + padding (4) plus the title row (1); the spacer, warning and
// footer rows are budgeted separately.
const MODE_LIST_CHROME_ROWS = 5;
const FOOTER_HINT_ROWS = 2;
// Warning margin plus up to two wrapped text rows at the normal dialog width.
const WORKSPACE_PRIORITY_WARNING_ROWS = 3;

/**
 * ink ApprovalModeDialog's derivation, ported line for line: which chrome
 * rows the budget still pays for, and how many mode rows fit in what is left.
 * `constrainedHeight` is the popup region's row budget (undefined when the
 * caller has none, which ink treats as "show everything").
 */
function modeListBudget(
  constrainedHeight: number | undefined,
  workspacePriorityWarning: boolean,
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
    (workspacePriorityWarning
      ? MIN_HEIGHT_WITH_WARNING_FOOTER_HINT
      : MIN_HEIGHT_WITH_FOOTER_HINT);
  const chromeWithoutFooter =
    MODE_LIST_CHROME_ROWS +
    (showModeSpacer ? 1 : 0) +
    (workspacePriorityWarning ? WORKSPACE_PRIORITY_WARNING_ROWS : 0);
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
  const footerWouldHideScrollArrows =
    !workspacePriorityWarning &&
    preferredShowFooterHint &&
    rowsWithPreferredFooter <= 2 &&
    rowsWithoutFooter > 2 &&
    rowsWithoutFooter < itemCount;
  const showFooterHint =
    preferredShowFooterHint && !footerWouldHideScrollArrows;
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

  // ink derives the window from the height its dialog manager hands over;
  // without it the list never windows (the default is 10 rows for 5 items)
  // and on a short terminal the unsized rows shrink to zero and overpaint
  // each other while the keys still commit a mode the user cannot read.
  const budget = modeListBudget(
    clampDialogHeight(props.availableTerminalHeight),
    showWorkspacePriorityWarning,
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
    onHighlight: (mode) => setHighlightedMode(mode),
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
  const scopeList = useDialogSelect<LabeledItem<SettingScope>>({
    items: scopeItems,
    initialIndex: Math.max(
      0,
      scopeItems.findIndex((item) => item.value === selectedScope),
    ),
    focused: view === 'scope',
    numbers: view === 'scope',
    // ink's handleScopeSelect only records the scope and steps back: the mode
    // row's Enter is what persists.
    onSelect: (scope) => {
      setSelectedScope(scope);
      setView('mode');
    },
    onHighlight: (scope) => setSelectedScope(scope),
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
          />
          <LabeledRows
            list={modeList}
            focused={view === 'mode'}
            maxItemsToShow={budget.maxItemsToShow}
            showScrollArrows={budget.showScrollArrows}
          />
          {showWorkspacePriorityWarning ? (
            <box marginTop={1}>
              <text fg={C.yellow}>
                {`⚠ ${t(
                  'Workspace approval mode exists and takes priority. User-level change will have no effect.',
                )}`}
              </text>
            </box>
          ) : null}
          {error ? (
            <box marginTop={1}>
              <text fg={C.red}>{error}</text>
            </box>
          ) : null}
        </box>
      ) : (
        <box flexDirection="column">
          <DialogTitle title={t('Apply To')} />
          <LabeledRows list={scopeList} focused={view === 'scope'} />
        </box>
      )}
      {budget.showFooterHint ? (
        <FooterHint
          text={
            view === 'mode'
              ? t('(Use Enter to select, Tab to configure scope)')
              : t('(Use Enter to apply scope, Tab to go back)')
          }
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
