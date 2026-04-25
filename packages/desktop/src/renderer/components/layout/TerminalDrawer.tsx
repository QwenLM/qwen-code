/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopProject, DesktopTerminal } from '../../api/client.js';

export function TerminalDrawer({
  command,
  error,
  input,
  notice,
  onClear,
  onCommandChange,
  onCopyOutput,
  onInputChange,
  onKill,
  onRun,
  onSendOutputToAi,
  onWriteInput,
  project,
  terminal,
}: {
  command: string;
  error: string | null;
  input: string;
  notice: string | null;
  onClear: () => void;
  onCommandChange: (command: string) => void;
  onCopyOutput: () => void;
  onInputChange: (input: string) => void;
  onKill: () => void;
  onRun: () => void;
  onSendOutputToAi: () => void;
  onWriteInput: () => void;
  project: DesktopProject | null;
  terminal: DesktopTerminal | null;
}) {
  const hasOutput = (terminal?.output.trim().length ?? 0) > 0;
  const canWriteInput = terminal?.status === 'running';

  return (
    <section
      className="terminal-drawer"
      aria-label="Terminal"
      data-testid="terminal-drawer"
    >
      <div className="terminal-header">
        <div>
          <span className="message-role">Terminal</span>
          <strong>{project?.name || 'No project'}</strong>
        </div>
        <div className="terminal-actions">
          <button
            className="secondary-button"
            disabled={!terminal}
            type="button"
            onClick={onCopyOutput}
          >
            Copy Output
          </button>
          <button
            className="secondary-button"
            disabled={!hasOutput}
            type="button"
            onClick={onSendOutputToAi}
          >
            Send to AI
          </button>
          <button className="secondary-button" type="button" onClick={onClear}>
            Clear
          </button>
          <button
            className="secondary-button"
            disabled={terminal?.status !== 'running'}
            type="button"
            onClick={onKill}
          >
            Kill
          </button>
        </div>
      </div>
      <div className="terminal-command-row">
        <input
          aria-label="Terminal command"
          disabled={!project}
          placeholder={project ? 'Run command in project' : 'Open a project'}
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
    </section>
  );
}
