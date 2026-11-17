// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { HelpDialog } from './HelpDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('HelpDialog built-in command classification', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function commandRow(name: string): HTMLButtonElement | undefined {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.startsWith(`/${name}`));
  }

  function clickTab(label: string): void {
    const tab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === label)!;
    act(() => {
      tab.click();
    });
  }

  it('classifies /pr as built-in and an unknown command as custom', async () => {
    // BUILT_IN_COMMANDS is a hand-maintained set; without this coupling a
    // dropped 'pr' entry would silently relabel /pr as a custom command and
    // move it off the built-in tab. Removing 'pr' from the set reds this test.
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <HelpDialog
            commands={[
              {
                name: 'pr',
                description: 'Bind a GitHub pull request to this session',
              },
              { name: 'my-custom', description: 'A custom command' },
            ]}
          />
        </I18nProvider>,
      );
    });
    // The built-in tab lists only built-in commands: /pr appears tagged
    // built-in, the custom command does not appear here at all.
    clickTab('Built-in commands');
    const prRow = commandRow('pr');
    expect(prRow).not.toBeUndefined();
    expect(prRow!.textContent).toContain('built-in');
    expect(commandRow('my-custom')).toBeUndefined();

    // The custom tab lists the unknown command tagged custom.
    clickTab('custom-commands');
    const customRow = commandRow('my-custom');
    expect(customRow).not.toBeUndefined();
    expect(customRow!.textContent).toContain('custom');
    expect(commandRow('pr')).toBeUndefined();
  });
});
