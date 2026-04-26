/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopProject, DesktopTerminal } from '../../api/client.js';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  PaperclipIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from './SidebarIcons.js';

export function TerminalDrawer({
  command,
  error,
  isExpanded,
  input,
  notice,
  onAttachOutput,
  onClear,
  onCommandChange,
  onCopyOutput,
  onInputChange,
  onKill,
  onRun,
  onToggleExpanded,
  onWriteInput,
  project,
  terminal,
}: {
  command: string;
  error: string | null;
  isExpanded: boolean;
  input: string;
  notice: string | null;
  onAttachOutput: () => void;
  onClear: () => void;
  onCommandChange: (command: string) => void;
  onCopyOutput: () => void;
  onInputChange: (input: string) => void;
  onKill: () => void;
  onRun: () => void;
  onToggleExpanded: () => void;
  onWriteInput: () => void;
  project: DesktopProject | null;
  terminal: DesktopTerminal | null;
}) {
  const hasOutput = (terminal?.output.trim().length ?? 0) > 0;
  const canWriteInput = terminal?.status === 'running';
  const terminalStatus = getTerminalStatusLabel(terminal);
  const terminalPreview = getTerminalPreview(terminal, notice, error);
  const toggleLabel = isExpanded ? 'Collapse Terminal' : 'Expand Terminal';

  return (
    <section
      className={
        isExpanded
          ? 'terminal-drawer terminal-drawer-expanded'
          : 'terminal-drawer terminal-drawer-collapsed'
      }
      aria-label="Terminal"
      data-expanded={String(isExpanded)}
      data-testid="terminal-drawer"
    >
      <button
        aria-controls="terminal-drawer-body"
        aria-expanded={isExpanded}
        aria-label={toggleLabel}
        className="terminal-strip"
        data-testid="terminal-toggle"
        title={toggleLabel}
        type="button"
        onClick={onToggleExpanded}
      >
        <span className="terminal-strip-icon" aria-hidden="true">
          <TerminalIcon />
        </span>
        <span className="terminal-strip-copy">
          <span className="sr-only">Terminal project</span>
          <strong data-testid="terminal-strip-project">
            {project?.name || 'No project'}
          </strong>
        </span>
        <span
          className="terminal-strip-status"
          data-testid="terminal-strip-status"
        >
          {terminalStatus}
        </span>
        <span
          className="terminal-strip-preview"
          data-testid="terminal-strip-preview"
        >
          {terminalPreview}
        </span>
        <span className="terminal-strip-chevron" aria-hidden="true">
          {isExpanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </span>
      </button>

      {isExpanded ? (
        <div
          className="terminal-body"
          data-testid="terminal-body"
          id="terminal-drawer-body"
        >
          <div className="terminal-actions" aria-label="Terminal actions">
            <button
              aria-label="Copy Output"
              className="terminal-icon-button"
              disabled={!terminal}
              title="Copy Output"
              type="button"
              onClick={onCopyOutput}
            >
              <CopyIcon />
              <span className="sr-only">Copy Output</span>
            </button>
            <button
              aria-label="Attach Output"
              className="terminal-icon-button"
              disabled={!hasOutput}
              title="Attach Output to Composer"
              type="button"
              onClick={onAttachOutput}
            >
              <PaperclipIcon />
              <span className="sr-only">Attach Output</span>
            </button>
            <button
              aria-label="Clear Terminal"
              className="terminal-icon-button terminal-icon-button-muted"
              title="Clear Terminal"
              type="button"
              onClick={onClear}
            >
              <TrashIcon />
              <span className="sr-only">Clear Terminal</span>
            </button>
            <button
              aria-label="Kill Terminal"
              className="terminal-icon-button terminal-icon-button-danger"
              disabled={terminal?.status !== 'running'}
              title="Kill Terminal"
              type="button"
              onClick={onKill}
            >
              <StopIcon />
              <span className="sr-only">Kill Terminal</span>
            </button>
          </div>
          <div className="terminal-command-row">
            <input
              aria-label="Terminal command"
              disabled={!project}
              placeholder={
                project ? 'Run command in project' : 'Open a project'
              }
              value={command}
              onChange={(event) => onCommandChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  onRun();
                }
              }}
            />
            <button
              className="primary-button"
              disabled={!project || command.trim().length === 0}
              type="button"
              onClick={onRun}
            >
              Run
            </button>
          </div>
          <div className="terminal-input-row">
            <textarea
              aria-label="Terminal input"
              disabled={!canWriteInput}
              placeholder={
                canWriteInput
                  ? 'Write to running process stdin'
                  : 'Start a running process to send stdin'
              }
              rows={2}
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
            />
            <button
              className="secondary-button"
              disabled={!canWriteInput || input.trim().length === 0}
              type="button"
              onClick={onWriteInput}
            >
              Send Input
            </button>
          </div>
          <pre className="terminal-output">
            {terminal
              ? `$ ${terminal.command}\n[${terminal.status}]${terminal.exitCode === null ? '' : ` exit ${terminal.exitCode}`}\n${terminal.output}`
              : 'No terminal output'}
          </pre>
          {notice ? <p className="success-text">{notice}</p> : null}
          {error ? <p className="error-text">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function getTerminalStatusLabel(terminal: DesktopTerminal | null): string {
  if (!terminal) {
    return 'Idle';
  }

  if (terminal.exitCode === null) {
    return terminal.status;
  }

  return `${terminal.status} ${String(terminal.exitCode)}`;
}

function getTerminalPreview(
  terminal: DesktopTerminal | null,
  notice: string | null,
  error: string | null,
): string {
  if (error) {
    return error;
  }

  if (notice) {
    return notice;
  }

  if (!terminal) {
    return 'No recent command';
  }

  const output = terminal.output.trim().replace(/\s+/gu, ' ');
  if (output) {
    return output;
  }

  return `$ ${terminal.command}`;
}
