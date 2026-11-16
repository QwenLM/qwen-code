// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import type { DaemonSessionSupportedCommandsStatus } from '@qwen-code/sdk/daemon';
import type { CommandInfo } from '../adapters/types';
import { mapSupportedCommands } from '../daemon/session/mappers';
import { inputHighlight } from './inputHighlight';

// Mirrors the live /supported-commands metadata: project skills arrive as
// 'skill-dir-command', bundled skills as 'bundled-skill', and extension
// skills as 'plugin-command' (a label they share with ordinary plugin
// commands) while all of them are listed in availableSkills. The
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
    {
      name: 'review-hint-fixture:hint-probe',
      description: 'Extension skill',
      input: { hint: '<id> [--watch]' },
      _meta: { source: 'plugin-command' },
    },
    {
      name: 'plugin-tool',
      description: 'Ordinary plugin command, not a skill',
      input: { hint: '<target>' },
      _meta: { source: 'plugin-command' },
    },
  ],
  availableSkills: ['verify-pr', 'review', 'review-hint-fixture:hint-probe'],
};

function renderHint(
  doc: string,
  commands: CommandInfo[],
  skillNames: string[],
): string | null {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const skills = skillNames.map((name) => ({ name, description: '' }));
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        inputHighlight(
          () => commands,
          () => 'en',
          () => skills,
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
    expect(
      commands.find((c) => c.name === 'review-hint-fixture:hint-probe')?.source,
    ).toBe('plugin-command');
  });

  it('renders progressive hints for project and bundled skills after session attach', () => {
    const { commands, skills } = mapSupportedCommands(SESSION_STATUS);
    expect(renderHint('/verify-pr', commands, skills)).toBe(
      ' <pr-number> [--publish] [--watch]',
    );
    expect(renderHint('/verify-pr 15871', commands, skills)).toBe(
      ' [--publish] [--watch]',
    );
    expect(renderHint('/review 15871', commands, skills)).toBe(' [--fix]');
  });

  it('renders progressive hints for extension skills via session skill membership', () => {
    const { commands, skills } = mapSupportedCommands(SESSION_STATUS);
    expect(
      renderHint('/review-hint-fixture:hint-probe 42', commands, skills),
    ).toBe(' [--watch]');
  });

  it('leaves ordinary plugin commands outside the skill hint path', () => {
    const { commands, skills } = mapSupportedCommands(SESSION_STATUS);
    expect(renderHint('/plugin-tool', commands, skills)).toBe(' <target>');
    expect(renderHint('/plugin-tool 42', commands, skills)).toBeNull();
  });
});
