/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useId, useMemo, useState } from 'react';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Box, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { DiffRenderer } from './DiffRenderer.js';
import {
  RenderInline,
  getInlinePlainText,
} from '../../utils/InlineMarkdownRenderer.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { truncateToWidth } from '../../utils/textUtils.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type {
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolMcpConfirmationDetails,
} from '@qwen-code/qwen-code-core/tools/tools.js';
import type { EditorType } from '@qwen-code/qwen-code-core/utils/editor.js';
import { IdeClient } from '@qwen-code/qwen-code-core/ide/ide-client.js';
import { buildHumanReadableRuleLabel } from '@qwen-code/qwen-code-core/permissions/rule-parser.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import { isEditorAvailable } from '@qwen-code/qwen-code-core/utils/editor.js';
import type { RadioSelectItem } from '../shared/RadioButtonSelect.js';
import { RadioButtonSelect } from '../shared/RadioButtonSelect.js';
import { MaxSizedBox, MINIMUM_MAX_HEIGHT } from '../shared/MaxSizedBox.js';
import { useOverflowActions } from '../../contexts/OverflowContext.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useContextMenu } from '../../context-menu/ContextMenuContext.js';
import { useLaunchEditor } from '../../hooks/useLaunchEditor.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';
import { AskUserQuestionDialog } from './AskUserQuestionDialog.js';

// Cap the body height of inline subagent approval banners so a
// multi-line command can't dominate the screen. MaxSizedBox renders
// a "... N more lines" footer past this cap.
const COMPACT_BODY_MAX_LINES = 5;

// A "… N hidden …" footer costs one terminal row, so every budget that clips
// content pays for it up front or the clip lands outside the cap unannounced.
const MARKER_ROW = 1;

// The branch's own body element — the command, the diff — is what the user is
// being asked to authorise, so it keeps one row of any shared grant.
const SUBJECT_ROW = 1;

/**
 * Marker for content this component clipped by hand rather than through
 * MaxSizedBox. Registering the overflow is what makes the global
 * "Press ctrl-s to show more lines" hint appear, so a clipped destination
 * list or inline-Markdown body is always revealable, not just announced.
 *
 * Pinned like every row MaxSizedBox renders: an ancestor cap compresses an
 * unpinned row onto its neighbour instead of clipping a tail, so a notice that
 * can shrink turns the clipped region into overlapping text.
 */
const OverflowNotice: React.FC<{
  message: string;
  color?: string;
  tail?: string;
  /**
   * Width the row is truncated at. A row that still fits hides nothing, so
   * passing the width keeps the reveal affordance honest: it is registered only
   * when the truncation actually cut characters off.
   */
  width?: number;
  /**
   * Set when the caller already cut the text to fit this row. What the row
   * renders fits, so the width alone cannot see that what it replaced did not.
   */
  hidden?: boolean;
}> = ({ message, color = theme.text.secondary, tail, width, hidden }) => {
  const id = useId();
  const actions = useOverflowActions();
  const clipped =
    hidden ??
    (width === undefined || stringWidth(`${message}${tail ?? ''}`) > width);
  useEffect(() => {
    if (!actions || !clipped) return;
    actions.addOverflowingId(id);
    return () => actions.removeOverflowingId(id);
  }, [actions, id, clipped]);

  // The count is the whole point of the row when content was dropped, so the
  // message is cut back to leave its columns free. Left to the row's own
  // truncation, a long message takes everything and the count disappears.
  const shownMessage =
    width === undefined || !tail
      ? message
      : truncateToWidth(message, Math.max(0, width - 1 - stringWidth(tail)));

  return (
    <Box flexShrink={0}>
      <Text color={color} wrap="truncate">
        {shownMessage}
      </Text>
      {tail ? (
        <Box flexShrink={0}>
          <Text color={theme.text.secondary}>{` ${tail}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

/**
 * Registers the reveal for content dropped with no row left to announce it.
 * The count rides another row's tail, so this renders nothing itself; without
 * it a clip this component performed would be silent and unrevealable.
 */
const HiddenOverflowRegistration: React.FC = () => {
  const id = useId();
  const actions = useOverflowActions();
  useEffect(() => {
    if (!actions) return;
    actions.addOverflowingId(id);
    return () => actions.removeOverflowingId(id);
  }, [actions, id]);
  return null;
};

export interface ToolConfirmationMessageProps {
  confirmationDetails: ToolCallConfirmationDetails;
  config: Config;
  isFocused?: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  compactMode?: boolean;
}

export const ToolConfirmationMessage: React.FC<
  ToolConfirmationMessageProps
> = ({
  confirmationDetails,
  config,
  isFocused = true,
  availableTerminalHeight,
  contentWidth,
  compactMode = false,
}) => {
  const { onConfirm } = confirmationDetails;
  const autoModeFallback = confirmationDetails.autoModeFallback;
  const offersSwitchToDefault =
    autoModeFallback?.reason === 'classifier_unavailable' ||
    autoModeFallback?.reason === 'consecutive_unavailable';
  const hidesAlwaysAllow =
    'hideAlwaysAllow' in confirmationDetails &&
    confirmationDetails.hideAlwaysAllow === true;

  // An open right-click context menu owns the keyboard while it is up. The
  // dispatch in KeypressContext is a broadcast that discards return values,
  // so an overlay cannot consume a key for the dialog — the dialog has to go
  // quiet itself, or one Enter aimed at "Open Link" also approves the
  // pending tool call. Mirrors the main view's InputPrompt gate; the
  // teammate tab renders this same dialog (via HistoryItemDisplay).
  const { menu: contextMenu } = useContextMenu();
  const inputActive = isFocused && contextMenu === null;

  const settings = useSettings();
  const preferredEditor = settings.merged.general?.preferredEditor as
    | EditorType
    | undefined;
  const hideModify =
    confirmationDetails.type === 'edit'
      ? confirmationDetails.hideModify
      : false;
  // Offering "Modify with external editor" for an editor that is not installed
  // only leads to a failed launch (#10745), so probe availability first.
  // `isEditorAvailable` shells out to look the binary up on PATH, hence the
  // memo and the guards that skip the probe when the option can't be offered
  // anyway (compact mode renders a fixed option list, non-edit confirmations
  // and `hideModify` never offer it).
  const editorAvailable = useMemo(
    () =>
      !compactMode &&
      confirmationDetails.type === 'edit' &&
      !hideModify &&
      preferredEditor !== undefined &&
      isEditorAvailable(preferredEditor),
    [compactMode, confirmationDetails.type, hideModify, preferredEditor],
  );

  const [ideClient, setIdeClient] = useState<IdeClient | null>(null);
  const [isDiffingEnabled, setIsDiffingEnabled] = useState(false);

  useEffect(() => {
    let isMounted = true;
    if (config.getIdeMode()) {
      const getIdeClient = async () => {
        const client = await IdeClient.getInstance();
        if (isMounted) {
          setIdeClient(client);
          setIsDiffingEnabled(client?.isDiffingEnabled() ?? false);
        }
      };
      getIdeClient();
    }
    return () => {
      isMounted = false;
    };
  }, [config]);

  const handleConfirm = async (outcome: ToolConfirmationOutcome) => {
    // Call onConfirm before resolving the IDE diff so that the CLI outcome
    // (e.g. ProceedAlways) is processed first.  resolveDiffFromCli would
    // otherwise trigger the scheduler's ideConfirmation .then() handler
    // with ProceedOnce, racing with the intended CLI outcome.
    //
    // Hold the rejection here: the scheduler re-throws after terminalizing a
    // call the trust gate refused, and an unhandled rejection trips the
    // process-level handler (llm.tsx), which shows a "file a bug report"
    // banner and opens the debug console over a correctly-refused action.
    void Promise.resolve(onConfirm(outcome)).catch(() => {});

    if (
      confirmationDetails.type === 'edit' &&
      !confirmationDetails.skipIdeDiff
    ) {
      if (config.getIdeMode() && isDiffingEnabled) {
        const cliOutcome =
          outcome === ToolConfirmationOutcome.Cancel ? 'rejected' : 'accepted';
        await ideClient?.resolveDiffFromCli(
          confirmationDetails.filePath,
          cliOutcome,
        );
      }
    }
  };

  const isTrustedFolder = config.isTrustedFolder();

  const launchEditor = useLaunchEditor();
  const [planViewError, setPlanViewError] = useState<string | null>(null);

  // #7001: a long plan can exceed the confirmation dialog's height budget and
  // get truncated (with a "... N more lines not shown ..." cue since #6882),
  // yet the user is asked to approve it. `o` writes the FULL plan to a temp
  // file and opens it in the configured editor so the decision is informed;
  // the dialog stays open (nothing is confirmed) while the user reads.
  const openFullPlanInEditor = () => {
    if (confirmationDetails.type !== 'plan') return;
    setPlanViewError(null);
    const openPlan = async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-plan-'));
      const planPath = path.join(dir, 'plan.md');
      await fs.writeFile(planPath, confirmationDetails.plan);
      await launchEditor(planPath);
    };
    void openPlan().catch((err: unknown) => {
      setPlanViewError(err instanceof Error ? err.message : String(err));
    });
  };

  useKeypress(
    (key) => {
      if (!inputActive) return;
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        handleConfirm(ToolConfirmationOutcome.Cancel);
        return;
      }
      if (
        key.name === 'o' &&
        !key.ctrl &&
        !key.meta &&
        confirmationDetails.type === 'plan'
      ) {
        openFullPlanInEditor();
      }
    },
    { isActive: inputActive },
  );

  const handleSelect = (item: ToolConfirmationOutcome) => handleConfirm(item);

  let bodyContent: React.ReactNode | null = null; // Removed contextDisplay here
  let question: string;

  const options: Array<RadioSelectItem<ToolConfirmationOutcome>> = new Array<
    RadioSelectItem<ToolConfirmationOutcome>
  >();

  // Body content is now the DiffRenderer, passing filename to it
  // The bordered box is removed from here and handled within DiffRenderer

  // The ceiling a body branch sizes against, read once, before the auto-mode
  // "switch to default" option is spliced into `options` and before the
  // auto-mode banner is folded into the body. The outer cap reuses this number
  // instead of calling availableBodyContentHeight() again afterwards, when the
  // spliced option and the banner would each be charged twice.
  let bodyBudget: number | undefined;

  function compactClamp(height: number | undefined) {
    // An undefined grant is full-detail mode, not a reveal-only one: clamping
    // it to the compact ceiling would hide body rows no shortcut can restore.
    return compactMode && height !== undefined
      ? Math.min(height, COMPACT_BODY_MAX_LINES)
      : height;
  }

  function wrappedRows(text: string, width: number) {
    return wrapAnsi(text, width, { trim: false, hard: true }).split('\n')
      .length;
  }

  function availableBodyContentHeight() {
    if (options.length === 0) {
      // This should not happen in practice as options are always added before this is called.
      throw new Error('Options not provided for confirmation message');
    }

    if (availableTerminalHeight === undefined) {
      return undefined;
    }

    // Calculate the vertical space (in lines) consumed by UI elements
    // surrounding the main body content. Compact mode drops outer padding
    // and inter-section margins, and renders a reduced option list rather
    // than the full options array.
    const PADDING_OUTER_Y = compactMode ? 0 : 2;
    const MARGIN_BODY_BOTTOM = compactMode ? 0 : 1;
    const HEIGHT_QUESTION = 1;
    const MARGIN_QUESTION_BOTTOM = compactMode ? 0 : 1;
    const HEIGHT_OPTIONS = compactMode
      ? 2 + (offersSwitchToDefault ? 1 : 0) + (hidesAlwaysAllow ? 0 : 1)
      : options.length + (offersSwitchToDefault ? 1 : 0);

    const surroundingElementsHeight =
      PADDING_OUTER_Y +
      MARGIN_BODY_BOTTOM +
      HEIGHT_QUESTION +
      MARGIN_QUESTION_BOTTOM +
      HEIGHT_OPTIONS +
      autoModeFallbackHeight;
    return Math.max(availableTerminalHeight - surroundingElementsHeight, 1);
  }

  // The warning box uses marginLeft={1} and paddingX={1}. Regular mode also
  // renders inside the outer box's padding={1}.
  const warningContentWidth = Math.max(
    contentWidth - 3 - (compactMode ? 0 : 2),
    1,
  );

  // Measured once: every body budget reserves this much room for the auto-mode
  // banner, and the outer cap adds it back because the banner is prepended to
  // the body content after those budgets were taken.
  const autoModeFallbackHeight = autoModeFallback
    ? wrappedRows(`⚠ ${autoModeFallback.message}`, warningContentWidth) + 1
    : 0;

  function warningRows(warnings: string[]): number {
    return warnings.reduce(
      (sum, warning) => sum + wrappedRows(`⚠ ${warning}`, warningContentWidth),
      0,
    );
  }

  // The warning box renders with its own margin row, so its footprint is the
  // wrapped rows plus that row.
  function warningsHeight(warnings: string[]): number {
    return warnings.length === 0 ? 0 : warningRows(warnings) + 1;
  }

  // Inside one capped column the warnings and the branch's own body element
  // (the diff, the command) split `bodyHeight` rows. The body element is the
  // thing being authorised, so it reserves its row first and the warnings share
  // out what is left: they keep their wrapped text while that fits, and once it
  // does not, each is cut to one row, which is the charge that stops a warning
  // wrapping to eight rows from squeezing the command out of its own dialog.
  function splitWarningBudget(bodyHeight: number, warnings: string[]) {
    const room = bodyHeight - SUBJECT_ROW;
    const wrapped = warningRows(warnings);
    const want = wrapped <= room ? wrapped : warnings.length;
    // The blank row between the two sides is affordable only while both still
    // get a row once it is charged.
    const gap = room >= want + MARKER_ROW ? 1 : 0;
    const warningHeight = Math.min(want, Math.max(room - gap, 0));
    return {
      warningHeight,
      gap,
      // The rows fit the warnings as written, so nothing is cut and they render
      // as plain wrapping text; otherwise they go through the truncating arms.
      uncapped: warningHeight >= wrapped,
      subjectHeight: bodyHeight - warningHeight - gap,
    };
  }

  if (confirmationDetails.type === 'edit') {
    if (confirmationDetails.isModifying) {
      return (
        <Box
          minWidth="90%"
          borderStyle="round"
          borderColor={theme.border.default}
          justifyContent="space-around"
          padding={1}
          overflow="hidden"
        >
          <Text color={theme.text.primary}>{t('Modify in progress:')} </Text>
          <Text color={theme.status.success}>
            {t('Save and close external editor to continue')}
          </Text>
        </Box>
      );
    }

    question = t('Apply this change?');
    options.push({
      label: t('Yes, allow once'),
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Yes, allow once',
    });
    if (isTrustedFolder && !confirmationDetails.hideAlwaysAllow) {
      options.push({
        label: t('Yes, allow always'),
        value: ToolConfirmationOutcome.ProceedAlways,
        key: 'Yes, allow always',
      });
    }
    if (
      !confirmationDetails.hideModify &&
      (!config.getIdeMode() || !isDiffingEnabled) &&
      editorAvailable
    ) {
      options.push({
        label: t('Modify with external editor'),
        value: ToolConfirmationOutcome.ModifyWithEditor,
        key: 'Modify with external editor',
      });
    }

    options.push({
      label: t('No, suggest changes (esc)'),
      value: ToolConfirmationOutcome.Cancel,
      key: 'No, suggest changes (esc)',
    });

    const warnings = confirmationDetails.warnings ?? [];
    bodyBudget = compactClamp(availableBodyContentHeight());
    const bodyHeight = bodyBudget;

    let warningMaxHeight: number | undefined;
    let warningsCapped = false;
    let warningMarginBottom = warnings.length > 0 ? 1 : 0;
    let diffHeight = bodyHeight;
    if (warnings.length > 0 && bodyHeight !== undefined) {
      const warningSplit = splitWarningBudget(bodyHeight, warnings);
      warningMarginBottom = warningSplit.gap;
      warningsCapped = !warningSplit.uncapped;
      warningMaxHeight = warningSplit.uncapped
        ? undefined
        : warningSplit.warningHeight;
      diffHeight = warningSplit.subjectHeight;
    } else if (diffHeight !== undefined) {
      diffHeight = Math.max(diffHeight - warningsHeight(warnings), 1);
    }
    const warningsDropped = warningMaxHeight === 0;

    const renderedDiff =
      diffHeight === undefined || diffHeight >= MINIMUM_MAX_HEIGHT ? (
        <DiffRenderer
          diffContent={confirmationDetails.fileDiff}
          filename={confirmationDetails.fileName}
          availableTerminalHeight={diffHeight}
          contentWidth={contentWidth}
          settings={settings}
        />
      ) : diffHeight === 1 ? (
        // The diff's last row is spent announcing itself: the renderer has no
        // one-row arm, so the change itself cannot be shown at this grant. The
        // warnings squeezed out with it are counted on the same row.
        <OverflowNotice
          message={t('... diff hidden ...')}
          tail={
            warningsDropped
              ? `+${warnings.length} warning(s) hidden`
              : undefined
          }
        />
      ) : null;

    bodyContent = (
      <Box flexDirection="column">
        {warnings.length > 0 ? (
          <Box
            flexDirection="column"
            paddingX={1}
            marginLeft={1}
            marginBottom={warningMarginBottom}
          >
            {warningsDropped ? (
              // No row left for the warnings: the body element kept the grant.
              // Nothing renders here, so the reveal is registered directly and
              // the count rides the surviving row's tail.
              <HiddenOverflowRegistration />
            ) : warningsCapped && warningMaxHeight === 1 ? (
              // A box cannot go below its two-row floor, so a one-row ask gets a
              // pinned row instead. Earlier warnings describe the mode, the last
              // names the exact action, so it is the row that survives, and the
              // width says whether truncation cut characters off it.
              <OverflowNotice
                color={theme.status.warning}
                width={warningContentWidth}
                message={`⚠ ${warnings.at(-1)?.replace(/\r\n?|\n/g, ' ↵ ')}`}
                tail={
                  warnings.length > 1
                    ? `+${warnings.length - 1} warning(s) hidden`
                    : undefined
                }
              />
            ) : warningsCapped ? (
              <MaxSizedBox
                maxHeight={warningMaxHeight}
                maxWidth={warningContentWidth}
                overflowDirection="top"
              >
                {warnings.map((warning, idx) => (
                  <Box key={idx}>
                    <Text color={theme.status.warning} wrap="truncate">
                      ⚠ {warning.replace(/\r\n?|\n/g, ' ↵ ')}
                    </Text>
                  </Box>
                ))}
              </MaxSizedBox>
            ) : (
              warnings.map((warning, idx) => (
                <Text key={idx} color={theme.status.warning}>
                  ⚠ {warning}
                </Text>
              ))
            )}
          </Box>
        ) : null}
        {renderedDiff}
      </Box>
    );
  } else if (confirmationDetails.type === 'exec') {
    const executionProps =
      confirmationDetails as ToolExecuteConfirmationDetails;

    question = t("Allow execution of: '{{command}}'?", {
      command: executionProps.rootCommand,
    });
    options.push({
      label: t('Yes, allow once'),
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Yes, allow once',
    });
    if (isTrustedFolder && !confirmationDetails.hideAlwaysAllow) {
      const friendlyLabel = executionProps.permissionRules?.length
        ? ` ${buildHumanReadableRuleLabel(executionProps.permissionRules)}`
        : '';
      options.push({
        label: friendlyLabel
          ? t('Always allow {{action}} in this project', {
              action: friendlyLabel.trim(),
            })
          : t('Always allow in this project'),
        value: ToolConfirmationOutcome.ProceedAlwaysProject,
        key: 'Always allow in this project',
      });
      options.push({
        label: friendlyLabel
          ? t('Always allow {{action}} for this user', {
              action: friendlyLabel.trim(),
            })
          : t('Always allow for this user'),
        value: ToolConfirmationOutcome.ProceedAlwaysUser,
        key: 'Always allow for this user',
      });
    }
    options.push({
      label: t('No, suggest changes (esc)'),
      value: ToolConfirmationOutcome.Cancel,
      key: 'No, suggest changes (esc)',
    });

    // Warnings render as a sibling Box *below* the MaxSizedBox-capped
    // command body, with marginTop={1}, so their footprint is charged against
    // the same budget instead of landing outside the cap. Each warning is
    // truncated to one row inside the box, and the box adds a counted footer
    // row when it clips.
    const warnings = executionProps.warnings ?? [];
    const warningsCount = warnings.length;

    // The command body is sized from the whole grant the surrounding chrome
    // leaves, and the compact ceiling applies to that grant, so a compact exec
    // still gets a full five command rows. The vertical chrome — the outer
    // padding, the body margin, the question and the option list — is already
    // charged inside availableBodyContentHeight(), and the command box's own
    // padding is horizontal, so no vertical reservation is owed here: taking one
    // made the cap two rows taller than the grant, which is how uncapped
    // warnings escaped it.
    bodyBudget = compactClamp(availableBodyContentHeight());

    let warningMarginTop = warningsCount > 0 ? 1 : 0;
    let warningMaxHeight: number | undefined;
    let warningsCapped = false;
    let commandHeight = bodyBudget;
    if (warningsCount > 0 && bodyBudget !== undefined) {
      const warningSplit = splitWarningBudget(bodyBudget, warnings);
      warningMarginTop = warningSplit.gap;
      warningsCapped = !warningSplit.uncapped;
      warningMaxHeight = warningSplit.uncapped
        ? undefined
        : warningSplit.warningHeight;
      commandHeight = warningSplit.subjectHeight;
    } else if (commandHeight !== undefined) {
      commandHeight = Math.max(commandHeight - warningsHeight(warnings), 1);
    }
    const warningsDropped = warningMaxHeight === 0;

    const renderedCommand =
      commandHeight === undefined || commandHeight >= MINIMUM_MAX_HEIGHT ? (
        <Box paddingX={1} marginLeft={1}>
          <MaxSizedBox
            maxHeight={commandHeight}
            maxWidth={Math.max(contentWidth, 1)}
            overflowDirection="bottom"
          >
            <Box>
              <Text color={theme.text.link}>{executionProps.command}</Text>
            </Box>
          </MaxSizedBox>
        </Box>
      ) : commandHeight === 1 ? (
        // The box cannot honour a one-row ask, so a pinned truncated row keeps
        // a cue that the command continues and registers it for the reveal only
        // when the truncation really did cut the command off. The command kept
        // that row from the warnings, so the warnings it dropped ride the tail.
        <Box paddingX={1} marginLeft={1}>
          <OverflowNotice
            color={theme.text.link}
            width={warningContentWidth}
            message={executionProps.command.replace(/\r\n?|\n/g, ' ↵ ')}
            tail={
              warningsDropped
                ? `+${warningsCount} warning(s) hidden`
                : undefined
            }
          />
        </Box>
      ) : null;

    bodyContent = (
      <Box flexDirection="column">
        {renderedCommand}
        {warningsCount > 0 ? (
          <Box
            flexDirection="column"
            paddingX={1}
            marginLeft={1}
            marginTop={warningMarginTop}
          >
            {warningsDropped ? (
              // No row left for the warnings: the command kept the grant. The
              // count rides the command row's tail, so nothing renders here and
              // the reveal is registered directly.
              <HiddenOverflowRegistration />
            ) : warningsCapped && warningMaxHeight === 1 ? (
              // The box floor is two rows, so a one-row ask gets a pinned row
              // instead. The last warning names the exact action; the earlier
              // ones only describe the mode, so it keeps that row, and the width
              // says whether truncation cut characters off it.
              <OverflowNotice
                color={theme.status.warning}
                width={warningContentWidth}
                message={`⚠ ${warnings.at(-1)?.replace(/\r\n?|\n/g, ' ↵ ')}`}
                tail={
                  warningsCount > 1
                    ? `+${warningsCount - 1} warning(s) hidden`
                    : undefined
                }
              />
            ) : warningsCapped ? (
              <MaxSizedBox
                maxHeight={warningMaxHeight}
                maxWidth={warningContentWidth}
                overflowDirection="top"
              >
                {warnings.map((warning, idx) => (
                  <Box key={idx}>
                    <Text color={theme.status.warning} wrap="truncate">
                      ⚠ {warning.replace(/\r\n?|\n/g, ' ↵ ')}
                    </Text>
                  </Box>
                ))}
              </MaxSizedBox>
            ) : (
              warnings.map((warning, idx) => (
                <Text key={idx} color={theme.status.warning}>
                  ⚠ {warning}
                </Text>
              ))
            )}
          </Box>
        ) : null}
      </Box>
    );
  } else if (confirmationDetails.type === 'plan') {
    const planProps = confirmationDetails;

    question = planProps.title;
    options.push({
      key: 'restore-previous',
      label: t('Yes, restore previous mode ({{mode}})', {
        mode: planProps.prePlanMode ?? 'default',
      }),
      value: ToolConfirmationOutcome.RestorePrevious,
    });
    // "Auto-accept edits" is a privileged escalation (AUTO_EDIT): in an
    // untrusted folder the trust gate refuses it, so exit_plan_mode would only
    // ever answer "Failed to exit plan mode". The two remaining exits
    // (proceed once / restore previous) both stay available untrusted.
    if (isTrustedFolder) {
      options.push({
        key: 'proceed-always',
        label: t('Yes, and auto-accept edits'),
        value: ToolConfirmationOutcome.ProceedAlways,
      });
    }
    options.push({
      key: 'proceed-once',
      label: t('Yes, and manually approve edits'),
      value: ToolConfirmationOutcome.ProceedOnce,
    });
    options.push({
      key: 'cancel',
      label: t('No, keep planning (esc)'),
      value: ToolConfirmationOutcome.Cancel,
    });

    bodyBudget = compactClamp(availableBodyContentHeight());
    // Reserve one row for the "o open full plan" hint below the plan body.
    const planHeight =
      bodyBudget === undefined ? undefined : Math.max(bodyBudget - 1, 1);
    // The plan view floors its ceiling at MINIMUM_MAX_HEIGHT and spends one of
    // those rows on its own truncation cue, so below that it renders nothing.
    const planDropped =
      planHeight !== undefined && planHeight < MINIMUM_MAX_HEIGHT;
    bodyContent = (
      <Box
        flexDirection="column"
        paddingX={1}
        marginLeft={1}
        flexShrink={0}
        maxHeight={bodyBudget}
        overflow="hidden"
      >
        {planDropped ? null : (
          <MarkdownDisplay
            text={planProps.plan}
            isPending={false}
            availableTerminalHeight={planHeight}
            contentWidth={contentWidth}
            // Live pending items render inside MainContent's maxHeight +
            // overflow="hidden" wrapper, and Ink clips the BOTTOM. Without a
            // height-aware pre-slice, a long plan silently loses its tail
            // (including the option buttons below). Opt into the same pre-slice
            // the streaming path uses so the body respects the viewport budget.
            // See #6867.
            enforceHeightBudget
          />
        )}
        {/* The plan can be height-truncated above, and the user is about to
            approve it — always offer a way to read the WHOLE thing. See #7001. */}
        {planViewError ? (
          <Box flexShrink={0}>
            <Text color={theme.status.error} wrap="truncate">
              {planViewError}
            </Text>
          </Box>
        ) : (
          <Box flexShrink={0}>
            <Text color={theme.text.secondary} wrap="truncate">
              {t('o open full plan in editor')}
            </Text>
          </Box>
        )}
        {/* Last so the row a one-row budget clips away is this announcement and
            not the hint above it. Registering the overflow is what makes
            ctrl-s, which lifts the budget and restores the whole plan, offer
            itself. */}
        {planDropped && <OverflowNotice message={t('... plan hidden ...')} />}
      </Box>
    );
  } else if (confirmationDetails.type === 'info') {
    const infoProps = confirmationDetails;
    const displayUrls =
      infoProps.urls &&
      !(infoProps.urls.length === 1 && infoProps.urls[0] === infoProps.prompt);

    question = t('Do you want to proceed?');
    options.push({
      label: t('Yes, allow once'),
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Yes, allow once',
    });
    if (isTrustedFolder && !confirmationDetails.hideAlwaysAllow) {
      const friendlyLabel =
        'permissionRules' in infoProps &&
        (infoProps as { permissionRules?: string[] }).permissionRules?.length
          ? ` ${buildHumanReadableRuleLabel((infoProps as { permissionRules?: string[] }).permissionRules!)}`
          : '';
      options.push({
        label: friendlyLabel
          ? t('Always allow {{action}} in this project', {
              action: friendlyLabel.trim(),
            })
          : t('Always allow in this project'),
        value: ToolConfirmationOutcome.ProceedAlwaysProject,
        key: 'Always allow in this project',
      });
      options.push({
        label: friendlyLabel
          ? t('Always allow {{action}} for this user', {
              action: friendlyLabel.trim(),
            })
          : t('Always allow for this user'),
        value: ToolConfirmationOutcome.ProceedAlwaysUser,
        key: 'Always allow for this user',
      });
    }
    options.push({
      label: t('No, suggest changes (esc)'),
      value: ToolConfirmationOutcome.Cancel,
      key: 'No, suggest changes (esc)',
    });

    bodyBudget = compactClamp(availableBodyContentHeight());
    const urlList = displayUrls ? (infoProps.urls ?? []) : [];
    // What the destination block costs besides the destinations themselves: a
    // blank row above the list, then the "URLs to fetch:" label.
    const URL_MARGIN_ROW = 1;
    const URL_LABEL_ROW = 1;
    // Measured from the source, not from the rendered link: every inline
    // Markdown construct RenderInline strips adds characters, so this never
    // counts a row short and cannot let the block grow past the cap.
    const urlRowHeights =
      bodyBudget === undefined
        ? []
        : urlList.map((url) => wrappedRows(` - ${url}`, warningContentWidth));
    const totalUrlRows = urlRowHeights.reduce((sum, rows) => sum + rows, 0);
    const takeWholeUrls = (room: number) => {
      let count = 0;
      let rows = 0;
      while (
        count < urlRowHeights.length &&
        rows + (urlRowHeights[count] ?? 0) <= room
      ) {
        rows += urlRowHeights[count] ?? 0;
        count++;
      }
      return { count, rows };
    };
    let urlFixedRows = 0;
    let urlLimit = 0;
    let urlRows = 0;
    let urlFooterRows = 0;
    if (urlList.length > 0) {
      if (bodyBudget === undefined) {
        urlFixedRows = URL_MARGIN_ROW + URL_LABEL_ROW;
        urlLimit = urlList.length;
        urlRows = totalUrlRows;
      } else {
        const budget = bodyBudget;
        // The destinations are what the user is being asked to authorise, so
        // they are costed before the prose that only describes the request. The
        // block's own chrome is what gets handed back when the budget is tight,
        // roomiest tier first: the blank row and label stay while at least one
        // destination still fits under them, and are dropped only when keeping
        // them would leave the list with nothing under it.
        const urlTiers = [URL_MARGIN_ROW + URL_LABEL_ROW, URL_LABEL_ROW, 0];
        // If every destination fits at some tier, the roomiest such tier is the
        // one to take: a tighter tier that also fits would hide a destination
        // behind a footer row the budget did not need.
        const fullChrome = urlTiers.find(
          (chrome) => chrome + totalUrlRows <= budget,
        );
        if (fullChrome !== undefined) {
          urlFixedRows = fullChrome;
          urlLimit = urlList.length;
          urlRows = totalUrlRows;
        } else {
          for (const chrome of urlTiers) {
            const taken = takeWholeUrls(budget - chrome - MARKER_ROW);
            if (taken.count > 0) {
              urlFixedRows = chrome;
              urlLimit = taken.count;
              urlRows = taken.rows;
              // Some destination is always hidden here: if none were, a tier
              // would have held the whole list above.
              urlFooterRows = MARKER_ROW;
              break;
            }
          }
          if (urlLimit === 0) {
            // No whole destination fits beside the footer row. The count still
            // gets a row, so a dropped destination list is never silent.
            urlFooterRows = MARKER_ROW;
          }
        }
      }
    }
    const hiddenUrlCount = urlList.length - urlLimit;
    const proseRows =
      bodyBudget === undefined
        ? 0
        : wrappedRows(
            infoProps.renderPromptAsPlainText
              ? infoProps.prompt
              : getInlinePlainText(infoProps.prompt),
            warningContentWidth,
          );
    let proseBudget =
      bodyBudget === undefined
        ? undefined
        : Math.max(bodyBudget - urlFixedRows - urlRows - urlFooterRows, 0);
    const proseOverflows = proseBudget !== undefined && proseRows > proseBudget;
    // Every clip spends a row on its announcement, so a budget below that row
    // leaves nothing of the prose on screen. The block is then dropped whole and
    // announced the way the plan body is, instead of claiming a tail clip over
    // an empty region. A block that already fits pays nothing, so the floor
    // never applies to it.
    const proseDropped =
      proseOverflows &&
      proseBudget !== undefined &&
      proseBudget < MINIMUM_MAX_HEIGHT;
    let hiddenProseRows = 0;
    if (
      !proseDropped &&
      proseOverflows &&
      proseBudget !== undefined &&
      !infoProps.renderPromptAsPlainText
    ) {
      // Ink clips the pinned inline-Markdown box, so what disappeared is
      // measured from the text it renders instead of being counted by the
      // clipper.
      hiddenProseRows = proseRows - (proseBudget - MARKER_ROW);
      proseBudget = proseBudget - MARKER_ROW;
    }
    // The prose is dropped whole rather than clipped, and the row it vacates
    // pays for the announcement. When not even that row is left, the
    // destinations keep it: they are what is being authorised.
    const proseHiddenWhole =
      proseDropped && proseBudget !== undefined && proseBudget >= MARKER_ROW;

    bodyContent = (
      <Box flexDirection="column" paddingX={1} marginLeft={1}>
        {infoProps.renderPromptAsPlainText ? (
          proseDropped ? null : (
            <MaxSizedBox
              maxHeight={proseBudget}
              maxWidth={warningContentWidth}
              overflowDirection="bottom"
            >
              {infoProps.prompt.split('\n').map((line, index) => (
                <Box key={index}>
                  <Text color={theme.text.link} wrap="wrap">
                    {line}
                  </Text>
                </Box>
              ))}
            </MaxSizedBox>
          )
        ) : proseDropped ? null : (
          <Box flexShrink={0} maxHeight={proseBudget} overflow="hidden">
            <Text color={theme.text.link}>
              <RenderInline
                text={infoProps.prompt}
                textColor={theme.text.link}
              />
            </Text>
          </Box>
        )}
        {proseDropped && !proseHiddenWhole && <HiddenOverflowRegistration />}
        {proseHiddenWhole && (
          <OverflowNotice message={t('... prompt hidden ...')} />
        )}
        {hiddenProseRows > 0 && (
          <OverflowNotice
            message={`... last ${hiddenProseRows} line${
              hiddenProseRows === 1 ? '' : 's'
            } hidden ...`}
          />
        )}
        {(urlLimit > 0 || hiddenUrlCount > 0) && (
          <Box
            flexDirection="column"
            marginTop={
              urlLimit > 0 && urlFixedRows > URL_LABEL_ROW ? URL_MARGIN_ROW : 0
            }
          >
            {urlLimit > 0 && urlFixedRows >= URL_LABEL_ROW && (
              // Pinned and truncated: the label is charged one row, so it may
              // not wrap or compress into the rows below it.
              <Box flexShrink={0}>
                <Text color={theme.text.primary} wrap="truncate">
                  {t('URLs to fetch:')}
                </Text>
              </Box>
            )}
            {urlList.slice(0, urlLimit).map((url, index) => (
              <Box key={`${url}-${index}`} flexShrink={0}>
                <Text wrap="wrap">
                  {' '}
                  - <RenderInline text={url} />
                </Text>
              </Box>
            ))}
            {hiddenUrlCount > 0 && (
              <OverflowNotice
                message={`... ${hiddenUrlCount} more URL${
                  hiddenUrlCount === 1 ? '' : 's'
                } hidden ...`}
              />
            )}
          </Box>
        )}
      </Box>
    );
  } else if (confirmationDetails.type === 'ask_user_question') {
    // Use dedicated dialog for ask_user_question type
    return (
      <AskUserQuestionDialog
        confirmationDetails={confirmationDetails}
        isFocused={inputActive}
        availableWidth={contentWidth}
        onConfirm={onConfirm}
      />
    );
  } else {
    // mcp tool confirmation
    const mcpProps = confirmationDetails as ToolMcpConfirmationDetails;

    question = t(
      'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?',
      {
        tool: mcpProps.toolName,
        server: mcpProps.serverName,
      },
    );
    options.push({
      label: t('Yes, allow once'),
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Yes, allow once',
    });
    if (isTrustedFolder && !confirmationDetails.hideAlwaysAllow) {
      const friendlyLabel = mcpProps.permissionRules?.length
        ? ` ${buildHumanReadableRuleLabel(mcpProps.permissionRules)}`
        : '';
      options.push({
        label: friendlyLabel
          ? t('Always allow {{action}} in this project', {
              action: friendlyLabel.trim(),
            })
          : t('Always allow in this project'),
        value: ToolConfirmationOutcome.ProceedAlwaysProject,
        key: 'Always allow in this project',
      });
      options.push({
        label: friendlyLabel
          ? t('Always allow {{action}} for this user', {
              action: friendlyLabel.trim(),
            })
          : t('Always allow for this user'),
        value: ToolConfirmationOutcome.ProceedAlwaysUser,
        key: 'Always allow for this user',
      });
    }
    options.push({
      label: t('No, suggest changes (esc)'),
      value: ToolConfirmationOutcome.Cancel,
      key: 'No, suggest changes (esc)',
    });

    // Sized after the options exist because availableBodyContentHeight()
    // charges the option list.
    bodyBudget = compactClamp(availableBodyContentHeight());
    const serverLabel = t('MCP Server: {{server}}', {
      server: mcpProps.serverName,
    });
    const toolLabel = t('Tool: {{tool}}', { tool: mcpProps.toolName });
    // One row cannot hold both labels, and neither half is dispensable: the
    // server says where the call goes, the tool says what it does. So each is
    // cut to its own head, which keeps both visible and puts the ellipsis
    // inside the label that ran out of room.
    const identityShare = Math.floor((warningContentWidth - 1) / 2);
    const identityLine = `${truncateToWidth(serverLabel, identityShare)} ${truncateToWidth(toolLabel, identityShare)}`;
    bodyContent = (
      <Box flexDirection="column" paddingX={1} marginLeft={1}>
        {bodyBudget !== undefined && bodyBudget < MINIMUM_MAX_HEIGHT ? (
          // MaxSizedBox floors its ceiling at MINIMUM_MAX_HEIGHT and spends one
          // of those rows on its footer, so under a one-row budget it renders
          // more than the cap and the outer clip takes the footer away. Pin one
          // row instead, carrying both halves of the identity, registered so
          // ctrl-s offers the whole labels.
          <OverflowNotice
            color={theme.text.link}
            hidden={
              stringWidth(`${serverLabel} ${toolLabel}`) > warningContentWidth
            }
            message={identityLine}
          />
        ) : (
          <MaxSizedBox
            maxHeight={bodyBudget}
            maxWidth={warningContentWidth}
            overflowDirection="bottom"
          >
            <Box>
              <Text color={theme.text.link} wrap="wrap">
                {serverLabel}
              </Text>
            </Box>
            <Box>
              <Text color={theme.text.link} wrap="wrap">
                {toolLabel}
              </Text>
            </Box>
          </MaxSizedBox>
        )}
      </Box>
    );
  }

  if (offersSwitchToDefault) {
    const cancelIndex = options.findIndex(
      (option) => option.value === ToolConfirmationOutcome.Cancel,
    );
    const switchOption: RadioSelectItem<ToolConfirmationOutcome> = {
      key: 'switch-default-and-proceed-once',
      label: t('Switch to Default Mode and allow once (recommended)'),
      value: ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
    };
    options.splice(
      cancelIndex === -1 ? options.length : cancelIndex,
      0,
      switchOption,
    );
  }

  if (autoModeFallback) {
    bodyContent = (
      <Box flexDirection="column">
        <Box paddingX={1} marginLeft={1} marginBottom={1}>
          <Text color={theme.status.warning}>
            ⚠ {autoModeFallback.message}
          </Text>
        </Box>
        {bodyContent}
      </Box>
    );
  }

  // For exec/mcp confirmations the type-specific question text would
  // restate what the body already shows (the full command, or the labeled
  // server + tool). Use the generic prompt so the question line acts as a
  // body→options transition without duplicating information.
  const renderedQuestion =
    compactMode &&
    (confirmationDetails.type === 'exec' || confirmationDetails.type === 'mcp')
      ? t('Do you want to proceed?')
      : question;

  // Compact mode trims the option list to a fixed 3-option set (the
  // project/user-scope "Always allow" variants would clutter the inline
  // subagent banner) but still shows the per-type body and question so the
  // parent knows what is being approved.
  const renderedOptions: Array<RadioSelectItem<ToolConfirmationOutcome>> =
    compactMode
      ? [
          {
            key: 'proceed-once',
            label: t('Yes, allow once'),
            value: ToolConfirmationOutcome.ProceedOnce,
          },
          ...(offersSwitchToDefault
            ? [
                {
                  key: 'switch-default-and-proceed-once',
                  label: t(
                    'Switch to Default Mode and allow once (recommended)',
                  ),
                  value: ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
                },
              ]
            : []),
          ...(isTrustedFolder && !confirmationDetails.hideAlwaysAllow
            ? [
                {
                  key: 'proceed-always',
                  label: t('Allow always'),
                  value: ToolConfirmationOutcome.ProceedAlways,
                },
              ]
            : []),
          {
            key: 'cancel',
            label: t('No'),
            value: ToolConfirmationOutcome.Cancel,
          },
        ]
      : options;

  // Compact mode strips outer padding, inter-section margins, and explicit
  // width — the parent (SubagentExecutionRenderer) already provides those.
  const outerPadding = compactMode ? 0 : 1;
  const sectionMargin = compactMode ? 0 : 1;
  const outerWidth = compactMode ? undefined : contentWidth;

  return (
    <Box flexDirection="column" padding={outerPadding} width={outerWidth}>
      {/* The cap also covers bodies that do not cap themselves (inline-Markdown
          info prompts, long MCP labels). Ink clips the bottom, so an uncapped
          body pushes the question line and the options out of the viewport.
          Reuse the budget the body branch already sized against instead of
          recomputing it: at this point `options` already contains the spliced
          auto-mode "switch to default" row and the banner has been folded into
          bodyContent, so a second availableBodyContentHeight() would charge
          both of them twice and cut the body below what it was sized for. */}
      <Box
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
        marginBottom={sectionMargin}
        maxHeight={
          bodyBudget === undefined
            ? undefined
            : bodyBudget + autoModeFallbackHeight
        }
      >
        {bodyContent}
      </Box>

      <Box marginBottom={sectionMargin} flexShrink={0}>
        <Text color={theme.text.primary} wrap="truncate">
          {renderedQuestion}
        </Text>
      </Box>

      <Box flexShrink={0}>
        <RadioButtonSelect
          items={renderedOptions}
          onSelect={handleSelect}
          isFocused={inputActive}
        />
      </Box>
    </Box>
  );
};
