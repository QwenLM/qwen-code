/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OutputStyleConfig } from '@qwen-code/core';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '../../test-utils/async.js';
import { cleanup, renderWithProviders } from '../../test-utils/render.js';
import { OutputStyleBrowser } from './OutputStyleBrowser.js';

const ENTER = '\r';
const FAKE_KEY = {
  name: 'tab',
  sequence: '\t',
  ctrl: false,
  meta: false,
  shift: false,
  paste: false,
};

const styles: Record<string, OutputStyleConfig | null> = {
  default: null,
  Learning: {
    name: 'Learning',
    description: 'Learn by doing',
    prompt: 'LEARNING',
    source: 'built-in',
  },
  'user-choice': {
    name: 'user-choice',
    description: 'User definition',
    prompt: 'USER',
    source: 'userSettings',
  },
  shared: {
    name: 'shared',
    description: 'Project definition',
    prompt: 'PROJECT',
    source: 'projectSettings',
  },
  'plain-language': {
    name: 'plain-language',
    description: 'Answer without coding guidance',
    prompt: 'PLAIN',
    source: 'projectSettings',
    keepCodingInstructions: false,
  },
  'writer:concise': {
    name: 'writer:concise',
    description: 'Keep every answer concise',
    prompt: 'CONCISE',
    source: 'plugin',
    pluginName: 'writer',
  },
};
const definitions = Object.values(styles).filter(
  (style): style is OutputStyleConfig => style !== null,
);

afterEach(() => {
  cleanup();
});

describe('OutputStyleBrowser', () => {
  it('distinguishes the current style from the configured project style', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <OutputStyleBrowser
        styles={styles}
        definitions={definitions}
        activeStyleName="default"
        configuredStyleName="Learning"
        onSelect={vi.fn()}
        onExit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('current');
      expect(lastFrame()).toContain('configured for project');
      expect(lastFrame()).toContain('Project setting: Learning');
      expect(lastFrame()).toContain('after /clear or /new.');
    });
    unmount();
  });

  it('groups styles by source and shows the active style and descriptions', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <OutputStyleBrowser
        styles={styles}
        definitions={definitions}
        activeStyleName="shared"
        onSelect={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain('Project (2)');
    expect(frame).toContain('User (1)');
    expect(frame).toContain('Built-in (2)');
    expect(frame).toContain('Plugin (1)');
    expect(frame).toContain('Project definition');
    expect(frame).toContain('current');
    expect(frame).toContain('plain-language');
    expect(frame).toContain('non-coding');
    unmount();
  });

  it('selects an available style and closes after the selection completes', async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();
    const { stdin, waitUntilReady, unmount } = await renderWithProviders(
      <OutputStyleBrowser
        styles={styles}
        definitions={definitions}
        activeStyleName="shared"
        onSelect={onSelect}
        onExit={onExit}
      />,
    );

    await act(async () => {
      stdin.write(ENTER);
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith('shared', styles['shared']);
      expect(onExit).toHaveBeenCalledOnce();
    });
    unmount();
  });

  it('shows a selection error and keeps the dialog open', async () => {
    const onSelect = vi.fn().mockRejectedValue(new Error('save failed'));
    const onExit = vi.fn();
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <OutputStyleBrowser
          styles={styles}
          definitions={definitions}
          activeStyleName="shared"
          onSelect={onSelect}
          onExit={onExit}
        />,
      );

    await act(async () => {
      stdin.write(ENTER);
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(lastFrame()).toContain(
        'Unable to select output style: save failed',
      );
      expect(onExit).not.toHaveBeenCalled();
    });
    unmount();
  });

  it('does not report a successful selection as failed when closing throws', async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn(() => {
      throw new Error('close failed');
    });
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <OutputStyleBrowser
          styles={styles}
          definitions={definitions}
          activeStyleName="shared"
          onSelect={onSelect}
          onExit={onExit}
        />,
      );

    await act(async () => {
      stdin.write(ENTER);
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(lastFrame()).toContain(
        'Output style selected, but unable to close dialog: close failed',
      );
      expect(lastFrame()).not.toContain('Unable to select output style');
    });
    unmount();
  });

  it('focuses the active style when its source tab opens', async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const { stdin, waitUntilReady, unmount } = await renderWithProviders(
      <OutputStyleBrowser
        styles={styles}
        definitions={definitions}
        activeStyleName="Learning"
        onSelect={onSelect}
        onExit={vi.fn()}
      />,
    );

    await act(async () => {
      stdin.write(ENTER);
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith('Learning', styles['Learning']);
    });
    unmount();
  });

  it('shows a forced plugin style and blocks selecting alternatives', async () => {
    const forcedStyles: Record<string, OutputStyleConfig | null> = {
      ...styles,
      'policy:required': {
        name: 'policy:required',
        description: 'Required by the policy plugin',
        prompt: 'REQUIRED',
        source: 'plugin',
        pluginName: 'policy',
        forceForPlugin: true,
      },
    };
    const onSelect = vi.fn();
    const { lastFrame, capturedRegistry, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <OutputStyleBrowser
          styles={forcedStyles}
          definitions={Object.values(forcedStyles).filter(
            (style): style is OutputStyleConfig => style !== null,
          )}
          activeStyleName="policy:required"
          onSelect={onSelect}
          onExit={vi.fn()}
        />,
      );

    expect(lastFrame()).toContain('policy:required');
    expect(lastFrame()).toContain('current');
    expect(lastFrame()).toContain('forced by policy');

    await act(async () => {
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:tab:next',
        FAKE_KEY as never,
      );
      await waitUntilReady();
    });
    await act(async () => {
      stdin.write(ENTER);
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(onSelect).not.toHaveBeenCalled();
      expect(lastFrame()).toContain(
        'Disable plugin "policy" before selecting another output style.',
      );
    });
    unmount();
  });

  it('hides the Plugin tab when no plugin styles are available', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <OutputStyleBrowser
        styles={Object.fromEntries(
          Object.entries(styles).filter(
            ([, style]) => style?.source !== 'plugin',
          ),
        )}
        definitions={definitions.filter((style) => style.source !== 'plugin')}
        activeStyleName="default"
        onSelect={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    expect(lastFrame()).not.toContain('Plugin (');
    unmount();
  });

  it('shows same-name project and user definitions and blocks the shadowed one', async () => {
    const userShared: OutputStyleConfig = {
      name: 'shared',
      description: 'User shared definition',
      prompt: 'USER_SHARED',
      source: 'userSettings',
    };
    const onSelect = vi.fn();
    const { lastFrame, capturedRegistry, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <OutputStyleBrowser
          styles={styles}
          definitions={[userShared, ...definitions]}
          activeStyleName="user-choice"
          onSelect={onSelect}
          onExit={vi.fn()}
        />,
      );

    expect(lastFrame()).toContain('Project (2)');
    expect(lastFrame()).toContain('User (2)');
    expect(lastFrame()).toContain('User shared definition');
    expect(lastFrame()).toMatch(/shared \[shadowed by Project\]/);

    await act(async () => {
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:up',
        FAKE_KEY as never,
      );
      await waitUntilReady();
    });
    await act(async () => {
      stdin.write(ENTER);
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(onSelect).not.toHaveBeenCalled();
      expect(lastFrame()).toContain(
        'This output style is shadowed by Project and cannot be selected.',
      );
    });
    unmount();
  });
});
