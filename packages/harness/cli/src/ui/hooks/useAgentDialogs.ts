/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';
import type { AgentDefinition } from '@qwen-code/core';
import type { SourceTabKey } from '../components/AgentBrowser.js';

export interface UseAgentDialogsReturn {
  isAgentConfigDialogOpen: boolean;
  isAgentBrowserOpen: boolean;
  agentBrowserActiveTab: SourceTabKey;
  selectedAgentName: string | undefined;
  selectedAgentDefinition: AgentDefinition | undefined;
  setAgentBrowserActiveTab: (tab: SourceTabKey) => void;
  openAgentConfigDialog: (name: string, definition: AgentDefinition) => void;
  closeAgentConfigDialog: () => void;
  openAgentBrowser: () => void;
  closeAgentBrowser: () => void;
}

/**
 * Owns agent-related dialog state: the per-agent config dialog and the
 * agent browser. The config dialog tracks the selected agent's identity
 * (name, definition) so the dialog body can render without extra plumbing
 * through the parent.
 */
export function useAgentDialogs(): UseAgentDialogsReturn {
  const [isAgentConfigDialogOpen, setIsAgentConfigDialogOpen] = useState(false);
  const [isAgentBrowserOpen, setIsAgentBrowserOpen] = useState(false);
  const [agentBrowserActiveTab, setAgentBrowserActiveTab] =
    useState<SourceTabKey>('project');
  const [selectedAgentName, setSelectedAgentName] = useState<
    string | undefined
  >();
  const [selectedAgentDefinition, setSelectedAgentDefinition] = useState<
    AgentDefinition | undefined
  >();

  const openAgentConfigDialog = useCallback(
    (name: string, definition: AgentDefinition) => {
      setSelectedAgentName(name);
      setSelectedAgentDefinition(definition);
      setIsAgentConfigDialogOpen(true);
    },
    [],
  );

  const closeAgentConfigDialog = useCallback(() => {
    setIsAgentConfigDialogOpen(false);
    setSelectedAgentName(undefined);
    setSelectedAgentDefinition(undefined);
  }, []);

  const openAgentBrowser = useCallback(() => {
    setIsAgentBrowserOpen(true);
  }, []);

  const closeAgentBrowser = useCallback(() => {
    setIsAgentBrowserOpen(false);
    setAgentBrowserActiveTab('project');
  }, []);

  return {
    isAgentConfigDialogOpen,
    isAgentBrowserOpen,
    agentBrowserActiveTab,
    selectedAgentName,
    selectedAgentDefinition,
    setAgentBrowserActiveTab,
    openAgentConfigDialog,
    closeAgentConfigDialog,
    openAgentBrowser,
    closeAgentBrowser,
  };
}
