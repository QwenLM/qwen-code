/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Box, Text, useStdin } from 'ink';
import {
  validatePlanPath,
  type Config,
  type EditorType,
  readFileWithEncoding,
  runLogger,
  BRAND_NAME,
} from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { openFileInEditor } from '../utils/editorUtils.js';
import { Command } from '../key/keyMatchers.js';
import { formatCommand } from '../key/keybindingUtils.js';
import {
  useRegisterActionHandlers,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { useRegisterKeyboardContext } from '../contexts/KeyboardContextRegistry.js';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import {
  InputField,
  INLINE_SELECTION_INPUT_WITH_DESCRIPTION_HEIGHT,
  resolveInlineSelectionInputLayout,
} from './shared/InputField.js';
import {
  useTextBuffer,
  expandPastePlaceholders,
} from './shared/text-buffer.js';

export interface ExitPlanModeDialogProps {
  planPath: string;
  planContent?: string;
  /**
   * Called when the user approves the plan. `options.startGoal === true`
   * indicates the user picked "Yes, start goal execution" — caller should
   * also activate the goal loop (Phase 2 §3.2.4).
   */
  onApprove: (options?: { startGoal?: boolean }) => void;
  onFeedback: (feedback: string) => void;
  onCancel: () => void;
  getPreferredEditor: () => EditorType | undefined;
  width: number;
  availableHeight?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

type ApprovalChoice = 'execute' | 'start_goal' | 'refuse_and_say' | 'reject';

const REFUSE_AND_SAY_VALUE: ApprovalChoice = 'refuse_and_say';
const REJECT_VALUE: ApprovalChoice = 'reject';
const START_GOAL_VALUE: ApprovalChoice = 'start_goal';
const EXECUTE_VALUE: ApprovalChoice = 'execute';

/**
 * Builds the plan approval options.
 * Simplified to 4 options (2 approve + 2 reject) to reduce decision cost.
 */
function buildApprovalOptions(): Array<RadioSelectItem<ApprovalChoice>> {
  return [
    {
      label: 'Yes, start executing',
      sublabel: 'Keep current permission mode and begin implementation.',
      value: EXECUTE_VALUE,
      key: 'execute',
    },
    {
      label: 'Yes, execute as Goal',
      sublabel: 'Start the goal loop.',
      value: START_GOAL_VALUE,
      key: 'start_goal',
    },
    {
      label: 'Refuse and say something',
      sublabel: 'Reject this plan and provide feedback to the model.',
      value: REFUSE_AND_SAY_VALUE,
      key: 'refuse_and_say',
    },
    {
      label: 'Reject plan',
      sublabel: 'Reject this plan without providing feedback.',
      value: REJECT_VALUE,
      key: 'reject',
    },
  ];
}

// Lines reserved for chrome outside the plan content box:
//   "Here is X's plan:" label + marginBottom  → 2
//   top/bottom border rows                    → 2
//   marginTop + question (may wrap to 2)       → 3
//   RadioButtonSelect options (label + sublabel per item)
//   marginTop + edit hint                     → 2
const PLAN_CHROME_LINES_BASE = 2 + 2 + 3 + 2;

// The keyboard shortcut label never changes — compute once at module load.
const EDIT_HINT = formatCommand(Command.OPEN_EXTERNAL_EDITOR);

// ─── Plan content state ───────────────────────────────────────────────────────

enum PlanStatus {
  Loading = 'loading',
  Loaded = 'loaded',
  Error = 'error',
}

interface PlanContentState {
  status: PlanStatus;
  content?: string;
  error?: string;
  refresh: () => void;
}

function usePlanContent(
  planPath: string,
  config: Config,
  providedPlanContent?: string,
): PlanContentState {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<Omit<PlanContentState, 'refresh'>>({
    status: PlanStatus.Loading,
  });

  const refresh = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    let ignore = false;
    setState({ status: PlanStatus.Loading });

    const load = async () => {
      if (providedPlanContent !== undefined) {
        const content = providedPlanContent.trim();
        if (!content) {
          setState({ status: PlanStatus.Error, error: 'Plan file is empty.' });
          return;
        }
        setState({ status: PlanStatus.Loaded, content });
        return;
      }

      try {
        const pathError = await validatePlanPath(
          planPath,
          config.storage.getPlansDir(),
        );
        if (ignore) return;
        if (pathError) {
          setState({ status: PlanStatus.Error, error: pathError });
          return;
        }

        const content = await readFileWithEncoding(planPath);
        if (ignore) return;

        if (!content.trim()) {
          setState({ status: PlanStatus.Error, error: 'Plan file is empty.' });
          return;
        }
        setState({ status: PlanStatus.Loaded, content: content.trim() });
      } catch (err: unknown) {
        if (ignore) return;
        const errorMessage = err instanceof Error ? err.message : String(err);
        setState({ status: PlanStatus.Error, error: errorMessage });
      }
    };

    void load();

    return () => {
      ignore = true;
    };
  }, [planPath, config.storage, providedPlanContent, version]);

  return { ...state, refresh };
}

// ─── Component ────────────────────────────────────────────────────────────────

const StatusMessage: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <Box paddingX={1}>{children}</Box>;

export const ExitPlanModeDialog: React.FC<ExitPlanModeDialogProps> = ({
  planPath,
  planContent,
  onApprove,
  onFeedback,
  onCancel,
  getPreferredEditor,
  width,
  availableHeight,
}) => {
  const config = useConfig();
  const { stdin, setRawMode } = useStdin();
  const planState = usePlanContent(planPath, config, planContent);
  const { refresh } = planState;
  const [showLoading, setShowLoading] = useState(false);
  const canEditPlan = planContent === undefined;
  const [typeSomethingActive, setTypeSomethingActive] = useState(false);

  const approvalOptions = useMemo(() => buildApprovalOptions(), []);

  const inputLayout = resolveInlineSelectionInputLayout(width - 4);
  const buffer = useTextBuffer({
    initialText: '',
    viewport: inputLayout.viewport,
    singleLine: true,
  });

  // A GUI editor session outlives this dialog: Ctrl+C now reaches
  // `app:interrupt` while the editor is open (it used to be swallowed by the
  // input gate), so the user can abort the confirmation and unmount us with
  // the editor still on screen. Without this guard the continuation below
  // still fires when they finally close it, messaging the model about a plan
  // review the user already cancelled.
  const isMountedRef = useRef(true);
  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    [],
  );

  const handleOpenEditor = useCallback(async () => {
    if (!canEditPlan) {
      return;
    }

    try {
      await openFileInEditor(planPath, stdin, setRawMode, getPreferredEditor());
      if (!isMountedRef.current) {
        return;
      }
      onFeedback(
        'I have edited the plan or annotated it with feedback. Review the edited plan, update if necessary, and present it again for approval.',
      );
      refresh();
    } catch (err) {
      runLogger.error('Failed to open plan in editor:', err);
    }
  }, [
    canEditPlan,
    planPath,
    stdin,
    setRawMode,
    getPreferredEditor,
    refresh,
    onFeedback,
  ]);

  const handleHighlight = useCallback((item: ApprovalChoice) => {
    setTypeSomethingActive(item === REFUSE_AND_SAY_VALUE);
  }, []);

  const submitFeedback = useCallback(
    (raw: string) => {
      const trimmed = expandPastePlaceholders(raw, buffer.pastedContent).trim();
      if (trimmed) {
        onFeedback(trimmed);
      }
    },
    [buffer.pastedContent, onFeedback],
  );

  // Ref avoids closing over buffer.text in callbacks, keeping handleSelect
  // and the app:interrupt handler stable across keystrokes.
  const bufferTextRef = useRef(buffer.text);
  bufferTextRef.current = buffer.text;
  const { setText: setBufferText } = buffer;

  const handleSelect = useCallback(
    (item: ApprovalChoice) => {
      if (item === REFUSE_AND_SAY_VALUE) {
        submitFeedback(bufferTextRef.current);
      } else if (item === REJECT_VALUE) {
        onCancel();
      } else if (item === START_GOAL_VALUE) {
        // Approve and enter the goal loop; the permission mode is left to the
        // user, same as the plain approve path.
        onApprove({ startGoal: true });
      } else {
        // "Yes, start executing" — keep current permission mode unchanged.
        onApprove();
      }
    },
    [submitFeedback, onCancel, onApprove],
  );

  const renderRadioItem = useCallback(
    (
      item: RadioSelectItem<ApprovalChoice>,
      { titleColor }: { titleColor: string },
    ) => {
      const isRefuseAndSay = item.value === REFUSE_AND_SAY_VALUE;
      return (
        <Box flexDirection="column">
          <Box height={1}>
            <Text color={titleColor} wrap="truncate">
              {item.label}
            </Text>
          </Box>
          {isRefuseAndSay && typeSomethingActive ? (
            <Box flexDirection="column">
              <Text color={theme.text.secondary}>
                Write the exact feedback to send to the model.
              </Text>
              <InputField
                variant="inline"
                buffer={buffer}
                placeholder="e.g. Use a different approach."
                onSubmit={submitFeedback}
                focus={true}
                width={inputLayout.fieldWidth}
              />
            </Box>
          ) : (
            item.sublabel && (
              <Box height={1}>
                <Text color={theme.text.secondary} wrap="truncate">
                  {item.sublabel}
                </Text>
              </Box>
            )
          )}
        </Box>
      );
    },
    [typeSomethingActive, buffer, submitFeedback, inputLayout.fieldWidth],
  );

  const handlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'input:openExternalEditor': () => {
        void handleOpenEditor();
        return true;
      },
      'dialog:escape': () => {
        if (typeSomethingActive && bufferTextRef.current !== '') {
          setBufferText('');
          return true;
        }
        onCancel();
        return true;
      },
    }),
    [handleOpenEditor, onCancel, typeSomethingActive, setBufferText],
  );

  useRegisterActionHandlers('Dialog', handlers);

  const globalHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'app:interrupt': () => {
        if (typeSomethingActive && bufferTextRef.current !== '') {
          setBufferText('');
          return true;
        }
        return false;
      },
    }),
    [typeSomethingActive, setBufferText],
  );

  useRegisterActionHandlers('Global', globalHandlers);

  // Bypasses BaseTabDialog, so we must activate the Dialog context manually.
  useRegisterKeyboardContext('Dialog', true);

  useEffect(() => {
    if (planState.status !== PlanStatus.Loading) {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowLoading(true), 200);
    return () => clearTimeout(timer);
  }, [planState.status]);

  // Pre-slice plan text to fit the available height so that flexShrink={0}
  // code blocks inside MarkdownDisplay cannot push the approval UI off screen.
  const visiblePlanContent = useMemo(() => {
    const content = planState.content ?? '';
    if (!content || availableHeight === undefined) return content;
    const approvalLines = approvalOptions.reduce(
      (sum, opt) => sum + 1 + (opt.sublabel ? 1 : 0),
      0,
    );
    const activeInputExpansion = typeSomethingActive
      ? INLINE_SELECTION_INPUT_WITH_DESCRIPTION_HEIGHT - 1
      : 0;
    const planChromeLines =
      PLAN_CHROME_LINES_BASE + approvalLines + activeInputExpansion;
    const maxLines = Math.max(3, availableHeight - planChromeLines);
    const lines = content.split('\n');
    return lines.length <= maxLines
      ? content
      : lines.slice(0, maxLines).join('\n');
  }, [
    planState.content,
    availableHeight,
    approvalOptions,
    typeSomethingActive,
  ]);

  // All hooks called — early returns are safe from here.

  if (planState.status === PlanStatus.Loading) {
    if (!showLoading) return null;
    return (
      <StatusMessage>
        <Text color={theme.text.secondary} italic>
          Loading plan...
        </Text>
      </StatusMessage>
    );
  }

  // empty/missing plan → simplified Yes/No dialog instead of error.
  // The agent may want to exit plan without having written anything yet.
  if (planState.status === PlanStatus.Error) {
    const emptyPlanOptions: Array<RadioSelectItem<ApprovalChoice>> = [
      {
        label: 'Yes, exit plan mode',
        value: EXECUTE_VALUE,
        key: 'yes',
      },
      { label: 'No, stay in plan mode', value: REJECT_VALUE, key: 'no' },
    ];
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.text.secondary}>
          Exit plan mode? (no plan content generated yet)
        </Text>
        <Box marginTop={1}>
          <RadioButtonSelect
            items={emptyPlanOptions}
            onSelect={(value: ApprovalChoice) => {
              if (value === REJECT_VALUE) {
                onCancel();
              } else {
                onApprove();
              }
            }}
            isFocused={true}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      {/* Label */}
      <Box paddingX={1} marginBottom={1} flexShrink={0}>
        <Text color={theme.text.secondary}>
          Here is {BRAND_NAME}&apos;s plan:
        </Text>
      </Box>

      {/* Plan content — top/bottom border only; no Yoga height constraint so
          flexShrink={0} code blocks inside MarkdownDisplay paint correctly. */}
      <Box
        borderStyle="single"
        borderColor={theme.border.default}
        borderLeft={false}
        borderRight={false}
        paddingX={1}
        flexDirection="column"
        flexShrink={0}
      >
        <MarkdownDisplay
          text={visiblePlanContent}
          terminalWidth={width - 2}
          isPending={false}
        />
      </Box>

      {/* Approval UI */}
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>
            {BRAND_NAME} has written up a plan and is ready to execute. Would
            you like to proceed?
          </Text>
        </Box>
        <RadioButtonSelect
          items={approvalOptions}
          onSelect={handleSelect}
          onHighlight={handleHighlight}
          isFocused={true}
          showNumbers={true}
          suppressAccept={typeSomethingActive}
          enableNumericSelection={!typeSomethingActive}
          renderItem={renderRadioItem}
        />
        {canEditPlan && (
          <Box marginTop={1}>
            <Text color={theme.text.secondary} dimColor>
              {EDIT_HINT} to edit plan
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
