/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useMemo, useCallback, useRef, useState } from 'react';
import { Box, Text, useStdin, type DOMElement } from 'ink';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type SerializableConfirmationDetails,
  type Config,
  type ToolConfirmationPayload,
  ToolConfirmationOutcome,
  type EditorType,
  runLogger,
  ASK_USER_TOOL_NAME,
  BRAND_CLI_SLUG,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '@qwen-code/core';
import { isOwnUITool } from '../../utils/toolConfirmationUtils.js';
import { useToolActions } from '../../contexts/ToolActionsContext.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from '../shared/RadioButtonSelect.js';
import { stripUnsafeCharacters } from '../../utils/textUtils.js';
import { theme } from '../../semantic-colors.js';
import { themeManager } from '../../themes/theme-manager.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../../contexts/ActionHandlerRegistry.js';
import { Command } from '../../key/keyMatchers.js';
import { formatCommand } from '../../key/keybindingUtils.js';
import { AskUserDialog } from '../AskUserDialog.js';
import { ExitPlanModeDialog } from '../ExitPlanModeDialog.js';
import { WarningMessage } from './WarningMessage.js';
import {
  getDeceptiveUrlDetails,
  type DeceptiveUrlDetails,
} from '../../utils/urlSecurityUtils.js';
import { getBorderStyle } from '../../utils/borderStyles.js';
import {
  InputField,
  INLINE_SELECTION_INPUT_WITH_DESCRIPTION_HEIGHT,
  resolveInlineSelectionInputLayout,
} from '../shared/InputField.js';
import {
  useTextBuffer,
  expandPastePlaceholders,
} from '../shared/text-buffer.js';
import {
  getConfirmationOptions,
  TYPE_SOMETHING_VALUE,
  VIEW_WORKFLOW_SCRIPT_VALUE,
} from './confirmationOptions.js';
import { openFileInEditor } from '../../utils/editorUtils.js';
import { formatOutcomeScopeTag } from '../../utils/scopeTag.js';
import {
  renderEditBody,
  renderExecBody,
  renderInfoBody,
  renderFileReadBody,
  renderMcpBody,
  renderWorkflowBody,
  renderRepeatedToolCallBody,
  renderVideoBody,
  getExtraInfoLines,
} from './confirmation-bodies.js';

export interface ToolConfirmationMessageProps {
  callId: string;
  confirmationDetails: SerializableConfirmationDetails;
  config: Config;
  getPreferredEditor: () => EditorType | undefined;
  isFocused?: boolean;
  availableTerminalHeight?: number;
  terminalWidth: number;
  toolName: string;
  /**
   * Called immediately when the user cancels, so the parent can hide
   * the entire dialog without waiting for the core round-trip.
   */
  onDismiss?: () => void;
}

export const ToolConfirmationMessage: React.FC<
  ToolConfirmationMessageProps
> = ({
  callId,
  confirmationDetails,
  config,
  getPreferredEditor,
  isFocused = true,
  availableTerminalHeight,
  terminalWidth,
  toolName,
  onDismiss,
}) => {
  const { confirm } = useToolActions();
  const { stdin, setRawMode } = useStdin();
  const [mcpDetailsExpansionState, setMcpDetailsExpansionState] = useState<{
    callId: string;
    expanded: boolean;
  }>({
    callId,
    expanded: false,
  });
  const [isCancelling, setIsCancelling] = useState(false);
  const [typeSomethingActive, setTypeSomethingActive] = useState(false);
  const [showRawWorkflowScript, setShowRawWorkflowScript] = useState(false);
  const [editedWorkflowScript, setEditedWorkflowScript] = useState<
    string | undefined
  >(undefined);
  const isMcpToolDetailsExpanded =
    mcpDetailsExpansionState.callId === callId
      ? mcpDetailsExpansionState.expanded
      : false;

  // Static estimate for security warning height (avoids ResizeObserver feedback loop).
  const SECURITY_WARNING_ESTIMATED_HEIGHT = 4;

  const deceptiveUrlWarnings = useMemo(() => {
    const urls: string[] = [];
    if (confirmationDetails.type === 'info' && confirmationDetails.urls) {
      urls.push(...confirmationDetails.urls);
    } else if (confirmationDetails.type === 'exec') {
      const commands =
        confirmationDetails.commands && confirmationDetails.commands.length > 0
          ? confirmationDetails.commands
          : [confirmationDetails.command];
      for (const cmd of commands) {
        const matches = cmd.match(/https?:\/\/[^\s"'`<>;&|()]+/g);
        if (matches) urls.push(...matches);
      }
    }

    const uniqueUrls = Array.from(new Set(urls));
    return uniqueUrls
      .map(getDeceptiveUrlDetails)
      .filter((d): d is DeceptiveUrlDetails => d !== null);
  }, [confirmationDetails]);

  const deceptiveUrlWarningText = useMemo(() => {
    if (deceptiveUrlWarnings.length === 0) return null;
    return `**Warning:** Deceptive URL(s) detected:\n\n${deceptiveUrlWarnings
      .map(
        (w) =>
          `   **Original:** ${w.originalUrl}\n   **Actual Host (Punycode):** ${w.punycodeUrl}`,
      )
      .join('\n\n')}`;
  }, [deceptiveUrlWarnings]);

  // No-op ref callback — security warnings height is now statically estimated.
  const onSecurityWarningsRefChange = useCallback(
    (_node: DOMElement | null) => {},
    [],
  );

  const settings = useSettings();
  const activeTheme = themeManager.getActiveTheme();

  const handlesOwnUI = isOwnUITool(confirmationDetails.type);

  // Text buffer for "Type Something" text input
  const inputLayout = resolveInlineSelectionInputLayout(terminalWidth - 4);
  const buffer = useTextBuffer({
    initialText: '',
    viewport: inputLayout.viewport,
    singleLine: true,
  });
  const inlineInputRef = useRef({ isActive: false, text: '' });
  inlineInputRef.current = {
    isActive: typeSomethingActive,
    text: buffer.text,
  };
  const { setText: setBufferText } = buffer;

  const clearInlineInputIfPresent = useCallback((): boolean => {
    if (inlineInputRef.current.isActive && inlineInputRef.current.text !== '') {
      setBufferText('');
      return true;
    }
    return false;
  }, [setBufferText]);

  const handleConfirm = useCallback(
    (outcome: ToolConfirmationOutcome, payload?: ToolConfirmationPayload) => {
      void confirm(callId, outcome, payload).catch((error: unknown) => {
        runLogger.error(
          `Failed to handle tool confirmation for ${callId}:`,
          error,
        );
      });
    },
    [confirm, callId],
  );

  useEffect(() => {
    setShowRawWorkflowScript(false);
    setEditedWorkflowScript(undefined);
  }, [callId]);

  const handleOpenWorkflowScriptEditor = useCallback(async () => {
    if (confirmationDetails.type !== 'workflow') return;
    const script = editedWorkflowScript ?? confirmationDetails.script;
    if (!script) return;

    const dir = await fsp.mkdtemp(
      path.join(os.tmpdir(), `${BRAND_CLI_SLUG}-workflow-edit-`),
    );
    const fileName = `${confirmationDetails.workflowName ?? 'workflow'}.js`;
    const filePath = path.join(dir, fileName.replace(/[/\\]/g, '-'));
    try {
      await fsp.writeFile(filePath, script, { encoding: 'utf8', mode: 0o600 });
      await openFileInEditor(filePath, stdin, setRawMode, getPreferredEditor());
      const updated = await fsp.readFile(filePath, 'utf8');
      setEditedWorkflowScript(updated);
      setShowRawWorkflowScript(true);
    } catch (error) {
      runLogger.error('Failed to edit workflow script:', error);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, [
    confirmationDetails,
    editedWorkflowScript,
    stdin,
    setRawMode,
    getPreferredEditor,
  ]);

  const mcpToolDetailsText = useMemo(() => {
    if (confirmationDetails.type !== 'mcp') {
      return null;
    }

    const detailsLines: string[] = [];
    const hasNonEmptyToolArgs =
      confirmationDetails.toolArgs !== undefined &&
      !(
        typeof confirmationDetails.toolArgs === 'object' &&
        confirmationDetails.toolArgs !== null &&
        Object.keys(confirmationDetails.toolArgs).length === 0
      );
    if (hasNonEmptyToolArgs) {
      let argsText: string;
      try {
        argsText = stripUnsafeCharacters(
          JSON.stringify(confirmationDetails.toolArgs, null, 2),
        );
      } catch {
        argsText = '[unserializable arguments]';
      }
      detailsLines.push('Invocation Arguments:');
      detailsLines.push(argsText);
    }

    const description = confirmationDetails.toolDescription?.trim();
    if (description) {
      if (detailsLines.length > 0) {
        detailsLines.push('');
      }
      detailsLines.push('Description:');
      detailsLines.push(stripUnsafeCharacters(description));
    }

    if (confirmationDetails.toolParameterSchema !== undefined) {
      let schemaText: string;
      try {
        schemaText = stripUnsafeCharacters(
          JSON.stringify(confirmationDetails.toolParameterSchema, null, 2),
        );
      } catch {
        schemaText = '[unserializable schema]';
      }
      if (detailsLines.length > 0) {
        detailsLines.push('');
      }
      detailsLines.push('Input Schema:');
      detailsLines.push(schemaText);
    }

    if (detailsLines.length === 0) {
      return null;
    }

    return detailsLines.join('\n');
  }, [confirmationDetails]);

  const hasMcpToolDetails = !!mcpToolDetailsText;
  const expandDetailsHintKey = formatCommand(Command.SHOW_MORE_LINES);

  // TODO(#23009): Remove this hack once we migrate to the new renderer.
  // Why useEffect is used here instead of calling handleConfirm directly:
  // There is a race condition where calling handleConfirm immediately upon
  // keypress removes the tool UI component while the UI is in an expanded state.
  // This simultaneously triggers setConstrainHeight, causing render two footers.
  // By bridging the cancel action through state (isCancelling) and this useEffect,
  // we delay handleConfirm until the next render cycle, ensuring setConstrainHeight
  // resolves properly first.
  useEffect(() => {
    if (isCancelling) {
      onDismiss?.();
      handleConfirm(ToolConfirmationOutcome.Cancel);
    }
  }, [isCancelling, handleConfirm, onDismiss]);

  const handleHighlight = useCallback((item: ToolConfirmationOutcome) => {
    const isTypeSomething = item === TYPE_SOMETHING_VALUE;
    setTypeSomethingActive(isTypeSomething);
  }, []);

  const handleSelect = useCallback(
    (item: ToolConfirmationOutcome) => {
      if (item === TYPE_SOMETHING_VALUE) {
        // When "Type Something" is highlighted and Enter is pressed, submit the buffer text
        const trimmed = expandPastePlaceholders(
          buffer.text,
          buffer.pastedContent,
        ).trim();
        if (trimmed) {
          handleConfirm(ToolConfirmationOutcome.Cancel, {
            cancelFeedback: trimmed,
          });
        }
      } else if (item === VIEW_WORKFLOW_SCRIPT_VALUE) {
        setShowRawWorkflowScript((current) => !current);
      } else if (item === ToolConfirmationOutcome.Cancel) {
        // Route through isCancelling for immediate UI dismissal
        setIsCancelling(true);
      } else {
        if (
          item === ToolConfirmationOutcome.ProceedOnce &&
          confirmationDetails.type === 'workflow' &&
          editedWorkflowScript !== undefined
        ) {
          handleConfirm(item, {
            script: editedWorkflowScript,
            scriptPath: undefined,
            name: undefined,
          });
          return;
        }
        handleConfirm(item);
      }
    },
    [
      handleConfirm,
      buffer.text,
      buffer.pastedContent,
      confirmationDetails,
      editedWorkflowScript,
    ],
  );

  const handleTextSubmit = useCallback(
    (val: string) => {
      const trimmed = expandPastePlaceholders(val, buffer.pastedContent).trim();
      if (trimmed) {
        handleConfirm(ToolConfirmationOutcome.Cancel, {
          cancelFeedback: trimmed,
        });
      }
    },
    [handleConfirm, buffer.pastedContent],
  );

  const memoizedOptions = useMemo(() => {
    const baseOptions = getConfirmationOptions(confirmationDetails);
    if (confirmationDetails.type !== 'workflow') {
      return baseOptions;
    }
    return baseOptions.map((option) =>
      option.value === VIEW_WORKFLOW_SCRIPT_VALUE
        ? {
            ...option,
            label: showRawWorkflowScript
              ? 'Close raw script'
              : 'View raw script',
            sublabel: showRawWorkflowScript
              ? 'Hide the full workflow script.'
              : 'Show the full workflow script before deciding.',
          }
        : option,
    );
  }, [confirmationDetails, showRawWorkflowScript]);

  // ─── Dialog action handlers (context routing) ───
  // In Dialog context, escape → 'dialog:escape'.
  // When handlesOwnUI is true (e.g. AskUserDialog), the child component manages
  // its own escape handling via BaseTabDialog's onClose — don't register here
  // to avoid conflicting handlers that cause premature dialog dismissal.
  useRegisterActionHandlers(
    'Dialog',
    useMemo(
      () => ({
        'dialog:escape': (() => {
          if (clearInlineInputIfPresent()) {
            return true;
          }
          setIsCancelling(true);
          return true;
        }) as ActionHandler,
        'input:openExternalEditor': (() => {
          if (
            confirmationDetails.type === 'workflow' &&
            showRawWorkflowScript
          ) {
            void handleOpenWorkflowScriptEditor();
            return true;
          }
          return false;
        }) as ActionHandler,
      }),
      [
        setIsCancelling,
        clearInlineInputIfPresent,
        confirmationDetails.type,
        showRawWorkflowScript,
        handleOpenWorkflowScriptEditor,
      ],
    ),
    isFocused && !handlesOwnUI,
  );

  // ─── Global action handlers (context routing) ───
  // - ctrl+o is a Global penetrating binding → 'app:showMoreLines'
  // - ctrl+c resolves to Global non-penetrating → 'app:interrupt'
  //   (child handlers run before AppContainer's handler due to React
  //   effect ordering; returning true prevents the global abort handler)
  useRegisterActionHandlers(
    'Global',
    useMemo(
      () => ({
        'app:showMoreLines': (() => {
          if (confirmationDetails.type === 'mcp' && hasMcpToolDetails) {
            setMcpDetailsExpansionState({
              callId,
              expanded: !isMcpToolDetailsExpanded,
            });
            return true;
          }
          return false;
        }) as ActionHandler,
        'app:interrupt': (() => clearInlineInputIfPresent()) as ActionHandler,
      }),
      [
        confirmationDetails.type,
        hasMcpToolDetails,
        callId,
        isMcpToolDetailsExpanded,
        clearInlineInputIfPresent,
      ],
    ),
    isFocused,
  );

  // Tool confirmations render their choices through RadioButtonSelect, so the
  // active keyboard context is usually Select rather than Dialog.
  useRegisterFallbackHandler(
    'Select',
    useCallback(
      ((key) => {
        if (
          confirmationDetails.type === 'workflow' &&
          showRawWorkflowScript &&
          key.ctrl &&
          (key.name === 'x' || key.sequence === '\x18')
        ) {
          void handleOpenWorkflowScriptEditor();
          return true;
        }
        return false;
      }) as ActionHandler,
      [
        confirmationDetails.type,
        showRawWorkflowScript,
        handleOpenWorkflowScriptEditor,
      ],
    ),
    isFocused &&
      !handlesOwnUI &&
      confirmationDetails.type === 'workflow' &&
      showRawWorkflowScript,
  );

  // ─── Dialog fallback handler (context routing) ───
  // When a key doesn't match any Dialog binding, the fallback checks for
  // 1-9 digit presses to select the corresponding option.
  useRegisterFallbackHandler(
    'Dialog',
    useCallback(
      ((key) => {
        if (!isFocused || handlesOwnUI || typeSomethingActive) {
          return false;
        }

        const numericIndex =
          key.sequence.length === 1 && /^[1-9]$/.test(key.sequence)
            ? Number.parseInt(key.sequence, 10) - 1
            : -1;

        if (numericIndex >= 0) {
          const option = memoizedOptions[numericIndex];
          if (option) {
            handleSelect(option.value);
            return true;
          }
        }

        return false;
      }) as ActionHandler,
      [
        isFocused,
        handlesOwnUI,
        typeSomethingActive,
        memoizedOptions,
        handleSelect,
      ],
    ),
    isFocused,
  );

  const availableBodyContentHeight = useCallback(() => {
    if (availableTerminalHeight === undefined) {
      return undefined;
    }

    if (handlesOwnUI) {
      return availableTerminalHeight;
    }

    // Calculate the vertical space (in lines) consumed by UI chrome
    // surrounding the main body content.
    const PADDING_OUTER_Y = 0;
    const HEIGHT_QUESTION = 1;
    const MARGIN_QUESTION_TOP = 0;
    const MARGIN_QUESTION_BOTTOM = 1;
    const SECURITY_WARNING_BOTTOM_MARGIN = 1;
    const SHOW_MORE_LINES_HEIGHT = 1;

    const optionsCount = memoizedOptions.length;

    const securityWarningsHeight = deceptiveUrlWarningText
      ? SECURITY_WARNING_ESTIMATED_HEIGHT + SECURITY_WARNING_BOTTOM_MARGIN
      : 0;

    const extraInfoLines = getExtraInfoLines(confirmationDetails, config);

    const surroundingElementsHeight =
      PADDING_OUTER_Y +
      HEIGHT_QUESTION +
      MARGIN_QUESTION_TOP +
      MARGIN_QUESTION_BOTTOM +
      SHOW_MORE_LINES_HEIGHT +
      optionsCount +
      (typeSomethingActive
        ? INLINE_SELECTION_INPUT_WITH_DESCRIPTION_HEIGHT
        : 0) +
      securityWarningsHeight +
      extraInfoLines;

    return Math.max(availableTerminalHeight - surroundingElementsHeight, 2);
  }, [
    availableTerminalHeight,
    handlesOwnUI,
    memoizedOptions,
    typeSomethingActive,
    deceptiveUrlWarningText,
    confirmationDetails,
    config,
  ]);

  const { question, bodyContent, options, securityWarnings, initialIndex } =
    useMemo<{
      question: React.ReactNode;
      bodyContent: React.ReactNode;
      options: Array<RadioSelectItem<ToolConfirmationOutcome>>;
      securityWarnings: React.ReactNode;
      initialIndex: number;
    }>(() => {
      const securityWarnings = deceptiveUrlWarningText ? (
        <WarningMessage text={deceptiveUrlWarningText} />
      ) : null;

      const bodyHeight = availableBodyContentHeight();

      // ── Special dialogs (handle their own UI) ──
      if (confirmationDetails.type === ASK_USER_TOOL_NAME) {
        return {
          question: '',
          bodyContent: (
            <AskUserDialog
              key={callId}
              questions={confirmationDetails.questions}
              onSubmit={(answers, annotations) => {
                handleConfirm(ToolConfirmationOutcome.ProceedOnce, {
                  answers,
                  ...(annotations ? { annotations } : {}),
                });
              }}
              onCancel={(cancelFeedback) => {
                handleConfirm(
                  ToolConfirmationOutcome.Cancel,
                  cancelFeedback ? { cancelFeedback } : undefined,
                );
              }}
              getPreferredEditor={getPreferredEditor}
              width={terminalWidth}
              availableHeight={bodyHeight}
            />
          ),
          options: [],
          securityWarnings: null,
          initialIndex: 0,
        };
      }

      if (confirmationDetails.type === EXIT_PLAN_MODE_TOOL_NAME) {
        return {
          question: '',
          bodyContent: (
            <ExitPlanModeDialog
              planPath={confirmationDetails.planPath}
              planContent={confirmationDetails.planContent}
              getPreferredEditor={getPreferredEditor}
              onApprove={(options) => {
                handleConfirm(ToolConfirmationOutcome.ProceedOnce, {
                  approved: true,
                  startGoal: options?.startGoal,
                });
              }}
              onFeedback={(feedback) => {
                handleConfirm(ToolConfirmationOutcome.ProceedOnce, {
                  approved: false,
                  feedback,
                });
              }}
              onCancel={() => {
                handleConfirm(ToolConfirmationOutcome.Cancel);
              }}
              width={terminalWidth}
              availableHeight={bodyHeight}
            />
          ),
          options: [],
          securityWarnings: null,
          initialIndex: 0,
        };
      }
      let question: React.ReactNode = '';
      let bodyContent: React.ReactNode = null;

      switch (confirmationDetails.type) {
        case 'edit': {
          if (!confirmationDetails.isModifying) {
            const result = renderEditBody(confirmationDetails, terminalWidth);
            question = result.question;
            bodyContent = result.body;
          }
          break;
        }
        case 'exec': {
          const result = renderExecBody(confirmationDetails, toolName, config);
          question = result.question;
          bodyContent = result.body;
          break;
        }
        case 'info': {
          const result = renderInfoBody(confirmationDetails);
          question = result.question;
          bodyContent = result.body;
          break;
        }
        case 'mcp': {
          const result = renderMcpBody(
            confirmationDetails,
            terminalWidth,
            bodyHeight,
            isMcpToolDetailsExpanded,
            mcpToolDetailsText,
            expandDetailsHintKey,
            settings,
            activeTheme,
          );
          question = result.question;
          bodyContent = result.body;
          break;
        }
        case 'file_read': {
          const result = renderFileReadBody(confirmationDetails);
          question = result.question;
          bodyContent = result.body;
          break;
        }
        case 'video': {
          const result = renderVideoBody(confirmationDetails);
          question = result.question;
          bodyContent = result.body;
          break;
        }
        case 'workflow': {
          const result = renderWorkflowBody(
            confirmationDetails,
            terminalWidth,
            bodyHeight,
            settings,
            activeTheme,
            showRawWorkflowScript,
            editedWorkflowScript,
          );
          question = result.question;
          bodyContent = result.body;
          break;
        }
        case 'repeated_tool_call': {
          const result = renderRepeatedToolCallBody(confirmationDetails);
          question = result.question;
          bodyContent = result.body;
          break;
        }
        default:
          break;
      }

      return {
        question,
        bodyContent,
        options: memoizedOptions,
        securityWarnings,
        initialIndex: 0,
      };
    }, [
      confirmationDetails,
      callId,
      memoizedOptions,
      availableBodyContentHeight,
      terminalWidth,
      handleConfirm,
      deceptiveUrlWarningText,
      isMcpToolDetailsExpanded,
      mcpToolDetailsText,
      expandDetailsHintKey,
      getPreferredEditor,
      settings,
      activeTheme,
      config,
      toolName,
      showRawWorkflowScript,
      editedWorkflowScript,
    ]);

  const renderRadioItem = useCallback(
    (
      item: RadioSelectItem<ToolConfirmationOutcome>,
      { titleColor }: { titleColor: string },
    ) => {
      const isTypeSomething = item.value === TYPE_SOMETHING_VALUE;
      const scopeTag = formatOutcomeScopeTag(item.value);
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={titleColor} wrap="wrap">
              {item.label}
            </Text>
            {scopeTag && (
              <Text color={scopeTag.color} bold>
                {' '}
                [{scopeTag.label}]
              </Text>
            )}
          </Box>
          {isTypeSomething && typeSomethingActive && (
            <Box flexDirection="column">
              <Text color={theme.text.secondary}>
                Write the exact feedback to send to the model.
              </Text>
              <InputField
                variant="inline"
                buffer={buffer}
                placeholder="e.g. Use a different approach."
                onSubmit={handleTextSubmit}
                focus={isFocused}
                width={inputLayout.fieldWidth}
              />
            </Box>
          )}
        </Box>
      );
    },
    [
      typeSomethingActive,
      buffer,
      handleTextSubmit,
      isFocused,
      inputLayout.fieldWidth,
    ],
  );

  const workflowSelectionHint = useMemo(() => {
    if (confirmationDetails.type !== 'workflow') {
      return null;
    }
    const script = editedWorkflowScript ?? confirmationDetails.script;
    if (showRawWorkflowScript) {
      return script ? 'Press Ctrl+X to edit script before running.' : null;
    }
    return null;
  }, [confirmationDetails, editedWorkflowScript, showRawWorkflowScript]);

  // Immediately hide the dialog when cancelling — don't wait for the core
  // round-trip to update the tool status.
  if (isCancelling) {
    return null;
  }

  if (confirmationDetails.type === 'edit') {
    if (confirmationDetails.isModifying) {
      return (
        <Box
          width={terminalWidth}
          borderStyle={getBorderStyle('dialog')}
          borderColor={theme.border.default}
          justifyContent="space-around"
          paddingTop={1}
          paddingBottom={1}
          overflow="hidden"
        >
          <Text color={theme.text.primary}>Modify in progress: </Text>
          <Text color={theme.status.success}>
            Save and close external editor to continue
          </Text>
        </Box>
      );
    }
  }

  return (
    <Box flexDirection="column" paddingTop={0} paddingBottom={0}>
      {!!confirmationDetails.systemMessage && (
        <Box marginBottom={1}>
          <Text color={theme.status.warning}>
            {confirmationDetails.systemMessage}
          </Text>
        </Box>
      )}

      {handlesOwnUI ? (
        bodyContent
      ) : (
        <>
          <Box
            flexShrink={0}
            marginBottom={!question && !securityWarnings ? 1 : 0}
            width={terminalWidth}
          >
            {bodyContent}
          </Box>

          {securityWarnings && (
            <Box
              flexShrink={0}
              marginBottom={1}
              ref={onSecurityWarningsRefChange}
            >
              {securityWarnings}
            </Box>
          )}

          {!!question && (
            <Box marginBottom={1} flexShrink={0}>
              {typeof question === 'string' ? (
                <Text color={theme.text.primary}>{question}</Text>
              ) : (
                question
              )}
            </Box>
          )}

          <Box flexShrink={0}>
            <RadioButtonSelect
              items={options}
              onSelect={handleSelect}
              onHighlight={handleHighlight}
              isFocused={isFocused}
              initialIndex={initialIndex}
              suppressAccept={typeSomethingActive}
              enableNumericSelection={!typeSomethingActive}
              renderItem={renderRadioItem}
            />
          </Box>
          {workflowSelectionHint ? (
            <Box marginTop={1} flexShrink={0}>
              <Text color={theme.text.secondary} dimColor>
                {workflowSelectionHint}
              </Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
};
