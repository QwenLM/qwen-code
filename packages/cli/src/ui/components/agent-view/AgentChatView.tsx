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

  if (!agent) {
    return <AgentChatMissing label={`Agent "${agentId}" not found.`} />;
  }

  return (
    <AgentChatContent
      view={agent.view}
      answerApproval={agent.answerApproval}
      instanceKey={agentId}
      modelName={agent.modelName}
    />
  );
};
