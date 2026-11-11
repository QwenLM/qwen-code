/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../test-utils/render.js';
import { SessionGateContext } from '../contexts/SessionGateContext.js';
import type { UIState } from '../contexts/UIStateContext.js';
import type { SessionGateProps } from '../sessionGate.js';
import { MainControls } from './MainControls.js';

vi.mock('./Composer.js', () => ({
  Composer: () => <Text>Composer</Text>,
}));
vi.mock('./DialogManager.js', () => ({
  DialogManager: () => <Text>DialogManager</Text>,
}));

const gateProps = vi.fn();

function TestGate(props: SessionGateProps) {
  gateProps(props);
  return <Text>SignInGate</Text>;
}

function uiState(overrides: Partial<UIState> = {}): UIState {
  return {
    terminalWidth: 80,
    customDialog: null,
    hasPendingToolConfirmation: false,
    dialogsVisible: false,
    sessionGateVisible: false,
    ...overrides,
  } as unknown as UIState;
}

function renderControls(
  Gate: typeof TestGate | undefined,
  overrides: Partial<UIState> = {},
  uiActions: { onSessionGateStateChange?: () => void } = {},
) {
  const state = uiState(overrides);
  return renderWithProviders(
    <SessionGateContext.Provider value={Gate}>
      <MainControls uiState={state} />
    </SessionGateContext.Provider>,
    { uiState: state, uiActions },
  );
}

afterEach(() => {
  gateProps.mockClear();
});

describe('MainControls session gate', () => {
  it('shows only the composer without a product gate', async () => {
    const { lastFrame, unmount } = await renderControls(undefined);

    expect(lastFrame()).toContain('Composer');
    expect(lastFrame()).not.toContain('SignInGate');
    unmount();
  });

  it('keeps the gate mounted while hidden and passes the state callback', async () => {
    const onSessionGateStateChange = vi.fn();
    const { lastFrame, unmount } = await renderControls(
      TestGate,
      {},
      { onSessionGateStateChange },
    );

    expect(lastFrame()).toContain('Composer');
    expect(gateProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ onStateChange: onSessionGateStateChange }),
    );
    unmount();
  });

  it('takes over every other control while visible', async () => {
    const { lastFrame, unmount } = await renderControls(TestGate, {
      sessionGateVisible: true,
      dialogsVisible: true,
      customDialog: <Text>CustomDialog</Text>,
    });

    expect(lastFrame()).toContain('SignInGate');
    expect(lastFrame()).not.toContain('Composer');
    expect(lastFrame()).not.toContain('CustomDialog');
    unmount();
  });
});
