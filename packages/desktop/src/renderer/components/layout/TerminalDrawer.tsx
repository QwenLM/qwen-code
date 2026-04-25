/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopProject, DesktopTerminal } from '../../api/client.js';

export function TerminalDrawer({
  command,
  error,
  onClear,
  onCommandChange,
  onKill,
  onRun,
  project,
  terminal,
}: {
  command: string;
  error: string | null;
  onClear: () => void;
  onCommandChange: (command: string) => void;
  onKill: () => void;
  onRun: () => void;
  project: DesktopProject | null;
  terminal: DesktopTerminal | null;
}) {
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
      <pre className="terminal-output">
        {terminal
          ? `$ ${terminal.command}\n[${terminal.status}]${terminal.exitCode === null ? '' : ` exit ${terminal.exitCode}`}\n${terminal.output}`
          : 'No terminal output'}
      </pre>
      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}
