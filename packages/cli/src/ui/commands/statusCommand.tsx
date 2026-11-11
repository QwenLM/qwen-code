/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { MessageType } from '../types.js';
import { UsageStatusPanel } from '../components/UsageStatusPanel.js';
import { CLI_VERSION } from '../../generated/git-commit.js';

/** Open the session-only usage/status panel on the given tab. */
export function openUsageStatusPanel(
  context: CommandContext,
  initialTab: 'usage' | 'status',
): SlashCommandActionReturn | void {
  const currentModel = context.services.agentContext?.config.getActiveModel();
  const currentSessionId = context.services.agentContext?.config.getSessionId();

  if (!currentSessionId) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Session context not available.',
    });
    return;
  }

  return {
    type: 'custom_dialog',
    component: (
      <UsageStatusPanel
        initialTab={initialTab}
        currentModel={currentModel}
        sessionStartTime={context.session.stats.sessionStartTime ?? undefined}
        sessionId={currentSessionId}
        sessionMetrics={context.session.stats.metrics}
        cliVersion={CLI_VERSION}
        onClose={() => context.ui.removeComponent()}
      />
    ),
  };
}

export const statusCommand: SlashCommand = {
  name: 'status',
  description: 'Show session status',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  isSafeConcurrent: true,
  action: (context: CommandContext) => openUsageStatusPanel(context, 'status'),
};
