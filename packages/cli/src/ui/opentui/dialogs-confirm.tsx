/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Real confirmation renderers for the OpenTUI backend (Batch 6).
 *
 * Batch 5 shipped a deny-everything confirmation bridge because no confirmation
 * renderer existed yet; a pending promise there would hang the dispatcher. This
 * module replaces that stub with actual dialogs so model turns and shell
 * commands can be approved interactively:
 *
 *  - {@link OpenTuiToolConfirmation} renders a scheduler tool call that parked
 *    in `awaiting_approval` (edit / exec / mcp / info / plan / ask_user_question)
 *    and resolves it through `confirmationDetails.onConfirm`. Every code path
 *    calls `onConfirm` — a request that never settles would hang the whole turn.
 *  - {@link OpenTuiShellConfirmation} renders the slash-processor shell-command
 *    gate and resolves a {@link ShellConfirmationResolution}.
 *  - {@link OpenTuiActionConfirmation} renders a plain yes/no prompt (extension
 *    consent and friends) and resolves a boolean.
 *
 * Deliberate parity gaps (tracked as deferred review items, not silently
 * dropped): the ink "modify with editor" flow is not offered because the
 * live-turn scheduler is constructed with `getPreferredEditor: () => undefined`,
 * and ask_user_question's free-text row advances one tab where ink skips the
 * question after it — ink's TextInput subscribes to Enter a second time, so
 * matching it would reproduce a defect rather than the experience.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationPayload,
  ToolEditConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolInfoConfirmationDetails,
  ToolMcpConfirmationDetails,
  ToolPlanConfirmationDetails,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import { buildHumanReadableRuleLabel } from '@qwen-code/qwen-code-core/permissions/rule-parser.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { useKeyboard, usePaste, useTerminalDimensions } from '@opentui/react';
import { decodePasteBytes, type PasteEvent } from '@opentui/core';
import { C } from './theme.js';
import { Command, matchesCommand, toOriginalKey } from './key-map.js';
import {
  DialogFrame,
  DialogSelect,
  FooterHint,
  dialogAreaWidth,
  useDialogSelect,
  type DialogListItem,
} from './dialogs-shared.js';
import { renderDiffBody } from './diff-render.js';
import {
  headWindowPhysical,
  hiddenLinesLabel,
  hiddenTailLinesLabel,
  tailWindow,
  tailWindowPhysical,
} from './messages.js';
import {
  cpLen,
  getCachedStringWidth,
  sanitizeTerminalText,
  truncateToWidth,
} from '../utils/textUtils.js';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { normalizePastedText } from './input-prompt-model.js';
import { caretSpans, useLineEdit } from './line-edit.js';
import type { ShellConfirmationResolution } from './commands-context.js';
import { McpApprovalChoice } from '../components/mcp/MCPServerApprovalDialog.js';
import { computeHeaderCap } from '../components/messages/AskUserQuestionDialog.js';
import type { PendingMcpServer } from '../hooks/useMcpApproval.js';
import { t } from '../../i18n/index.js';

/** Structural mirror of live-session's `WaitingCallInfo` (no import cycle). */
export interface PendingToolConfirmation {
  callId: string;
  name: string;
  confirmationDetails: ToolCallConfirmationDetails;
}

/** Max body rows before the tail window truncates (keeps dialogs bounded). */
const MAX_BODY_ROWS = 20;

/**
 * Cells the free-text answer row may draw. ink holds this exact field in a
 * TextInput with `inputWidth={50}` and no height — one physical row inside a
 * fixed window — and the confirmation this dialog lives in has no body window
 * of its own, so an unbounded row lets a single long paste grow the dialog past
 * the terminal height and push the options the user still has to pick off
 * screen. Submission is untouched: it reads the stored value, not the drawing.
 */
const CUSTOM_FIELD_WIDTH = 50;

/**
 * The caret's logical line inside that window, and whether the caret cell still
 * falls inside it. One cell is held back for the cursor the selected row draws.
 */
function customFieldWindow(
  line: string,
  caret: number,
  cap: number,
): {
  line: string;
  before: string;
  at: string;
  after: string;
  caretInside: boolean;
} {
  const drawn = truncateToWidth(line, Math.max(1, cap - 1));
  return {
    line: drawn,
    ...caretSpans({ text: drawn, cursor: caret }),
    caretInside: caret <= cpLen(drawn),
  };
}

/**
 * Rows reserved around an EXPANDED body: the inline confirmation's chrome
 * (padding, question, outcome list, waiting row) plus the transcript region
 * that keeps its place above it. The expanded tail window is budgeted as
 * terminal height minus this reserve, so the end of the content — where the
 * options still are — stays on screen (ink reaches the same visible outcome
 * through terminal scrollback). Deliberately generous: erring low makes the
 * window taller than the chrome allows and pushes the options off screen,
 * erring high only hides a few payload rows, which the expanded window's own
 * hidden-rows label reports.
 */
const EXPANDED_BODY_RESERVE_ROWS = 20;

interface OutcomeOption {
  label: string;
  value: ToolConfirmationOutcome;
}

interface ConfirmationPrompt {
  question: string;
  options: OutcomeOption[];
}

/**
 * Confirmation types that reach the outcome list. Written out rather than
 * derived with `Exclude`: {@link ToolCallConfirmationDetails} intersects the
 * union with the `autoModeFallback` bag, and `Exclude` does not distribute over
 * that shape — it would silently keep ask_user_question in the union and the
 * exhaustiveness check below would never fire.
 */
type SelectableConfirmationDetails = (
  | ToolEditConfirmationDetails
  | ToolExecuteConfirmationDetails
  | ToolMcpConfirmationDetails
  | ToolInfoConfirmationDetails
  | ToolPlanConfirmationDetails
) &
  Pick<ToolCallConfirmationDetails, 'autoModeFallback'>;

/**
 * The allow-once / scoped-always-allow / decline list shared by the exec, mcp,
 * and info confirmations. The always-allow labels carry ink's human-readable
 * rule description so the user can see the scope being granted — `run 'touch *'
 * commands` rather than a bare "Always allow" — and are offered only when the
 * caller says they may be.
 */
function allowOnceOrAlways(
  permissionRules: string[] | undefined,
  showAlwaysAllow: boolean,
): OutcomeOption[] {
  const options: OutcomeOption[] = [
    { label: t('Yes, allow once'), value: ToolConfirmationOutcome.ProceedOnce },
  ];
  if (showAlwaysAllow) {
    const action = permissionRules?.length
      ? buildHumanReadableRuleLabel(permissionRules)
      : '';
    options.push(
      {
        label: action
          ? t('Always allow {{action}} in this project', { action })
          : t('Always allow in this project'),
        value: ToolConfirmationOutcome.ProceedAlwaysProject,
      },
      {
        label: action
          ? t('Always allow {{action}} for this user', { action })
          : t('Always allow for this user'),
        value: ToolConfirmationOutcome.ProceedAlwaysUser,
      },
    );
  }
  options.push({
    label: t('No, suggest changes (esc)'),
    value: ToolConfirmationOutcome.Cancel,
  });
  return options;
}

function buildTypePrompt(
  details: SelectableConfirmationDetails,
  showAlwaysAllow: boolean,
): ConfirmationPrompt {
  switch (details.type) {
    case 'edit': {
      const options: OutcomeOption[] = [
        {
          label: t('Yes, allow once'),
          value: ToolConfirmationOutcome.ProceedOnce,
        },
      ];
      if (showAlwaysAllow) {
        options.push({
          label: t('Yes, allow always'),
          value: ToolConfirmationOutcome.ProceedAlways,
        });
      }
      options.push({
        label: t('No, suggest changes (esc)'),
        value: ToolConfirmationOutcome.Cancel,
      });
      return { question: t('Apply this change?'), options };
    }
    case 'exec':
      return {
        question: t("Allow execution of: '{{command}}'?", {
          command: details.rootCommand,
        }),
        options: allowOnceOrAlways(details.permissionRules, showAlwaysAllow),
      };
    case 'mcp':
      return {
        question: t(
          'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?',
          { tool: details.toolName, server: details.serverName },
        ),
        options: allowOnceOrAlways(details.permissionRules, showAlwaysAllow),
      };
    case 'info':
      return {
        question: t('Do you want to proceed?'),
        options: allowOnceOrAlways(details.permissionRules, showAlwaysAllow),
      };
    case 'plan':
      return {
        question: details.title,
        options: [
          {
            label: t('Yes, restore previous mode ({{mode}})', {
              mode: details.prePlanMode ?? 'default',
            }),
            value: ToolConfirmationOutcome.RestorePrevious,
          },
          {
            label: t('Yes, and auto-accept edits'),
            value: ToolConfirmationOutcome.ProceedAlways,
          },
          {
            label: t('Yes, and manually approve edits'),
            value: ToolConfirmationOutcome.ProceedOnce,
          },
          {
            label: t('No, keep planning (esc)'),
            value: ToolConfirmationOutcome.Cancel,
          },
        ],
      };
    default: {
      const exhaustive: never = details;
      return exhaustive;
    }
  }
}

/**
 * Builds the question line and the approval choices for a tool call, matching
 * ink's per-type lists.
 *
 * `hideAlwaysAllow` (explicit-interaction / PM ask rules that a persisted allow
 * rule must not replace) suppresses the always-allow rows, and so does an
 * untrusted folder: granting a durable rule for a workspace the user has not
 * trusted is not a decision the dialog may offer. Cancel is always present so
 * the user can always decline.
 */
export function buildConfirmationPrompt(
  details: SelectableConfirmationDetails,
  isTrustedFolder: boolean,
): ConfirmationPrompt {
  const hideAlways = details.hideAlwaysAllow === true;
  const prompt = buildTypePrompt(details, isTrustedFolder && !hideAlways);

  // An AUTO-mode call that fell back to manual confirmation because the
  // classifier was unavailable offers to leave AUTO mode as part of approving.
  const reason = details.autoModeFallback?.reason;
  if (
    reason === 'classifier_unavailable' ||
    reason === 'consecutive_unavailable'
  ) {
    const cancelIndex = prompt.options.findIndex(
      (option) => option.value === ToolConfirmationOutcome.Cancel,
    );
    prompt.options.splice(
      cancelIndex === -1 ? prompt.options.length : cancelIndex,
      0,
      {
        label: t('Switch to Default Mode and allow once (recommended)'),
        value: ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
      },
    );
  }
  return prompt;
}

/** Renders a colored diff body within a bounded row window. */
function DiffBody({ fileDiff }: { fileDiff: string }) {
  const lines = useMemo(() => renderDiffBody(fileDiff), [fileDiff]);
  const window = tailWindow(lines, MAX_BODY_ROWS);
  return (
    <box flexDirection="column">
      {window.hiddenCount > 0 ? (
        <text
          fg={C.dim}
        >{`... ${window.hiddenCount} earlier line${window.hiddenCount === 1 ? '' : 's'} hidden ...`}</text>
      ) : null}
      {window.visible.map((line, i) => (
        <box key={`${i}`} flexDirection="row">
          {line.map((span, j) => (
            <text key={`${j}`} fg={span.color}>
              {span.text}
            </text>
          ))}
        </box>
      ))}
    </box>
  );
}

/**
 * Plain, sanitized text body. Long bodies keep their head (ink MaxSizedBox
 * overflowDirection 'bottom' parity) with a hidden-tail indicator plus the
 * ink ShowMoreLines hint; ctrl-s expands the full text. The cap counts
 * WRAPPED rows — a single JSON-stringified payload line can wrap to dozens
 * of physical rows, which a logical-row window never bounds.
 */
function TextBody({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const { width, height } = useTerminalDimensions();
  const rows = useMemo(() => sanitizeTerminalText(text).split('\n'), [text]);
  const window = useMemo(
    () => headWindowPhysical(rows, width, MAX_BODY_ROWS),
    [rows, width],
  );
  const expandedWindow = useMemo(
    () =>
      tailWindowPhysical(
        rows,
        width,
        Math.max(height - EXPANDED_BODY_RESERVE_ROWS, 1),
      ),
    [rows, width, height],
  );
  // The ctrl-s promise is "show more lines": offer and honor it only when
  // expansion actually reveals rows the collapsed window hides. On short
  // terminals the expanded tail window is strictly smaller — pressing it
  // would drop head rows, so the handler refuses and the hint must not
  // claim otherwise (R5-2, ink MaxSizedBox honesty parity).
  const canExpand =
    window.hiddenRows > 0 && expandedWindow.hiddenRows < window.hiddenRows;

  useKeyboard((key) => {
    // A body that fits must ignore ctrl-s: the expanded tail window can be
    // shorter than the fitting body and would silently drop its head rows.
    // The same guard covers short terminals, where the expanded tail window
    // is strictly smaller than the collapsed head it would replace — the
    // key's on-screen promise is "show more lines".
    if (key.ctrl && toOriginalKey(key).name === 's' && canExpand) {
      setExpanded(true);
    }
  });

  if (expanded) {
    // ink's expanded screen shows the tail with no label (its head lives in
    // terminal scrollback); the alt-screen viewport has no scrollback to
    // point at, so when the tail window itself still drops rows the label is
    // the only trace of what is missing.
    return (
      <box flexDirection="column">
        {expandedWindow.visible.map((row, i) => (
          <text key={`${i}`}>{row}</text>
        ))}
        {expandedWindow.hiddenRows > 0 ? (
          // The tail window keeps the LAST rows, so what it drops is the
          // head — the same label the transcript's tail windows use (R5-1).
          <text fg={C.dim}>{hiddenLinesLabel(expandedWindow.hiddenRows)}</text>
        ) : null}
      </box>
    );
  }
  if (window.hiddenRows === 0) {
    return (
      <box flexDirection="column">
        {rows.map((row, i) => (
          <text key={`${i}`}>{row}</text>
        ))}
      </box>
    );
  }
  return (
    <box flexDirection="column">
      {window.visible.map((row, i) => (
        <text key={`${i}`}>{row}</text>
      ))}
      <text fg={C.dim}>{hiddenTailLinesLabel(window.hiddenRows)}</text>
      {canExpand ? (
        <text fg={C.dim}>Press ctrl-s to show more lines</text>
      ) : null}
    </box>
  );
}

/** The type-specific body of a tool confirmation. */
function ConfirmationBody({
  details,
}: {
  details: ToolCallConfirmationDetails;
}) {
  switch (details.type) {
    case 'edit':
      return (
        <box flexDirection="column">
          <text fg={C.accent} attributes={1}>
            {sanitizeTerminalText(details.fileName)}
          </text>
          {details.warnings?.map((warning, i) => (
            <text key={`${i}`} fg={C.yellow}>
              {sanitizeTerminalText(`⚠ ${warning}`)}
            </text>
          ))}
          <DiffBody fileDiff={details.fileDiff} />
        </box>
      );
    case 'exec':
      return (
        <box flexDirection="column">
          <text fg={C.accent} attributes={1}>
            {sanitizeTerminalText(details.command)}
          </text>
          {details.warnings?.map((warning, i) => (
            <text key={`${i}`} fg={C.yellow}>
              {sanitizeTerminalText(`⚠ ${warning}`)}
            </text>
          ))}
        </box>
      );
    case 'mcp':
      return (
        <box flexDirection="column">
          <text fg={C.accent}>
            {sanitizeTerminalText(
              t('MCP Server: {{server}}', { server: details.serverName }),
            )}
          </text>
          <text fg={C.accent}>
            {sanitizeTerminalText(
              t('Tool: {{tool}}', { tool: details.toolName }),
            )}
          </text>
        </box>
      );
    case 'info': {
      // A single URL identical to the prompt would be listed twice.
      const displayUrls =
        details.urls !== undefined &&
        !(details.urls.length === 1 && details.urls[0] === details.prompt);
      return (
        <box flexDirection="column">
          <TextBody text={details.prompt} />
          {displayUrls && details.urls?.length ? (
            <box flexDirection="column" marginTop={1}>
              <text>{sanitizeTerminalText(t('URLs to fetch:'))}</text>
              {details.urls.map((url, i) => (
                <text key={`${i}`}>{sanitizeTerminalText(` - ${url}`)}</text>
              ))}
            </box>
          ) : null}
        </box>
      );
    }
    case 'plan':
      return <TextBody text={details.plan} />;
    case 'ask_user_question':
      // Handled by the dedicated question flow; this branch is unreachable
      // when the caller routes questions to AskUserQuestionFlow.
      return null;
    default: {
      const exhaustive: never = details;
      return exhaustive;
    }
  }
}

/** A row in the outcome selection list. */
interface OutcomeItem extends DialogListItem<ToolConfirmationOutcome> {
  label: string;
}

/**
 * Approve/decline selector shared by the tool and shell confirmations. Drives
 * the outcome list with the shared selection-list keyboard behavior.
 */
function OutcomeSelect(props: {
  options: OutcomeOption[];
  onChoose: (outcome: ToolConfirmationOutcome) => void;
}) {
  const items = useMemo<OutcomeItem[]>(
    () =>
      props.options.map((option, index) => ({
        key: `${option.value}-${index}`,
        value: option.value,
        label: option.label,
      })),
    [props.options],
  );
  const select = useDialogSelect<OutcomeItem>({
    items,
    onSelect: (value) => props.onChoose(value),
  });
  return (
    <DialogSelect
      items={items}
      activeIndex={select.activeIndex}
      scrollOffset={select.scrollOffset}
      onHover={select.highlightIndex}
      onWheel={(direction) =>
        select.setActiveIndex(
          direction === 'up'
            ? select.activeIndexRef.current - 1
            : select.activeIndexRef.current + 1,
        )
      }
      onSelectIndex={select.selectIndex}
      renderLabel={(item, { isSelected }) => (
        <text fg={isSelected ? C.accent : C.text}>{item.label}</text>
      )}
    />
  );
}

export interface OpenTuiToolConfirmationProps {
  call: PendingToolConfirmation;
  /** Read for folder trust, which gates the always-allow rows. */
  config: Config;
  /** Called after the call has been settled (approved, declined, or answered). */
  onSettled: () => void;
}

/**
 * ink renders a tool confirmation inline in the transcript, as a sibling
 * directly below the pending tool's own row — no border, no title row and no
 * navigation hint. The two-column margin is the transcript's own and the
 * one-column padding is ink's outer box, which together put the question and
 * the options at column 3; the body adds two more columns of its own.
 */
function InlineConfirmation(props: { children?: ReactNode }) {
  return (
    <box flexDirection="column" marginLeft={2} padding={1}>
      {props.children}
    </box>
  );
}

/**
 * Renders one awaiting tool call and settles it through
 * `confirmationDetails.onConfirm`. ask_user_question gets its own flow; every
 * other type shows its body plus the outcome list.
 */
export function OpenTuiToolConfirmation(props: OpenTuiToolConfirmationProps) {
  const { call, config, onSettled } = props;
  const details = call.confirmationDetails;

  const settledRef = useRef(false);
  const settle = useCallback(
    (outcome: ToolConfirmationOutcome, payload?: ToolConfirmationPayload) => {
      if (settledRef.current) return;
      settledRef.current = true;
      void details.onConfirm(outcome, payload);
      onSettled();
    },
    [details, onSettled],
  );

  // Esc declines, matching the "No (esc)" option label.
  useKeyboard((key) => {
    if (toOriginalKey(key).name === 'escape') {
      settle(ToolConfirmationOutcome.Cancel);
    }
  });

  if (details.type === 'ask_user_question') {
    // ink's ToolConfirmationMessage early-returns this dialog, so neither its
    // border nor the payload title is rendered — the question's own header is
    // the title row.
    return (
      <InlineConfirmation>
        <AskUserQuestionFlow
          details={details}
          onAnswered={(answers) => {
            if (answers === null) {
              settle(ToolConfirmationOutcome.Cancel);
            } else {
              settle(ToolConfirmationOutcome.ProceedOnce, { answers });
            }
          }}
        />
      </InlineConfirmation>
    );
  }

  const prompt = buildConfirmationPrompt(details, config.isTrustedFolder());
  return (
    <InlineConfirmation>
      <box
        flexDirection="column"
        marginLeft={1}
        paddingLeft={1}
        marginBottom={1}
      >
        <ConfirmationBody details={details} />
      </box>
      <box marginBottom={1}>
        <text fg={C.text}>{sanitizeTerminalText(prompt.question)}</text>
      </box>
      <OutcomeSelect
        options={prompt.options}
        onChoose={(outcome) => settle(outcome)}
      />
    </InlineConfirmation>
  );
}

/**
 * ask_user_question parity port of ink's AskUserQuestionDialog: one tab per
 * question plus a review-and-Submit tab, numbered options carrying their
 * descriptions, multi-select checkboxes, and a trailing free-text row.
 *
 * One deliberate divergence. ink mounts a TextInput on the free-text row, and
 * its own Enter subscriber fires alongside the dialog's — both call
 * `selectAndAdvance`, so a typed answer on a multi-question dialog skips the
 * question after it. Every key here runs through the single handler below, so
 * Enter advances exactly one tab.
 */
function AskUserQuestionFlow(props: {
  details: Extract<ToolCallConfirmationDetails, { type: 'ask_user_question' }>;
  onAnswered: (answers: Record<string, string> | null) => void;
}) {
  const { details, onAnswered } = props;
  const questions = details.questions;
  const hasMultipleQuestions = questions.length > 1;
  // Only a multi-question dialog gets the review tab; a single question
  // commits straight from its own.
  const totalTabs = hasMultipleQuestions
    ? questions.length + 1
    : questions.length;

  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState(0);
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [checked, setChecked] = useState<Record<number, string[]>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [typedChecked, setTypedChecked] = useState<Record<number, boolean>>({});
  // Key events can land in one React batch, where the value captured by the
  // render that registered the handler is already stale by the second
  // keystroke. The mirror is written synchronously so each event appends to
  // what the previous one produced.
  const typedRef = useRef<Record<number, string>>({});
  const tabRef = useRef(0);
  const selectedRef = useRef(0);
  const checkedRef = useRef<Record<number, string[]>>({});
  const pickedRef = useRef<Record<number, string>>({});
  const typedCheckedRef = useRef<Record<number, boolean>>({});
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width } = useTerminalDimensions();

  // Derived from the two indices alone so the keyboard handler can read them
  // for the batch's live position rather than for the one this render saw.
  const viewOf = (tabIdx: number, selIdx: number) => {
    const onSubmit = hasMultipleQuestions && tabIdx === totalTabs - 1;
    const q = onSubmit ? undefined : questions[tabIdx];
    return {
      isSubmitTab: onSubmit,
      question: q,
      isMultiSelect: q?.multiSelect === true,
      // The free-text row sits after the predefined options.
      totalOptions: q ? q.options.length + 1 : 2,
      isCustomRow: q !== undefined && selIdx === q.options.length,
    };
  };
  const { isSubmitTab, question, isMultiSelect, isCustomRow } = viewOf(
    tab,
    selected,
  );
  const typedValue = (idx: number) => typedRef.current[idx] ?? typed[idx] ?? '';
  const checkedLabels = (idx: number) =>
    checkedRef.current[idx] ?? checked[idx] ?? [];
  // The state stays as the fallback because `answerFor` also runs during render,
  // for the chip ✓ and the review list, where a ref-only read would report a
  // question unanswered until the first write lands.
  const pickedValue = (idx: number) => pickedRef.current[idx] ?? picked[idx];
  const typedCheckedFor = (idx: number) =>
    typedCheckedRef.current[idx] ?? typedChecked[idx] ?? false;
  const customValue = typedValue(tab);
  const isCustomAnswer =
    question !== undefined &&
    !isMultiSelect &&
    pickedValue(tab) !== undefined &&
    !question.options.some((option) => option.label === pickedValue(tab));

  const answerFor = (idx: number): string | undefined => {
    const current = questions[idx];
    if (!current?.multiSelect) return pickedValue(idx);
    const labels = [...checkedLabels(idx)];
    const own = typedValue(idx).trim();
    if (typedCheckedFor(idx) && own) labels.push(own);
    return labels.length > 0 ? labels.join(', ') : undefined;
  };

  const moveToTab = (next: number) => {
    tabRef.current = next;
    setTab(next);
  };

  const moveToOption = (next: number) => {
    selectedRef.current = next;
    setSelected(next);
  };

  const toggleChecked = (idx: number, label: string) => {
    const current = checkedLabels(idx);
    const next = current.includes(label)
      ? current.filter((value) => value !== label)
      : [...current, label];
    checkedRef.current = { ...checkedRef.current, [idx]: next };
    setChecked((prev) => ({ ...prev, [idx]: next }));
  };

  // A multi-select box tracks whether its free-text entry counts, so typing into
  // it checks the box and emptying it unchecks it again.
  const markTypedChecked = (idx: number, on: boolean) => {
    typedCheckedRef.current = { ...typedCheckedRef.current, [idx]: on };
    setTypedChecked((prev) => ({ ...prev, [idx]: on }));
  };

  const cancelPendingAdvance = () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    advanceTimer.current = null;
  };

  // While a swap is armed, the row it just settled is still drawn and still owns
  // the keys, so the rest of one stdin read would answer the same question again
  // and quietly replace the answer already recorded. Only the answer is locked,
  // not the cursor: a manual ←/→ cancels the swap and this guard with it, and
  // those two are the only moves besides the swap's own, so an armed timer always
  // belongs to the tab the cursor is still on.
  const answerIsLocked = () => advanceTimer.current !== null;

  /**
   * Whether the answer was recorded. The pause of the answer before it can
   * reject this one, and a caller that latches a field on success has to hear
   * about that rather than assume it.
   */
  const selectAndAdvance = (value: string): boolean => {
    if (answerIsLocked()) return false;
    const idx = tabRef.current;
    pickedRef.current = { ...pickedRef.current, [idx]: value };
    setPicked((prev) => ({ ...prev, [idx]: value }));
    if (!hasMultipleQuestions) {
      onAnswered({ [idx]: value });
      return true;
    }
    if (idx >= totalTabs - 1) return true;
    // ink's pause, so the ✓ on the row just answered is visible before the tab
    // swap carries it up into the chip row. A second answer inside that pause is
    // dropped by the lock above instead of arming a second timer: left running,
    // both fire and the question between them is skipped without ever being
    // drawn. A manual ←/→ cancels the swap outright.
    advanceTimer.current = setTimeout(() => {
      advanceTimer.current = null;
      moveToTab(Math.min(tabRef.current + 1, totalTabs - 1));
      moveToOption(0);
    }, 150);
    return true;
  };

  const submitAll = () => {
    const answers: Record<string, string> = {};
    questions.forEach((_, idx) => {
      const answer = answerFor(idx);
      if (answer !== undefined) answers[idx] = answer;
    });
    onAnswered(answers);
  };

  const multiAnswer = (includeTyped: boolean, value: string) => {
    const labels = [...checkedLabels(tabRef.current)];
    const own = value.trim();
    if (includeTyped && own) labels.push(own);
    return labels.length > 0 ? labels.join(', ') : undefined;
  };

  const writeCustomValue = (next: string) => {
    const idx = tabRef.current;
    typedRef.current = { ...typedRef.current, [idx]: next };
    setTyped((prev) => ({ ...prev, [idx]: next }));
    if (questions[idx]?.multiSelect === true) {
      markTypedChecked(idx, next.trim().length > 0);
    }
  };

  // ink mounts this field only while its row is the selected option, and mounts
  // it with the caret past the value it holds. Coming back to the row, or to
  // another question's row, drops the position it was left at.
  const custom = useLineEdit(
    customValue,
    writeCustomValue,
    `${isCustomRow}:${tab}`,
  );

  const submitCustomRow = () => {
    // Re-read rather than use the rendered value: the keystroke that fills the
    // row and this Enter can share one batch.
    const idx = tabRef.current;
    const current = typedValue(idx);
    const value = current.trim();
    const isMulti = questions[idx]?.multiSelect === true;
    if (isMulti) {
      markTypedChecked(idx, value.length > 0);
    }
    if (!value) return;
    const answer = isMulti ? multiAnswer(true, current) : value;
    if (answer === undefined) return;
    // Settle on the verdict, not before it: a submit the pause rejects has to
    // leave the row editable, or the answer the user retypes is swallowed too.
    if (selectAndAdvance(answer)) custom.settle();
  };

  useEffect(
    () => () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    },
    [],
  );

  // The overheads below are ink's, taken line for line; the width they come off
  // is not. ink draws its row in the box a tool confirmation gets inside the
  // transcript, while this one spends two columns of margin, plus the padding
  // already charged inside `rowOverhead`. Recomputed per render so answering
  // re-fits it.
  const answeredHeaders = questions.filter(
    (_, idx) => answerFor(idx) !== undefined,
  ).length;
  const rowOverhead =
    2 + // the dialog's own padding
    (isSubmitTab ? 2 : 1) + // "▸ " when Submit is the active tab
    getCachedStringWidth(t('Submit')) +
    questions.length + // gap={1} between each chip and the Submit chip
    2 * questions.length + // "▸ " or "  " before each header
    2 * answeredHeaders; // " ✓" after each answered header
  const headerCap = computeHeaderCap(
    questions.map((q) => getCachedStringWidth(q.header)),
    width - 2 - rowOverhead,
  );

  // The field re-seeds its buffer during render, so a tab move inside one burst
  // leaves it holding the question that render drew. A keystroke handled now
  // would append to that text and store it under the new tab, so the row keeps
  // its keys only while the burst still stands on the tab it drew — and none at
  // all once its answer has been given. One stdin read carries pastes beside
  // keys, so both paths ask this rather than only the one that dispatches keys.
  const fieldIsMine = () => tabRef.current === tab && !custom.settled;

  useKeyboard((key) => {
    const original = toOriginalKey(key);
    // One stdin burst runs every key it carries against this one closure, so
    // the position each branch acts on comes from the mirrors rather than from
    // what this render drew.
    const {
      isSubmitTab: onReview,
      question: asked,
      isMultiSelect: multi,
      totalOptions: optionCount,
      isCustomRow: onCustomRow,
    } = viewOf(tabRef.current, selectedRef.current);

    if (onCustomRow) {
      // Bare letters belong to the input and ←/→ must not switch tabs while it
      // owns the cursor, so only unambiguous shortcuts are honoured here.
      if (original.name === 'up' || (original.ctrl && original.name === 'p')) {
        moveToOption(Math.max(0, selectedRef.current - 1));
      } else if (
        original.name === 'down' ||
        (original.ctrl && original.name === 'n')
      ) {
        moveToOption(Math.min(optionCount - 1, selectedRef.current + 1));
      } else if (original.name === 'return') {
        submitCustomRow();
      } else if (
        fieldIsMine() &&
        // Only a multi-select answer is recomputed from the typed value, so
        // only one can be widened after its Enter has been recorded. A
        // single-select field whose submit the pause rejected stays editable.
        !(multi && answerIsLocked()) &&
        !custom.handleKey(original) &&
        isPrintableKeyInput(key)
      ) {
        custom.insert(key.sequence);
      }
      return;
    }

    if (
      hasMultipleQuestions &&
      original.name === 'left' &&
      tabRef.current > 0
    ) {
      cancelPendingAdvance();
      moveToTab(tabRef.current - 1);
      moveToOption(0);
      return;
    }
    if (
      hasMultipleQuestions &&
      original.name === 'right' &&
      tabRef.current < totalTabs - 1
    ) {
      cancelPendingAdvance();
      moveToTab(tabRef.current + 1);
      moveToOption(0);
      return;
    }
    if (matchesCommand(Command.SELECTION_UP, key)) {
      moveToOption(Math.max(0, selectedRef.current - 1));
      return;
    }
    if (matchesCommand(Command.SELECTION_DOWN, key)) {
      moveToOption(Math.min(optionCount - 1, selectedRef.current + 1));
      return;
    }

    const numKey = /^[1-9]\d*$/.test(original.sequence)
      ? Number(original.sequence)
      : NaN;
    if (Number.isSafeInteger(numKey) && numKey <= optionCount) {
      const target = numKey - 1;
      moveToOption(target);
      // Single-select commits a predefined option straight from its digit; the
      // free-text row's digit only moves the cursor onto it.
      const option = !multi ? asked?.options[target] : undefined;
      if (option) selectAndAdvance(option.label);
      return;
    }

    if (original.name === 'space' && multi && asked && !answerIsLocked()) {
      const option = asked.options[selectedRef.current];
      if (option) toggleChecked(tabRef.current, option.label);
      return;
    }

    if (original.name === 'return') {
      if (onReview) {
        if (selectedRef.current === 0) submitAll();
        else onAnswered(null);
        return;
      }
      if (multi) {
        const idx = tabRef.current;
        const answer = multiAnswer(typedCheckedFor(idx), typedValue(idx));
        if (answer !== undefined) selectAndAdvance(answer);
        return;
      }
      const option = asked?.options[selectedRef.current];
      if (option) selectAndAdvance(option.label);
    }
    // Escape is owned by OpenTuiToolConfirmation (it settles the whole call).
  });

  // Bracketed pastes arrive as one event with no keypress per character, and
  // the composer that would otherwise consume them is unmounted while a
  // confirmation owns the screen. The write path stores under the live tab, so
  // this asks for the live position too: one read can carry the keys that moved
  // the cursor and the paste that trails them.
  usePaste((event: PasteEvent) => {
    const { isCustomRow: onCustomRow } = viewOf(
      tabRef.current,
      selectedRef.current,
    );
    if (!onCustomRow || !fieldIsMine() || answerIsLocked()) return;
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (!text) return;
    event.preventDefault();
    custom.insert(text);
  });

  // Defensive: an empty question list, or a question with no options, has
  // nothing to answer; settle as cancel (from an effect — settling during
  // render would update the parent mid-render) so the waiting call never
  // hangs.
  useEffect(() => {
    if (questions.length === 0 || question?.options.length === 0) {
      onAnswered(null);
    }
  }, [questions.length, question, onAnswered]);

  const chipRow = (
    <box flexDirection="row" gap={1} marginBottom={1}>
      {questions.map((q, idx) => {
        const active = !isSubmitTab && idx === tab;
        return (
          <text
            key={idx}
            fg={active ? C.accent : C.dim}
            attributes={active ? 1 : 0}
          >
            {(active ? '▸ ' : '  ') +
              truncateToWidth(sanitizeTerminalText(q.header), headerCap) +
              (answerFor(idx) !== undefined ? ' ✓' : '')}
          </text>
        );
      })}
      <text
        fg={isSubmitTab ? C.accent : C.dim}
        attributes={isSubmitTab ? 1 : 0}
      >
        {(isSubmitTab ? '▸ ' : ' ') + t('Submit')}
      </text>
    </box>
  );

  if (isSubmitTab) {
    return (
      <>
        {hasMultipleQuestions ? chipRow : null}
        <box flexDirection="column" marginBottom={1}>
          <text fg={C.text} attributes={1}>
            {t('Your answers:')}
          </text>
          {questions.map((q, idx) => {
            const answer = answerFor(idx);
            return (
              <box key={idx} flexDirection="row" marginLeft={2}>
                <text fg={C.text}>{sanitizeTerminalText(q.header) + ': '}</text>
                {answer ? (
                  <text fg={C.accent}>{sanitizeTerminalText(answer)}</text>
                ) : (
                  <text fg={C.dim}>{t('(not answered)')}</text>
                )}
              </box>
            );
          })}
        </box>
        <box marginTop={1} marginBottom={1}>
          <text fg={C.text}>{t('Ready to submit your answers?')}</text>
        </box>
        <box flexDirection="column">
          <text
            fg={selected === 0 ? C.accent : C.text}
            attributes={selected === 0 ? 1 : 0}
          >
            {(selected === 0 ? '❯ ' : '  ') + `1. ${t('Submit answers')}`}
          </text>
          <text
            fg={selected === 1 ? C.accent : C.text}
            attributes={selected === 1 ? 1 : 0}
          >
            {(selected === 1 ? '❯ ' : '  ') + `2. ${t('Cancel')}`}
          </text>
        </box>
        <FooterHint
          text={t('↑/↓: Navigate | ←/→: Switch tabs | Enter: Select')}
        />
      </>
    );
  }

  if (!question) return null;

  const customMark = isMultiSelect ? (typedChecked[tab] ? '[✓] ' : '[ ] ') : '';
  const customEmphasis = isCustomAnswer || typedChecked[tab] === true;
  const customLabel = `${question.options.length + 1}. `;
  const placeholder = t('Type something...');
  const caretLine = caretSpans({ text: customValue, cursor: custom.caret });
  const fieldCap = Math.max(
    1,
    Math.min(
      CUSTOM_FIELD_WIDTH,
      // The inline confirmation's own two columns of margin and two of padding;
      // `headerCap` charges the same four, split across `rowOverhead`.
      width - 4 - getCachedStringWidth(`❯ ${customMark}${customLabel}> `),
    ),
  );
  const customField = customFieldWindow(
    caretLine.before + caretLine.at + caretLine.after,
    cpLen(caretLine.before),
    fieldCap,
  );

  return (
    <>
      {hasMultipleQuestions ? chipRow : null}
      <box flexDirection="column" marginBottom={1}>
        {!hasMultipleQuestions ? (
          <box marginBottom={1}>
            <text fg={C.accent} attributes={1}>
              {sanitizeTerminalText(question.header)}
            </text>
          </box>
        ) : null}
        <text fg={C.text}>{sanitizeTerminalText(question.question)}</text>
      </box>
      <box flexDirection="column" marginBottom={1}>
        {question.options.map((option, idx) => {
          const isSelected = selected === idx;
          const isChecked =
            isMultiSelect && (checked[tab] ?? []).includes(option.label);
          const isAnswered = !isMultiSelect && picked[tab] === option.label;
          const highlighted = isSelected || isAnswered || isChecked;
          return (
            <box key={idx} flexDirection="column">
              <text
                fg={highlighted ? C.accent : C.text}
                attributes={highlighted ? 1 : 0}
              >
                {(isSelected ? '❯ ' : '  ') +
                  (isMultiSelect ? (isChecked ? '[✓] ' : '[ ] ') : '') +
                  `${idx + 1}. ${sanitizeTerminalText(option.label)}` +
                  (isAnswered ? ' ✓' : '')}
              </text>
              {option.description ? (
                <box
                  marginLeft={
                    2 + (isMultiSelect ? 4 : 0) + String(idx + 1).length + 2
                  }
                >
                  <text fg={C.dim}>
                    {sanitizeTerminalText(option.description)}
                  </text>
                </box>
              ) : null}
            </box>
          );
        })}
        {isCustomRow ? (
          <box flexDirection="row">
            <text fg={C.accent} attributes={1}>
              {'❯ ' + customMark + customLabel}
            </text>
            <text fg={C.accent}>{'> '}</text>
            {customValue ? (
              <>
                <text fg={C.text}>
                  {sanitizeTerminalText(customField.before)}
                </text>
                {/* ink's software cursor: a background-filled cell at the
                    caret, which a text frame cannot show. Past the window the
                    cell has nowhere to go, exactly as in ink's fixed-width
                    TextInput. */}
                {customField.caretInside ? (
                  <text bg={C.accent}>
                    {sanitizeTerminalText(customField.at) || ' '}
                  </text>
                ) : null}
                <text fg={C.text}>
                  {sanitizeTerminalText(customField.after)}
                </text>
              </>
            ) : (
              <>
                <text bg={C.accent}>{placeholder.slice(0, 1)}</text>
                <text fg={C.dim}>{placeholder.slice(1)}</text>
              </>
            )}
          </box>
        ) : (
          <text
            fg={customEmphasis ? C.accent : customValue ? C.text : C.dim}
            attributes={customEmphasis ? 1 : 0}
          >
            {/* The echo is bounded like the row it stands in for: the value it
                prints is the one a paste can make arbitrarily long. */}
            {'  ' +
              customMark +
              customLabel +
              (customValue
                ? sanitizeTerminalText(customField.line)
                : placeholder) +
              (isCustomAnswer ? ' ✓' : '')}
          </text>
        )}
      </box>
      <FooterHint
        text={
          hasMultipleQuestions
            ? isMultiSelect
              ? t(
                  '↑/↓: Navigate | ←/→: Switch tabs | Space: Toggle | Enter: Confirm | Esc: Cancel',
                )
              : t(
                  '↑/↓: Navigate | ←/→: Switch tabs | Enter: Select | Esc: Cancel',
                )
            : isMultiSelect
              ? t(
                  '↑/↓: Navigate | Space: Toggle | Enter: Confirm | Esc: Cancel',
                )
              : t('↑/↓: Navigate | Enter: Select | Esc: Cancel')
        }
      />
    </>
  );
}

export interface OpenTuiShellConfirmationProps {
  commands: readonly string[];
  onResolve: (resolution: ShellConfirmationResolution) => void;
}

/**
 * The slash-processor shell-command gate (ink ShellConfirmationDialog parity):
 * shows the requested commands and resolves an approval outcome. Approving
 * authorizes every requested command, exactly like the original.
 */
export function OpenTuiShellConfirmation(props: OpenTuiShellConfirmationProps) {
  const { commands, onResolve } = props;
  const options = useMemo<OutcomeOption[]>(
    () => [
      {
        label: t('Yes, allow once'),
        value: ToolConfirmationOutcome.ProceedOnce,
      },
      {
        label: t('Always allow in this project'),
        value: ToolConfirmationOutcome.ProceedAlwaysProject,
      },
      {
        label: t('Always allow for this user'),
        value: ToolConfirmationOutcome.ProceedAlwaysUser,
      },
      { label: t('No (esc)'), value: ToolConfirmationOutcome.Cancel },
    ],
    [],
  );

  useKeyboard((key) => {
    if (toOriginalKey(key).name === 'escape') {
      onResolve({ outcome: ToolConfirmationOutcome.Cancel });
    }
  });

  return (
    <DialogFrame borderColor={C.yellow}>
      <box flexDirection="column">
        <text fg={C.text} attributes={1}>
          {t('Shell Command Execution')}
        </text>
        <text fg={C.text}>
          {t('A custom command wants to run the following shell commands:')}
        </text>
        <box marginTop={1} marginBottom={1} flexDirection="column">
          {commands.map((command, i) => (
            <text key={`${i}`} fg={C.accent}>
              {sanitizeTerminalText(command)}
            </text>
          ))}
        </box>
        <OutcomeSelect
          options={options}
          onChoose={(outcome) =>
            onResolve(
              outcome === ToolConfirmationOutcome.Cancel
                ? { outcome }
                : { outcome, approvedCommands: [...commands] },
            )
          }
        />
        <FooterHint
          text={t('↑↓ to choose · Enter to confirm · Esc to cancel')}
        />
      </box>
    </DialogFrame>
  );
}

export interface OpenTuiActionConfirmationProps {
  prompt: ReactNode;
  onResolve: (confirmed: boolean) => void;
}

/**
 * A yes/no confirmation (extension consent and friends). Enter confirms, Esc
 * declines; both paths resolve the promise so the caller never hangs.
 */
export function OpenTuiActionConfirmation(
  props: OpenTuiActionConfirmationProps,
) {
  const { prompt, onResolve } = props;
  const options = useMemo<Array<DialogListItem<boolean>>>(
    () => [
      { key: 'yes', value: true },
      { key: 'no', value: false },
    ],
    [],
  );
  const select = useDialogSelect<DialogListItem<boolean>>({
    items: options,
    numbers: false,
    onSelect: (value) => onResolve(value),
  });

  useKeyboard((key) => {
    if (toOriginalKey(key).name === 'escape') onResolve(false);
  });

  return (
    <DialogFrame borderColor={C.yellow}>
      <box flexDirection="column">
        {prompt}
        <box marginTop={1}>
          <DialogSelect
            items={options}
            activeIndex={select.activeIndex}
            scrollOffset={select.scrollOffset}
            showNumbers={false}
            onHover={select.highlightIndex}
            onSelectIndex={select.selectIndex}
            renderLabel={(item, { isSelected }) => (
              <text fg={isSelected ? C.accent : C.text}>
                {item.value ? t('Yes') : t('No')}
              </text>
            )}
          />
        </box>
        <FooterHint
          text={t('↑↓ to choose · Enter to confirm · Esc to cancel')}
        />
      </box>
    </DialogFrame>
  );
}

interface OpenTuiMcpApprovalProps {
  /** The gated server currently being decided. */
  server: PendingMcpServer;
  /** Everything "approve all" would trust, this server included. */
  pendingServers: readonly PendingMcpServer[];
  /** How many more pending gated servers follow this one. */
  remaining: number;
  onSelect: (choice: McpApprovalChoice) => void;
}

const MCP_APPROVAL_OPTIONS: Array<DialogListItem<McpApprovalChoice>> = [
  { key: 'approve', value: McpApprovalChoice.APPROVE },
  { key: 'approve_all', value: McpApprovalChoice.APPROVE_ALL },
  { key: 'reject', value: McpApprovalChoice.REJECT },
];

function mcpApprovalLabel(choice: McpApprovalChoice): string {
  switch (choice) {
    case McpApprovalChoice.APPROVE:
      return t('Approve this server');
    case McpApprovalChoice.APPROVE_ALL:
      return t('Approve all pending servers in this workspace');
    default:
      return t('Reject (esc)');
  }
}

/**
 * Startup approval for a gated MCP server — a project's `.mcp.json` or the
 * workspace's own settings. The queue, the persisted hash-bound decision and
 * the reconnect all live in the renderer-agnostic hook; this is only the view.
 * Esc declines the current server, which is ink's escape-to-deny convention
 * here. Its radio select prints no navigation hint, so neither does this.
 */
export function OpenTuiMcpApprovalDialog(props: OpenTuiMcpApprovalProps) {
  const { server, pendingServers, remaining, onSelect } = props;
  const { width } = useTerminalDimensions();
  const select = useDialogSelect<DialogListItem<McpApprovalChoice>>({
    items: MCP_APPROVAL_OPTIONS,
    onSelect: (value) => onSelect(value),
  });

  useKeyboard((key) => {
    if (toOriginalKey(key).name === 'escape') {
      onSelect(McpApprovalChoice.REJECT);
    }
  });

  return (
    // ink adds a margin of its own inside the dialog area, which pushes this
    // box's left edge one column further in without moving its right edge — so
    // it measures one narrower than the shared popup width.
    <box marginLeft={3} width={Math.max(0, dialogAreaWidth(width) - 1)}>
      <DialogFrame borderColor={C.yellow}>
        <box flexDirection="column">
          <box flexDirection="column" marginBottom={1}>
            <text fg={C.text} attributes={1}>
              {t('Untrusted MCP server in {{source}}', {
                source: server.source,
              })}
            </text>
            <text fg={C.text}>
              {t(
                'This workspace declares an MCP server. Approving lets Qwen Code start it and run its tools. Approval is bound to this exact configuration — if {{source}} changes, you will be asked again.',
                { source: server.source },
              )}
            </text>
          </box>
          <box flexDirection="column" marginBottom={1}>
            <box flexDirection="row">
              <text fg={C.text} attributes={1}>
                {server.name}
              </text>
              <text fg={C.text}>{`  ${server.summary}`}</text>
            </box>
            {remaining > 0 ? (
              <box flexDirection="column" marginTop={1}>
                <text fg={C.dim}>
                  {t('Approve all will trust these servers:')}
                </text>
                {pendingServers.map((pending) => (
                  <text key={pending.name} fg={C.dim}>
                    {`  ${pending.name}  ${pending.summary}`}
                  </text>
                ))}
              </box>
            ) : null}
          </box>
          <DialogSelect
            items={MCP_APPROVAL_OPTIONS}
            activeIndex={select.activeIndex}
            scrollOffset={select.scrollOffset}
            onHover={select.highlightIndex}
            onSelectIndex={select.selectIndex}
            renderLabel={(item, { isSelected }) => (
              <text fg={isSelected ? C.accent : C.text}>
                {mcpApprovalLabel(item.value)}
              </text>
            )}
          />
        </box>
      </DialogFrame>
    </box>
  );
}
