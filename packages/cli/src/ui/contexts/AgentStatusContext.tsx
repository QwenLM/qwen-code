/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { createContext, useContext, useState, useEffect } from 'react';
import type { TaskResultDisplay } from '@qwen-code/qwen-code-core';

export interface ActiveAgentStatus {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: Date;
  toolCalls?: number;
  completedCalls?: number;
}

export interface AgentStatusContextType {
  activeAgents: ActiveAgentStatus[];
  addAgent: (agent: ActiveAgentStatus) => void;
  updateAgent: (id: string, updates: Partial<ActiveAgentStatus>) => void;
  removeAgent: (id: string) => void;
  updateAgentFromDisplay: (display: TaskResultDisplay) => void;
}

const AgentStatusContext = createContext<AgentStatusContextType | null>(null);

export const AgentStatusProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [activeAgents, setActiveAgents] = useState<ActiveAgentStatus[]>([]);

  const addAgent = (agent: ActiveAgentStatus) => {
    setActiveAgents((prev) => [...prev, agent]);
  };

  const updateAgent = (id: string, updates: Partial<ActiveAgentStatus>) => {
    setActiveAgents((prev) =>
      prev.map((agent) => (agent.id === id ? { ...agent, ...updates } : agent)),
    );
  };

  const removeAgent = (id: string) => {
    setActiveAgents((prev) => prev.filter((agent) => agent.id !== id));
  };

  const updateAgentFromDisplay = (display: TaskResultDisplay) => {
    const agentId = `${display.subagentName}-${Date.now()}`;

    const existingAgent = activeAgents.find(
      (agent) =>
        agent.name === display.subagentName && agent.status === 'running',
    );

    if (display.status === 'running') {
      if (existingAgent) {
        // Update existing running agent
        updateAgent(existingAgent.id, {
          status: display.status,
          toolCalls: display.toolCalls?.length,
          completedCalls: display.toolCalls?.filter(
            (call) => call.status === 'success' || call.status === 'failed',
          ).length,
        });
      } else {
        // Add new running agent
        addAgent({
          id: agentId,
          name: display.subagentName,
          status: display.status,
          startTime: new Date(),
          toolCalls: display.toolCalls?.length,
          completedCalls: display.toolCalls?.filter(
            (call) => call.status === 'success' || call.status === 'failed',
          ).length,
        });
      }
    } else if (existingAgent) {
      // Update status to completed/failed/cancelled and remove after a delay
      updateAgent(existingAgent.id, {
        status: display.status,
      });

      // Remove agent after a short delay to allow UI to show completion
      setTimeout(() => {
        removeAgent(existingAgent.id);
      }, 2000);
    }
  };

  // Clean up completed agents periodically
  useEffect(() => {
    const interval = setInterval(() => {
      setActiveAgents((prev) =>
        prev.filter(
          (agent) =>
            agent.status === 'running' ||
            new Date().getTime() - agent.startTime.getTime() < 3000, // Keep completed agents for 3 seconds
        ),
      );
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  return (
    <AgentStatusContext.Provider
      value={{
        activeAgents,
        addAgent,
        updateAgent,
        removeAgent,
        updateAgentFromDisplay,
      }}
    >
      {children}
    </AgentStatusContext.Provider>
  );
};

export const useAgentStatus = () => {
  const context = useContext(AgentStatusContext);
  if (!context) {
    throw new Error(
      'useAgentStatus must be used within an AgentStatusProvider',
    );
  }
  return context;
};
