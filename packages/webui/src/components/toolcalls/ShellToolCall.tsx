/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shell tool call component for Execute/Bash/Command
 * Pure UI component - platform interactions via usePlatform hook
 */

import type { FC } from 'react';
import {
  ToolCallContainer,
  CopyButton,
  safeTitle,
  groupContent,
} from './shared/index.js';
import { usePlatform } from '../../context/PlatformContext.js';
import type {
  BaseToolCallProps,
  ToolCallContainerProps,
} from './shared/index.js';

import './ShellToolCall.css';

type ShellVariant = 'execute' | 'bash';

/**
 * Custom container for Execute variant with different styling
 */
const ExecuteToolCallContainer: FC<ToolCallContainerProps> = ({
  label,
  status = 'success',
  children,
  toolCallId: _toolCallId,
  labelSuffix,
  className: _className,
  isFirst = false,
  isLast = false,
}) => (
  <div
    className={`ExecuteToolCall qwen-message message-item ${_className || ''} relative pl-[30px] py-2 select-text toolcall-container toolcall-status-${status}`}
    data-first={isFirst}
    data-last={isLast}
  >
    <div className="toolcall-content-wrapper flex flex-col min-w-0 max-w-full">
      <div className="flex items-baseline gap-1.5 relative min-w-0">
        <span className="text-[14px] leading-none font-bold text-[var(--app-primary-foreground)]">
          {label}
        </span>
        <span className="text-[11px] text-[var(--app-secondary-foreground)]">
          {labelSuffix}
        </span>
      </div>
      {children && (
        <div className="text-[var(--app-secondary-foreground)]">{children}</div>
      )}
    </div>
  </div>
);

/**
 * Get command text from tool call data
 */
const getCommandText = (
  variant: ShellVariant,
  title: unknown,
  rawInput?: unknown,
): string => {
  if (variant === 'execute' && rawInput && typeof rawInput === 'object') {
    const description = (rawInput as Record<string, unknown>).description;
    const describedTitle = safeTitle(description);
    if (describedTitle) {
      return describedTitle;
    }
  }
  return safeTitle(title);
};

/**
 * Get input command from raw input
 */
const getInputCommand = (
  commandText: string,
  rawInput?: string | object,
): string => {
  if (rawInput && typeof rawInput === 'object') {
    const inputObj = rawInput as Record<string, unknown>;
    return (inputObj.command as string | undefined) || commandText;
  }
  if (typeof rawInput === 'string') {
    return rawInput;
  }
  return commandText;
};

/**
 * Shell tool call implementation
 */
const ShellToolCallImpl: FC<BaseToolCallProps & { variant: ShellVariant }> = ({
  toolCall,
  variant,
  isFirst,
  isLast,
}) => {
  const { title, content, rawInput, toolCallId } = toolCall;
  const classPrefix = variant;
  const platform = usePlatform();

  /**
   * Open content in a temporary file (if platform supports it)
   */
  const openTempFile = (content: string, fileName: string) => {
    if (platform.openTempFile) {
      platform.openTempFile(content, fileName);
      return;
    }
    // Fallback: post message for platforms that handle it differently
    platform.postMessage({
      type: 'createAndOpenTempFile',
      data: {
        content,
        fileName,
      },
    });
  };

  const commandText = getCommandText(variant, title, rawInput);
  const inputCommand = getInputCommand(commandText, rawInput);

  const Container =
    variant === 'execute' ? ExecuteToolCallContainer : ToolCallContainer;
  const label = variant === 'execute' ? 'Execute' : 'Bash';

  // Group content by type
  const { textOutputs, errors } = groupContent(content);

  // Handle click on IN section
  const handleInClick = () => {
    openTempFile(inputCommand, `${classPrefix}-input-${toolCallId}`);
  };

  // Handle click on OUT section
  const handleOutClick = () => {
    if (textOutputs.length > 0) {
      const output = textOutputs.join('\n');
      openTempFile(output, `${classPrefix}-output-${toolCallId}`);
    }
  };

  // Map tool status to container status for proper bullet coloring
  const containerStatus:
    | 'success'
    | 'error'
    | 'warning'
    | 'loading'
    | 'default' =
    errors.length > 0 || (variant === 'execute' && toolCall.status === 'failed')
      ? 'error'
      : toolCall.status === 'in_progress' || toolCall.status === 'pending'
        ? 'loading'
        : 'success';

  // Error case
  if (errors.length > 0) {
    return (
      <Container
        label={label}
        status={containerStatus}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
      >
        {/* Branch connector summary */}
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <span className="flex-shrink-0 w-full">{commandText}</span>
        </div>

        <div className={`${classPrefix}-toolcall-card`}>
          <div className={`${classPrefix}-toolcall-content`}>
            <div
              className={`${classPrefix}-toolcall-row ${classPrefix}-toolcall-row-with-copy group`}
              onClick={handleInClick}
              style={{ cursor: 'pointer' }}
            >
              <div className={`${classPrefix}-toolcall-label`}>IN</div>
              <div className={`${classPrefix}-toolcall-row-content`}>
                <pre className={`${classPrefix}-toolcall-pre`}>
                  {inputCommand}
                </pre>
              </div>
              <CopyButton text={inputCommand} />
            </div>

            <div className={`${classPrefix}-toolcall-row`}>
              <div className={`${classPrefix}-toolcall-label`}>Error</div>
              <div className={`${classPrefix}-toolcall-row-content`}>
                <pre
                  className={`${classPrefix}-toolcall-pre ${classPrefix}-toolcall-error-content`}
                >
                  {errors.join('\n')}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </Container>
    );
  }

  // Success with output
  if (textOutputs.length > 0) {
    const output = textOutputs.join('\n');
    const truncatedOutput =
      output.length > 500 ? output.substring(0, 500) + '...' : output;

    return (
      <Container
        label={label}
        status={containerStatus}
        toolCallId={toolCallId}
        isFirst={isFirst}
        isLast={isLast}
      >
        {/* Branch connector summary */}
        <div className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1">
          <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
          <span className="flex-shrink-0 w-full">{commandText}</span>
        </div>

        <div className={`${classPrefix}-toolcall-card`}>
          <div className={`${classPrefix}-toolcall-content`}>
            <div
              className={`${classPrefix}-toolcall-row ${classPrefix}-toolcall-row-with-copy group`}
              onClick={handleInClick}
              style={{ cursor: 'pointer' }}
            >
              <div className={`${classPrefix}-toolcall-label`}>IN</div>
              <div className={`${classPrefix}-toolcall-row-content`}>
                <pre className={`${classPrefix}-toolcall-pre`}>
                  {inputCommand}
                </pre>
              </div>
              <CopyButton text={inputCommand} />
            </div>

            <div
              className={`${classPrefix}-toolcall-row`}
              onClick={handleOutClick}
              style={{ cursor: 'pointer' }}
            >
              <div className={`${classPrefix}-toolcall-label`}>OUT</div>
              <div className={`${classPrefix}-toolcall-row-content`}>
                <div className={`${classPrefix}-toolcall-output-subtle`}>
                  <pre className={`${classPrefix}-toolcall-pre`}>
                    {truncatedOutput}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Container>
    );
  }

  // Success without output: show command with branch connector
  return (
    <Container
      label={label}
      status={containerStatus}
      toolCallId={toolCallId}
      isFirst={isFirst}
      isLast={isLast}
    >
      <div
        className="inline-flex text-[var(--app-secondary-foreground)] text-[0.85em] opacity-70 mt-[2px] mb-[2px] flex-row items-start w-full gap-1"
        onClick={handleInClick}
        style={{ cursor: 'pointer' }}
      >
        <span className="flex-shrink-0 relative top-[-0.1em]">⎿</span>
        <span className="flex-shrink-0 w-full">{commandText}</span>
      </div>
    </Container>
  );
};

/**
 * ShellToolCall - displays bash/execute command tool calls
 * Shows command input and output with IN/OUT cards
 */
export const ShellToolCall: FC<BaseToolCallProps> = (props) => {
  const normalizedKind = props.toolCall.kind.toLowerCase();
  const variant: ShellVariant =
    normalizedKind === 'execute' ? 'execute' : 'bash';
  return <ShellToolCallImpl {...props} variant={variant} />;
};
