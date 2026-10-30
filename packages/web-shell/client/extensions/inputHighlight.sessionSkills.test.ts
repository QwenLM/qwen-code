// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import type { DaemonSessionSupportedCommandsStatus } from '@qwen-code/sdk/daemon';
import type { CommandInfo } from '../adapters/types';
import { mapSupportedCommands } from '../daemon/session/mappers';
import { inputHighlight } from './inputHighlight';

// Mirrors the live /supported-commands metadata: project skills arrive as
// 'skill-dir-command' and bundled skills as 'bundled-skill', while the
// availableSkills merge synthesizes raw._meta.source 'skill' without
// replacing the top-level loader source.
const SESSION_STATUS: DaemonSessionSupportedCommandsStatus = {
  v: 1,
  sessionId: 'test-session',
  availableCommands: [
    {
      name: 'verify-pr',
      description: 'Verify a PR',
      input: { hint: '<pr-number> [--publish] [--watch]' },
      _meta: { source: 'skill-dir-command' },
    },
    {
      name: 'review',
      description: 'Review code',
      input: { hint: '[pr-number] [--fix]' },
      _meta: { source: 'bundled-skill' },
    },
  ],
  availableSkills: ['verify-pr', 'review'],
};

function renderHint(doc: string, commands: CommandInfo[]): string | null {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        inputHighlight(
          () => commands,
          () => 'en',
        ),
      ],
    }),
    parent,
  });
  view.measure();
  const text =
    parent.querySelector('.cm-input-slash-argument-hint')?.textContent ?? null;
  view.destroy();
  parent.remove();
  return text;
}

describe('inputHighlight with live-session skill commands', () => {
  it('keeps the loader source through the availableSkills merge', () => {
    const { commands } = mapSupportedCommands(SESSION_STATUS);
    expect(commands.find((c) => c.name === 'verify-pr')?.source).toBe(
      'skill-dir-command',
    );
    expect(commands.find((c) => c.name === 'review')?.source).toBe(
      'bundled-skill',
    );
  });

  it('renders progressive hints for project and bundled skills after session attach', () => {
    const { commands } = mapSupportedCommands(SESSION_STATUS);
    expect(renderHint('/verify-pr', commands)).toBe(
      ' <pr-number> [--publish] [--watch]',
    );
    expect(renderHint('/verify-pr 15871', commands)).toBe(
      ' [--publish] [--watch]',
    );
    expect(renderHint('/review 15871', commands)).toBe(' [--fix]');
  });
});
