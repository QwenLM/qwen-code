/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { SessionHandle, SessionState } from '../../session/session.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { createSessionConfig } from '../session/sessionConfig.js';
import { statusCommand } from './statusCommand.js';
import { renameCommand } from './renameCommand.js';
import { effortCommand } from './effortCommand.js';
import { contextWindowCommand } from './contextWindowCommand.js';

function fixture() {
  const context = createMockCommandContext();
  const local = {
    getModel: () => 'local-model',
    getActiveModel: () => 'local-model',
    getSessionId: () => 'conversation',
    getReasoningEffort: () => 'low',
    getContextWindow: () => 32_000,
    getFunctionSwitchSelections: () => undefined,
    getUltracode: () => false,
    setUltracode: vi.fn(),
    setModel: vi.fn(),
    setReasoningEffort: vi.fn(),
    setContextWindow: vi.fn(),
    persistSessionTitle: vi.fn(),
  };
  context.services.agentContext = {
    config: local,
  } as unknown as CommandContext['services']['agentContext'];
  const state = {
    model: 'session-model',
    reasoningEffort: 'high',
    contextWindow: 128_000,
    permissionMode: 'default',
    access: { status: 'connected', sessionId: 'conversation', error: null },
    models: [
      {
        modelId: 'session-model',
        displayName: 'Session model',
        source: 'system',
        efforts: ['low', 'high'],
        availableContextWindows: [64_000, 128_000],
      },
    ],
  } as unknown as SessionState;
  const setModel = vi.fn(async () => {});
  const setTitle = vi.fn(async () => {});
  const session = {
    getState: () => state,
    setModel,
    setTitle,
    applySettings: vi.fn(async () => {}),
  } as unknown as SessionHandle;
  context.services.sessionHandle = session;
  context.services.agentContext = createSessionConfig(
    local as unknown as import('@qwen-code/core').Config,
    { current: { session, settings: state } },
    (text) => context.ui.addItem({ type: 'error', text }),
  );
  return { context, local, session, setModel, setTitle };
}
describe('commands with an explicit session handle', () => {
  it('lets the unchanged status command read the supplied session model', async () => {
    const h = fixture();
    const result = await statusCommand.action!(h.context, '');
    expect(result).toMatchObject({
      type: 'custom_dialog',
      component: { props: { currentModel: 'session-model', sessionId: 'conversation' } },
    });
  });
  it('reads effort and context from the session, not the local config', async () => {
    const h = fixture();
    await effortCommand.action!(h.context, 'low');
    expect(h.setModel).toHaveBeenCalledWith('session-model', 'low', 128_000);
    expect(h.local.setReasoningEffort).not.toHaveBeenCalled();
    expect(h.local.setContextWindow).not.toHaveBeenCalled();
  });
  it('renames the supplied conversation without persisting a local title', async () => {
    const h = fixture();
    await renameCommand.action!(h.context, 'New title');
    expect(h.setTitle).toHaveBeenCalledWith('New title');
    expect(h.local.persistSessionTitle).not.toHaveBeenCalled();
  });
  it('opens context options with the session values', async () => {
    const h = fixture();
    const result = await contextWindowCommand.action!(h.context, '');
    expect(result).toMatchObject({
      type: 'custom_dialog',
      component: {
        props: {
          currentReasoningEffort: 'high',
          currentContextWindow: 128_000,
        },
      },
    });
    expect(h.local.setContextWindow).not.toHaveBeenCalled();
  });
});
