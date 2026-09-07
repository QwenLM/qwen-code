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
 * and ask_user_question has no free-text "Other" option yet.
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
} from '@qwen-code/qwen-code-core/tools/tools.js';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { C } from './theme.js';
import { toOriginalKey } from './key-map.js';
import {
  DialogFrame,
  DialogSelect,
  FooterHint,
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
import { sanitizeTerminalText } from '../utils/textUtils.js';
import type { ShellConfirmationResolution } from './commands-context.js';
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
 * Rows reserved above/below an EXPANDED body: dialog chrome (frame, title,
 * options, footer) plus the transcript region that keeps its place above the
 * dialog. The expanded tail window is budgeted as terminal height minus this
 * reserve, so the end of the content — where the options still are — stays on
 * screen (ink reaches the same visible outcome through terminal scrollback).
 */
const EXPANDED_BODY_RESERVE_ROWS = 20;

interface OutcomeOption {
  label: string;
  value: ToolConfirmationOutcome;
}

/**
 * Builds the approval choices for a tool call, honoring `hideAlwaysAllow`
 * (explicit-interaction / PM ask rules that a persisted allow rule must not
 * replace). Cancel is always present so the user can always decline.
 */
export function buildOutcomeOptions(
  details: ToolCallConfirmationDetails,
): OutcomeOption[] {
  const options: OutcomeOption[] = [
    { label: t('Yes, allow once'), value: ToolConfirmationOutcome.ProceedOnce },
  ];
  // hideAlwaysAllow lives on only some union members (not ask_user_question).
  const hideAlways =
    'hideAlwaysAllow' in details && details.hideAlwaysAllow === true;
  if (!hideAlways) {
    options.push(
      {
        label: t('Always allow in this project'),
        value: ToolConfirmationOutcome.ProceedAlwaysProject,
      },
      {
        label: t('Always allow for this user'),
        value: ToolConfirmationOutcome.ProceedAlwaysUser,
      },
    );
  }
  options.push({ label: t('No (esc)'), value: ToolConfirmationOutcome.Cancel });
  return options;
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
              {sanitizeTerminalText(warning)}
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
              {sanitizeTerminalText(warning)}
            </text>
          ))}
        </box>
      );
    case 'mcp':
      return (
        <box flexDirection="column">
          <text>
            {sanitizeTerminalText(
              t(
                'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?',
                {
                  tool: details.toolName,
                  server: details.serverName,
                },
              ),
            )}
          </text>
          <text fg={C.accent} attributes={1}>
            {sanitizeTerminalText(details.toolDisplayName)}
          </text>
          <text fg={C.dim}>
            {sanitizeTerminalText(
              `${details.serverName} · ${details.toolName}`,
            )}
          </text>
        </box>
      );
    case 'info':
      return (
        <box flexDirection="column">
          <TextBody text={details.prompt} />
          {details.urls?.map((url, i) => (
            <text key={`${i}`} fg={C.dim}>
              {sanitizeTerminalText(url)}
            </text>
          ))}
        </box>
      );
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
    numbers: false,
    onSelect: (value) => props.onChoose(value),
  });
  return (
    <DialogSelect
      items={items}
      activeIndex={select.activeIndex}
      scrollOffset={select.scrollOffset}
      showNumbers={false}
      onHover={select.highlightIndex}
      onWheel={(direction) =>
        select.setActiveIndex(
          direction === 'up' ? select.activeIndex - 1 : select.activeIndex + 1,
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
  /** Called after the call has been settled (approved, declined, or answered). */
  onSettled: () => void;
}

/**
 * Renders one awaiting tool call and settles it through
 * `confirmationDetails.onConfirm`. ask_user_question gets its own flow; every
 * other type shows its body plus the outcome list.
 */
export function OpenTuiToolConfirmation(props: OpenTuiToolConfirmationProps) {
  const { call, onSettled } = props;
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

  // Esc declines, matching the "No (esc)" option and the footer hint.
  useKeyboard((key) => {
    if (toOriginalKey(key).name === 'escape') {
      settle(ToolConfirmationOutcome.Cancel);
    }
  });

  if (details.type === 'ask_user_question') {
    return (
      <DialogFrame borderColor={C.yellow}>
        <box flexDirection="column">
          <text fg={C.text} attributes={1}>
            {sanitizeTerminalText(details.title)}
          </text>
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
        </box>
      </DialogFrame>
    );
  }

  const options = buildOutcomeOptions(details);
  return (
    <DialogFrame borderColor={C.yellow}>
      <box flexDirection="column">
        <text fg={C.text} attributes={1}>
          {sanitizeTerminalText(details.title)}
        </text>
        <box marginTop={1} marginBottom={1}>
          <ConfirmationBody details={details} />
        </box>
        <OutcomeSelect
          options={options}
          onChoose={(outcome) => settle(outcome)}
        />
        <FooterHint
          text={t('↑↓ to choose · Enter to confirm · Esc to cancel')}
        />
      </box>
    </DialogFrame>
  );
}

/**
 * Sequential ask_user_question flow: walks the questions one at a time,
 * collects single- or multi-select answers, and hands back an ink-parity
 * answers record keyed by question index — or null when the user escapes.
 */
function AskUserQuestionFlow(props: {
  details: Extract<ToolCallConfirmationDetails, { type: 'ask_user_question' }>;
  onAnswered: (answers: Record<string, string> | null) => void;
}) {
  const { details, onAnswered } = props;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const question = details.questions[index];
  const isMulti = question?.multiSelect === true;

  const commitQuestion = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return;
      const nextAnswers = { ...answers, [index]: value };
      setAnswers(nextAnswers);
      setSelected(new Set());
      if (index + 1 < details.questions.length) {
        setIndex(index + 1);
      } else {
        const out: Record<string, string> = {};
        for (const [key, val] of Object.entries(nextAnswers)) {
          out[String(key)] = val;
        }
        onAnswered(out);
      }
    },
    [answers, index, details.questions.length, onAnswered],
  );

  const items = useMemo<Array<DialogListItem<string>>>(
    () =>
      (question?.options ?? []).map((option, i) => ({
        key: `${option.label}-${i}`,
        value: option.label,
      })),
    [question],
  );

  const select = useDialogSelect<DialogListItem<string>>({
    items,
    numbers: false,
    // For single-select we commit directly on Enter; for multi-select Enter is
    // handled by the keyboard hook below (it submits the accumulated set), so
    // onSelect must stay unset in that mode to avoid a double commit.
    onSelect: isMulti ? undefined : (value) => commitQuestion(value),
    resyncKey: index,
  });

  useKeyboard((key) => {
    // Escape is owned by OpenTuiToolConfirmation (it settles the whole call).
    if (!isMulti) return;
    const original = toOriginalKey(key);
    const current = items[select.activeIndex];
    if (!current) return;
    if (original.name === 'space' || original.sequence === ' ') {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(current.value)) next.delete(current.value);
        else next.add(current.value);
        return next;
      });
      return;
    }
    if (original.name === 'return') {
      if (selected.size === 0) return;
      commitQuestion([...selected].join(', '));
    }
  });

  // Defensive: an empty question list, or a question with no options, has
  // nothing to answer; settle as cancel (from an effect — settling during
  // render would update the parent mid-render) so the waiting call never
  // hangs.
  useEffect(() => {
    if (details.questions.length === 0 || !question?.options?.length) {
      onAnswered(null);
    }
  }, [details.questions.length, question, onAnswered]);

  if (!question) return null;

  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={C.dim}>
        {sanitizeTerminalText(question.header)} ({index + 1}/
        {details.questions.length})
      </text>
      <text fg={C.text}>{sanitizeTerminalText(question.question)}</text>
      <box marginTop={1}>
        <DialogSelect
          items={items}
          activeIndex={select.activeIndex}
          scrollOffset={select.scrollOffset}
          showNumbers={false}
          onHover={select.highlightIndex}
          onSelectIndex={select.selectIndex}
          renderLabel={(item, { isSelected }) => {
            const checked = isMulti && selected.has(item.value);
            const marker = isMulti ? (checked ? '[x] ' : '[ ] ') : '';
            return (
              <text fg={isSelected ? C.accent : C.text}>
                {marker + item.value}
              </text>
            );
          }}
        />
      </box>
      <FooterHint
        text={
          isMulti
            ? t('Space to toggle · Enter to submit · Esc to cancel')
            : t('↑↓ to choose · Enter to answer · Esc to cancel')
        }
      />
    </box>
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
