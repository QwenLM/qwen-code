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

import { useAgentViewState } from '../../contexts/AgentViewContext.js';
import { AgentChatContent, AgentChatMissing } from './AgentChatContent.js';

interface AgentChatViewProps {
  agentId: string;
}

export const AgentChatView = ({ agentId }: AgentChatViewProps) => {
  const { agents } = useAgentViewState();
  const agent = agents.get(agentId);

  const interactiveAgent = agent?.interactiveAgent;
  const core = interactiveAgent?.getCore();

  if (!agent || !interactiveAgent || !core) {
    return <AgentChatMissing label={`Agent "${agentId}" not found.`} />;
  }

  return (
    <AgentChatContent
      core={core}
      interactiveAgent={interactiveAgent}
      instanceKey={agentId}
      modelName={agent.modelName}
    />
  );
};
