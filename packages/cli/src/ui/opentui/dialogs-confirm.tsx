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
  ToolEditConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolInfoConfirmationDetails,
  ToolMcpConfirmationDetails,
  ToolPlanConfirmationDetails,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import { buildHumanReadableRuleLabel } from '@qwen-code/qwen-code-core/permissions/rule-parser.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { C } from './theme.js';
import { toOriginalKey } from './key-map.js';
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
  CONFIRM_BODY_COLLAPSED_ROWS,
  headWindowPhysical,
  hiddenLinesLabel,
  hiddenTailLinesLabel,
  tailWindow,
  tailWindowPhysical,
} from './messages.js';
import { sanitizeTerminalText } from '../utils/textUtils.js';
import type { ShellConfirmationResolution } from './commands-context.js';
import { McpApprovalChoice } from '../components/mcp/MCPServerApprovalDialog.js';
import type { PendingMcpServer } from '../hooks/useMcpApproval.js';
import { t } from '../../i18n/index.js';

/** Structural mirror of live-session's `WaitingCallInfo` (no import cycle). */
export interface PendingToolConfirmation {
  callId: string;
  name: string;
  confirmationDetails: ToolCallConfirmationDetails;
}

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
  const window = tailWindow(lines, CONFIRM_BODY_COLLAPSED_ROWS);
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
    () => headWindowPhysical(rows, width, CONFIRM_BODY_COLLAPSED_ROWS),
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
  /** Read for folder trust, which gates the always-allow rows. */
  config: Config;
  /** Called after the call has been settled (approved, declined, or answered). */
  onSettled: () => void;
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

  const prompt = buildConfirmationPrompt(details, config.isTrustedFolder());
  return (
    <DialogFrame borderColor={C.yellow}>
      <box flexDirection="column">
        <text fg={C.text} attributes={1}>
          {sanitizeTerminalText(details.title)}
        </text>
        <box marginTop={1} marginBottom={1}>
          <ConfirmationBody details={details} />
        </box>
        <text fg={C.text}>{sanitizeTerminalText(prompt.question)}</text>
        <OutcomeSelect
          options={prompt.options}
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
