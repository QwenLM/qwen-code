// @vitest-environment jsdom
//
// Pins the wiring that carries the session's availableSkills membership
// into the argument hint: useComposerCore must feed its `skills` prop to
// the input highlight extension. Extension skills arrive with the shared
// 'plugin-command' source, so without this link they lose progressive
// hints the moment an argument is typed while the parser tests stay green.

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import type { CommandInfo } from '../adapters/types';
import type { SkillInfo } from '../completions/slashCompletion';
import { useComposerCore, type UseComposerCoreReturn } from './useComposerCore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseComposerCoreReturn | null = null;

const EXTENSION_SKILL_COMMAND: CommandInfo = {
  name: 'ext:probe',
  description: '',
  source: 'plugin-command',
  argumentHint: '<id> [--watch]',
};

function Harness({
  commands,
  skills,
}: {
  commands: CommandInfo[];
  skills: SkillInfo[];
}) {
  const composer = useComposerCore({
    onSubmit: () => true,
    commands,
    skills,
    editorTheme: {},
  });
  latest = composer;
  return <div ref={composer.containerRef} />;
}

async function mount(skills: SkillInfo[]) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <Harness commands={[EXTENSION_SKILL_COMMAND]} skills={skills} />
      </I18nProvider>,
    );
  });
}

function typeAndReadHint(text: string): string | null {
  const view = latest!.viewRef.current!;
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
    view.measure();
  });
  return (
    container!.querySelector('.cm-input-slash-argument-hint')?.textContent ??
    null
  );
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.innerHTML = '';
});

describe('useComposerCore skill argument hint wiring', () => {
  it('renders the progressive hint for an extension skill listed in skills', async () => {
    await mount([{ name: 'ext:probe', description: '' }]);
    expect(typeAndReadHint('/ext:probe 42')).toBe(' [--watch]');
  });

  it('withholds the hint when the same command is not a session skill', async () => {
    await mount([]);
    expect(typeAndReadHint('/ext:probe 42')).toBeNull();
  });
});
