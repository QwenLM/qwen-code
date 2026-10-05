/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Arena wrapper around AgentChatContent. Resolves the selected agent
 * from AgentViewContext; the content component owns live-state reads
 * and the Ctrl+F embedded-shell toggle.
 */

import { Box, Text } from 'ink';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import {
  useAgentViewState,
  useAgentViewActions,
} from '../../contexts/AgentViewContext.js';
import { ErrorBoundary } from '../shared/ErrorBoundary.js';
import { theme } from '../../semantic-colors.js';
import { sanitizeTerminalText } from '../../utils/textUtils.js';
import { AgentChatContent, AgentChatMissing } from './AgentChatContent.js';

const debugLogger = createDebugLogger('AGENT_TAB_RENDER');

interface AgentChatViewProps {
  agentId: string;
}

export const AgentChatView = ({ agentId }: AgentChatViewProps) => {
  const { agents } = useAgentViewState();
  const { setAgentShellFocused } = useAgentViewActions();
  const agent = agents.get(agentId);

  const interactiveAgent = agent?.interactiveAgent;
  const core = interactiveAgent?.getCore();

  if (!agent || !interactiveAgent || !core) {
    return <AgentChatMissing label={`Agent "${agentId}" not found.`} />;
  }

  return (
    // Non-fatal per-tab containment (#9290): the app-level boundary is
    // FATAL — a render error that reaches it logs [FATAL_RENDER_ERROR]
    // and exits the whole session. An errored or incomplete teammate
    // whose transcript throws during render must degrade THIS tab only,
    // keeping the session and the other tabs alive. Keyed by agentId so
    // switching tabs starts from fresh boundary state: one crashed tab
    // must not strand every later tab in its fallback.
    <ErrorBoundary
      key={agentId}
      fallback={(error) => (
        <Box flexDirection="column" paddingX={1}>
          <Text color={theme.status.error} bold>
            Something went wrong while rendering this agent tab.
          </Text>
          <Text color={theme.text.secondary}>
            {sanitizeTerminalText(error.message)}
          </Text>
          <Text color={theme.text.secondary} dimColor>
            The session is still running; other tabs are unaffected.
          </Text>
          <Text color={theme.text.secondary} dimColor>
            Switch to another tab and back to retry rendering this tab.
          </Text>
          <Text color={theme.text.secondary} dimColor>
            Set QWEN_DEBUG_LOG_FILE=1 and reproduce for a full log.
          </Text>
        </Box>
      )}
      onError={(error, info) => {
        // The crashed content can no longer own the embedded-shell focus:
        // it is the only production writer of the flag and it deliberately
        // never clears it on unmount (React error #185). Clear it here —
        // componentDidCatch runs in the commit phase, so this update is
        // safe. The tab-switch resets cover normal navigation, but while
        // the flag is stale the tab bar swallows left/right — the only
        // escape — so a crash is exactly when only this hook can release
        // the lock (#9290 review).
        setAgentShellFocused(false);
        debugLogger.error(
          `[AGENT_TAB_RENDER_ERROR] agentId=${agentId} ${error.message}\n${info.componentStack ?? ''}\n${error.stack ?? ''}`,
        );
      }}
    >
      <AgentChatContent
        core={core}
        interactiveAgent={interactiveAgent}
        instanceKey={agentId}
        modelName={agent.modelName}
      />
    </ErrorBoundary>
  );
};
